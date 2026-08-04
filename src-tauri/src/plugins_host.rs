//! Signed plugin verification.
//!
//! A downloaded plugin bundle (`.obxplugin`, a zip) unpacks to a directory holding
//! `manifest.json`, the built `plugin.mjs`, optional `assets/`, and
//! `manifest.json.sig` — a detached Ed25519 signature over the *exact bytes* of
//! `manifest.json`.
//!
//! `manifest.json` lists a SHA-256 for every other file in the bundle, so one
//! signature over the manifest transitively authenticates all of the plugin's
//! code: tamper with `plugin.mjs` and its hash stops matching before the module is
//! ever loaded.
//!
//! Verification lives in the Rust host on purpose. It runs in the privileged,
//! harder-to-tamper layer, and the frontend only ever loads plugin code from a
//! directory this module has already vouched for (see the `obxplugin://` protocol,
//! added with the loader). Bytes off the network are written to disk and verified
//! here *before* any `import()` touches them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Trusted publisher public keys (raw 32-byte Ed25519), newest first.
///
/// An array so a key can be rotated without bricking installs signed by the
/// previous one: add the new key at the front, keep the old one until every
/// published bundle has been re-signed, then drop it.
///
/// Mint your production key with `npm run plugin:keygen` — it prints the exact
/// literal to paste here and writes the private key to `.plugin-keys/` (gitignored;
/// move it into a CI secret). The all-zero placeholder below is not a valid key and
/// verifies nothing, so the loader is fail-closed until a real key is pasted in.
const TRUSTED_KEYS: &[[u8; 32]] = &[
    // OBX_PLUGIN_PUBLIC_KEY (minted 2026-06-28; private key in .plugin-keys/private.pem).
    [0xb3, 0x0e, 0x26, 0xda, 0x17, 0xb7, 0x02, 0xe9, 0x3f, 0x16, 0x84, 0xe8, 0xc7, 0xdb, 0x1b, 0x5a,
     0x96, 0x88, 0x42, 0xd6, 0x0c, 0x92, 0x1f, 0x9c, 0x80, 0x1d, 0xce, 0x23, 0x56, 0x2e, 0x6c, 0xc9],
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// Routing key — must equal the firmware handshake `product`, and be unique.
    pub product: String,
    pub name: String,
    pub icon: String,
    pub transports: Vec<String>,
    /// Bundle version (semver).
    pub version: String,
    /// Minimum Console version this plugin supports (semver).
    pub min_app_version: String,
    /// Coarse host capabilities the plugin requests, surfaced to the user at
    /// install time. The host SDK is the real boundary; this is for disclosure.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Relative file path -> lowercase hex SHA-256. Covers every bundle file
    /// except `manifest.json` (the signed object itself) and `manifest.json.sig`.
    pub files: BTreeMap<String, String>,
}

#[derive(Debug)]
pub enum VerifyError {
    Io(std::io::Error),
    Json(serde_json::Error),
    /// The `.sig` file is not a well-formed 64-byte Ed25519 signature.
    MalformedSignature,
    /// The signature did not verify against any trusted key.
    UntrustedSignature,
    /// A file listed in the manifest is missing or unreadable.
    MissingFile(String),
    /// A bundle file's contents don't match the hash the manifest committed to.
    HashMismatch(String),
    /// A manifest path escapes the bundle directory (`..` or absolute).
    UnsafePath(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Io(e) => write!(f, "i/o error reading bundle: {e}"),
            VerifyError::Json(e) => write!(f, "malformed manifest.json: {e}"),
            VerifyError::MalformedSignature => write!(f, "manifest.json.sig is not a valid signature"),
            VerifyError::UntrustedSignature => {
                write!(f, "signature does not match any trusted publisher key")
            }
            VerifyError::MissingFile(p) => write!(f, "bundle is missing file listed in manifest: {p}"),
            VerifyError::HashMismatch(p) => write!(f, "bundle file has been tampered with: {p}"),
            VerifyError::UnsafePath(p) => write!(f, "manifest references an unsafe path: {p}"),
        }
    }
}

impl std::error::Error for VerifyError {}

impl From<std::io::Error> for VerifyError {
    fn from(e: std::io::Error) -> Self {
        VerifyError::Io(e)
    }
}

