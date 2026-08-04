// Firmware flasher — cold-flashes blank or bricked chips over USB/UART.
// Uses espflash as a library so no external tooling is required.

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use espflash::connection::reset::{ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::{Flasher, ProgressCallbacks};
use serde::Serialize;
use serialport::UsbPortInfo;
use tauri::{AppHandle, Emitter};

// ── Progress events ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashProgress {
    pub port: String,
    pub stage: String,
    pub percent: u32,
}

fn emit(app: &AppHandle, port: &str, stage: &str, percent: u32) {
    let _ = app.emit(
        "obx://flash-progress",
        FlashProgress {
            port: port.to_string(),
            stage: stage.to_string(),
            percent,
        },
    );
}

// ── Progress callback ─────────────────────────────────────────────────────────

struct Reporter {
    app: AppHandle,
    port: String,
    total: usize,
}

impl ProgressCallbacks for Reporter {
    fn init(&mut self, _addr: u32, total: usize) {
        self.total = total;
        emit(&self.app, &self.port, "flashing", 30);
    }

    fn update(&mut self, current: usize) {
        if self.total == 0 {
            return;
        }
        // Map bytes written into the 30–95 % window of overall progress.
        let pct = 30 + (current * 65 / self.total) as u32;
        emit(&self.app, &self.port, "flashing", pct.min(95));
    }

    fn finish(&mut self) {
        emit(&self.app, &self.port, "done", 100);
    }
}

// ── Download-mode entry ("Enter Flash Mode") ───────────────────────────────────
//
// A running OpenBricx device exposes its native USB-OTG CDC port. The ROM serial
// bootloader needs the chip rebooted with the download-boot flag set, otherwise
// espflash can't talk to it (the app firmware owns USB, not the ROM). The deck
// firmware reboots into download mode on two cues — the host opening the CDC at
// 1200 baud (the esptool/Arduino "touch") and the OBX `DFU` command. We send both
// for robustness, then wait for the download port to appear.

/// Snapshot of the serial port names currently present, so we can detect the
/// download port re-enumerating after the reboot.
fn port_names() -> HashSet<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}

/// Reboots a running OpenBricx device into the ROM serial bootloader by touching
/// its CDC port at 1200 baud and sending the OBX `DFU` command, then waits for
/// the download port to enumerate. Returns the resolved download-port name.
///
/// `before` is the set of ports present before the touch. The download port is
/// whichever name appears that wasn't there before; if none is new (some chips
/// keep the same COM name across the reboot) we fall back to `app_port`.
fn enter_download_mode(app_port: &str, before: &HashSet<String>) -> Result<String> {
    // Two triggers, sent in order of reliability:
    //
    //  1. The OBX `DFU` command. The firmware only processes CDC input while the
    //     host asserts DTR (tud_cdc_connected()), so we raise DTR before writing.
    //  2. The 1200-baud "touch": switch the line coding to 1200 and toggle the
    //     control lines. The firmware's tud_cdc_line_coding_cb reboots on this
    //     regardless of DTR (line coding is a USB control request, not CDC data).
    //
    // We send both because either alone can miss: #1 needs new-enough firmware
    // that honours `DFU`, #2 needs the line-coding callback — current firmware
    // has both, but this stays robust across versions.
    if let Ok(mut port) = serialport::new(app_port, 115_200)
        .timeout(Duration::from_millis(100))
        .open()
    {
        // Assert DTR/RTS so the firmware sees us as "connected" and reads input.
        let _ = port.write_data_terminal_ready(true);
        let _ = port.write_request_to_send(true);
        sleep(Duration::from_millis(50));

        let _ = port.write_all(b"DFU\n");
        let _ = port.flush();
        sleep(Duration::from_millis(100));

        // 1200-baud touch as a fallback trigger.
        let _ = port.set_baud_rate(1_200);
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);
        sleep(Duration::from_millis(120));
        // Drop the handle so the OS releases the (now-rebooting) port.
    }
    // The device drops its USB and re-enumerates as the download port. Poll until
    // a new port shows up (or the original disappears and comes back — same COM
    // name in download mode).
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut app_port_vanished = false;
    loop {
        sleep(Duration::from_millis(200));
        let now = port_names();

        // Track the reboot actually happening: the app port must VANISH at some
        // point. Without this, a device that ignored both DFU triggers (port
        // never re-enumerates) was falsely reported as being in download mode.
        if !now.contains(app_port) {
            app_port_vanished = true;
        }

        // Prefer a port that wasn't present before the reboot.
        if let Some(new_port) = now.difference(before).next() {
            // Windows takes ~1-2 s to make a freshly enumerated USB-Serial/JTAG
            // download port openable; settle before handing it to espflash.
            sleep(Duration::from_millis(1200));
            return Ok(new_port.clone());
        }

        // Some boards keep the same COM name across the download-mode reboot:
        // accept the original name only if we saw it disappear and come back.
        if app_port_vanished && now.contains(app_port) {
            sleep(Duration::from_millis(1200));
            return Ok(app_port.to_string());
        }

        if Instant::now() > deadline {
            return Err(anyhow!(
                "device did not enter download mode — hold BOOT then press RESET and retry"
            ));
        }
    }
}

