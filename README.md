# OpenBricx Console

One cross-platform app for the whole OpenBricx hardware ecosystem. Every product
— Deck, Pixels, Mods, IR Blaster — lives inside it as a self-contained plugin,
downloaded from a signed catalog rather than baked into the build.

The Console itself knows nothing about any specific product. It moves bytes over
USB serial, BLE, or Wi-Fi; verifies signatures; discovers devices; and flashes
chips. Everything product-specific lives in a plugin.

## Features

- **Device discovery** — mDNS, BLE scan, and serial port enumeration, normalised
  into one device list.
- **Three transports, one API** — plugins receive a typed `Connection` and never
  learn whether it's serial, BLE, or Wi-Fi underneath.
- **Signed plugins** — `.obxplugin` bundles are Ed25519-signed and verified in
  the Rust host before loading. Tampered bundles refuse to load.
- **Cold flash + OTA** — `espflash` over USB on desktop; HTTP OTA over Wi-Fi on
  every platform, including iOS.
- **Runs in the tray** — closing the window keeps the app alive in the
  background so connected devices stay served.

## Platform support

|                     | Windows | macOS | Linux | Android | iOS |
| ------------------- | :-----: | :---: | :---: | :-----: | :-: |
| Plugin UIs          |   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| Wi-Fi / BLE control |   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| Wi-Fi OTA update    |   ✅    |  ✅   |  ✅   |   ✅    | ✅  |
| Serial control      |   ✅    |  ✅   |  ✅   |   ❌    | ❌  |
| USB cold flash      |   ✅    |  ✅   |  ✅   |   ❌    | ❌  |

USB flashing is desktop-only — iOS exposes no generic USB-serial access to apps.
Every device therefore ships Wi-Fi OTA from its first firmware build.

## Building

Requires Node 18+ and a Rust toolchain (1.77.2+), plus the
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform.

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production installer
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layering, the transport
abstraction, and the **device handshake protocol** every OpenBricx firmware
implements. If you're building firmware or a plugin, read the handshake section
first — most integration bugs trace back to skipping it.

## Writing your own firmware

The handshake and line protocol are documented, deliberately. Any device that
answers `OBX-WHO` with a valid `OBX-HELLO` payload works with this Console — you
do not need permission or any of this source code to build compatible hardware.

## License

**GPL-3.0-only**, with a **plugin linking exception**.

The Console itself is copyleft: modified versions must stay open. But plugins
that talk to it only through the documented SDK boundary (`src/host/`,
`plugin-sdk/`) may be released under **any** license, including proprietary.
See [LICENSE](LICENSE) and [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md).

"OpenBricx" and the OpenBricx logo are trademarks and are not licensed by the
GPL or by the exception. Modified builds must not use the OpenBricx name or
branding.
