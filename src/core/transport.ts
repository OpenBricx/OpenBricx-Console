import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Connection, Unsubscribe } from './types';

// Shared base for the Tauri-backed transports. The status listener is attached
// in the CONSTRUCTOR, not lazily in onStatusChange(): a closed event that fires
// before any page subscribes must still flip `status`, or a plugin mounted later
// reads a stale 'connected' and polls a dead link forever. A rejected send()
// also marks the link closed — the Rust side removes dead connections from its
// map, so "connection not found" is the reliable death signal.
abstract class TauriConnection implements Connection {
  private _status: Connection['status'] = 'connected';
  private readonly statusCbs = new Set<(s: Connection['status']) => void>();
  private readonly unlistenMsg: Promise<() => void>;
  private readonly unlistenStatus: Promise<() => void>;
  private readonly msgCbs = new Set<(data: Uint8Array) => void>();

  constructor(protected readonly connectionId: string) {
    this.unlistenMsg = listen<{ connectionId: string; data: number[] }>('obx://message', (e) => {
      if (e.payload.connectionId === this.connectionId) {
        const bytes = new Uint8Array(e.payload.data);
        for (const cb of this.msgCbs) cb(bytes);
      }
    });
    this.unlistenStatus = listen<{ connectionId: string; status: Connection['status'] }>(
      'obx://status',
      (e) => {
        if (e.payload.connectionId === this.connectionId) this.setStatus(e.payload.status);
      },
    );
  }

  get status(): Connection['status'] {
    return this._status;
  }

  private setStatus(s: Connection['status']) {
    if (this._status === s) return;
    this._status = s;
    for (const cb of this.statusCbs) cb(s);
  }

  async send(data: Uint8Array): Promise<void> {
    try {
      await invoke('send', { connectionId: this.connectionId, data: Array.from(data) });
    } catch (e) {
      this.setStatus('closed');
      throw e;
    }
  }

  onMessage(cb: (data: Uint8Array) => void): Unsubscribe {
    this.msgCbs.add(cb);
    return () => { this.msgCbs.delete(cb); };
  }

  onStatusChange(cb: (s: Connection['status']) => void): Unsubscribe {
    this.statusCbs.add(cb);
    return () => { this.statusCbs.delete(cb); };
  }

  protected async teardown(): Promise<void> {
    this.setStatus('closed');
    this.msgCbs.clear();
    this.statusCbs.clear();
    (await this.unlistenMsg)();
    (await this.unlistenStatus)();
  }

  abstract close(): Promise<void>;
}

export class WifiConnection extends TauriConnection {
  async close(): Promise<void> {
    await invoke('disconnect', { connectionId: this.connectionId }).catch(() => {});
    await this.teardown();
  }
}

export async function connectWifi(deviceId: string): Promise<WifiConnection> {
  const connectionId: string = await invoke('connect_wifi', { deviceId });
  return new WifiConnection(connectionId);
}

// ── Serial ────────────────────────────────────────────────────────────────────

export interface SerialPortInfo {
  name: string;
  description: string | null;
  vid: number | null;
  pid: number | null;
}

export class SerialConnection extends TauriConnection {
  async close(): Promise<void> {
    await invoke('disconnect_serial', { connectionId: this.connectionId }).catch(() => {});
    await this.teardown();
  }
}

export async function connectSerial(
  portName: string,
): Promise<{ connection: SerialConnection; handshake: import('./types').DeviceHandshake }> {
  const result = await invoke<{ connectionId: string; handshake: import('./types').DeviceHandshake }>(
    'connect_serial',
    { portName },
  );
  return { connection: new SerialConnection(result.connectionId), handshake: result.handshake };
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke('list_serial_ports');
}

// ── BLE ─────────────────────────────────────────────────────────────────────

export interface BleDeviceInfo {
  /** Opaque peripheral id — pass to connectBle(). */
  id: string;
  name: string;
}

export class BleConnection extends TauriConnection {
  async close(): Promise<void> {
    await invoke('disconnect_ble', { connectionId: this.connectionId }).catch(() => {});
    await this.teardown();
  }
}

/** Begin scanning for OpenBricx BLE peripherals (idempotent). */
export async function startBleScan(): Promise<void> {
  await invoke('start_ble_scan');
}

/** Stop the BLE scan (radio housekeeping when leaving the devices page). */
export async function stopBleScan(): Promise<void> {
  await invoke('stop_ble_scan').catch(() => {});
}

/** Snapshot of currently-advertising OpenBricx peripherals. */
export async function listBleDevices(): Promise<BleDeviceInfo[]> {
  return invoke('list_ble_devices');
}

export async function connectBle(
  deviceId: string,
): Promise<{ connection: BleConnection; handshake: import('./types').DeviceHandshake }> {
  // connect_ble runs the OBX-WHO/OBX-HELLO handshake over NUS, so we learn the
  // product before picking a plugin — exactly like serial.
  const result = await invoke<{ connectionId: string; handshake: import('./types').DeviceHandshake }>(
    'connect_ble',
    { deviceId },
  );
  return { connection: new BleConnection(result.connectionId), handshake: result.handshake };
}

// ── Offline (no device) ───────────────────────────────────────────────────────

/**
 * A stub connection that satisfies the Connection interface without a device.
 * send() silently drops data; status is permanently 'closed'.
 * This lets plugins launch their UI for configuration / browsing even when
 * no hardware is attached.
 */
export class OfflineConnection implements Connection {
  get status(): Connection['status'] {
    return 'closed';
  }

  async send(_data: Uint8Array): Promise<void> {
    // No device — silently drop.
  }

  onMessage(_cb: (data: Uint8Array) => void): Unsubscribe {
    return () => {};
  }

  onStatusChange(_cb: (s: Connection['status']) => void): Unsubscribe {
    return () => {};
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