/// Public wrapper: reboot a running OpenBricx device into the ROM serial
/// bootloader and return the name of the resulting download port. Used by the
/// `reboot_to_bootloader` command so the frontend (esptool-js over Web Serial)
/// can then flash it — mirroring the original MochiBridge "Enter Flash Mode".
pub fn reboot_to_download_mode(port_name: &str) -> Result<String> {
    let before = port_names();
    enter_download_mode(port_name, &before)
}

// ── Bootloader connect (with retry) ───────────────────────────────────────────

/// Resolve the USB descriptor info for a port name (vid/pid/etc), defaulting to
/// zeros if the port isn't a USB port or has vanished.
fn usb_info_for(port_name: &str) -> UsbPortInfo {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.port_name == port_name)
        .and_then(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(info) => Some(info),
            _ => None,
        })
        .unwrap_or(UsbPortInfo {
            vid: 0,
            pid: 0,
            serial_number: None,
            manufacturer: None,
            product: None,
        })
}

/// First Espressif (VID 0x303A) serial port currently present, if any. Used as a
/// fallback when a download port re-enumerates under a different COM name between
/// the time we detected it and the time espflash tries to open it.
fn first_espressif_port() -> Option<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .find(|p| matches!(&p.port_type, serialport::SerialPortType::UsbPort(i) if i.vid == 0x303A))
        .map(|p| p.port_name)
}

