pub mod commands;
pub mod deck_host;
pub mod discovery;
pub mod firmware_host;
pub mod flasher;
pub mod ota;
pub mod plugins_host;
pub mod transport;

use commands::{
    connect_ble, connect_serial, connect_wifi, disconnect, disconnect_ble, disconnect_serial,
    flash_firmware, list_ble_devices, list_serial_ports, open_external, read_firmware_file,
    read_text_file, reboot_to_bootloader, relay_node_ota, send, start_ble_scan, start_discovery,
    stop_ble_scan, stop_discovery, update_firmware_wifi, write_text_file,
};
use deck_host::{
    deck_launch_app, deck_now_playing, deck_open_link, deck_system_info, deck_volume,
};
use discovery::AppState;
use firmware_host::{download_firmware, fetch_firmware_catalog};
use plugins_host::{
    fetch_catalog, install_plugin, list_installed_plugins, uninstall_plugin, verify_plugin_bundle,
};

/// Build the system tray: the app keeps running (discovery, telemetry push to a
/// connected Deck) after the window is dismissed, so closing the window hides it
/// instead of exiting. Quit is deliberately ONLY reachable from the tray menu.
#[cfg(desktop)]
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Open Console", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit OpenBricx Console", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("bundle icon").clone())
        .tooltip("OpenBricx Console")
        .menu(&menu)
        // Left click restores the window; the menu is right-click only (the
        // platform convention, and it keeps "Quit" out of accidental reach).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Un-hide + focus the main window. Also un-minimizes: a window hidden while
/// minimized stays minimized when shown again, which reads as "tray click did
/// nothing".
#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            setup_tray(app.handle())?;
            Ok(())
        })
        // Closing the window hides it to the tray rather than exiting, so
        // background work survives. `quit` on the tray menu is the real exit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .register_uri_scheme_protocol("obxplugin", |ctx, req| {
            plugins_host::serve_asset(ctx, req)
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            start_discovery,
            stop_discovery,
            connect_wifi,
            connect_serial,
            disconnect_serial,
            list_serial_ports,
            start_ble_scan,
            stop_ble_scan,
            list_ble_devices,
            connect_ble,
            disconnect_ble,
            send,
            disconnect,
            flash_firmware,
            reboot_to_bootloader,
            read_firmware_file,
            read_text_file,
            write_text_file,
            open_external,
            update_firmware_wifi,
            relay_node_ota,
            deck_system_info,
            deck_now_playing,
            deck_volume,
            deck_launch_app,
            deck_open_link,
            verify_plugin_bundle,
            list_installed_plugins,
            install_plugin,
            uninstall_plugin,
            fetch_catalog,
            fetch_firmware_catalog,
            download_firmware,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
