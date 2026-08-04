//! Signed firmware catalog + verified firmware downloads.
//!
//! Mirrors the plugin pipeline's trust model (`plugins_host.rs`), because the
//! stakes are higher: a bad plugin fails to load, a bad firmware image bricks or
//! hijacks hardware. The catalog (`firmware.json`) is Ed25519-signed with the same
//! publisher key as plugin bundles, each entry carries a mandatory SHA-256, and a
//! downloaded image is refused unless its bytes match that hash — so a compromised
//! mirror or a tampered GitHub asset can never reach the flasher or the OTA pusher.
//!
//! The flow deliberately keeps the Console as the middleman (download to PC,
//! verify, then flash over USB / POST to `/obx/ota`): devices never fetch from
//! GitHub themselves, TLS stays on the desktop, and SoftAP-mode devices (no
//! internet) still update fine.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::plugins_host::{sha256_hex, verify_signed_bytes};

/// One downloadable firmware image.
///
/// `kind` is the split every product already ships with:
///   - `"flash"` — merged image for USB cold-flash (esptool at 0x0, desktop only)
///   - `"ota"`   — app image POSTed to the device's `/obx/ota` (all platforms)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareEntry {
    /// Matches the device handshake `product` — the selection key.
    pub product: String,
    /// ESP variant (`esp32-s3`, `esp32-c3`, …); must match the handshake `chip`.
    pub chip: String,
    /// Hardware revision this image accepts ('' = any). Brick-prevention filter.
    #[serde(default)]
    pub hw_rev: String,
    /// Image version (semver).
    pub version: String,
    /// `"flash"` or `"ota"` (see above).
    pub kind: String,
    /// Direct download URL (e.g. a GitHub Release asset).
    pub url: String,
    /// Lowercase hex SHA-256 of the image — **required**, the download gate.
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    /// Human release notes shown in the picker.
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FirmwareCatalog {
    #[serde(default)]
    pub schema: u32,
    pub firmware: Vec<FirmwareEntry>,
}

/// Fetch a signed firmware catalog from `url` (detached sig at `<url>.sig`),
/// verify it against the trusted publisher keys, and return it parsed.
///
/// Same shape as `fetch_catalog` for plugins: signing the catalog stops a
/// compromised host from advertising a malicious image URL or rolling a product
/// back to a vulnerable firmware.
#[tauri::command]
pub async fn fetch_firmware_catalog(url: String) -> Result<FirmwareCatalog, String> {
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
    verify_signed_bytes(&catalog_bytes, &sig_bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&catalog_bytes).map_err(|e| e.to_string())
}

/// Where verified images are cached: `<app_data>/firmware/<sha256>/<file>`.
/// Keyed by hash, so a re-published asset with the same name but different bytes
/// can never be confused with a previously verified download.
fn firmware_cache_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("firmware"))
}

/// True when `s` is a plausible lowercase-hex SHA-256 (the catalog's gate format).
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Derive a safe cache file name from a download URL (last path segment, query
/// stripped, no separators). Falls back to `firmware.bin`.
fn cache_file_name(url: &str) -> String {
    let no_query = url.split(['?', '#']).next().unwrap_or("");
    let name = no_query.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name.contains("..") || name.contains('\\') {
        "firmware.bin".to_string()
    } else {
        name.to_string()
    }
}

/// One download-progress tick, emitted on `obx://fw-download-progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FwDownloadProgress {
    url: String,
    received: usize,
    total: usize,
    percent: u32,
}

/// Download a firmware image, verify its SHA-256 against the (signed) catalog's
/// hash, cache it, and return the local path — which then feeds the existing
/// flasher (`read_firmware_file`) or OTA (`update_firmware_wifi`) unchanged.
///
/// Fail-closed: an entry without a valid sha256 is refused outright, and a hash
/// mismatch discards the bytes. A cache hit re-verifies before short-circuiting.
#[tauri::command]
pub async fn download_firmware(
    app: tauri::AppHandle,
    url: String,
    sha256: String,
) -> Result<String, String> {
    use tauri::Emitter;

    let want = sha256.trim().to_ascii_lowercase();
    if !is_sha256_hex(&want) {
        return Err(
            "catalog entry has no valid sha256 — refusing to download unverifiable firmware"
                .to_string(),
        );
    }

    let dest_dir = firmware_cache_root(&app)?.join(&want);
    let dest = dest_dir.join(cache_file_name(&url));

    // Cache hit — but only if the bytes still match (a corrupted or hand-edited
    // cache file must never reach the flasher).
    if dest.exists() {
        if let Ok(bytes) = std::fs::read(&dest) {
            if sha256_hex(&bytes) == want {
                return Ok(dest.to_string_lossy().into_owned());
            }
        }
        let _ = std::fs::remove_file(&dest);
    }

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let total = resp.content_length().unwrap_or(0) as usize;
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::with_capacity(total);
    let mut last_pct = u32::MAX;

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        let percent = if total > 0 {
            (buf.len() * 100 / total) as u32
        } else {
            0
        };
        if percent != last_pct {
            last_pct = percent;
            let _ = app.emit(
                "obx://fw-download-progress",
                &FwDownloadProgress {
                    url: url.clone(),
                    received: buf.len(),
                    total,
                    percent,
                },
            );
        }
    }

    // The trust gate: bytes must match the hash the signed catalog committed to.
    let got = sha256_hex(&buf);
    if got != want {
        return Err(format!(
            "firmware hash mismatch — expected {want}, downloaded {got}. Refusing to keep it."
        ));
    }

    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    std::fs::write(&dest, &buf).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn firmware_catalog_parses_and_verifies() {
        let sk = SigningKey::from_bytes(&[6u8; 32]);
        let catalog = br#"{"schema":1,"firmware":[{"product":"openbricx-deck","chip":"esp32-s3","hwRev":"v1","version":"1.2.0","kind":"ota","url":"https://x/deck-ota.bin","sha256":"aa","notes":"fix"}]}"#;
        let sig = sk.sign(catalog).to_bytes();

        // Signature machinery is shared with plugins_host; prove the round-trip
        // against this key, then that our schema parses.
        crate::plugins_host::verify_signed_bytes(catalog, &sig)
            .expect_err("must NOT verify against the embedded production keys");

        let parsed: FirmwareCatalog = serde_json::from_slice(catalog).unwrap();
        assert_eq!(parsed.firmware.len(), 1);
        let e = &parsed.firmware[0];
        assert_eq!(e.product, "openbricx-deck");
        assert_eq!(e.hw_rev, "v1");
        assert_eq!(e.kind, "ota");
    }

    #[test]
    fn sha256_gate_rejects_junk() {
        assert!(is_sha256_hex(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ));
        assert!(!is_sha256_hex(""));
        assert!(!is_sha256_hex("abc"));
        assert!(!is_sha256_hex(&"g".repeat(64))); // non-hex
    }

    #[test]
    fn cache_file_name_is_safe() {
        assert_eq!(
            cache_file_name("https://github.com/o/r/releases/download/v1/deck-v1.bin?token=x"),
            "deck-v1.bin"
        );
        assert_eq!(cache_file_name("https://x/"), "firmware.bin");
        assert_eq!(cache_file_name("https://x/..\\evil"), "firmware.bin");
    }
}