impl From<serde_json::Error> for VerifyError {
    fn from(e: serde_json::Error) -> Self {
        VerifyError::Json(e)
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Verify a detached signature over `manifest_bytes` against any of `keys`.
fn verify_signature_with(
    keys: &[[u8; 32]],
    manifest_bytes: &[u8],
    sig_bytes: &[u8],
) -> Result<(), VerifyError> {
    let sig = Signature::from_slice(sig_bytes).map_err(|_| VerifyError::MalformedSignature)?;
    for key in keys {
        if let Ok(vk) = VerifyingKey::from_bytes(key) {
            if vk.verify(manifest_bytes, &sig).is_ok() {
                return Ok(());
            }
        }
    }
    Err(VerifyError::UntrustedSignature)
}

/// Verify a detached Ed25519 signature over `data` against the embedded trusted
/// publisher keys. Shared with the firmware pipeline (`firmware_host.rs`) so both
/// catalogs — plugins and firmware — hang off the same root of trust.
pub(crate) fn verify_signed_bytes(data: &[u8], sig: &[u8]) -> Result<(), VerifyError> {
    verify_signature_with(TRUSTED_KEYS, data, sig)
}

/// Verify an unpacked bundle directory against `keys` and return its manifest.
///
/// Order matters: the signature is checked first (cheap, and it's the trust gate),
/// then the manifest is parsed, then every file it commits to is hashed. A caller
/// that gets `Ok` may load `plugin.mjs` from `dir`; anything else must be discarded.
pub fn verify_bundle_dir_with(
    dir: &Path,
    keys: &[[u8; 32]],
) -> Result<PluginManifest, VerifyError> {
    let manifest_bytes = std::fs::read(dir.join("manifest.json"))?;
    let sig_bytes = std::fs::read(dir.join("manifest.json.sig"))?;
    verify_signature_with(keys, &manifest_bytes, &sig_bytes)?;

    let manifest: PluginManifest = serde_json::from_slice(&manifest_bytes)?;

    for (rel, expected) in &manifest.files {
        // A signed manifest is trusted, but a path that escapes the bundle dir
        // could still make us read (and later serve) an arbitrary file. Reject it.
        if rel.contains("..") || Path::new(rel).is_absolute() {
            return Err(VerifyError::UnsafePath(rel.clone()));
        }
        let data = std::fs::read(dir.join(rel)).map_err(|_| VerifyError::MissingFile(rel.clone()))?;
        if !sha256_hex(&data).eq_ignore_ascii_case(expected) {
            return Err(VerifyError::HashMismatch(rel.clone()));
        }
    }

    Ok(manifest)
}

/// Verify an unpacked bundle directory against the embedded trusted keys.
pub fn verify_bundle_dir(dir: &Path) -> Result<PluginManifest, VerifyError> {
    verify_bundle_dir_with(dir, TRUSTED_KEYS)
}

/// Verify a plugin bundle directory and return its manifest, or an error string.
///
/// Thin command wrapper over [`verify_bundle_dir`] for the frontend / manual
/// testing. The install + load commands (later steps) build on the same core.
#[tauri::command]
pub fn verify_plugin_bundle(dir: String) -> Result<PluginManifest, String> {
    verify_bundle_dir(Path::new(&dir)).map_err(|e| e.to_string())
}

// ── Installed-plugin store + asset serving ───────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    /// URL the frontend dynamically `import()`s. Served by the `obxplugin://`
    /// handler below, only from this plugin's already-verified directory.
    pub entry_url: String,
}

/// Directory holding verified, installed plugins: `<app_data>/plugins/`. Each
/// plugin lives in a subdirectory named after its `product`.
pub fn plugins_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins"))
}

/// The URL the webview imports a plugin's entry from.
///
/// Custom-scheme URLs differ by platform: Windows/Android serve them as
/// `http://<scheme>.localhost/…`, elsewhere as `<scheme>://…`. We always put the
/// product as the *first path segment* (host is just `localhost`), so
/// [`split_request`] parses every platform's form identically.
fn plugin_entry_url(product: &str) -> String {
    #[cfg(windows)]
    {
        format!("http://obxplugin.localhost/{product}/plugin.mjs")
    }
    #[cfg(not(windows))]
    {
        format!("obxplugin://localhost/{product}/plugin.mjs")
    }
}

/// Split an `obxplugin` request path into `(product, relative-path)`. Works for both
/// `http://obxplugin.localhost/<product>/<rel>` (Windows) and
/// `obxplugin://localhost/<product>/<rel>` because the product is always the first
/// path segment.
fn split_request(path: &str) -> (String, String) {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let product = parts.next().unwrap_or("").to_string();
    let rel = parts.next().unwrap_or("").to_string();
    (product, rel)
}

