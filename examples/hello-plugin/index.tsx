// A minimal *external* OpenBricx plugin — the proof that a separately-built,
// signed bundle loads into the Console and shares its React (hooks work). It only
// imports from 'react' and '@openbricx/host'; both resolve to the host at runtime.
import { useState, useEffect } from 'react';
import { version as hostVersion, type Connection, type PluginProps } from '@openbricx/host';

export const manifest = {
  product: 'openbricx-hello',
  name: 'Hello Plugin',
  icon: 'hello',
  transports: ['wifi'] as const,
};

export function Root({ connection }: PluginProps) {
  // useState + useEffect exercise the hook dispatcher — the thing that breaks if
  // the plugin ever ends up with its own second copy of React.
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTicks((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hello-plugin">
      <h2>Hello from an external, signed plugin</h2>
      <p>Host SDK version: {hostVersion}</p>
      <p>Connection status: {connection.status}</p>
      <p>Ticks since mount: {ticks}</p>
    </div>
  );
}

export function createDriver(connection: Connection) {
  return {
    ping: () => connection.send(new Uint8Array([0x01])),
  };
}