/// Opens the port and connects espflash to the ROM bootloader, trying each reset
/// strategy in `strategies` in turn. A freshly enumerated USB-Serial/JTAG download
/// port (produced by the auto-DFU reboot) often isn't ready on the first try —
/// Windows is still wiring up the driver, so the open succeeds but the initial
/// sync gets no reply. We retry, re-resolving the port each attempt in case the
/// COM name shifted, and fall back across reset strategies.
fn connect_flasher(
    port_name: &str,
    strategies: &[ResetBeforeOperation],
    app: &AppHandle,
    ui_port: &str,
) -> Result<Flasher> {
    let mut last_err: Option<anyhow::Error> = None;

    for (attempt, &before_op) in strategies.iter().enumerate() {
        if attempt > 0 {
            sleep(Duration::from_millis(700));
        }

        // The download port can re-enumerate under a new name; if the one we were
        // given is gone, fall back to whatever Espressif port is present.
        let name = if port_names().contains(port_name) {
            port_name.to_string()
        } else if let Some(p) = first_espressif_port() {
            p
        } else {
            port_name.to_string()
        };

        let usb_info = usb_info_for(&name);

        let port = match serialport::new(&name, 115_200)
            .timeout(Duration::from_secs(10))
            .open_native()
        {
            Ok(p) => p,
            Err(e) => {
                last_err = Some(anyhow!("cannot open {name}: {e}"));
                continue;
            }
        };

        emit(app, ui_port, "connecting", 15 + attempt as u32 * 2);

        match Flasher::connect(
            port,
            usb_info,
            None,                           // speed — use default 115200
            true,                           // use_stub
            true,                           // verify
            false,                          // skip
            None,                           // chip — auto-detect
            ResetAfterOperation::HardReset, // hard-reset device after flash
            before_op,
        ) {
            Ok(f) => return Ok(f),
            Err(e) => last_err = Some(anyhow!("{e}")),
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow!("could not connect to the ROM bootloader")))
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Flashes a raw merged `.bin` image to a device.
///
/// Assumes the binary is a merged image (bootloader + partition table + app)
/// starting at address 0x0000 — the format produced by `esptool.py merge_bin`
/// and "Export Compiled Binary" in Arduino IDE.
///
/// For ESP32-S3 SuperMini and other Espressif native-USB devices (VID 0x303A)
/// the USB reset sequence is used automatically.  For UART-to-USB adapters
/// (e.g. CP2102, CH340) the standard DTR/RTS reset is used.
///
/// When `auto_dfu` is set the device is first rebooted into the ROM bootloader by
/// touching its CDC port at 1200 baud and sending the OBX `DFU` command (see
/// `enter_download_mode`). This lets a *running* OpenBricx device be re-flashed
/// without the user pressing BOOT+RESET. It requires firmware new enough to honour
/// the touch; on older firmware (or a blank chip) leave it off and use the manual
/// button sequence.
///
/// Progress is streamed via `obx://flash-progress` Tauri events:
/// `{ port, stage: "preparing" | "connecting" | "erasing" | "flashing" | "done", percent: 0..100 }`
pub fn flash_firmware(
    port_name: String,
    firmware_path: &Path,
    auto_dfu: bool,
    app: AppHandle,
) -> Result<()> {
    let firmware = std::fs::read(firmware_path)
        .map_err(|e| anyhow!("cannot read firmware file: {e}"))?;

    // Progress is reported against the port the user selected, even if the device
    // re-enumerates under a different COM name in download mode.
    let ui_port = port_name.clone();

    // Optionally reboot a running device into the ROM bootloader first.
    let port_name = if auto_dfu {
        emit(&app, &ui_port, "preparing", 0);
        let before = port_names();
        let dl_port = enter_download_mode(&port_name, &before)?;
        emit(&app, &ui_port, "preparing", 10);
        dl_port
    } else {
        port_name
    };

    emit(&app, &ui_port, "connecting", 0);

    // Reset strategies to try, in order, when connecting to the ROM:
    //  - auto_dfu already rebooted the chip into download mode (via the RTC
    //    FORCE_DOWNLOAD_BOOT bit, which survives a reset). Try `NoReset` first —
    //    just sync, no re-enumeration — then fall back to `UsbReset`, the proper
    //    reset for a USB-Serial/JTAG port (it re-enters download cleanly because
    //    the RTC bit persists). This mirrors esptool, which connects to a JTAG
    //    download port via its USB reset sequence.
    //  - Espressif native-USB devices (VID 0x303A) not yet in download mode need
    //    a USB reset to enter the ROM.
    //  - Everything else (CP210x, CH340, …) uses the default DTR/RTS reset.
    let strategies: Vec<ResetBeforeOperation> = if auto_dfu {
        vec![
            ResetBeforeOperation::NoReset,
            ResetBeforeOperation::NoReset,
            ResetBeforeOperation::UsbReset,
            ResetBeforeOperation::UsbReset,
            ResetBeforeOperation::NoReset,
        ]
    } else if usb_info_for(&port_name).vid == 0x303A {
        vec![ResetBeforeOperation::UsbReset; 3]
    } else {
        vec![ResetBeforeOperation::DefaultReset; 3]
    };

    // Connect with retry — a just-enumerated download port can need a few tries.
    let mut flasher = connect_flasher(&port_name, &strategies, &app, &ui_port).map_err(|e| {
        if auto_dfu {
            anyhow!(
                "device entered download mode but the bootloader didn't respond: {e}. \
                 Unplug and replug the USB cable, then try again."
            )
        } else {
            anyhow!("cannot connect to bootloader (hold BOOT then press RESET, then retry): {e}")
        }
    })?;

    emit(&app, &ui_port, "erasing", 25);

    let mut reporter = Reporter {
        app: app.clone(),
        port: ui_port.clone(),
        total: 0,
    };

    flasher
        .write_bin_to_flash(0x0000, &firmware, Some(&mut reporter))
        .map_err(|e| anyhow!("flash failed: {e}"))?;

    // reporter.finish() is called by espflash internally, so the "done" event
    // is already emitted via ProgressCallbacks::finish.
    Ok(())
}