/// Map an `obxplugin` request to a file under `root`, refusing anything that would
/// escape the plugin's own directory. Both segments are untrusted, so `..`,
/// absolute paths, and empty segments are all rejected.
pub fn resolve_asset(root: &Path, product: &str, rel: &str) -> Result<PathBuf, VerifyError> {
    let rel = rel.trim_start_matches('/');
    for seg in [product, rel] {
        if seg.is_empty() || seg.contains("..") || Path::new(seg).is_absolute() {
            return Err(VerifyError::UnsafePath(format!("{product}/{rel}")));
        }
    }
    Ok(root.join(product).join(rel))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("mjs") | Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// List installed plugins whose bundle currently verifies. A directory that fails
/// verification (tampered, signed with an untrusted key) is skipped, never
/// surfaced — so the frontend can only ever import code that passed
/// [`verify_bundle_dir`].
#[tauri::command]
pub fn list_installed_plugins(app: tauri::AppHandle) -> Vec<InstalledPlugin> {
    let mut out = Vec::new();
    let Ok(root) = plugins_root(&app) else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        // Skip non-dirs and internal/hidden dirs like `.staging`.
        let hidden = dir
            .file_name()
            .and_then(|n| n.to_str())
            .map_or(true, |n| n.starts_with('.'));
        if !dir.is_dir() || hidden {
            continue;
        }
        match verify_bundle_dir(&dir) {
            Ok(manifest) => {
                let entry_url = plugin_entry_url(&manifest.product);
                out.push(InstalledPlugin { manifest, entry_url });
            }
            Err(e) => eprintln!("skipping unverified plugin {}: {e}", dir.display()),
        }
    }
    out
}

/// `obxplugin://` URI-scheme handler — serves files only from installed plugin
/// directories. The bytes here were verified at install/list time; this handler is
/// the *only* way the webview can fetch plugin code, and it never touches the
/// network. Combined with `withGlobalTauri: false`, a loaded plugin gets the host
/// SDK and nothing else.
pub fn serve_asset<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::Response;
    // The webview is served from a *different* origin (`tauri.localhost`) than this
    // scheme (`obxplugin.localhost`), and ES modules are always fetched in CORS
    // mode — so without an `Access-Control-Allow-Origin` header the `import()` is
    // blocked and the plugin silently never loads. The bytes are already verified
    // and served only from local plugin dirs, so `*` is safe here.
    let not_found = || {
        Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };

    let Ok(root) = plugins_root(ctx.app_handle()) else {
        return not_found();
    };
    let (product, rel) = split_request(request.uri().path());
    let path = match resolve_asset(&root, &product, &rel) {
        Ok(p) => p,
        Err(_) => return not_found(),
    };
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("Content-Type", content_type(&path))
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => not_found(),
    }
}

// ── Install / uninstall ───────────────────────────────────────────────────────

#[derive(Debug)]
pub enum InstallError {
    Io(std::io::Error),
    Zip(String),
    /// A zip entry path escapes the bundle (`..` or absolute).
    UnsafeEntry(String),
    Verify(VerifyError),
    Http(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Io(e) => write!(f, "i/o error: {e}"),
            InstallError::Zip(e) => write!(f, "not a valid plugin archive: {e}"),
            InstallError::UnsafeEntry(p) => write!(f, "archive entry escapes the bundle: {p}"),
            InstallError::Verify(e) => write!(f, "{e}"),
            InstallError::Http(e) => write!(f, "download failed: {e}"),
        }
    }
}

impl std::error::Error for InstallError {}
impl From<std::io::Error> for InstallError {
    fn from(e: std::io::Error) -> Self {
        InstallError::Io(e)
    }
}
impl From<VerifyError> for InstallError {
    fn from(e: VerifyError) -> Self {
        InstallError::Verify(e)
    }
}

