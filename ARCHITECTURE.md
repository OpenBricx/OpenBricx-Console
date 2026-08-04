# OpenBricx Console — Architecture

A single cross-platform application (Windows, macOS, Linux, Android, iOS) that serves the entire OpenBricx hardware ecosystem. One install, one home screen, one shared toolkit — every product (Deck, Pixels, OpenBricx Mods, and whatever comes next) lives inside it as a self-contained plugin.

This is the reference document for contributors. Read the *Core Principle* and the *Device Handshake Protocol* sections before adding firmware or a plugin — almost every integration mistake traces back to skipping one of them.

---

## Core Principle

**Plugins live in the frontend and never touch Rust or a transport directly.**

A plugin is handed a typed `Connection` and stays completely ignorant of whether bytes are moving over USB serial, BLE, or WiFi. That ignorance is the whole design: it is what lets us add or change transports later without editing a single plugin, and what keeps each product's code small enough that one person can own it.

If you find a plugin importing a serial library, opening a socket, or calling a privileged Tauri command that isn't part of the core SDK, that's a bug in the layering — push it down into the core.

---

## Platform Support

The app shell and all plugin UIs run identically everywhere. The hardware-facing features do not — and that split is deliberate, not a limitation we're fighting.

| Capability         | Windows | macOS | Linux | Android | iOS |
| ------------------ | :-----: | :---: | :---: | :-----: | :-: |
| Plugin UIs         |   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| WiFi control       |   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| BLE control        |   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| **WiFi OTA update**|   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| Serial control     |   ✅    |  ✅   |  ✅   |   ❌¹   | ❌  |
| **USB cold flash** |   ✅    |  ✅   |  ✅   |   ❌¹   | ❌² |

¹ Android USB serial is *technically* possible via the USB-Host API plus a native plugin and an OTG cable, but it is **out of scope for V1** by project decision.
² iOS exposes no generic USB-serial access to apps (only MFi-certified hardware), so USB flashing is impossible on the platform — no framework or Tauri trick changes this.

The consequence that shapes everything below: **the flasher is desktop-only, and every device must support WiFi OTA from its first firmware build.** Cold flash gets a blank chip running once (on a desktop, over USB); after that, every platform — including iPhones — updates the same device wirelessly over HTTP.

---

## Layered Architecture

Three layers, top to bottom. Privilege and platform-specificity increase as you go down; product knowledge decreases.

### 1. Rust Host (`src-tauri`)

Owns everything privileged and platform-specific, and exposes it as a uniform Tauri command + event surface. The frontend never sees a COM port or a socket — only a `Device` and a `Connection`.

- **Transports** — serial (`serialport`), BLE (`btleplug`), WiFi (TCP/WebSocket). Each implements the same internal trait so the command layer treats them identically.
- **Flasher** — wraps `espflash` (the Rust-native esptool; links in as a library, no bundled Python). Compiled and exposed on desktop targets only.
- **Discovery** — mDNS browse + BLE scan + serial port enumeration, normalized into one `DiscoveredDevice` stream.
- **OTA** — pushes a firmware binary to a device's HTTP update endpoint. Plain HTTP, so it works from every platform.

### 2. Frontend Core (`src/core`, `src/ui`, `src/launcher`)

The SDK every plugin is built on:

- **`core/`** — thin typed clients wrapping the Tauri IPC: `transport`, `devices`, `flasher`, `ota`. This is the *only* gateway plugins use to reach hardware.
- **`ui/`** — the shared kit (`@openbricx/ui`): the PCB-dark theme, the device picker, the connection-status widget, common controls. Plugins compose these so the whole app feels like one product.
- **`launcher/`** — the home screen and the plugin registry. Lists installed plugins, reflects connected devices, and routes the user into the right plugin.

### 3. Plugins (`src/plugins/*`)

Each product is a self-contained module exporting three things:

- a **manifest** (its product ID, display name, icon, supported transports),
- a **root component** (its UI, handed a live `Connection`),
- a **driver** (the product-specific protocol — the only place that knows the actual bytes).

The driver sits on top of the generic `Connection`; the transport just moves whatever the driver encodes.

---

## The Transport Abstraction

This is the seam that makes the whole thing work. A plugin asks the core to connect to a device and receives a `Connection`. That's the entire contract.

```ts
type TransportKind = 'serial' | 'ble' | 'wifi';

interface Transport {
  readonly kind: TransportKind;
  connect(target: DeviceTarget): Promise<Connection>;
}

interface Connection {
  send(data: Uint8Array): Promise<void>;
  onMessage(cb: (data: Uint8Array) => void): Unsubscribe;
  readonly status: 'connected' | 'reconnecting' | 'closed';
  onStatusChange(cb: (s: Connection['status']) => void): Unsubscribe;
  close(): Promise<void>;
}
```

A **driver** wraps a `Connection` and exposes a product-shaped API. It is the only code that encodes/decodes protocol bytes, and it never learns which transport it's on:

```ts
class DeckDriver {
  constructor(private conn: Connection) {}

  setButton(index: number, action: Action): Promise<void> {
    return this.conn.send(encodeSetButton(index, action));
  }

  onButtonPress(cb: (index: number) => void): Unsubscribe {
    return this.conn.onMessage((data) => {
      const evt = decodeEvent(data);
      if (evt.type === 'press') cb(evt.index);
    });
  }
}
```

Want USB and BLE and WiFi support for the Deck? You already have it — the driver doesn't change. Only the transport the core hands you differs.

---

## Repository Layout

```
openbricx-console/
├─ src-tauri/                 # Rust host — privileged, platform-specific
│  └─ src/
│     ├─ transport/
│     │  ├─ serial.rs
│     │  ├─ ble.rs
│     │  └─ wifi.rs
│     ├─ flasher.rs           # espflash wrapper (desktop targets only)
│     ├─ discovery.rs         # mDNS + BLE scan + port enumeration
│     ├─ ota.rs               # HTTP push to device OTA endpoint
│     └─ commands.rs          # the Tauri command surface
│
├─ src/                       # Frontend
│  ├─ core/                   # IPC clients: transport, devices, flasher, ota
│  ├─ ui/                     # shared kit + theme  (@openbricx/ui)
│  ├─ launcher/               # home screen + plugin registry
│  └─ plugins/
│     ├─ deck/
│     │  ├─ manifest.ts
│     │  ├─ index.tsx         # root component
│     │  └─ driver.ts
│     ├─ pixels/
│     │  ├─ manifest.ts
│     │  ├─ index.tsx
│     │  └─ driver.ts
│     └─ mods/
│        ├─ manifest.ts
│        ├─ index.tsx
│        └─ driver.ts
│
└─ registry.ts                # lists installed plugins
```

---

## Device Handshake Protocol

**This is the glue that makes the single-app experience feel automatic.** Standardize it across *all* firmware now and you get auto-routing, correct OTA targeting, and capability-gated UIs for free. Skip it and every one of those becomes a manual, fragile mess.

On connection — over any transport — the firmware announces itself with the same JSON payload. Only the *delivery mechanism* differs per transport; the payload is identical.

### The Payload

```json
{
  "obx": 1,
  "product": "openbricx-deck",
  "deviceId": "obx-deck-3c71bf2a",
  "fwVersion": "1.2.0",
  "chip": "esp32-c3",
  "name": "Living Room Deck",
  "hwRev": "v1",
  "transports": ["wifi", "ble", "serial"],
  "capabilities": {
    "buttons": 12,
    "argb": { "channels": 1, "maxLeds": 60 },
    "ota": true
  }
}
```

| Field          | Type        | Required | Purpose                                                                                  |
| -------------- | ----------- | :------: | ---------------------------------------------------------------------------------------- |
| `obx`          | integer     |   yes    | Handshake schema version. Bump on any breaking change so the app can adapt or reject.    |
| `product`      | string      |   yes    | Machine product ID. **The launcher's routing key** — must equal a plugin manifest's `product`. |
| `deviceId`     | string      |   yes    | Stable unique ID (derive from MAC). Used for reconnect, multi-device, and remembering devices. |
| `fwVersion`    | string      |   yes    | Running firmware, semver. Compared against the latest available to decide if an OTA is offered. |
| `chip`         | string      |   yes    | ESP variant (`esp32-c3`, `esp32-s3`, …). Drives OTA binary targeting and the flasher.    |
| `name`         | string      |   rec.   | Human-friendly, user-settable label shown in the UI.                                     |
| `hwRev`        | string      |   rec.   | Hardware revision (`v1`, `v2`). Affects which OTA binary a device accepts.               |
| `transports`   | string[]    |   rec.   | Transports the device supports. Lets the app offer WiFi OTA even while connected over serial. |
| `capabilities` | object      |   opt.   | Product-namespaced bag. **The core ignores it; the owning plugin interprets it** to gate features. |

The five required fields are universal and the core relies on them. Everything inside `capabilities` is the plugin's private contract with its own firmware — add whatever that product needs there without touching the core.

### Per-Transport Exposure

**Serial.** Request/response, to avoid racing the boot log.

1. Host opens the port (115200 8N1) and waits ~100 ms for boot output to settle.
2. Host sends `OBX-WHO\n`.
3. Firmware replies with exactly one line: `OBX-HELLO <json>\n`.

The `OBX-HELLO ` sentinel lets the parser pick the handshake out of an otherwise noisy serial stream — anything not carrying the sentinel is treated as a log line.

**BLE.** Discovery in the advertisement, full handshake in a characteristic.

- Advertise a fixed **Info Service UUID** so scanners can filter to OpenBricx devices *without connecting*.
- Put `product` and a short `deviceId` in the advertisement's **Service Data** so the launcher can list and identify a device before any connection.
- On connect, the host reads the **Info Characteristic**, which returns the full handshake JSON as UTF-8.

```
Info Service UUID         0bc10000-1bad-c0de-0001-0a1b2c3d4e5f
Info Characteristic (R)   0bc10001-1bad-c0de-0001-0a1b2c3d4e5f
```

