# Publishing & signing OpenBricx plugins

OpenBricx Console can install plugins downloaded from a URL. Safety rests on **two
independent signatures**, both free:

| Signature | Signs | Protects | Tooling |
| --- | --- | --- | --- |
| **Ed25519 plugin signature** | each `.obxplugin` bundle | the app only loads code *you* published | `npm run plugin:*` + the keypair |
| **Authenticode (SignPath)** | the app installer | Windows/SmartScreen trusts the `.exe` | SignPath Foundation (OSS) |

They are unrelated: the first is the app trusting plugins; the second is the OS
trusting the app. Neither requires a paid Microsoft certificate.

---

## 1. One-time: mint the publisher key

```bash
npm run plugin:keygen
```

This writes `.plugin-keys/` (gitignored) and prints three things:

1. a `[u8; 32]` literal → paste into `TRUSTED_KEYS` in
   [`src-tauri/src/plugins_host.rs`](../src-tauri/src/plugins_host.rs);
2. the base64 public key (for documentation / catalog notes);
3. the base64 PKCS8 **private key** → store as the GitHub Actions secret
   `OBX_PLUGIN_PRIVATE_KEY`. Never commit it.

The embedded public key is the root of trust: the app refuses any bundle not signed
by its matching private key.

### Key rotation

`TRUSTED_KEYS` is an array. To rotate: mint a new key, add it to the **front** of
the array (ship that build), re-sign all published bundles with the new key, then
drop the old key in a later release. Old installs keep working throughout.

---

## 2. Build & sign a plugin

A plugin source dir needs `index.tsx` (exporting `{ manifest, Root, createDriver? }`)
and `manifest.json` (`product`, `name`, `icon`, `transports`, `version`,
`minAppVersion`, `capabilities`). See [`examples/hello-plugin`](../examples/hello-plugin).

```bash
npm run plugin:build examples/hello-plugin
```

This builds `dist/plugin.mjs` (React + `@openbricx/host` externalized to the host
SDK), signs the manifest, and packs `openbricx-hello-1.0.0.obxplugin`.

> Plugins import shared code from `react` and `@openbricx/host` only — never from
> `@tauri-apps/api`. `withGlobalTauri` is off, so a plugin cannot reach raw IPC; it
> gets the curated host SDK on `window.__OPENBRICX__` and nothing else.

---

## 3. Build & sign the catalog

```bash
node scripts/build-catalog.mjs \
  --base-url https://your.host/plugins \
  --out catalog.json \
  examples/hello-plugin
npm run plugin:sign-file catalog.json     # -> catalog.json.sig
```

Host `catalog.json` + `catalog.json.sig` together; the app fetches both and verifies
the signature before showing anything. Users paste the `catalog.json` URL into the
**Plugins** tab.

---

## 4. CI

- [`.github/workflows/publish-plugins.yml`](../.github/workflows/publish-plugins.yml)
  — builds/signs every plugin under `examples/`, builds + signs the catalog, and
  attaches everything to a GitHub Release. Needs only `OBX_PLUGIN_PRIVATE_KEY`.
  Trigger by pushing a `plugins-v*` tag (or run it manually).

- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — builds the
  Windows installer and Authenticode-signs it via SignPath. Configure:
  - secret `SIGNPATH_API_TOKEN`
  - variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`

  For OSS, apply for free signing at <https://signpath.org/>. The signing job is
  skipped until those are set, so the build job is usable immediately.

---

## 5. Runtime hardening (already in place)

In [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json):

- `app.withGlobalTauri: false` — no global `__TAURI__`, so a loaded plugin can't
  call privileged commands directly.
- A CSP whose `script-src` is `'self' obxplugin: http://obxplugin.localhost` — the
  webview can execute app code and **verified local plugin code only**, never a
  remote `<script>`. All network I/O happens in Rust, so `connect-src` is just
  `'self'` + IPC.

> If a build ever shows a blank window, open devtools and check for a CSP violation;
> temporarily set `"csp": null` to confirm, then add the specific source the app
> needs rather than loosening everything.