/// Install a `.obxplugin` archive (held in memory) into `root`, trusting `keys`.
///
/// The archive is extracted to a staging dir, verified there, and only then moved
/// into place at `root/<product>/` — so a bad bundle never half-installs over a
/// good one, and unverified code never lands in a directory the loader scans.
pub fn install_from_zip_with(
    zip_bytes: &[u8],
    root: &Path,
    keys: &[[u8; 32]],
) -> Result<PluginManifest, InstallError> {
    let staging = root.join(".staging").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&staging)?;

    let outcome = (|| -> Result<PluginManifest, InstallError> {
        let reader = std::io::Cursor::new(zip_bytes);
        let mut archive = zip::ZipArchive::new(reader).map_err(|e| InstallError::Zip(e.to_string()))?;

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| InstallError::Zip(e.to_string()))?;
            let name = entry.name().to_string();
            // Guard against zip-slip before touching the filesystem.
            if name.contains("..")
                || name.starts_with('/')
                || name.starts_with('\\')
                || Path::new(&name).is_absolute()
            {
                return Err(InstallError::UnsafeEntry(name));
            }
            let out = staging.join(&name);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
            } else {
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut f = std::fs::File::create(&out)?;
                std::io::copy(&mut entry, &mut f)?;
            }
        }

        // The trust gate: only a fully-verified bundle proceeds to install.
        let manifest = verify_bundle_dir_with(&staging, keys)?;

        let dest = root.join(&manifest.product);
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        std::fs::rename(&staging, &dest)?;
        Ok(manifest)
    })();

    if outcome.is_err() {
        std::fs::remove_dir_all(&staging).ok();
    }
    outcome
}

/// Install using the embedded trusted keys.
pub fn install_from_zip(zip_bytes: &[u8], root: &Path) -> Result<PluginManifest, InstallError> {
    install_from_zip_with(zip_bytes, root, TRUSTED_KEYS)
}

