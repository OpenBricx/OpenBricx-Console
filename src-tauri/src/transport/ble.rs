// BLE transport — btleplug over the Nordic UART Service (NUS).
//
// The Mods firmware (ble_link.c) exposes the SAME console line protocol as USB
// serial, just over BLE NUS: a phone/host WRITEs newline-terminated commands to
// the RX characteristic and receives replies as NOTIFYs on the TX characteristic.
// So this transport is a transparent byte pipe (identical semantics to serial),
// and the handshake is the same OBX-WHO / OBX-HELLO exchange.
//
// The firmware advertises only its name ("OBX-RX-xxxx" / "OBX-TX-xxxx") — NOT the
// NUS service UUID — so discovery filters advertisements by that name prefix and
// identifies the product only on connect (mirroring how serial ports work).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use uuid::Uuid;

use crate::discovery::BleConnHandle;

// Nordic UART Service UUIDs (must match ble_link.c).
//   service 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
//   RX (host → device, WRITE)  …0002…
//   TX (device → host, NOTIFY) …0003…
const NUS_RX: Uuid = Uuid::from_u128(0x6E40_0002_B5A3_F393_E0A9_E50E_24DC_CA9E);
const NUS_TX: Uuid = Uuid::from_u128(0x6E40_0003_B5A3_F393_E0A9_E50E_24DC_CA9E);

// Only OpenBricx boards advertise with this local-name prefix.
const NAME_PREFIX: &str = "OBX-";

// Conservative GATT write chunk. The default ATT MTU yields a 20-byte payload;
// the firmware reassembles by newline, so any chunk size is fine — 20 is the
// universally safe floor regardless of the negotiated MTU.
const WRITE_CHUNK: usize = 20;

// ── Discovery listing ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleDeviceInfo {
    /// Opaque peripheral id — pass back to `connect` to open this device.
    pub id: String,
    pub name: String,
}

// ── Handshake payload (identical shape to serial/wifi) ────────────────────────

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

// ── Adapter (Central) — created once, reused for scan/list/connect ────────────

async fn ensure_central(slot: &Arc<tokio::sync::Mutex<Option<Adapter>>>) -> Result<Adapter> {
    let mut guard = slot.lock().await;
    if let Some(a) = guard.as_ref() {
        return Ok(a.clone());
    }
    let manager = Manager::new().await?;
    let adapter = manager
        .adapters()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no Bluetooth adapter found — is Bluetooth turned on?"))?;
    *guard = Some(adapter.clone());
    Ok(adapter)
}

pub async fn start_scan(slot: Arc<tokio::sync::Mutex<Option<Adapter>>>) -> Result<()> {
    let central = ensure_central(&slot).await?;
    // Empty filter: the firmware doesn't advertise the NUS UUID, so we scan all
    // and filter by name ourselves.
    central.start_scan(ScanFilter::default()).await?;
    Ok(())
}

pub async fn stop_scan(slot: Arc<tokio::sync::Mutex<Option<Adapter>>>) -> Result<()> {
    if let Some(a) = slot.lock().await.as_ref() {
        a.stop_scan().await.ok();
    }
    Ok(())
}

/// Snapshot of currently-seen OpenBricx peripherals. Polled by the frontend.
pub async fn list_devices(slot: Arc<tokio::sync::Mutex<Option<Adapter>>>) -> Result<Vec<BleDeviceInfo>> {
    let central = ensure_central(&slot).await?;
    let mut out = Vec::new();
    for p in central.peripherals().await? {
        if let Ok(Some(props)) = p.properties().await {
            if let Some(name) = props.local_name {
                if name.starts_with(NAME_PREFIX) {
                    out.push(BleDeviceInfo { id: p.id().to_string(), name });
                }
            }
        }
    }
    Ok(out)
}

// ── Connect ───────────────────────────────────────────────────────────────────

