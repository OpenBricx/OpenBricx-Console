// @openbricx/host — the SDK every external OpenBricx plugin builds against.
//
// At plugin *build* time the bundler aliases this module in (see
// vite.plugin.config.ts). At *runtime* it reads the live SDK the Console published
// on `window.__OPENBRICX__`, so the plugin shares the Console's single React
// instance and gets a curated host surface — never raw Tauri IPC.
//
// This file is intentionally standalone (it does not import from the app's `src/`)
// so it can later be extracted into a published `@openbricx/host` npm package.
// That's why the types below are duplicated rather than imported: they are the
// *contract*, and the host-side shape (src/host/types.ts) must keep filling it.

export type TransportKind = 'serial' | 'ble' | 'wifi';
export type Unsubscribe = () => void;

export interface Connection {
  send(data: Uint8Array): Promise<void>;
  onMessage(cb: (data: Uint8Array) => void): Unsubscribe;
  readonly status: 'connected' | 'reconnecting' | 'closed';
  onStatusChange(cb: (s: Connection['status']) => void): Unsubscribe;
  close(): Promise<void>;
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

export interface PluginProps {
  connection: Connection;
  handshake?: DeviceHandshake;
}

// ── Host services ─────────────────────────────────────────────────────────────

export interface HostFileFilter {
  name: string;
  extensions: string[];
}

export interface HostFileDialogOptions {
  title?: string;
  filters?: HostFileFilter[];
  defaultPath?: string;
}

export interface HostDialog {
  /** Native open-file picker (single file). Resolves to a path, or null on cancel. */
  open(opts?: HostFileDialogOptions): Promise<string | null>;
  /** Native save-file picker. Resolves to a path, or null on cancel. */
  save(opts?: HostFileDialogOptions): Promise<string | null>;
}

export interface HostFiles {
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
}

export interface HostOta {
  /** POST a firmware image at `path` to the device's /obx/ota at `ip`. */
  updateFirmwareWifi(ip: string, path: string): Promise<void>;
  /** Upload progress 0–100. Resolves to an unlisten fn. */
  onProgress(cb: (percent: number) => void): Promise<() => void>;
}

export interface HostPc {
  launchApp(path: string): Promise<void>;
  openLink(url: string, browser?: string): Promise<void>;
  /** System master volume 0–100, or -1 when unavailable. */
  getVolume(): Promise<number>;
  getSystemInfo<T>(): Promise<T>;
  getNowPlaying<T>(): Promise<T | null>;
}

/** `"flash"` = merged USB cold-flash image; `"ota"` = app image for /obx/ota. */
export interface FirmwareEntry {
  product: string;
  chip: string;
  hwRev: string;
  version: string;
  kind: 'flash' | 'ota' | string;
  url: string;
  sha256: string;
  size: number;
  notes: string;
}

export interface FirmwareCatalog {
  schema: number;
  firmware: FirmwareEntry[];
}

export interface HostFirmware {
  /** The signed firmware catalog URL baked into this Console build. */
  defaultCatalogUrl: string;
  /** Fetch + signature-verify a catalog (defaults to `defaultCatalogUrl`). */
  fetchCatalog(url?: string): Promise<FirmwareCatalog>;
  /** Download + hash-verify an image; resolves to a local path for `ota`. */
  download(entry: Pick<FirmwareEntry, 'url' | 'sha256'>): Promise<string>;
  onDownloadProgress(cb: (url: string, percent: number) => void): Promise<() => void>;
}

// ── Runtime binding ───────────────────────────────────────────────────────────

interface OpenBricxHostRuntime {
  version: string;
  react: unknown;
  jsxRuntime: unknown;
  dialog?: HostDialog;
  files?: HostFiles;
  ota?: HostOta;
  pcHost?: HostPc;
  firmware?: HostFirmware;
}

const host = (globalThis as { __OPENBRICX__?: OpenBricxHostRuntime }).__OPENBRICX__;
if (!host) {
  throw new Error(
    'OpenBricx host SDK missing — this plugin must run inside OpenBricx Console.',
  );
}

/** Version of the host SDK this plugin is running against. */
export const version: string = host.version;

/** Bind a namespace lazily: a plugin that never touches it loads fine on an older
 *  host; one that does gets a clear "update the Console" error at first use. */
function lazy<T extends object>(name: string, get: () => T | undefined): T {
  return new Proxy({} as T, {
    get(_, prop) {
      const ns = get();
      if (!ns) {
        throw new Error(
          `OpenBricx host SDK ${host!.version} does not provide "${name}" — update OpenBricx Console.`,
        );
      }
      return (ns as Record<PropertyKey, unknown>)[prop];
    },
  });
}

export const dialog: HostDialog = lazy('dialog', () => host!.dialog);
export const files: HostFiles = lazy('files', () => host!.files);
export const ota: HostOta = lazy('ota', () => host!.ota);
export const pcHost: HostPc = lazy('pcHost', () => host!.pcHost);
export const firmware: HostFirmware = lazy('firmware', () => host!.firmware);
