# OpenBricx Console — Plugin Linking Exception

## Additional permission under GNU GPL version 3, section 7

The OpenBricx Console is licensed under the GNU General Public License v3.0
(see [`LICENSE`](LICENSE)). As a special exception, the copyright holder grants
the following additional permission:

> **You may link, load, or combine a Plugin with the OpenBricx Console, and
> distribute that Plugin under terms of your choice — including proprietary,
> closed-source terms — without the Plugin being considered a derivative work
> of the OpenBricx Console for the purposes of the GPL.**

### Definitions

**"Plugin"** means a distributable bundle that:

1. is loaded at runtime by the Console's plugin loader
   (`src-tauri/src/plugins_host.rs`); **and**
2. interacts with the Console solely through the documented plugin SDK
   boundary — the modules under `src/host/` and `plugin-sdk/`, exposed to
   plugins at runtime as `window.__OPENBRICX__`; **and**
3. does not incorporate Console source code from outside that boundary.

### What this exception does *not* permit

This exception applies only to Plugins as defined above. It does **not** grant
permission to:

- distribute a modified OpenBricx Console itself under non-GPL terms;
- copy Console source code from outside the SDK boundary into a closed-source
  work;
- remove or weaken the Ed25519 signature verification in
  `src-tauri/src/plugins_host.rs` and distribute the result as the
  OpenBricx Console.

Everything not covered by this exception remains governed by the GPL-3.0.

### Why this exists

The Console is a device-agnostic host: it moves bytes over serial/BLE/Wi-Fi,
verifies signatures, and flashes chips. Product-specific behaviour lives in
plugins. Making the SDK boundary explicitly non-copyleft means anyone can build
and ship a plugin for their own hardware on their own terms, which is the point
of the plugin architecture.

### Trademarks

This exception, and the GPL itself, concern **copyright only**. "OpenBricx" and
the OpenBricx logo are trademarks of the project owner and are not licensed by
the GPL or by this exception. You may distribute modified versions of this
software, but not under the OpenBricx name or branding.
