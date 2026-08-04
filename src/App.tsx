import './App.css';
import { useEffect, useState } from 'react';
import { NavShell } from './ui/NavShell';
import { HomePage } from './pages/HomePage';
import { DevicesPage } from './pages/DevicesPage';
import { FlashPage } from './pages/FlashPage';
import { PluginsPage } from './pages/PluginsPage';
import { AboutPage } from './pages/AboutPage';
import { OfflineConnection } from './core/transport';
import { usePlugins } from './core/usePlugins';
import type { Connection, Plugin, DeviceHandshake } from './core/types';
import type { Section } from './ui/NavShell';

type PluginView = { plugin: Plugin; connection: Connection; handshake?: DeviceHandshake };

function App() {
  const [section, setSection] = useState<Section>('home');
  const [pluginView, setPluginView] = useState<PluginView | null>(null);
  const { plugins, refresh } = usePlugins();

  function handleEnterPlugin(plugin: Plugin, connection: Connection, handshake?: DeviceHandshake) {
    setPluginView({ plugin, connection, handshake });
  }

  async function handleBack() {
    if (pluginView) {
      await pluginView.connection.close().catch(console.error);
      setPluginView(null);
    }
  }

  // Navigating via the sidebar while inside a plugin leaves the plugin
  // (and closes its connection) before switching sections.
  async function handleNav(s: Section) {
    if (pluginView) {
      await pluginView.connection.close().catch(console.error);
      setPluginView(null);
    }
    setSection(s);
  }

  return (
    <NavShell active={section} onNav={handleNav}>
      {pluginView ? (
        <PluginPane view={pluginView} onBack={handleBack} />
      ) : (
        <>
          {section === 'home' && <HomePage plugins={plugins} onEnterPlugin={handleEnterPlugin} />}
          {section === 'devices' && <DevicesPage plugins={plugins} onEnterPlugin={handleEnterPlugin} />}
          {section === 'flash' && <FlashPage plugins={plugins} onEnterPlugin={handleEnterPlugin} />}
          {section === 'plugins' && <PluginsPage onChanged={refresh} />}
          {section === 'about' && <AboutPage />}
        </>
      )}
    </NavShell>
  );
}

function PluginPane({ view, onBack }: { view: PluginView; onBack: () => void }) {
  const { plugin, connection, handshake } = view;
  const PluginRoot = plugin.Root;
  const isOffline = connection instanceof OfflineConnection;
  // Subscribe — reading connection.status once per render left the pill
  // frozen on "connected" after the device unplugged (nothing re-rendered).
  const [status, setStatus] = useState(connection.status);
  useEffect(() => {
    setStatus(connection.status);
    return connection.onStatusChange(setStatus);
  }, [connection]);
  const statusLabel = isOffline ? 'offline' : status;
  return (
    <div className="plugin-pane">
      <nav className="plugin-nav">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <span className="plugin-title">{plugin.manifest.name}</span>
        <span className={`status-pill status-${statusLabel}`}>{statusLabel}</span>
      </nav>
      <div className="plugin-body">
        <PluginRoot connection={connection} handshake={handshake} />
      </div>
    </div>
  );
}

export default App;

