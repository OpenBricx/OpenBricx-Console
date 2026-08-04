import { useEffect, useState } from 'react';
import { useDiscovery } from '../core/devices';
import {
  connectWifi, connectSerial, listSerialPorts, type SerialPortInfo,
  connectBle, listBleDevices, startBleScan, stopBleScan, type BleDeviceInfo,
} from '../core/transport';
import { Launcher } from '../launcher/Launcher';
import type { Connection, Plugin, DeviceHandshake } from '../core/types';

interface Props {
  plugins: Plugin[];
  onEnterPlugin: (plugin: Plugin, connection: Connection, handshake?: DeviceHandshake) => void;
}

type PageState =
  | { kind: 'launcher' }
  | { kind: 'connecting'; label: string }
  | { kind: 'error'; message: string };

// Espressif's USB vendor ID — the Deck enumerates as a native-USB CDC device
// under this VID in app mode, so we surface those ports as connectable cards.
const ESPRESSIF_VID = 0x303a;

// Poll the USB serial ports every 2 s so a Deck plugged in (or DFU-rebooted back
// to app mode) shows up without the user leaving the page.
function useSerialPorts(): SerialPortInfo[] {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const scan = () =>
      listSerialPorts()
        .then((p) => alive && setPorts(p.filter((x) => x.vid === ESPRESSIF_VID)))
        .catch(() => {});
    scan();
    const id = setInterval(scan, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return ports;
}

// Scan for OpenBricx BLE peripherals while the page is mounted, polling the
// snapshot every 2 s (mirrors useSerialPorts). Scanning is stopped on unmount so
// the radio isn't left running. If BLE is unavailable the list just stays empty.
function useBleDevices(): BleDeviceInfo[] {
  const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    startBleScan().catch(() => {});
    const scan = () =>
      listBleDevices()
        .then((d) => alive && setDevices(d))
        .catch(() => {});
    scan();
    const id = setInterval(scan, 2000);
    return () => {
      alive = false;
      clearInterval(id);
      stopBleScan();
    };
  }, []);
  return devices;
}

export function DevicesPage({ plugins, onEnterPlugin }: Props) {
  const devices = useDiscovery();
  const serialPorts = useSerialPorts();
  const bleDevices = useBleDevices();
  const [state, setState] = useState<PageState>({ kind: 'launcher' });

  async function handleConnect(plugin: Plugin, deviceId: string) {
    setState({ kind: 'connecting', label: plugin.manifest.name });
    try {
      const connection = await connectWifi(deviceId);
      // WiFi has no OBX-WHO exchange, but discovery already carries the same
      // identity fields — pass them through so plugins get fwVersion/name/
      // capabilities on WiFi exactly like they do on serial/BLE.
      const d = devices.get(deviceId);
      const handshake = d
        ? {
            obx: 1, product: d.product, deviceId: d.deviceId, fwVersion: d.fwVersion,
            chip: d.chip, name: d.name, hwRev: d.hwRev, capabilities: d.capabilities,
          }
        : undefined;
      onEnterPlugin(plugin, connection, handshake);
    } catch (e) {
      console.error('[DevicesPage] wifi connect failed:', e);
      setState({ kind: 'error', message: `Couldn't connect: ${e}` });
    }
  }

  async function handleConnectSerial(port: SerialPortInfo) {
    setState({ kind: 'connecting', label: port.description ?? port.name });
    try {
      // connectSerial runs the OBX-WHO/OBX-HELLO handshake (and asserts DTR so the
      // firmware accepts the link), so we learn the product before picking a plugin.
      const { connection, handshake } = await connectSerial(port.name);
      const plugin = plugins.find((p) => p.manifest.product === handshake.product);
      if (!plugin) {
        await connection.close().catch(() => {});
        throw new Error(`no plugin installed for "${handshake.product}"`);
      }
      onEnterPlugin(plugin, connection, handshake);
    } catch (e) {
      console.error('[DevicesPage] serial connect failed:', e);
      setState({ kind: 'error', message: `${port.name}: ${e instanceof Error ? e.message : e}` });
    }
  }

  async function handleConnectBle(device: BleDeviceInfo) {
    setState({ kind: 'connecting', label: device.name });
    try {
      // connect_ble runs the OBX-WHO handshake over BLE NUS — same as serial — so
      // we learn the product before picking a plugin.
      const { connection, handshake } = await connectBle(device.id);
      const plugin = plugins.find((p) => p.manifest.product === handshake.product);
      if (!plugin) {
        await connection.close().catch(() => {});
        throw new Error(`no plugin installed for "${handshake.product}"`);
      }
      onEnterPlugin(plugin, connection, handshake);
    } catch (e) {
      console.error('[DevicesPage] ble connect failed:', e);
      setState({ kind: 'error', message: `${device.name}: ${e instanceof Error ? e.message : e}` });
    }
  }

  if (state.kind === 'connecting') {
    return (
      <div className="container center">
        <p className="connecting-text">Connecting to {state.label}…</p>
      </div>
    );
  }

  return (
    <>
      {state.kind === 'error' && (
        <div className="connect-error" role="alert" onClick={() => setState({ kind: 'launcher' })}>
          {state.message} <span className="connect-error-dismiss">✕</span>
        </div>
      )}
      <Launcher
        plugins={plugins}
        devices={devices}
        serialPorts={serialPorts}
        bleDevices={bleDevices}
        onConnect={handleConnect}
        onConnectSerial={handleConnectSerial}
        onConnectBle={handleConnectBle}
      />
    </>
  );
}
