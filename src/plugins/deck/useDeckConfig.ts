import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_PRESETS,
  DEFAULT_PROFILE_NAMES,
  defaultMacro,
  macroKey,
  type DeckConfig,
  type MacroConfig,
} from './types';
import type { DeckDriver } from './driver';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Config persistence + device sync.
//
// The host config (this hook) is the editable source of truth; the device's NVS
// is a mirror that we push on connect and on each edit. Config is keyed by
// deviceId in localStorage so multiple OpenBricx Decks don't clobber each other.

const storageKey = (deviceId: string) => `obx.deck.config.${deviceId}`;

function loadConfig(deviceId: string): DeckConfig {
  try {
    const raw = localStorage.getItem(storageKey(deviceId));
    if (raw) {
      const parsed = JSON.parse(raw) as DeckConfig;
      if (parsed && parsed.macros) {
        return {
          schemaVersion: CONFIG_SCHEMA_VERSION,
          profileNames: parsed.profileNames?.length ? parsed.profileNames : [...DEFAULT_PROFILE_NAMES],
          macros: parsed.macros,
        };
      }
    }
  } catch (e) {
    console.error('[deck] failed to load config:', e);
  }
  // First run — seed defaults.
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    profileNames: [...DEFAULT_PROFILE_NAMES],
    macros: { ...DEFAULT_PRESETS },
  };
}

export interface UseDeckConfig {
  config: DeckConfig;
  isFirstRun: boolean;
  /** Number of edits made locally that haven't been pushed to the device yet. */
  pendingCount: number;
  getMacro: (profile: number, btn: number) => MacroConfig;
  /** Update one macro slot locally (staged — call saveToDevice to push). */
  updateMacro: (profile: number, btn: number, patch: Partial<MacroConfig>) => void;
  renameProfile: (idx: number, name: string) => void;
  replaceProfile: (profile: number, macros: Record<number, MacroConfig>, name?: string) => void;
  /** Reload Profile 0 with the built-in default macros (staged). */
  restoreDefaults: () => void;
  /** Push all staged edits to the device. Returns how many were sent. */
  saveToDevice: () => Promise<number>;
  /** Re-push the entire config to the device (used on connect). */
  syncAll: () => Promise<void>;
}

export function useDeckConfig(deviceId: string, driver: DeckDriver | null): UseDeckConfig {
  const [config, setConfig] = useState<DeckConfig>(() => loadConfig(deviceId));
  const isFirstRun = useRef(localStorage.getItem(storageKey(deviceId)) === null).current;

  // Edits are staged here until the user clicks "Save to Deck" (matches the
  // original companion's explicit-save flow). Entries are macro keys (`p0_b1`)
  // or profile-name keys (`name0`). localStorage still persists every edit, so
  // nothing is lost — only the *device* push is deferred.
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(deviceId), JSON.stringify(config));
    } catch (e) {
      console.error('[deck] failed to save config:', e);
    }
  }, [deviceId, config]);

  const getMacro = useCallback(
    (profile: number, btn: number): MacroConfig =>
      config.macros[macroKey(profile, btn)] ?? defaultMacro(btn),
    [config.macros],
  );

  const updateMacro = useCallback((profile: number, btn: number, patch: Partial<MacroConfig>) => {
    const key = macroKey(profile, btn);
    setConfig((prev) => {
      const current = prev.macros[key] ?? defaultMacro(btn);
      return { ...prev, macros: { ...prev.macros, [key]: { ...current, ...patch } } };
    });
    setPending((prev) => new Set(prev).add(key));
  }, []);

  const renameProfile = useCallback((idx: number, name: string) => {
    setConfig((prev) => {
      const names = [...prev.profileNames];
      names[idx] = name;
      return { ...prev, profileNames: names };
    });
    setPending((prev) => new Set(prev).add(`name${idx}`));
  }, []);

  const replaceProfile = useCallback(
    (profile: number, macros: Record<number, MacroConfig>, name?: string) => {
      setConfig((prev) => {
        const nextMacros = { ...prev.macros };
        for (let btn = 1; btn <= 9; btn++) {
          nextMacros[macroKey(profile, btn)] = macros[btn] ?? defaultMacro(btn);
        }
        const names = [...prev.profileNames];
        if (name) names[profile] = name;
        return { ...prev, profileNames: names, macros: nextMacros };
      });
      setPending((prev) => {
        const next = new Set(prev);
        for (let btn = 1; btn <= 9; btn++) next.add(macroKey(profile, btn));
        if (name) next.add(`name${profile}`);
        return next;
      });
    },
    [],
  );

  const restoreDefaults = useCallback(() => {
    setConfig((prev) => ({ ...prev, macros: { ...prev.macros, ...DEFAULT_PRESETS } }));
    setPending((prev) => {
      const next = new Set(prev);
      for (const k of Object.keys(DEFAULT_PRESETS)) next.add(k);
      return next;
    });
  }, []);

  const saveToDevice = useCallback(async (): Promise<number> => {
    if (!driver) return 0;
    const keys = Array.from(pending);
    const sent = new Set<string>();
    for (const key of keys) {
      const nameMatch = /^name(\d+)$/.exec(key);
      let ok = true; // unknown key shapes just get dropped from pending
      if (nameMatch) {
        ok = await driver.setProfileName(Number(nameMatch[1]), config.profileNames[Number(nameMatch[1])] ?? '');
      } else {
        const m = /^p(\d+)_b(\d+)$/.exec(key);
        if (m) {
          const cfg = config.macros[key] ?? defaultMacro(Number(m[2]));
          ok = await driver.setMacro(Number(m[1]), Number(m[2]), cfg);
        }
      }
      if (ok) sent.add(key);
      await delay(15); // pace writes so a slow link can't overflow the device buffer
    }
    // Clear only what was actually delivered: writes a dead link rejected stay
    // pending, and so do edits staged WHILE this save was in flight (they were
    // never in `keys`, so a blanket clear would silently mark them saved).
    setPending((prev) => {
      const next = new Set(prev);
      for (const k of sent) next.delete(k);
      return next;
    });
    return sent.size;
  }, [driver, pending, config]);

  const syncAll = useCallback(async () => {
    if (!driver) return;
    await driver.syncAll(config);
    setPending(new Set()); // a full sync clears any staged edits
  }, [driver, config]);

  return {
    config,
    isFirstRun,
    pendingCount: pending.size,
    getMacro,
    updateMacro,
    renameProfile,
    replaceProfile,
    restoreDefaults,
    saveToDevice,
    syncAll,
  };
}
