use std::path::PathBuf;

use tauri::State;

use crate::discovery::AppState;
use crate::flasher;
use crate::transport::{ble, serial, wifi};

// ── WiFi discovery ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn start_discovery(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let s = state.inner();
    wifi::start_browse(
        s.discovered.clone(),
        s.fullname_to_id.clone(),
        s.mdns_daemon.clone(),
        app,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_discovery(state: State<'_, AppState>) -> Result<(), String> {
    wifi::stop_browse(state.inner().mdns_daemon.clone()).map_err(|e| e.to_string())
}

// ── WiFi connect ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect_wifi(
    device_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let s = state.inner();
    wifi::connect(
        device_id,
        s.discovered.clone(),
        s.connections.clone(),
        app,
    )
    .await
    .map_err(|e| e.to_string())
}

// ── Serial ports ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_serial_ports() -> Vec<serial::SerialPortInfo> {
    serial::list_ports()
}

// ── Serial connect ────────────────────────────────────────────────────────────

/// Connects to a serial port, performs the OBX-WHO handshake, and returns a
/// `{ connectionId, handshake }` object.  Runs in a background thread so the
/// blocking I/O doesn't stall the async runtime.
#[tauri::command]
pub async fn connect_serial(
    port_name: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let serial_connections = state.inner().serial_connections.clone();

    // Spawn on a blocking thread because `serialport::open` and the handshake
    // read loop are both synchronous / blocking.
    tauri::async_runtime::spawn_blocking(move || {
        serial::connect(port_name, serial_connections, app)
            .map(|(conn_id, hs)| {
                serde_json::json!({
                    "connectionId": conn_id,
                    "handshake": hs,
                })
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Serial disconnect ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn disconnect_serial(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    serial::disconnect(&connection_id, state.inner().serial_connections.clone());
    Ok(())
}

// ── BLE discovery ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_ble_scan(state: State<'_, AppState>) -> Result<(), String> {
    ble::start_scan(state.inner().ble_central.clone())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_ble_scan(state: State<'_, AppState>) -> Result<(), String> {
    ble::stop_scan(state.inner().ble_central.clone())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_ble_devices(
    state: State<'_, AppState>,
) -> Result<Vec<ble::BleDeviceInfo>, String> {
    ble::list_devices(state.inner().ble_central.clone())
        .await
        .map_err(|e| e.to_string())
}

// ── BLE connect ───────────────────────────────────────────────────────────────

/// Connects to a BLE peripheral over the Nordic UART Service, runs the OBX-WHO
/// handshake, and returns `{ connectionId, handshake }` — same shape as serial.
#[tauri::command]
pub async fn connect_ble(
    device_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let s = state.inner();
    ble::connect(device_id, s.ble_central.clone(), s.ble_connections.clone(), app)
        .await
        .map(|(conn_id, hs)| serde_json::json!({ "connectionId": conn_id, "handshake": hs }))
        .map_err(|e| e.to_string())
}

// ── BLE disconnect ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn disconnect_ble(connection_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ble::disconnect(&connection_id, &state.inner().ble_connections);
    Ok(())
}

// ── Unified send (WiFi + Serial) ──────────────────────────────────────────────

#[tauri::command]
pub fn send(
    connection_id: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Try WiFi first.
    {
        let connections = state.connections.lock().unwrap();
        if let Some(handle) = connections.get(&connection_id) {
            return handle.tx.send(data).map_err(|e| e.to_string());
        }
    }
    // Then BLE.
    {
        let ble_conns = state.ble_connections.lock().unwrap();
        if let Some(handle) = ble_conns.get(&connection_id) {
            return handle.tx.send(data).map_err(|e| e.to_string());
        }
    }
    // Fall through to serial.
    serial::send(&connection_id, data, &state.inner().serial_connections)
}

// ── Unified disconnect (WiFi) ─────────────────────────────────────────────────

#[tauri::command]
pub fn disconnect(connection_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.connections.lock().unwrap().remove(&connection_id);
    Ok(())
}

// ── Reboot to bootloader (for esptool-js / Web Serial flashing) ───────────────

/// Reboots a running OpenBricx device into the ROM serial bootloader (1200-baud
/// touch + OBX `DFU`) and returns the resulting download-port name. The frontend
/// then flashes it with esptool-js over Web Serial — the approach proven in the
/// original MochiBridge companion. Runs on a blocking thread.
#[tauri::command]
pub async fn reboot_to_bootloader(port_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        flasher::reboot_to_download_mode(&port_name).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Read a firmware file (base64) for the frontend flasher ────────────────────

/// Reads a `.bin` file and returns it base64-encoded. The frontend decodes it
/// with `atob()` into the binary string esptool-js expects. base64 keeps the IPC
/// payload compact (vs. a JSON array of 388k byte values).
#[tauri::command]
pub fn read_firmware_file(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

// ── Text file I/O (profile import/export) ─────────────────────────────────────
//
// The webview's `<a download>` / `<input type=file>` tricks don't work reliably in
// the Tauri webview, so the dialog plugin picks a path and these do the actual
// disk I/O. Used by the Deck plugin's profile export/import.

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("cannot write {path}: {e}"))
}

// ── External links ────────────────────────────────────────────────────────────

/// Open a URL in the OS default browser (used by the About page's social links).
/// `window.open` is unreliable inside the Tauri webview, so we hand off to the OS.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("cannot open {url}: {e}"))
}

// ── Wi-Fi firmware OTA ────────────────────────────────────────────────────────

/// One OTA upload-progress tick, emitted on the event named per call site.
/// `mac` is the target node ('' for the hub's own image). Because TCP flow-control
/// throttles the upload to the receiver's write/relay speed, `percent` of bytes
/// sent is a faithful proxy for actual progress.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OtaProgress {
    mac: String,
    sent: usize,
    total: usize,
    percent: u32,
}

/// POST a firmware image to `url`, streaming the body in chunks and emitting an
/// `OtaProgress` on `event` as it goes. Shared by the hub and node-relay OTA.
async fn post_image_with_progress(
    app: &tauri::AppHandle,
    url: &str,
    path: &str,
    event: &str,
    mac: &str,
) -> Result<(), String> {
    use tauri::Emitter;

    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let total = bytes.len();

    // Chunk the body so progress can be reported as it uploads. Vec<u8> chunks
    // are accepted by wrap_stream (Bytes: From<Vec<u8>>), so no extra crate.
    const CHUNK: usize = 4096;
    let chunks: Vec<Vec<u8>> = bytes.chunks(CHUNK).map(|c| c.to_vec()).collect();

    let app2 = app.clone();
    let mac2 = mac.to_string();
    let event2 = event.to_string();
    let mut sent = 0usize;
    let mut last_pct = u32::MAX;
    let stream = futures_util::stream::iter(chunks.into_iter().map(move |chunk| {
        sent += chunk.len();
        let percent = if total == 0 { 100 } else { (sent * 100 / total) as u32 };
        if percent != last_pct {
            last_pct = percent;
            let _ = app2.emit(
                event2.as_str(),
                OtaProgress { mac: mac2.clone(), sent, total, percent },
            );
        }
        Ok::<_, std::io::Error>(chunk)
    }));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header("Content-Type", "application/octet-stream")
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|e| format!("upload to {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("device returned HTTP {}", resp.status()));
    }
    Ok(())
}

/// Push an app image (`firmware.bin`) to a Wi-Fi-provisioned device by POSTing it
/// to `http://<ip>/obx/ota`. The device streams it into its spare OTA slot,
/// validates, and reboots into it. Progress is emitted on `obx://hub-ota-progress`.
#[tauri::command]
pub async fn update_firmware_wifi(
    ip: String,
    path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let url = format!("http://{ip}/obx/ota");
    post_image_with_progress(&app, &url, &path, "obx://hub-ota-progress", "").await
}

/// Relay a node firmware image through the Pixels MAIN (the hub). The Console
/// POSTs the image to `http://<ip>/obx/node-ota?mac=<mac>`; the main streams it
/// chunk-by-chunk over ESP-NOW to that one node (unicast + ack), having verified
/// the node is on-channel and the image's product/hw id match. Update one node at
/// a time — the caller serializes any "update all". Progress is emitted on
/// `obx://node-ota-progress` (carrying the target `mac`).
#[tauri::command]
pub async fn relay_node_ota(
    ip: String,
    mac: String,
    path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let url = format!("http://{ip}/obx/node-ota?mac={mac}");
    post_image_with_progress(&app, &url, &path, "obx://node-ota-progress", &mac).await
}

// ── Flash firmware ────────────────────────────────────────────────────────────

/// Flashes a merged `.bin` firmware image to a device over serial.
///
/// When `auto_dfu` is true the device is first rebooted into the ROM bootloader
/// (1200-baud touch + OBX `DFU`) so a running OpenBricx device can be re-flashed
/// without the manual BOOT+RESET sequence. Requires firmware that honours the
/// touch; leave it off for a blank chip or older firmware.
///
/// Runs on a blocking thread so the async runtime is not stalled.
#[tauri::command]
pub async fn flash_firmware(
    port_name: String,
    firmware_path: String,
    auto_dfu: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = PathBuf::from(firmware_path);
    let auto_dfu = auto_dfu.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        flasher::flash_firmware(port_name, &path, auto_dfu, app).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
