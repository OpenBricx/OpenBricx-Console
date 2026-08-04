import type { DiscoveredDevice } from '../core/devices';
import type { SerialPortInfo, BleDeviceInfo } from '../core/transport';
import type { Plugin } from '../core/types';

interface Props {
  plugins: Plugin[];
  devices: Map<string, DiscoveredDevice>;
  onConnect: (plugin: Plugin, deviceId: string) => void;
  serialPorts?: SerialPortInfo[];
  onConnectSerial?: (port: SerialPortInfo) => void;
  bleDevices?: BleDeviceInfo[];
  onConnectBle?: (device: BleDeviceInfo) => void;
}

export function Launcher({
  plugins, devices, onConnect,
  serialPorts = [], onConnectSerial,
  bleDevices = [], onConnectBle,
}: Props) {
  const findPlugin = (product: string): Plugin | undefined =>
    plugins.find((p) => p.manifest.product === product);

  const total = devices.size + serialPorts.length + bleDevices.length;

  return (
    <div className="launcher">
      <header className="app-header">
        <h1>OpenBricx Console</h1>
        <span className="scanning-badge">
          {total === 0 ? 'Scanning…' : `${total} device${total === 1 ? '' : 's'}`}
        </span>
      </header>

      {total === 0 ? (
        <p className="empty-hint">
          Waiting for devices — plug in over USB, pair over Bluetooth, or join the local network…
        </p>
      ) : (
        <div className="device-grid">
          {serialPorts.map((port) => (
            <SerialCard
              key={port.name}
              port={port}
              onConnect={() => onConnectSerial?.(port)}
            />
          ))}
          {bleDevices.map((device) => (
            <BleCard
              key={device.id}
              device={device}
              onConnect={() => onConnectBle?.(device)}
            />
          ))}
          {Array.from(devices.values()).map((device) => {
            const plugin = findPlugin(device.product);
            return (
              <DeviceCard
                key={device.deviceId}
                device={device}
                plugin={plugin}
                onConnect={() => plugin && onConnect(plugin, device.deviceId)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SerialCardProps {
  port: SerialPortInfo;
  onConnect: () => void;
}

// A USB serial port. We don't know the product until the handshake runs on
// connect, so the card shows the USB description and a generic "connect" affordance.
function SerialCard({ port, onConnect }: SerialCardProps) {
  return (
    <div
      className="device-card"
      onClick={onConnect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onConnect()}
    >
      <div className="device-header">
        <span className="device-name">{port.description ?? 'USB Serial Device'}</span>
        <span className="device-transport transport-serial">serial</span>
      </div>
      <div className="device-meta">
        <span>{port.name}</span>
        {port.vid != null && port.pid != null && (
          <span>
            {port.vid.toString(16).padStart(4, '0')}:{port.pid.toString(16).padStart(4, '0')}
          </span>
        )}
      </div>
    </div>
  );
}

interface BleCardProps {
  device: BleDeviceInfo;
  onConnect: () => void;
}

// A BLE peripheral. Like serial, we only know the advertised name until the
// handshake runs on connect, so the card shows the name and a generic affordance.
function BleCard({ device, onConnect }: BleCardProps) {
  return (
    <div
      className="device-card"
      onClick={onConnect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onConnect()}
    >
      <div className="device-header">
        <span className="device-name">{device.name}</span>
        <span className="device-transport transport-ble">ble</span>
      </div>
      <div className="device-meta">
        <span>Bluetooth LE</span>
      </div>
    </div>
  );
}

interface CardProps {
  device: DiscoveredDevice;
  plugin: Plugin | undefined;
  onConnect: () => void;
}

function DeviceCard({ device, plugin, onConnect }: CardProps) {
  const supported = plugin !== undefined;
  return (
    <div
      className={`device-card${supported ? '' : ' device-card--unsupported'}`}
      onClick={supported ? onConnect : undefined}
      role={supported ? 'button' : undefined}
      tabIndex={supported ? 0 : undefined}
      onKeyDown={supported ? (e) => e.key === 'Enter' && onConnect() : undefined}
    >
      <div className="device-header">
        <span className="device-name">{device.name ?? device.deviceId}</span>
        <span className={`device-transport transport-${device.transport}`}>
          {device.transport}
        </span>
      </div>
      <div className="device-meta">
        <span>{plugin ? plugin.manifest.name : device.product}</span>
        <span>{device.fwVersion}</span>
        <span>{device.chip}</span>
        {device.hwRev && <span>{device.hwRev}</span>}
      </div>
      {!supported && (
        <div className="device-unsupported">No plugin installed for this product</div>
      )}
    </div>
  );
}
