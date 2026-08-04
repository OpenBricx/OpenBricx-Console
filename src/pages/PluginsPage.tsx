import { useEffect, useRef, useState } from 'react';
import {
  listInstalledPlugins,
  fetchCatalog,
  installPlugin,
  uninstallPlugin,
  requiresNewerApp,
  type CatalogEntry,
  type InstalledPluginInfo,
} from '../core/plugins';
import { APP_VERSION, DEFAULT_PLUGIN_CATALOG_URL } from '../core/config';

interface Props {
  /** Called after an install/uninstall so the launcher can reload its registry. */
  onChanged: () => void;
}

export function PluginsPage({ onChanged }: Props) {
  const [installed, setInstalled] = useState<InstalledPluginInfo[]>([]);
  // The official catalog is baked in so the tab works with zero setup; the field
  // stays editable for third-party / development catalogs.
  const [catalogUrl, setCatalogUrl] = useState(DEFAULT_PLUGIN_CATALOG_URL);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshInstalled = () =>
    listInstalledPlugins()
      .then(setInstalled)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    refreshInstalled();
  }, []);

  const isInstalled = (product: string) => installed.some((i) => i.manifest.product === product);

  async function fetchFrom(url: string, quiet = false) {
    setError(null);
    setCatalog(null);
    setBusy('catalog');
    try {
      const c = await fetchCatalog(url.trim());
      setCatalog(c.plugins);
    } catch (e) {
      // A failed auto-fetch on first open (offline, catalog not published yet)
      // shouldn't greet the user with a red error — the button is still there.
      if (!quiet) setError(`Catalog: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  const handleFetch = () => fetchFrom(catalogUrl);

  // Auto-load the official catalog once on open, so "Browse" is populated
  // without the user having to know any URL.
  const autoFetched = useRef(false);
  useEffect(() => {
    if (autoFetched.current || !DEFAULT_PLUGIN_CATALOG_URL) return;
    autoFetched.current = true;
    fetchFrom(DEFAULT_PLUGIN_CATALOG_URL, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleInstall(entry: CatalogEntry) {
    // Same gate the startup sync applies: the bundle would verify and install
    // fine, then fail at import against an older host SDK.
    if (requiresNewerApp(entry)) {
      setError(
        `${entry.name} needs OpenBricx Console ${entry.minAppVersion} or newer — ` +
          `you're running ${APP_VERSION}. Update the app, then try again.`,
      );
      return;
    }
    setBusy(entry.product);
    setError(null);
    try {
      await installPlugin(entry.url);
      await refreshInstalled();
      onChanged();
    } catch (e) {
      setError(`Install ${entry.name}: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(product: string) {
    setBusy(product);
    setError(null);
    try {
      await uninstallPlugin(product);
      await refreshInstalled();
      onChanged();
    } catch (e) {
      setError(`Remove ${product}: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="plugins-page">
      <header className="app-header">
        <h1>Plugins</h1>
      </header>

      {error && (
        <p className="plugins-error" role="alert" onClick={() => setError(null)}>
          {error} <span className="connect-error-dismiss">✕</span>
        </p>
      )}

      <section className="plugins-section">
        <h2>Browse</h2>
        <div className="plugins-catalog-bar">
          <input
            className="plugins-input"
            type="url"
            placeholder="Catalog URL (e.g. https://openbricx.example/catalog.json)"
            value={catalogUrl}
            onChange={(e) => setCatalogUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && catalogUrl.trim() && handleFetch()}
          />
          <button
            className="plugins-btn primary"
            disabled={!catalogUrl.trim() || busy !== null}
            onClick={handleFetch}
          >
            {busy === 'catalog' ? 'Fetching…' : 'Fetch'}
          </button>
        </div>

        {catalog && catalog.length === 0 && <p className="empty-hint">Catalog is empty.</p>}
        {catalog && catalog.length > 0 && (
          <div className="plugins-list">
            {catalog.map((entry) => (
              <div key={entry.product} className="plugins-row">
                <div className="plugins-row-body">
                  <span className="plugins-row-name">
                    {entry.name} <span className="plugins-row-version">v{entry.version}</span>
                  </span>
                  {entry.description && (
                    <span className="plugins-row-desc">{entry.description}</span>
                  )}
                  <span className="plugins-row-product">{entry.product}</span>
                </div>
                <button
                  className="plugins-btn"
                  disabled={busy !== null || isInstalled(entry.product)}
                  onClick={() => handleInstall(entry)}
                >
                  {isInstalled(entry.product)
                    ? 'Installed'
                    : busy === entry.product
                      ? 'Installing…'
                      : 'Install'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="plugins-section">
        <h2>Installed &middot; {installed.length}</h2>
        {installed.length === 0 ? (
          <p className="empty-hint">
            No plugins installed yet — install your product's plugin from the list above.
          </p>
        ) : (
          <div className="plugins-list">
            {installed.map(({ manifest }) => (
              <div key={manifest.product} className="plugins-row">
                <div className="plugins-row-body">
                  <span className="plugins-row-name">
                    {manifest.name} <span className="plugins-row-version">v{manifest.version}</span>
                  </span>
                  <span className="plugins-row-product">{manifest.product}</span>
                  {manifest.capabilities.length > 0 && (
                    <span className="plugins-row-caps">
                      can: {manifest.capabilities.join(', ')}
                    </span>
                  )}
                </div>
                <button
                  className="plugins-btn danger"
                  disabled={busy !== null}
                  onClick={() => handleRemove(manifest.product)}
                >
                  {busy === manifest.product ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
