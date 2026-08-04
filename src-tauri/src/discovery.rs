use std::collections::HashMap;
use std::sync::{
    atomic::AtomicBool,
    {Arc, Mutex},
};

use btleplug::platform::Adapter;
use mdns_sd::ServiceDaemon;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredDevice {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub product: String,
    #[serde(rename = "fwVersion")]
    pub fw_version: String,
    pub chip: String,
    #[serde(rename = "hwRev")]
    pub hw_rev: Option<String>,
    pub name: Option<String>,
    pub host: String,
    pub port: u16,
    pub transport: String,
    pub capabilities: Option<serde_json::Value>,
}

pub struct WifiConnHandle {
    pub tx: UnboundedSender<Vec<u8>>,
}

pub struct SerialConnHandle {
    pub tx: UnboundedSender<Vec<u8>>,
    pub stop: Arc<AtomicBool>,
}

pub struct BleConnHandle {
    pub tx: UnboundedSender<Vec<u8>>,
}

pub struct AppState {
    pub discovered: Arc<Mutex<HashMap<String, DiscoveredDevice>>>,
    /// Maps mDNS fullname → deviceId so we can emit `obx://lost` on ServiceRemoved.
    pub fullname_to_id: Arc<Mutex<HashMap<String, String>>>,
    pub connections: Arc<Mutex<HashMap<String, WifiConnHandle>>>,
    pub serial_connections: Arc<Mutex<HashMap<String, SerialConnHandle>>>,
    pub ble_connections: Arc<Mutex<HashMap<String, BleConnHandle>>>,
    /// The BLE adapter, created lazily on first scan and reused for connect.
    pub ble_central: Arc<tokio::sync::Mutex<Option<Adapter>>>,
    pub mdns_daemon: Arc<Mutex<Option<ServiceDaemon>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            discovered: Arc::new(Mutex::new(HashMap::new())),
            fullname_to_id: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            serial_connections: Arc::new(Mutex::new(HashMap::new())),
            ble_connections: Arc::new(Mutex::new(HashMap::new())),
            ble_central: Arc::new(tokio::sync::Mutex::new(None)),
            mdns_daemon: Arc::new(Mutex::new(None)),
        }
    }
}
