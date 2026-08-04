// OpenBricx Deck — shared types and constants.

// Action modes. 1–4 are executed on the device (HID). 5–6 are PC-handled: the
// device only emits an `E<prof>:<btn>` event and the host runs the action.
export const Mode = {
  Keyboard: 1,
  Media: 2,
  Hotkey: 3,
  Text: 4,
  LaunchApp: 5,
  OpenLink: 6,
} as const;
export type ModeId = (typeof Mode)[keyof typeof Mode];

/** Modes the firmware resolves locally vs. modes the host executes. */
export const isPcMode = (mode: number) => mode === Mode.LaunchApp || mode === Mode.OpenLink;

export interface ModeOption {
  id: ModeId;
  icon: string;
  label: string;
}

export const MODE_OPTIONS: ModeOption[] = [
  { id: Mode.Keyboard, icon: '⌨️', label: 'Keyboard' },
  { id: Mode.Media, icon: '🔊', label: 'Media' },
  { id: Mode.Hotkey, icon: '⚡', label: 'Hotkey' },
  { id: Mode.Text, icon: '📝', label: 'Text' },
  { id: Mode.LaunchApp, icon: '🚀', label: 'Launch App' },
  { id: Mode.OpenLink, icon: '🔗', label: 'Open Link' },
];

export const modeIcon = (m: number): string =>
  MODE_OPTIONS.find((o) => o.id === m)?.icon ?? '🔘';

// Modifier bitmask (matches firmware MOD_CTRL/SHIFT/ALT/GUI).
export const Modifier = { Ctrl: 1, Shift: 2, Alt: 4, Gui: 8 } as const;

// Special (non-ASCII) keys for Hotkey mode. `val` is normally an ASCII char code
// (0–127); special keys are encoded 0xF000 | HID keycode so they can never
// collide with an ASCII code. The firmware decodes the same flag (see hid.c).
export const SPECIAL_KEY_FLAG = 0xf000;
export const SPECIAL_KEYS = [
  { val: 0xf046, label: 'PrtSc' }, // HID_KEY_PRINT_SCREEN = 0x46
] as const;
export const isSpecialKey = (val: number) => (val & 0xff00) === SPECIAL_KEY_FLAG;
// Consumer-control media usage codes used by the Media mode dropdown.
export const MEDIA_ACTIONS = [
  { val: 205, label: 'Play/Pause' },
  { val: 181, label: 'Next' },
  { val: 182, label: 'Previous' },
  { val: 226, label: 'Mute' },
] as const;

// Display modes for the on-device Mochi screen.
export const DISPLAY_MODES = [
  { id: 0, label: 'Mochi (Face Only)' },
  { id: 1, label: 'Stats (Data Only)' },
] as const;

export const PROFILE_COUNT = 4;
export const BUTTON_COUNT = 9;

export interface MacroConfig {
  mode: number;
  val: number;
  mods: number;
  text: string;
  pcPath: string;
  pcBrowser: string;
  title: string;
}

export function defaultMacro(btn: number): MacroConfig {
  return {
    mode: Mode.Keyboard,
    val: 97,
    mods: 0,
    text: '',
    pcPath: '',
    pcBrowser: 'default',
    title: `Key ${btn}`,
  };
}

/** Full editable config for a device: macros keyed `p<prof>_b<btn>` + profile names. */
export interface DeckConfig {
  schemaVersion: number;
  profileNames: string[];
  macros: Record<string, MacroConfig>;
}

export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_PROFILE_NAMES = ['Default', 'Streaming', 'Productivity', 'Music'];

export const macroKey = (profile: number, btn: number) => `p${profile}_b${btn}`;

// Sensible first-run presets for Profile 0.
export const DEFAULT_PRESETS: Record<string, MacroConfig> = {
  p0_b1: { mode: 2, val: 182, mods: 0, text: '', pcPath: '', pcBrowser: 'default', title: 'Previous' },
  p0_b2: { mode: 2, val: 205, mods: 0, text: '', pcPath: '', pcBrowser: 'default', title: 'Play/Pause' },
  p0_b3: { mode: 2, val: 181, mods: 0, text: '', pcPath: '', pcBrowser: 'default', title: 'Next' },
  p0_b4: { mode: 3, val: 99, mods: 1, text: '', pcPath: '', pcBrowser: 'default', title: 'Copy' },
  p0_b5: { mode: 3, val: 118, mods: 1, text: '', pcPath: '', pcBrowser: 'default', title: 'Paste' },
  p0_b6: { mode: 3, val: 122, mods: 1, text: '', pcPath: '', pcBrowser: 'default', title: 'Undo' },
  p0_b7: { mode: 2, val: 226, mods: 0, text: '', pcPath: '', pcBrowser: 'default', title: 'Mute' },
  p0_b8: { mode: 3, val: 0xf046, mods: 8, text: '', pcPath: '', pcBrowser: 'default', title: 'Screenshot' },
  p0_b9: { mode: 3, val: 108, mods: 8, text: '', pcPath: '', pcBrowser: 'default', title: 'Lock PC' },
};

// PC-side telemetry shapes returned by the Rust deck_* commands.
export interface SystemInfo {
  cpu: number;
  cpuTemp: number;
  ramUsed: number;
  ramTotal: number;
  gpu: number;
  gpuTemp: number;
}

export interface NowPlaying {
  title: string;
  artist: string;
  posMs: number;
  durMs: number;
  playing: boolean;
}
