import type { Connection, Unsubscribe } from '@openbricx/host';
import { encode, parseLine, type DeckEvent } from './protocol';
import { isPcMode, type MacroConfig } from './types';

// DeckDriver — the OpenBricx Deck-specific layer over a transport-agnostic Connection.
//
// Everything above this (UI, hooks) deals in semantic calls (setMacro,
// switchProfile, sendVolume…). Everything below is opaque bytes. Incoming bytes
// are buffered and split on newlines, then decoded into DeckEvents.
export class DeckDriver {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly listeners = new Set<(e: DeckEvent) => void>();
  private unsubMessage: Unsubscribe | null = null;

  constructor(private readonly conn: Connection) {}

  /** Start decoding the connection's byte stream. Called from a React effect —
   *  NOT the constructor — and idempotent, so StrictMode's mount→cleanup→mount
   *  cycle re-arms the memoized driver instead of leaving it permanently deaf. */
  attach() {
    if (this.unsubMessage) return;
    this.buffer = '';
    this.unsubMessage = this.conn.onMessage((data) => this.ingest(data));
  }

  /** Stop decoding. The driver stays usable; attach() re-arms it. */
  detach() {
    this.unsubMessage?.();
    this.unsubMessage = null;
  }

  // ── Incoming ────────────────────────────────────────────────────────────────

  private ingest(data: Uint8Array) {
    this.buffer += this.decoder.decode(data, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const event = parseLine(raw);
      if (event) {
        for (const cb of this.listeners) cb(event);
      }
    }
    // Overflow guard AFTER the split loop: only a partial line can remain here,
    // so a runaway newline-less stream is dropped without ever discarding
    // complete queued protocol lines (which a mid-loop guard did on big bursts).
    if (this.buffer.length > 4096) this.buffer = '';
  }

  /** Subscribe to decoded device events (pcAction / profileChanged / version). */
  onEvent(cb: (e: DeckEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ── Outgoing ────────────────────────────────────────────────────────────────

  // All writes go through one chain so two callers (e.g. an OTA chunk and a
  // background telemetry push) can never interleave at the byte level and corrupt
  // a line on the wire. Each send waits for the previous to finish.
  private sendChain: Promise<unknown> = Promise.resolve();

  /** Queued write. Resolves true if the transport accepted the bytes, false if
   *  the link is dead — anything reporting "saved/sent" success must check it
   *  (a swallowed rejection here is how a dead link shows fake success toasts). */
  private send(bytes: Uint8Array): Promise<boolean> {
    const next = this.sendChain.then(() =>
      this.conn.send(bytes).then(
        () => true,
        (e) => {
          console.error('[DeckDriver] send failed:', e);
          return false;
        },
      ),
    );
    this.sendChain = next;
    return next;
  }

  /** Push a single macro slot to the device (uses T for text mode, M otherwise).
   *  Resolves false if the transport rejected the write (dead link). */
  setMacro(profile: number, btn: number, cfg: MacroConfig): Promise<boolean> {
    if (cfg.mode === 4) {
      return this.send(encode.text(profile, btn, cfg.text));
    }
    return this.send(encode.macro(profile, btn, cfg.mode, cfg.val, cfg.mods));
  }

  setProfileName(idx: number, name: string) {
    return this.send(encode.profileName(idx, name));
  }

  switchProfile(page: number) {
    return this.send(encode.switchProfile(page));
  }

  setDisplayMode(mode: number) {
    return this.send(encode.displayMode(mode));
  }

  setBrightness(pct: number) {
    return this.send(encode.brightness(pct));
  }

  sendVolume(vol: number) {
    return this.send(encode.volume(vol));
  }

  sendSystemInfo(cpu: number, cTemp: number, rUsed: number, rTotal: number, gpu: number, gTemp: number) {
    return this.send(encode.systemInfo(cpu, cTemp, rUsed, rTotal, gpu, gTemp));
  }

  sendNowPlaying(title: string, artist: string, posMs: number, durMs: number, playing: boolean) {
    return this.send(encode.nowPlaying(title, artist, posMs, durMs, playing));
  }

  queryVersion() {
    return this.send(encode.queryVersion());
  }

  reboot() {
    return this.send(encode.reboot());
  }

  wipe() {
    return this.send(encode.wipe());
  }

  /** Provision Wi-Fi over the USB link; the device replies with a `wifiIp` event. */
  setWifiCredentials(ssid: string, pass: string) {
    return this.send(encode.setWifi(ssid, pass));
  }

  /** Scan for nearby networks; results arrive as `wifiNet` events, then `wifiScanDone`. */
  scanWifi() {
    return this.send(encode.scanWifi());
  }

  /**
   * Push every configured macro for every profile, plus profile names, to the
   * device. Used on connect so the device's NVS mirrors the host config.
   * Yields between writes so a slow link can't overflow the device buffer.
   */
  async syncAll(config: { profileNames: string[]; macros: Record<string, MacroConfig> }) {
    for (let i = 0; i < config.profileNames.length; i++) {
      await this.setProfileName(i, config.profileNames[i]);
      await delay(20);
    }
    for (const [key, cfg] of Object.entries(config.macros)) {
      const m = /^p(\d+)_b(\d+)$/.exec(key);
      if (!m) continue;
      await this.setMacro(Number(m[1]), Number(m[2]), cfg);
      await delay(20);
    }
  }

}

/** True for modes the host must execute when an E-event arrives. */
export { isPcMode };

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