pub async fn connect(
    device_id: String,
    slot: Arc<tokio::sync::Mutex<Option<Adapter>>>,
    connections: Arc<Mutex<HashMap<String, BleConnHandle>>>,
    app: AppHandle,
) -> Result<(String, ObxHandshake)> {
    let central = ensure_central(&slot).await?;

    // Resolve the advertised id back to a peripheral handle.
    let periph = central
        .peripherals()
        .await?
        .into_iter()
        .find(|p| p.id().to_string() == device_id)
        .ok_or_else(|| anyhow!("BLE device not found — is it still in range and advertising?"))?;

    periph.connect().await?;
    periph.discover_services().await?;

    let chars = periph.characteristics();
    let rx_char = chars
        .iter()
        .find(|c| c.uuid == NUS_RX)
        .cloned()
        .ok_or_else(|| anyhow!("this device doesn't expose the OpenBricx BLE service"))?;
    let tx_char = chars
        .iter()
        .find(|c| c.uuid == NUS_TX)
        .cloned()
        .ok_or_else(|| anyhow!("this device doesn't expose the OpenBricx BLE service"))?;

    periph.subscribe(&tx_char).await?;
    let mut notifs = periph.notifications().await?;

    // Handshake: write OBX-WHO and read the OBX-HELLO {json} line off the notify
    // stream. Re-probe periodically — the first write can race the firmware's
    // CCCD-subscribe handling, in which case the reply is dropped.
    let handshake = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut line = String::new();
        let mut result: Option<ObxHandshake> = None;

        write_chunked(&periph, &rx_char, b"OBX-WHO\n").await?;
        let mut last_probe = tokio::time::Instant::now();

        while tokio::time::Instant::now() < deadline && result.is_none() {
            let timeout = tokio::time::timeout(Duration::from_millis(300), notifs.next()).await;
            match timeout {
                Ok(Some(n)) => {
                    for &b in n.value.iter() {
                        let ch = b as char;
                        if ch == '\n' {
                            if let Some(json) = line.trim().strip_prefix("OBX-HELLO ") {
                                if let Ok(hs) = serde_json::from_str::<ObxHandshake>(json) {
                                    result = Some(hs);
                                    break;
                                }
                            }
                            line.clear();
                        } else if ch != '\r' {
                            line.push(ch);
                        }
                    }
                }
                Ok(None) => return Err(anyhow!("BLE link dropped during handshake")),
                Err(_) => {} // read timed out — fall through to maybe re-probe
            }
            if last_probe.elapsed() >= Duration::from_millis(800) {
                write_chunked(&periph, &rx_char, b"OBX-WHO\n").await?;
                last_probe = tokio::time::Instant::now();
            }
        }

        match result {
            Some(hs) => hs,
            None => {
                let _ = periph.disconnect().await;
                return Err(anyhow!("handshake timeout — is this an OpenBricx device?"));
            }
        }
    };

    let conn_id = Uuid::new_v4().to_string();
    let (tx, rx) = unbounded_channel::<Vec<u8>>();
    connections.lock().unwrap().insert(conn_id.clone(), BleConnHandle { tx });

    let conn_id_t = conn_id.clone();
    tauri::async_runtime::spawn(run_link(
        periph, rx_char, notifs, rx, conn_id_t, connections.clone(), app.clone(),
    ));

    app.emit(
        "obx://status",
        serde_json::json!({ "connectionId": conn_id, "status": "connected" }),
    )
    .ok();

    Ok((conn_id, handshake))
}

/// The connection pump: forwards host→device writes to the RX characteristic and
/// device→host notifications to the frontend. Exits (and disconnects the
/// peripheral) when the write channel is dropped (close requested) or the notify
/// stream ends (device gone).
async fn run_link(
    periph: Peripheral,
    rx_char: btleplug::api::Characteristic,
    mut notifs: std::pin::Pin<Box<dyn futures_util::Stream<Item = btleplug::api::ValueNotification> + Send>>,
    mut rx: UnboundedReceiver<Vec<u8>>,
    conn_id: String,
    connections: Arc<Mutex<HashMap<String, BleConnHandle>>>,
    app: AppHandle,
) {
    loop {
        tokio::select! {
            notif = notifs.next() => match notif {
                Some(n) => {
                    app.emit(
                        "obx://message",
                        serde_json::json!({ "connectionId": &conn_id, "data": n.value }),
                    ).ok();
                }
                None => break, // device disconnected
            },
            cmd = rx.recv() => match cmd {
                Some(data) => {
                    if write_chunked(&periph, &rx_char, &data).await.is_err() {
                        break;
                    }
                }
                None => break, // handle dropped → close requested
            },
        }
    }

    let _ = periph.disconnect().await;
    connections.lock().unwrap().remove(&conn_id);
    app.emit(
        "obx://status",
        serde_json::json!({ "connectionId": &conn_id, "status": "closed" }),
    )
    .ok();
}

/// Writes `data` to the RX characteristic in MTU-safe fragments. WithoutResponse
/// matches the NUS convention and the firmware's WRITE_NO_RSP flag.
async fn write_chunked(
    periph: &Peripheral,
    rx_char: &btleplug::api::Characteristic,
    data: &[u8],
) -> Result<()> {
    for chunk in data.chunks(WRITE_CHUNK) {
        periph
            .write(rx_char, chunk, WriteType::WithoutResponse)
            .await?;
    }
    Ok(())
}

// ── Disconnect ────────────────────────────────────────────────────────────────

pub fn disconnect(conn_id: &str, connections: &Arc<Mutex<HashMap<String, BleConnHandle>>>) {
    // Removing the handle drops its `tx`, so the link task's `rx.recv()` returns
    // None, breaks, and disconnects the peripheral.
    connections.lock().unwrap().remove(conn_id);
}

// ── Send ──────────────────────────────────────────────────────────────────────

pub fn send(
    conn_id: &str,
    data: Vec<u8>,
    connections: &Arc<Mutex<HashMap<String, BleConnHandle>>>,
) -> Result<(), String> {
    let map = connections.lock().unwrap();
    let handle = map
        .get(conn_id)
        .ok_or_else(|| format!("ble connection {conn_id} not found"))?;
    handle.tx.send(data).map_err(|e| e.to_string())
}

pub type BleTx = UnboundedSender<Vec<u8>>;
