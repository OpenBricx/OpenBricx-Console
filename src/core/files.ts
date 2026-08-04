import { invoke } from '@tauri-apps/api/core';

// Core text-file I/O — the webview's `<a download>` / `<input type=file>` tricks
// don't work reliably in Tauri, so the dialog plugin picks a path and these do
// the actual disk I/O (used by profile import/export and exposed to plugins via
// the host SDK).

export function readTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke('write_text_file', { path, contents });
}
