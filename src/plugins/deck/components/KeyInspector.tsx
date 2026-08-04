import { dialog } from '@openbricx/host';
import {
  MEDIA_ACTIONS,
  MODE_OPTIONS,
  Mode,
  Modifier,
  SPECIAL_KEYS,
  isSpecialKey,
  modeIcon,
  type MacroConfig,
} from '../types';

interface Props {
  profileName: string;
  button: number;
  macro: MacroConfig;
  onChange: (patch: Partial<MacroConfig>) => void;
}

// Render a character from an ASCII val. Empty for 0 or a special (non-ASCII) key
// — those would otherwise stringify to a junk glyph in the single-char input.
const charOf = (val: number) => (val === 0 || isSpecialKey(val) ? '' : String.fromCharCode(val));

export function KeyInspector({ profileName, button, macro, onChange }: Props) {
  const mods = {
    ctrl: (macro.mods & Modifier.Ctrl) !== 0,
    shift: (macro.mods & Modifier.Shift) !== 0,
    alt: (macro.mods & Modifier.Alt) !== 0,
    gui: (macro.mods & Modifier.Gui) !== 0,
  };

  const toggleMod = (key: keyof typeof mods) => {
    const next = { ...mods, [key]: !mods[key] };
    const bits =
      (next.ctrl ? Modifier.Ctrl : 0) |
      (next.shift ? Modifier.Shift : 0) |
      (next.alt ? Modifier.Alt : 0) |
      (next.gui ? Modifier.Gui : 0);
    onChange({ mods: bits });
  };

  const setKeyChar = (s: string) => {
    const code = s.charCodeAt(0);
    onChange({ val: Number.isNaN(code) ? 0 : code });
  };

  async function pickExecutable() {
    const path = await dialog.open({
      title: 'Select application',
      filters: [{ name: 'Executable', extensions: ['exe'] }],
    });
    if (path) onChange({ pcPath: path });
  }

  return (
    <div className="inspector-body">
      <div className="inspector-id">
        <div className="inspector-preview">{modeIcon(macro.mode)}</div>
        <div className="inspector-id-text">
          <input
            className="inspector-title-input"
            value={macro.title}
            placeholder={`Key ${button}`}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          <span className="inspector-id-sub">Key {button} · {profileName}</span>
        </div>
      </div>

      <div className="inspector-config">
        <div className="mode-picker">
          {MODE_OPTIONS.map((m) => (
            <button
              key={m.id}
              className={`mode-pill${macro.mode === m.id ? ' active' : ''}`}
              onClick={() => onChange({ mode: m.id })}
            >
              <span className="mode-pill-icon">{m.icon}</span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <div className="action-fields">
          {macro.mode === Mode.Keyboard && (
            <div className="field" style={{ maxWidth: 160 }}>
              <label>Key</label>
              <input
                type="text"
                maxLength={1}
                placeholder="Press a key"
                value={charOf(macro.val)}
                onChange={(e) => setKeyChar(e.target.value)}
              />
            </div>
          )}

          {macro.mode === Mode.Media && (
            <div className="field">
              <label>Media Action</label>
              <select value={macro.val} onChange={(e) => onChange({ val: Number(e.target.value) })}>
                {MEDIA_ACTIONS.map((a) => (
                  <option key={a.val} value={a.val}>{a.label}</option>
                ))}
              </select>
            </div>
          )}

          {macro.mode === Mode.Hotkey && (
            <>
              <div className="field" style={{ maxWidth: 110 }}>
                <label>Key</label>
                <input
                  type="text"
                  maxLength={1}
                  placeholder={isSpecialKey(macro.val) ? '—' : 'Key'}
                  value={charOf(macro.val)}
                  disabled={isSpecialKey(macro.val)}
                  onChange={(e) => setKeyChar(e.target.value)}
                />
              </div>
              <div className="field" style={{ maxWidth: 130 }}>
                <label>Special</label>
                <select
                  value={isSpecialKey(macro.val) ? macro.val : 0}
                  onChange={(e) => onChange({ val: Number(e.target.value) })}
                >
                  <option value={0}>— none —</option>
                  {SPECIAL_KEYS.map((k) => (
                    <option key={k.val} value={k.val}>{k.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Modifiers</label>
                <div className="mod-chips">
                  {(['ctrl', 'shift', 'alt', 'gui'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={`mod-chip${mods[key] ? ' active' : ''}`}
                      onClick={() => toggleMod(key)}
                    >
                      {key === 'gui' ? 'Win' : key.charAt(0).toUpperCase() + key.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {macro.mode === Mode.Text && (
            <div className="field" style={{ flex: 1 }}>
              <label>Text to type</label>
              <input
                type="text"
                value={macro.text}
                placeholder="e.g. your email, a code snippet, GG"
                onChange={(e) => onChange({ text: e.target.value })}
              />
            </div>
          )}

          {macro.mode === Mode.LaunchApp && (
            <div className="field" style={{ flex: 1 }}>
              <label>Application</label>
              <div className="field-row">
                <input
                  type="text"
                  value={macro.pcPath}
                  placeholder="C:\\Path\\to\\app.exe"
                  onChange={(e) => onChange({ pcPath: e.target.value })}
                />
                <button className="field-btn" onClick={pickExecutable}>📁 Browse</button>
              </div>
            </div>
          )}

          {macro.mode === Mode.OpenLink && (
            <>
              <div className="field" style={{ flex: 1 }}>
                <label>URL</label>
                <input
                  type="text"
                  value={macro.pcPath}
                  placeholder="https://example.com"
                  onChange={(e) => onChange({ pcPath: e.target.value })}
                />
              </div>
              <div className="field" style={{ maxWidth: 150 }}>
                <label>Browser</label>
                <select value={macro.pcBrowser} onChange={(e) => onChange({ pcBrowser: e.target.value })}>
                  <option value="default">Default</option>
                  <option value="chrome">Chrome</option>
                  <option value="edge">Edge</option>
                  <option value="firefox">Firefox</option>
                </select>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
