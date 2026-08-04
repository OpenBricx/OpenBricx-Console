// Shared device-facing formatting helpers. These were duplicated per plugin
// (mods + pixels) and had already drifted — formatMac was uppercase in one copy
// and mixed-case in the other, and the RSSI ladder is product-wide tuning that
// must not fork. One copy here; plugin types.ts re-export for local callers.

/** Format a 12-hex-char MAC as AA:BB:CC:DD:EE:FF. */
export function formatMac(hex: string): string {
  if (hex.length !== 12) return hex;
  return (hex.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

/** Loose MAC input ("aa:bb...", "AABB.CCDD.EEFF", …) → 12 uppercase hex chars, or null. */
export function normalizeMac(input: string): string | null {
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex : null;
}

/** RSSI (dBm, 0 = unknown) → signal label + bar count for the UI meters. */
export function linkQuality(rssi: number): { label: string; bars: number } {
  if (rssi === 0) return { label: 'no signal', bars: 0 };
  if (rssi > -55) return { label: 'excellent', bars: 4 };
  if (rssi > -67) return { label: 'good', bars: 3 };
  if (rssi > -75) return { label: 'fair', bars: 2 };
  return { label: 'weak', bars: 1 };
}

/** Friendly "last seen" label from a millisecond age. */
export function lastSeenLabel(ms: number): string {
  if (ms < 2_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}