> Generate your own 128-bit UUIDs once with `uuidgen` and freeze them forever — the bytes above are placeholders. Keep the handshake under ~400 bytes so it fits in a single MTU-extended read; if a product genuinely needs more, trim `capabilities` or chunk the read.

**WiFi.** Lightweight discovery via mDNS, full handshake over HTTP.

- Advertise the DNS-SD service type **`_openbricx._tcp.local`** with TXT records carrying a subset of fields for LAN discovery and identification without connecting:

  ```
  product=openbricx-deck
  id=obx-deck-3c71bf2a
  fw=1.2.0
  chip=esp32-c3
  hw=v1
  ```

- Serve the canonical full handshake at **`GET /obx/info`** → the JSON payload above.
- OTA lives alongside it at **`POST /obx/ota`** (see below).

### Lifecycle: Discover → Identify → Route → Connect → Update

1. **Discover** — the core surfaces devices from each transport's announce mechanism (serial `OBX-HELLO`, BLE service data, mDNS TXT).
2. **Identify** — read `product` + `deviceId`.
3. **Route** — the launcher opens the plugin whose manifest `product` matches, or surfaces it on the home screen ("Deck detected → Open Deck").
4. **Connect** — the chosen plugin receives a live `Connection` over whichever transport the user/app selected.
5. **Update** — the app compares `fwVersion` against the latest binary for this `product` + `chip` + `hwRev` and offers an OTA. Because OTA is HTTP over WiFi, this step works on **every** platform, iOS included.

---

## Flashing & OTA

Two distinct operations, often confused:

**Cold flash** gets a blank or bricked chip running for the first time. It uses `espflash` over USB and is **desktop-only**. The UI must gate the flash action so it appears only on a desktop build with a serial device present — never show it on mobile, where it cannot work.

**OTA update** replaces firmware on a device that is already running and on the network. The app `POST`s the new binary to `/obx/ota`; the device writes it to the inactive OTA partition (`esp_ota_ops`), validates it, and reboots, with rollback on failure. This is the normal update path for end users and runs on all five platforms.

**Firmware requirement, from day one:** ship with an OTA-capable partition table (two app/OTA partitions). This is a build-time decision baked into the device's first flash — it **cannot** be retrofitted to a unit already in the field without a desktop cold reflash. Every OpenBricx firmware image must include it.

---

## Adding a New Plugin

For a standard product, this requires **no Rust and no core changes**:

1. Create `src/plugins/<name>/` with `manifest.ts`, `index.tsx`, and `driver.ts`.
2. In the manifest, declare the product ID (it **must** match the firmware's handshake `product`), a display name, an icon, and the transports the product speaks.
3. In the driver, wrap the `Connection` and encode/decode your product's protocol — this is the only place protocol bytes live.
4. Build the UI in `index.tsx` using `@openbricx/ui` so it matches the rest of the app, and have it talk only through the driver.
5. Register the plugin in `registry.ts`.
6. Make sure the firmware emits a matching handshake (`product` equal to your plugin's product ID) over every transport it supports.

```ts
interface PluginManifest {
  product: string;            // MUST equal the firmware handshake `product`
  name: string;               // shown in the launcher
  icon: string;
  transports: TransportKind[]; // which transports this product speaks
}

interface Plugin {
  manifest: PluginManifest;
  Root: React.ComponentType<{ connection: Connection }>;
  createDriver(conn: Connection): Driver;
}
```

---

## Design Decisions (and What We Deferred)

- **Desktop-only flasher + day-1 WiFi OTA.** USB flashing can't work on iOS and is descoped on Android for V1, so rather than chase per-platform serial, the first flash happens on a desktop and everything after is wireless. This makes mobile — iOS especially — a first-class control and update client instead of dead weight.
- **Build-time plugin modules, not runtime loading.** Tauri compiles plugins in; it can't safely load arbitrary native plugins at runtime. So "plugin" is a frontend-module convention over a shared core. The module boundaries are drawn now so that the bigger lift below stays possible.
- **One handshake schema for all transports.** Identical payload, transport-specific delivery. This single decision buys auto-routing, OTA targeting, and capability-gating across the whole ecosystem.

**Now implemented: signed dynamic plugins.** First-party plugins can be downloaded and loaded at runtime without rebuilding the app. Each `.obxplugin` bundle is Ed25519-signed; the Rust host verifies the signature against an embedded publisher key, serves the verified files over an `obxplugin://` protocol, and the frontend dynamically imports them through a shared host SDK (`window.__OPENBRICX__`) so they share the app's React. See [docs/plugins-publishing.md](docs/plugins-publishing.md). This keeps the build-time convention for in-tree products while adding a safe download path on top.

**Still deferred (not V1):** a true sandbox for *untrusted third-party* plugins (e.g. WASM or per-plugin command capability tokens) — today a loaded plugin is first-party-trusted by signature — and Android USB serial flashing via a native USB-Host plugin. Both remain compatible with this architecture.
