export type TransportKind = 'serial' | 'ble' | 'wifi';

export type Unsubscribe = () => void;

export interface Connection {
  send(data: Uint8Array): Promise<void>;
  onMessage(cb: (data: Uint8Array) => void): Unsubscribe;
  readonly status: 'connected' | 'reconnecting' | 'closed';
  onStatusChange(cb: (s: Connection['status']) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface DeviceTarget {
  deviceId: string;
  transport: TransportKind;
}

export interface DeviceHandshake {
  obx: number;
  product: string;
  deviceId: string;
  fwVersion: string;
  chip: string;
  name?: string;
  hwRev?: string;
  transports?: TransportKind[];
  capabilities?: Record<string, unknown>;
}

export interface PluginManifest {
  product: string;
  name: string;
  icon: string;
  transports: TransportKind[];
}

export interface Plugin {
  manifest: PluginManifest;
  Root: import('react').ComponentType<{ connection: Connection; handshake?: DeviceHandshake }>;
}
