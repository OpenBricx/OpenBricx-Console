// OpenBricx Deck PC-side host — native telemetry + action execution.
//
// These commands replace what the old MochiBridge Rust thread did, but exposed
// as discrete commands the OpenBricx Deck plugin polls and pushes to the device itself.
// Cross-platform safe: Windows-specific telemetry is cfg-gated; other platforms
// return neutral defaults so the plugin still runs (just without live stats).

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sysinfo::System;

// ── Telemetry shapes (camelCase to match the TS interfaces) ───────────────────

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub cpu: u32,
    pub cpu_temp: i32,
    pub ram_used: f32,
    pub ram_total: f32,
    pub gpu: u32,
    pub gpu_temp: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub pos_ms: i64,
    pub dur_ms: i64,
    pub playing: bool,
}

// Persistent System so CPU-usage deltas are correct across polls.
fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

// ── System info ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn deck_system_info() -> SystemInfo {
    let (cpu, ram_used, ram_total) = {
        let mut s = system().lock().unwrap_or_else(|e| e.into_inner());
        s.refresh_cpu_usage();
        s.refresh_memory();
        let gb = |b: u64| b as f32 / 1024.0 / 1024.0 / 1024.0;
        (
            s.global_cpu_usage().round() as u32,
            gb(s.used_memory()),
            gb(s.total_memory()),
        )
    };

    let (gpu, gpu_temp) = gpu_stats();
    SystemInfo {
        cpu,
        cpu_temp: cpu_temp(),
        ram_used,
        ram_total,
        gpu,
        gpu_temp,
    }
}

// ── Now playing ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn deck_now_playing() -> Option<NowPlaying> {
    #[cfg(windows)]
    {
        read_now_playing()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

// ── Master volume (0–100, or -1 if unavailable) ───────────────────────────────

#[tauri::command]
pub fn deck_volume() -> i32 {
    #[cfg(windows)]
    {
        read_volume().unwrap_or(-1)
    }
    #[cfg(not(windows))]
    {
        -1
    }
}

// ── PC actions ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn deck_launch_app(path: String) -> Result<(), String> {
    new_command(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn deck_open_link(url: String, browser: String) -> Result<(), String> {
    match browser.as_str() {
        "chrome" => new_command("chrome").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string()),
        "edge" => new_command("msedge").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string()),
        "firefox" => new_command("firefox").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string()),
        _ => open::that(&url).map_err(|e| e.to_string()),
    }
}

// ── Platform helpers ──────────────────────────────────────────────────────────

/// Build a Command that doesn't flash a console window on Windows (we poll
/// subprocesses for GPU/temp every couple of seconds).
fn new_command(program: &str) -> std::process::Command {
    let cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    {
        cmd
    }
}

/// CPU package temperature in °C. Windows-only via WMI; 0 elsewhere.
fn cpu_temp() -> i32 {
    #[cfg(windows)]
    {
        let out = new_command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace 'root/wmi' -ErrorAction SilentlyContinue).CurrentTemperature | Select-Object -First 1",
            ])
            .output();
        if let Ok(out) = out {
            if let Ok(dk) = String::from_utf8_lossy(&out.stdout).trim().parse::<f64>() {
                // WMI reports deci-Kelvin.
                return ((dk - 2732.0) / 10.0) as i32;
            }
        }
        0
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// GPU utilisation % and temperature °C. Tries nvidia-smi, then a PerfCounter
/// fallback for utilisation. Returns (0, 0) when unavailable.
fn gpu_stats() -> (u32, i32) {
    #[cfg(windows)]
    {
        let nv = new_command("nvidia-smi")
            .args([
                "--query-gpu=utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ])
            .output();
        if let Ok(out) = nv {
            let s = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = s.trim().split(',').collect();
            if parts.len() == 2 {
                let util = parts[0].trim().parse::<u32>().unwrap_or(0);
                let temp = parts[1].trim().parse::<i32>().unwrap_or(0);
                if util != 0 || temp != 0 {
                    return (util, temp);
                }
            }
        }

        // Fallback: sum the 3D engine utilisation counters (no temperature).
        let pc = new_command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.InstanceName -like '*engtype_3D*' } | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum",
            ])
            .output();
        if let Ok(out) = pc {
            let util = String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0);
            return (util.round() as u32, 0);
        }
        (0, 0)
    }
    #[cfg(not(windows))]
    {
        (0, 0)
    }
}

// ── Windows COM telemetry ─────────────────────────────────────────────────────

#[cfg(windows)]
fn read_volume() -> Option<i32> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    unsafe {
        // Repeated init on a thread is harmless (returns S_FALSE / RPC_E_CHANGED_MODE).
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        let scalar = volume.GetMasterVolumeLevelScalar().ok()?;
        Some((scalar * 100.0).round() as i32)
    }
}

#[cfg(windows)]
fn read_now_playing() -> Option<NowPlaying> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    };

    let manager = SessionManager::RequestAsync().ok()?.get().ok()?;
    let session = manager.GetCurrentSession().ok()?;

    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|t| t.to_string()).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let artist = props.Artist().map(|a| a.to_string()).unwrap_or_default();

    let (pos_ms, dur_ms) = match session.GetTimelineProperties() {
        Ok(t) => (
            t.Position().map(|p| p.Duration / 10_000).unwrap_or(0),
            t.EndTime().map(|e| e.Duration / 10_000).unwrap_or(0),
        ),
        Err(_) => (0, 0),
    };

    let playing = session
        .GetPlaybackInfo()
        .ok()
        .and_then(|i| i.PlaybackStatus().ok())
        .map(|s| s == PlaybackStatus::Playing)
        .unwrap_or(false);

    Some(NowPlaying {
        title,
        artist,
        pos_ms,
        dur_ms,
        playing,
    })
}