/// Download a `.obxplugin` from `url`, verify it, and install it. Returns the
/// verified manifest. The download is unprivileged HTTP; trust comes entirely from
/// the signature check inside [`install_from_zip`], not from the source URL.
#[tauri::command]
pub async fn install_plugin(app: tauri::AppHandle, url: String) -> Result<PluginManifest, String> {
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let root = plugins_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        install_from_zip(bytes.as_ref(), &root).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove an installed plugin by product id.
#[tauri::command]
pub fn uninstall_plugin(app: tauri::AppHandle, product: String) -> Result<(), String> {
    if product.is_empty()
        || product.contains("..")
        || product.contains('/')
        || product.contains('\\')
    {
        return Err(format!("invalid product id: {product}"));
    }
    let dir = plugins_root(&app)?.join(&product);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Catalog ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub product: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub min_app_version: String,
    #[serde(default)]
    pub description: String,
    /// Direct download URL for the `.obxplugin`.
    pub url: String,
    /// Optional SHA-256 of the `.obxplugin` (integrity hint; the bundle's own
    /// signature is the authoritative gate).
    #[serde(default)]
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalog {
    #[serde(default)]
    pub schema: u32,
    pub plugins: Vec<CatalogEntry>,
}

/// Fetch a signed catalog from `url` (with its detached `.sig` at `<url>.sig`),
/// verify the signature against the trusted keys, and return it parsed.
///
/// Signing the catalog stops a compromised mirror from advertising a malicious
/// download URL or rolling a plugin back to a vulnerable version.
#[tauri::command]
pub async fn fetch_catalog(url: String) -> Result<Catalog, String> {
    let client = reqwest::Client::new();
    let fetch = |u: String| {
        let client = client.clone();
        async move {
            client
                .get(&u)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map_err(|e| e.to_string())
        }
    };

    let catalog_bytes = fetch(url.clone()).await?;
    let sig_bytes = fetch(format!("{url}.sig")).await?;
    verify_signature_with(TRUSTED_KEYS, &catalog_bytes, &sig_bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&catalog_bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Build a minimal signed bundle in a fresh temp dir and return (dir, pubkey).
    fn make_bundle(seed: [u8; 32]) -> (std::path::PathBuf, [u8; 32]) {
        let sk = SigningKey::from_bytes(&seed);
        let vk = sk.verifying_key();

        let dir = std::env::temp_dir().join(format!("obx-plugin-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let code = b"export const manifest = {}; export function Root() {}\n";
        std::fs::write(dir.join("plugin.mjs"), code).unwrap();

        // Manifest commits to the code's hash; sign the manifest's exact bytes.
        let manifest = format!(
            r#"{{"product":"openbricx-test","name":"Test","icon":"x","transports":["wifi"],"version":"1.0.0","minAppVersion":"0.1.0","capabilities":["telemetry"],"files":{{"plugin.mjs":"{}"}}}}"#,
            sha256_hex(code)
        );
        std::fs::write(dir.join("manifest.json"), &manifest).unwrap();
        let sig = sk.sign(manifest.as_bytes());
        std::fs::write(dir.join("manifest.json.sig"), sig.to_bytes()).unwrap();

        (dir, vk.to_bytes())
    }

    #[test]
    fn accepts_a_correctly_signed_bundle() {
        let (dir, key) = make_bundle([7u8; 32]);
        let m = verify_bundle_dir_with(&dir, &[key]).expect("should verify");
        assert_eq!(m.product, "openbricx-test");
        assert_eq!(m.version, "1.0.0");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_an_untrusted_key() {
        let (dir, _key) = make_bundle([7u8; 32]);
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key().to_bytes();
        let err = verify_bundle_dir_with(&dir, &[other]).unwrap_err();
        assert!(matches!(err, VerifyError::UntrustedSignature));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_tampered_code() {
        let (dir, key) = make_bundle([7u8; 32]);
        // Swap the code after signing — hash no longer matches the manifest.
        std::fs::write(dir.join("plugin.mjs"), b"export function Root() { steal(); }\n").unwrap();
        let err = verify_bundle_dir_with(&dir, &[key]).unwrap_err();
        assert!(matches!(err, VerifyError::HashMismatch(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_tampered_manifest() {
        let (dir, key) = make_bundle([7u8; 32]);
        // Rewrite the manifest (e.g. to add a capability) without re-signing.
        let tampered = std::fs::read_to_string(dir.join("manifest.json"))
            .unwrap()
            .replace("\"telemetry\"", "\"telemetry\",\"files\"");
        std::fs::write(dir.join("manifest.json"), tampered).unwrap();
        let err = verify_bundle_dir_with(&dir, &[key]).unwrap_err();
        // Either the signature fails or the JSON no longer parses — both reject.
        assert!(matches!(
            err,
            VerifyError::UntrustedSignature | VerifyError::Json(_)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_path_traversal_in_manifest() {
        let sk = SigningKey::from_bytes(&[5u8; 32]);
        let vk = sk.verifying_key();
        let dir = std::env::temp_dir().join(format!("obx-plugin-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = r#"{"product":"x","name":"x","icon":"x","transports":[],"version":"1.0.0","minAppVersion":"0.1.0","files":{"../../evil.js":"00"}}"#;
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
        std::fs::write(dir.join("manifest.json.sig"), sk.sign(manifest.as_bytes()).to_bytes()).unwrap();
        let err = verify_bundle_dir_with(&dir, &[vk.to_bytes()]).unwrap_err();
        assert!(matches!(err, VerifyError::UnsafePath(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_request_finds_product_in_path() {
        // Both platform URL forms reduce to the same path → first segment = product.
        assert_eq!(
            split_request("/openbricx-hello/plugin.mjs"),
            ("openbricx-hello".into(), "plugin.mjs".into())
        );
        assert_eq!(
            split_request("/openbricx-hello/assets/x.css"),
            ("openbricx-hello".into(), "assets/x.css".into())
        );
        assert_eq!(split_request("/"), (String::new(), String::new()));
    }

    #[test]
    fn resolve_asset_stays_inside_the_bundle() {
        let root = Path::new("/plugins");

        let ok = resolve_asset(root, "openbricx-hello", "plugin.mjs").unwrap();
        assert!(ok.starts_with(root));
        assert!(ok.ends_with("plugin.mjs"));

        // Traversal / absolute / empty segments are all rejected.
        assert!(resolve_asset(root, "openbricx-hello", "../../secret").is_err());
        assert!(resolve_asset(root, "..", "plugin.mjs").is_err());
        assert!(resolve_asset(root, "openbricx-hello", "").is_err());
        assert!(resolve_asset(root, "", "plugin.mjs").is_err());
    }

    fn zip_bundle(manifest: &str, sig: &[u8], code: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("manifest.json", opts).unwrap();
            zw.write_all(manifest.as_bytes()).unwrap();
            zw.start_file("manifest.json.sig", opts).unwrap();
            zw.write_all(sig).unwrap();
            zw.start_file("plugin.mjs", opts).unwrap();
            zw.write_all(code).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn installs_a_signed_zip_and_rejects_a_tampered_one() {
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let key = sk.verifying_key().to_bytes();
        let code = b"export function Root(){}\n";
        let manifest = format!(
            r#"{{"product":"openbricx-zip","name":"Zip","icon":"x","transports":["wifi"],"version":"1.0.0","minAppVersion":"0.1.0","files":{{"plugin.mjs":"{}"}}}}"#,
            sha256_hex(code)
        );
        let sig = sk.sign(manifest.as_bytes()).to_bytes();

        let root = std::env::temp_dir().join(format!("obx-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        // Good archive installs and the installed copy re-verifies.
        let good = zip_bundle(&manifest, &sig, code);
        let m = install_from_zip_with(&good, &root, &[key]).expect("install");
        assert_eq!(m.product, "openbricx-zip");
        let dest = root.join("openbricx-zip");
        assert!(dest.join("plugin.mjs").exists());
        verify_bundle_dir_with(&dest, &[key]).expect("installed bundle verifies");

        // Tampered archive (code swapped, not re-signed) is rejected, and nothing
        // is left in the staging area.
        let bad = zip_bundle(&manifest, &sig, b"HACKED");
        assert!(install_from_zip_with(&bad, &root, &[key]).is_err());
        assert!(!root.join(".staging").exists() || std::fs::read_dir(root.join(".staging")).unwrap().next().is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_zip_slip() {
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let key = sk.verifying_key().to_bytes();
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("../escape.js", opts).unwrap();
            zw.write_all(b"pwned").unwrap();
            zw.finish().unwrap();
        }
        let root = std::env::temp_dir().join(format!("obx-slip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(matches!(
            install_from_zip_with(&buf, &root, &[key]),
            Err(InstallError::UnsafeEntry(_))
        ));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verifies_a_signed_catalog() {
        let sk = SigningKey::from_bytes(&[4u8; 32]);
        let key = sk.verifying_key().to_bytes();
        let catalog = br#"{"schema":1,"plugins":[{"product":"p","name":"P","version":"1.0.0","url":"https://x/y.obxplugin"}]}"#;
        let sig = sk.sign(catalog).to_bytes();

        verify_signature_with(&[key], catalog, &sig).expect("catalog verifies");
        let parsed: Catalog = serde_json::from_slice(catalog).unwrap();
        assert_eq!(parsed.plugins.len(), 1);
        assert_eq!(parsed.plugins[0].product, "p");

        let other = SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes();
        assert!(verify_signature_with(&[other], catalog, &sig).is_err());
    }

    /// End-to-end on the real artifact: install an actual `.obxplugin` built by
    /// `npm run plugin:build`. Skips unless the env vars are set; run with:
    ///   OBX_TEST_PUBKEY_B64=<key> OBX_TEST_OBXPLUGIN=<file> cargo test install_real -- --nocapture
    #[test]
    fn install_real_obxplugin() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let (Ok(key_b64), Ok(file)) = (
            std::env::var("OBX_TEST_PUBKEY_B64"),
            std::env::var("OBX_TEST_OBXPLUGIN"),
        ) else {
            eprintln!("install_real test skipped (OBX_TEST_PUBKEY_B64 / OBX_TEST_OBXPLUGIN unset)");
            return;
        };
        let key: [u8; 32] = STANDARD.decode(key_b64.trim()).unwrap().try_into().unwrap();
        let bytes = std::fs::read(&file).unwrap();
        let root = std::env::temp_dir().join(format!("obx-real-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let m = install_from_zip_with(&bytes, &root, &[key]).expect("real .obxplugin installs");
        eprintln!("install_real OK: {} v{} -> {}", m.product, m.version, root.display());
        assert!(root.join(&m.product).join("plugin.mjs").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    /// Cross-language proof: verify a bundle produced by `scripts/sign-plugin.mjs`.
    /// Skips silently unless the env vars are set, so normal `cargo test` and CI are
    /// unaffected. Run it with:
    ///   OBX_TEST_PUBKEY_B64=<key>  OBX_TEST_BUNDLE_DIR=<dir>  cargo test interop -- --nocapture
    #[test]
    fn interop_node_signed_bundle() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let (Ok(key_b64), Ok(dir)) = (
            std::env::var("OBX_TEST_PUBKEY_B64"),
            std::env::var("OBX_TEST_BUNDLE_DIR"),
        ) else {
            eprintln!("interop test skipped (OBX_TEST_PUBKEY_B64 / OBX_TEST_BUNDLE_DIR unset)");
            return;
        };
        let raw = STANDARD.decode(key_b64.trim()).expect("pubkey base64");
        let key: [u8; 32] = raw.try_into().expect("pubkey must be 32 bytes");
        let m = verify_bundle_dir_with(Path::new(&dir), &[key]).expect("node-signed bundle should verify");
        eprintln!("interop OK: verified {} v{}", m.product, m.version);
    }
}
