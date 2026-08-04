import { useState } from 'react';
import { BUTTON_COUNT, modeIcon } from '../types';
import type { UseDeckConfig } from '../useDeckConfig';
import { KeyInspector } from './KeyInspector';

interface Props {
  cfg: UseDeckConfig;
  activeProfile: number;
  online: boolean;
  onSwitchProfile: (page: number) => void;
  showToast: (msg: string) => void;
}

export function Dashboard({ cfg, activeProfile, online, onSwitchProfile, showToast }: Props) {
  const [selectedBtn, setSelectedBtn] = useState<number | null>(null);
  const keys = Array.from({ length: BUTTON_COUNT }, (_, i) => i + 1);

  function handleRestore() {
    if (confirm('Load the built-in default macros into this profile? They\'ll be staged — click "Save to Deck" to apply.')) {
      cfg.restoreDefaults();
      showToast('Defaults loaded — click Save to Deck to apply');
    }
  }

  return (
    <div className="deck-page">
      <div className="dashboard-controls">
        <span className="muted">Active Profile:</span>
        <select value={activeProfile} onChange={(e) => onSwitchProfile(Number(e.target.value))}>
          {cfg.config.profileNames.map((name, i) => (
            <option key={i} value={i}>{name}</option>
          ))}
        </select>
        <button className="deck-btn" style={{ marginLeft: 'auto' }} onClick={handleRestore}>
          ↺ Restore Defaults
        </button>
      </div>

      {!online && (
        <p className="deck-offline-hint">
          ⚠ No device connected — edits are saved locally. Open the <strong>Devices</strong> tab and
          connect your Deck over USB, then press <strong>Save to Deck</strong>.
        </p>
      )}

      <div className="macro-grid">
        {keys.map((i) => {
          const m = cfg.getMacro(activeProfile, i);
          return (
            <button
              key={i}
              className={`grid-key${selectedBtn === i ? ' selected' : ''}`}
              onClick={() => setSelectedBtn(i)}
            >
              <span className="key-icon">{modeIcon(m.mode)}</span>
              <span className="key-label">{m.title || `Key ${i}`}</span>
            </button>
          );
        })}
      </div>

      <div className="property-inspector">
        {selectedBtn === null ? (
          <div className="placeholder-text">
            <span className="placeholder-icon">🎯</span>
            <span>Select a key from the grid to configure it</span>
          </div>
        ) : (
          <KeyInspector
            profileName={cfg.config.profileNames[activeProfile]}
            button={selectedBtn}
            macro={cfg.getMacro(activeProfile, selectedBtn)}
            onChange={(patch) => cfg.updateMacro(activeProfile, selectedBtn, patch)}
          />
        )}
      </div>
    </div>
  );
}
