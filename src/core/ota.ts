import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Core OTA client — the only gateway plugins use to push firmware
// (ARCHITECTURE.md: plugins never call privileged Tauri commands directly).

/** POST a firmware image to a device's /obx/ota endpoint — the device is either
 *  on the LAN (its DHCP IP) or serving its own SoftAP (192.168.4.1). */
export function updateFirmwareWifi(ip: string, path: string): Promise<void> {
  return invoke('update_firmware_wifi', { ip, path });
}

/** Relay a node OTA image through a Pixels hub to one of its nodes. */
export function relayNodeOta(ip: string, mac: string, path: string): Promise<void> {
  return invoke('relay_node_ota', { ip, mac, path });
}

/** Direct-device upload progress (percent 0–100). Resolves to an unlisten fn,
 *  same contract as Tauri's listen(). */
export function onOtaProgress(cb: (percent: number) => void): Promise<() => void> {
  return listen<{ percent: number }>('obx://hub-ota-progress', (e) => cb(e.payload.percent));
}

/** Per-node progress while a Pixels hub relays a node image over ESP-NOW. */
export function onNodeOtaProgress(
  cb: (mac: string, percent: number) => void,
): Promise<() => void> {
  return listen<{ mac: string; percent: number }>('obx://node-ota-progress', (e) =>
    cb(e.payload.mac, e.payload.percent),
  );
}
