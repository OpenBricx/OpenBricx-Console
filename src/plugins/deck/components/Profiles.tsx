import { useState } from 'react';
import { dialog, files } from '@openbricx/host';
import { PROFILE_COUNT, macroKey, type MacroConfig } from '../types';
import type { UseDeckConfig } from '../useDeckConfig';

interface Props {
  cfg: UseDeckConfig;
  activeProfile: number;
  onSwitchProfile: (page: number) => void;
  showToast: (msg: string) => void;
}

const PROFILE_ICONS = ['🎮', '🎬', '💼', '🎵'];

export function Profiles({ cfg, activeProfile, onSwitchProfile, showToast }: Props) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  function commitRename(idx: number) {
    if (editingName.trim()) cfg.renameProfile(idx, editingName.trim());
    setEditingIdx(null);
  }

  async function exportProfile(page: number) {
    const macros: Record<number, MacroConfig> = {};
    for (let i = 1; i <= 9; i++) {
      const m = cfg.config.macros[macroKey(page, i)];
      if (m) macros[i] = m;
    }
    const data = { type: 'DeckProfile', profileName: cfg.config.profileNames[page], macros };
    const suggested = `OpenBricxDeck_${cfg.config.profileNames[page].replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    try {
      // Native save dialog → host write. The webview's <a download> blob trick
      // is a no-op inside the Tauri webview, which is why Export "did nothing".
      const path = await dialog.save({
        title: 'Export profile',
        defaultPath: suggested,
        filters: [{ name: 'OpenBricx Deck Profile', extensions: ['json'] }],
      });
      if (!path) return; // user cancelled
      await files.writeText(path, JSON.stringify(data, null, 2));
      showToast('Profile exported ✨');
    } catch (e) {
      console.error('[deck] export failed:', e);
      showToast('Export failed');
    }
  }

  async function importProfile(page: number) {
    try {
      const selected = await dialog.open({
        title: 'Import profile',
        filters: [{ name: 'OpenBricx Deck Profile', extensions: ['json'] }],
      });
      if (!selected) return; // cancelled
      const text = await files.readText(selected);
      const data = JSON.parse(text);
      if (data.type !== 'DeckProfile' || !data.macros) {
        showToast('Invalid profile file');
        return;
      }
      cfg.replaceProfile(page, data.macros, data.profileName);
      showToast('Profile imported — click Save to Deck to sync ✨');
    } catch (e) {
      console.error('[deck] import failed:', e);
      showToast('Failed to read profile file');
    }
  }

  return (
    <div className="deck-page">
      <div className="deck-card">
        <h2>👤 Profile Manager</h2>
        <p className="muted">Switch between layouts. Double-click a name to rename.</p>

        <div className="profile-list">
          {Array.from({ length: PROFILE_COUNT }, (_, p) => (
            <div
              key={p}
              className={`profile-item${activeProfile === p ? ' active' : ''}`}
              onClick={() => onSwitchProfile(p)}
            >
              <div className="profile-id">
                <span className="profile-emoji">{PROFILE_ICONS[p]}</span>
                <div>
                  {editingIdx === p ? (
                    <input
                      className="profile-name-input"
                      value={editingName}
                      autoFocus
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => commitRename(p)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(p);
                        if (e.key === 'Escape') setEditingIdx(null);
                      }}
                    />
                  ) : (
                    <div
                      className="profile-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingIdx(p);
                        setEditingName(cfg.config.profileNames[p]);
                      }}
                    >
                      {cfg.config.profileNames[p]}
                    </div>
                  )}
                  <div className="profile-sub">Profile {p + 1}</div>
                </div>
              </div>

              <div className="profile-actions">
                {activeProfile === p && <span className="profile-active-dot">● Active</span>}
                <button
                  className="profile-action-btn"
                  title="Export"
                  onClick={(e) => { e.stopPropagation(); exportProfile(p); }}
                >📤</button>
                <button
                  className="profile-action-btn"
                  title="Import"
                  onClick={(e) => { e.stopPropagation(); importProfile(p); }}
                >📥</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
