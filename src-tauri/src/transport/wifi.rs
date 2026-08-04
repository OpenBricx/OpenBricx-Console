use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

use crate::discovery::{DiscoveredDevice, WifiConnHandle};

const SERVICE_TYPE: &str = "_openbricx._tcp.local.";

#[derive(Debug, Deserialize)]
struct ObxHandshake {
    obx: u32,
    product: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "fwVersion")]
    fw_version: String,
    chip: String,
    name: Option<String>,
    #[serde(rename = "hwRev")]
    hw_rev: Option<String>,
    capabilities: Option<serde_json::Value>,
}

async fn fetch_handshake(host: &str, port: u16) -> Result<ObxHandshake> {
    let client = Client::builder().timeout(Duration::from_secs(5)).build()?;
    let hs = client
        .get(format!("http://{}:{}/obx/info", host, port))
        .send()
        .await?
        .json::<ObxHandshake>()
        .await?;
    if hs.obx < 1 {
        return Err(anyhow!("unsupported handshake schema version {}", hs.obx));
    }
    Ok(hs)
}

pub fn start_browse(
    discovered: Arc<Mutex<HashMap<String, DiscoveredDevice>>>,
    fullname_to_id: Arc<Mutex<HashMap<String, String>>>,
    mdns_daemon: Arc<Mutex<Option<ServiceDaemon>>>,
    app: AppHandle,
) -> Result<()> {
    let daemon = ServiceDaemon::new()?;
    let receiver = daemon.browse(SERVICE_TYPE)?;
    // Replace-don't-leak: a second start (page remount, StrictMode) would
    // otherwise overwrite the slot and orphan the previous daemon's browse
    // thread forever (mdns-sd needs an explicit shutdown()).
    if let Some(old) = mdns_daemon.lock().unwrap().replace(daemon) {
        old.shutdown().ok();
    }

    std::thread::spawn(move || {
        for event in receiver {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let host = info.get_hostname().trim_end_matches('.').to_string();
                    let port = info.get_port();
                    let fullname = info.get_fullname().to_string();
                    let discovered2 = discovered.clone();
                    let fullname_to_id2 = fullname_to_id.clone();
                    let app2 = app.clone();

                    tauri::async_runtime::spawn(async move {
                        match fetch_handshake(&host, port).await {
                            Ok(hs) => {
                                let device = DiscoveredDevice {
                                    device_id: hs.device_id.clone(),
                                    product: hs.product,
                                    fw_version: hs.fw_version,
                                    chip: hs.chip,
                                    hw_rev: hs.hw_rev,
                                    name: hs.name,
                                    host,
                                    port,
                                    transport: "wifi".into(),
                                    capabilities: hs.capabilities,
                                };
                                fullname_to_id2
                                    .lock()
                                    .unwrap()
                                    .insert(fullname, hs.device_id.clone());
                                discovered2
                                    .lock()
                                    .unwrap()
                                    .insert(hs.device_id, device.clone());
                                app2.emit("obx://discovered", &device).ok();
                            }
                            Err(e) => eprintln!("[wifi] handshake failed for {host}:{port}: {e}"),
                        }
                    });
                }
                ServiceEvent::ServiceRemoved(_svc_type, fullname) => {
                    if let Some(device_id) = fullname_to_id.lock().unwrap().remove(&fullname) {
                        discovered.lock().unwrap().remove(&device_id);
                        app.emit(
                            "obx://lost",
                            serde_json::json!({ "deviceId": device_id }),
                        )
                        .ok();
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

pub fn stop_browse(mdns_daemon: Arc<Mutex<Option<ServiceDaemon>>>) -> Result<()> {
    if let Some(daemon) = mdns_daemon.lock().unwrap().take() {
        daemon.shutdown().map_err(|e| anyhow!("{e}"))?;
    }
    Ok(())
}

pub async fn connect(
    device_id: String,
    discovered: Arc<Mutex<HashMap<String, DiscoveredDevice>>>,
    connections: Arc<Mutex<HashMap<String, WifiConnHandle>>>,
    app: AppHandle,
) -> Result<String> {
    let device = discovered
        .lock()
        .unwrap()
        .get(&device_id)
        .cloned()
        .ok_or_else(|| anyhow!("device {device_id} not found in discovered list"))?;

    let url = format!("ws://{}:{}/obx/ws", device.host, device.port);
    let (ws_stream, _) = connect_async(&url)
        .await
        .map_err(|e| anyhow!("WebSocket connect to {url} failed: {e}"))?;

    let connection_id = Uuid::new_v4().to_string();
    let (tx, rx) = unbounded_channel::<Vec<u8>>();
    connections
        .lock()
        .unwrap()
        .insert(connection_id.clone(), WifiConnHandle { tx });

    let conn_id = connection_id.clone();
    tauri::async_runtime::spawn(run_ws(ws_stream, rx, conn_id, app));

    Ok(connection_id)
}

async fn run_ws(
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut rx: UnboundedReceiver<Vec<u8>>,
    connection_id: String,
    app: AppHandle,
) {
    let (mut write, mut read) = stream.split();

    app.emit(
        "obx://status",
        serde_json::json!({ "connectionId": &connection_id, "status": "connected" }),
    )
    .ok();

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        app.emit(
                            "obx://message",
                            serde_json::json!({ "connectionId": &connection_id, "data": data.to_vec() }),
                        ).ok();
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        eprintln!("[wifi] WebSocket error on {connection_id}: {e}");
                        break;
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(data) => {
                        if write.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    let _ = write.close().await;
    app.emit(
        "obx://status",
        serde_json::json!({ "connectionId": &connection_id, "status": "closed" }),
    )
    .ok();
}
