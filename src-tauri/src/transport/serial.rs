// Serial transport — USB CDC-ACM, 115200 8N1.
// Handshake: host sends `OBX-WHO\n`; firmware replies `OBX-HELLO <json>\n`.
// The sentinel lets the parser extract the handshake from a noisy boot log.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    {Arc, Mutex},
};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::discovery::SerialConnHandle;

// ── Port listing ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub name: String,
    pub description: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

pub fn list_ports() -> Vec<SerialPortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(info) => Some(SerialPortInfo {
                name: p.port_name,
                description: info.product,
                vid: Some(info.vid),
                pid: Some(info.pid),
            }),
            _ => None,
        })
        .collect()
}

// ── Handshake ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ObxHandshake {
    pub obx: u32,
    pub product: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "fwVersion")]
    pub fw_version: String,
    pub chip: String,
    pub name: Option<String>,
    #[serde(rename = "hwRev")]
    pub hw_rev: Option<String>,
    pub capabilities: Option<serde_json::Value>,
}

/// Opens the port, performs the OBX-WHO/OBX-HELLO handshake, and returns the
/// parsed handshake payload. Re-probes with OBX-WHO every 400 ms (so a device
/// that's still booting, or whose boot banner we missed, still gets caught) and
/// gives up after `timeout`.
fn do_handshake(
    port: &mut dyn serialport::SerialPort,
    timeout: Duration,
) -> Result<ObxHandshake> {
    let deadline = std::time::Instant::now() + timeout;
    let mut last_probe: Option<std::time::Instant> = None;
    let mut line = String::new();

    loop {
        let now = std::time::Instant::now();
        if now > deadline {
            return Err(anyhow!("handshake timeout — is this an OpenBricx device?"));
        }
        // Probe immediately, then re-probe periodically until something answers.
        if last_probe.map_or(true, |t| now.duration_since(t) >= Duration::from_millis(400)) {
            port.write_all(b"OBX-WHO\n")?;
            port.flush()?;
            last_probe = Some(now);
        }
        let mut byte = [0u8; 1];
        match port.read(&mut byte) {
            Ok(1) => {
                let ch = byte[0] as char;
                if ch == '\n' {
                    let trimmed = line.trim();
                    if let Some(json) = trimmed.strip_prefix("OBX-HELLO ") {
                        return Ok(serde_json::from_str(json)?);
                    }
                    line.clear();
                } else {
                    line.push(ch);
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e.into()),
        }
    }
}

/// Mirror esptool's USB-Serial-JTAG reset: pulse the control lines so an
/// ESP32-C3 (native USB) reboots into its application with DTR/RTS released.
/// Used as recovery when the first handshake gets no reply — asserting DTR
/// (which TinyUSB CDC devices need) can nudge a USB-Serial-JTAG chip into
/// reset/download, and this knocks it back into the running firmware.
fn usb_jtag_recover(port: &mut dyn serialport::SerialPort) {
    let _ = port.write_data_terminal_ready(false); // release the boot/download hold
    let _ = port.write_request_to_send(false);
    std::thread::sleep(Duration::from_millis(100));
    let _ = port.write_request_to_send(true); // assert EN (reset)
    std::thread::sleep(Duration::from_millis(100));
    let _ = port.write_request_to_send(false); // release → boots the app
    std::thread::sleep(Duration::from_millis(400)); // let it come up
}

// ── Connect ──────────────────────────────────────────────────────────────────

pub fn connect(
    port_name: String,
    serial_connections: Arc<Mutex<HashMap<String, SerialConnHandle>>>,
    app: AppHandle,
) -> Result<(String, ObxHandshake)> {
    // Native USB-Serial-JTAG (ESP32-C3, e.g. Mods) and TinyUSB CDC (e.g. deck)
    // need opposite control-line handling. The JTAG bridge has Espressif's fixed
    // VID:PID 303A:1001; identify it before opening so we pick the right path.
    let is_usb_jtag = serialport::available_ports()
        .ok()
        .into_iter()
        .flatten()
        .find(|p| p.port_name == port_name)
        .map(|p| matches!(&p.port_type,
            serialport::SerialPortType::UsbPort(info) if info.vid == 0x303A && info.pid == 0x1001))
        .unwrap_or(false);

    let mut port = serialport::new(&port_name, 115_200)
        .timeout(Duration::from_millis(10))
        .open()
        .map_err(|e| anyhow!("failed to open {port_name}: {e}"))?;

    let handshake = if is_usb_jtag {
        // USB-Serial-JTAG receives regardless of DTR, and toggling the control
        // lines (asserting DTR / pulsing RTS) RESETS the chip — which re-enumerates
        // the USB and leaves this handle stale, so every later command is silently
        // dropped. Leave the lines released and just probe.
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);
        do_handshake(port.as_mut(), Duration::from_secs(3))?
    } else {
        // TinyUSB CDC needs DTR asserted or tud_cdc_connected() is false and the
        // firmware drops our writes. Recover-and-retry if the first probe is silent.
        let _ = port.write_data_terminal_ready(true);
        match do_handshake(port.as_mut(), Duration::from_secs(2)) {
            Ok(h) => h,
            Err(_) => {
                usb_jtag_recover(port.as_mut());
                do_handshake(port.as_mut(), Duration::from_secs(3))?
            }
        }
    };

    let conn_id = Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    serial_connections.lock().unwrap().insert(
        conn_id.clone(),
        SerialConnHandle {
            tx,
            stop: stop.clone(),
        },
    );

    // One thread owns the port and interleaves both directions: drain any queued
    // host→device writes, then do a short-timeout read and emit device→host bytes.
    //
    // This deliberately avoids serialport's `try_clone()` (used previously to give
    // the writer its own handle). On Windows a cloned COM handle can silently fail
    // to transmit — `write_all` returns Ok but nothing reaches the wire — which
    // left the device receiving nothing after the handshake (e.g. the `I` version
    // query and OTA both got no reply). A single handle writes reliably.
    //
    // On ANY exit (error or stop) the connection is also removed from the map, so
    // a later `send` fails loudly ("connection not found") instead of dropping
    // bytes into a dead channel while the UI still believes it's connected.
    let conn_id_t = conn_id.clone();
    let app_t = app.clone();
    let map_t = serial_connections.clone();
    std::thread::spawn(move || {
        let mut rx = rx;
        let mut buf = [0u8; 512];
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            // 1. Flush everything queued for the device.
            let mut failed = false;
            while let Ok(data) = rx.try_recv() {
                if port.write_all(&data).is_err() || port.flush().is_err() {
                    failed = true;
                    break;
                }
            }
            if failed {
                break;
            }

            // 2. Read whatever arrived (short timeout keeps writes responsive).
            match port.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    let _ = app_t.emit(
                        "obx://message",
                        serde_json::json!({ "connectionId": conn_id_t, "data": &buf[..n] }),
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
        map_t.lock().unwrap().remove(&conn_id_t);
        let _ = app_t.emit(
            "obx://status",
            serde_json::json!({ "connectionId": conn_id_t, "status": "closed" }),
        );
    });

    let _ = app.emit(
        "obx://status",
        serde_json::json!({ "connectionId": conn_id, "status": "connected" }),
    );

    Ok((conn_id, handshake))
}

// ── Disconnect ───────────────────────────────────────────────────────────────

pub fn disconnect(
    conn_id: &str,
    serial_connections: Arc<Mutex<HashMap<String, SerialConnHandle>>>,
) {
    if let Some(handle) = serial_connections.lock().unwrap().remove(conn_id) {
        handle.stop.store(true, Ordering::Relaxed);
        // Dropping `handle.tx` causes the writer thread's `blocking_recv()` to
        // return None, which exits that thread cleanly.
    }
}

// ── Send ─────────────────────────────────────────────────────────────────────

pub fn send(
    conn_id: &str,
    data: Vec<u8>,
    serial_connections: &Arc<Mutex<HashMap<String, SerialConnHandle>>>,
) -> Result<(), String> {
    let map = serial_connections.lock().unwrap();
    let handle = map
        .get(conn_id)
        .ok_or_else(|| format!("serial connection {conn_id} not found"))?;
    handle.tx.send(data).map_err(|e| e.to_string())
}

// ── Re-export sender type for commands.rs ────────────────────────────────────

pub type SerialTx = UnboundedSender<Vec<u8>>;
