// OpenBricx Deck — line protocol codec.
//
// The Deck speaks a newline-delimited ASCII protocol, carried verbatim over the
// transport-agnostic Connection byte channel (serial today, WiFi/BLE later).
// This module is the ONLY place the wire format lives — encode helpers produce
// the exact bytes the firmware parses, and `parseLine` decodes device→host events.
//
// Outgoing (host → device):
//   V<vol>                                  volume 0–100
//   M<prof>:<btn>:<mode>:<val>:<mods>       macro update (non-text modes)
//   T<prof>:<btn>:<text>                    text snippet (MODE_TEXT)
//   Q<idx>:<name>                           profile name
//   P<page>                                 switch active profile
//   S<cpu>:<cTemp>:<rUsed>:<rTotal>:<gpu>:<gTemp>   system stats
//   N<title>|<artist>|<posMs>|<durMs>|<playing>     now playing
//   D<mode>                                 display mode (0=Mochi,1=Stats,2=Idle,3=Overlay)
//   B<1-100>                                backlight brightness %
//   I                                       query firmware version
//   R                                       reboot
//   WIPE                                    wipe NVS config
//
// Incoming (device → host):
//   E<prof>:<btn>      device asks host to run a PC action (launch app / open link)
//   PROF_SYNC:<page>   device changed profile locally (encoder long-press)
//   VER:<version>      firmware version reply to `I`

const enc = new TextEncoder();

/** Encode a single protocol line (without trailing newline) into bytes + `\n`. */
export function line(s: string): Uint8Array {
  return enc.encode(s + '\n');
}

// ── Host → device encoders ────────────────────────────────────────────────────

export const encode = {
  volume: (vol: number) => line(`V${vol | 0}`),

  macro: (prof: number, btn: number, mode: number, val: number, mods: number) =>
    line(`M${prof}:${btn}:${mode}:${val}:${mods}`),

  text: (prof: number, btn: number, text: string) =>
    // Strip newlines so the snippet can't split the protocol frame.
    line(`T${prof}:${btn}:${text.replace(/[\r\n]+/g, ' ')}`),

  profileName: (idx: number, name: string) =>
    line(`Q${idx}:${name.replace(/[\r\n:]+/g, ' ')}`),

  switchProfile: (page: number) => line(`P${page}`),

  systemInfo: (
    cpu: number, cTemp: number, rUsed: number, rTotal: number, gpu: number, gTemp: number,
  ) => line(`S${cpu}:${cTemp}:${rUsed.toFixed(1)}:${rTotal.toFixed(1)}:${gpu}:${gTemp}`),

  nowPlaying: (title: string, artist: string, posMs: number, durMs: number, playing: boolean) => {
    // '|' is this frame's field separator and newlines end it — strip both from
    // the free-text fields ("Artist | Topic" titles are common) or every later
    // field shifts on the device.
    const clean = (s: string) => s.replace(/[|\r\n]+/g, ' ');
    return line(`N${clean(title)}|${clean(artist)}|${posMs}|${durMs}|${playing ? 1 : 0}`);
  },

  displayMode: (mode: number) => line(`D${mode}`),

  brightness: (pct: number) => line(`B${Math.max(1, Math.min(100, pct | 0))}`),

  queryVersion: () => line('I'),
  reboot: () => line('R'),
  wipe: () => line('WIPE'),

  // Provision Wi-Fi over USB. The device joins the network and replies WIFIIP:<ip>.
  // Note: the firmware splits on the first ':', so SSIDs containing ':' aren't
  // supported (passwords may contain ':'). Newlines are stripped to keep the frame.
  setWifi: (ssid: string, pass: string) =>
    line(`WIFI:${ssid.replace(/[\r\n:]/g, '')}:${pass.replace(/[\r\n]/g, '')}`),

  // Scan for nearby networks; the device streams WIFINET:<rssi>:<ssid> then WIFISCAN:done.
  scanWifi: () => line('WIFISCAN'),
};

// ── Device → host decoding ────────────────────────────────────────────────────

export type DeckEvent =
  | { kind: 'pcAction'; profile: number; button: number }
  | { kind: 'profileChanged'; page: number }
  | { kind: 'version'; version: string }
  // Wi-Fi link address (or '0.0.0.0' when it drops), reported after provisioning.
  | { kind: 'wifiIp'; ip: string }
  // Wi-Fi join progress: connecting, or a failure with a wifi_err_reason_t code.
  | { kind: 'wifiStatus'; connecting: boolean; reason?: number }
  // A network found during a scan, and the end-of-scan marker.
  | { kind: 'wifiNet'; ssid: string; rssi: number }
  | { kind: 'wifiScanDone' };

/** Friendly text for a Wi-Fi join failure (wifi_err_reason_t code). */
export function wifiReasonText(reason?: number): string {
  if (reason === 201) return 'Network not found — check the name (the deck is 2.4 GHz only)';
  if (reason === 15 || reason === 202 || reason === 204 || reason === 205) {
    return 'Wrong password / authentication failed';
  }
  if (reason === undefined) return 'Wi-Fi command rejected by device';
  return `Couldn't join (Wi-Fi error ${reason})`;
}

/** Parse one trimmed line from the device. Returns null for diagnostics/unknown. */
export function parseLine(raw: string): DeckEvent | null {
  const lineStr = raw.trim();
  if (lineStr.length === 0) return null;

  if (lineStr.startsWith('PROF_SYNC:')) {
    const page = Number.parseInt(lineStr.slice(10), 10);
    return Number.isNaN(page) ? null : { kind: 'profileChanged', page };
  }

  if (lineStr.startsWith('VER:')) {
    return { kind: 'version', version: lineStr.slice(4) };
  }

  if (lineStr.startsWith('WIFIIP:')) {
    return { kind: 'wifiIp', ip: lineStr.slice(7) };
  }
  if (lineStr === 'WIFISCAN:done') {
    return { kind: 'wifiScanDone' };
  }
  if (lineStr.startsWith('WIFINET:')) {
    const rest = lineStr.slice(8); // "<rssi>:<ssid>"
    const c = rest.indexOf(':');
    if (c > 0) {
      const rssi = Number.parseInt(rest.slice(0, c), 10);
      const ssid = rest.slice(c + 1);
      if (ssid && !Number.isNaN(rssi)) return { kind: 'wifiNet', ssid, rssi };
    }
    return null;
  }
  if (lineStr === 'WIFI:connecting') {
    return { kind: 'wifiStatus', connecting: true };
  }
  if (lineStr.startsWith('WIFI:fail:')) {
    const reason = Number.parseInt(lineStr.slice(10), 10);
    return { kind: 'wifiStatus', connecting: false, reason: Number.isNaN(reason) ? undefined : reason };
  }
  if (lineStr.startsWith('WIFI:err')) {
    return { kind: 'wifiStatus', connecting: false };
  }

  // E<prof>:<btn> — but only treat as event if it matches the exact shape, so we
  // don't misread diagnostic lines that happen to start with 'E'.
  if (lineStr.startsWith('E')) {
    const m = /^E(\d+):(\d+)$/.exec(lineStr);
    if (m) {
      return { kind: 'pcAction', profile: Number(m[1]), button: Number(m[2]) };
    }
  }

  return null;
}
