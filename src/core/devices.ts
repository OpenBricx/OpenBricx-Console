import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TransportKind } from './types';

export interface DiscoveredDevice {
  deviceId: string;
  product: string;
  fwVersion: string;
  chip: string;
  hwRev?: string;
  name?: string;
  host: string;
  port: number;
  transport: TransportKind;
  capabilities?: Record<string, unknown>;
}

// start/stop_discovery are async IPC with no ordering guarantee. The hook now
// mounts per-page (not once at the App root), so StrictMode's mount→unmount→
// mount — or fast page toggling — can interleave them: a stale stop landing
// AFTER the next start kills the fresh scan ("Scanning…" forever). Serialize
// every transition through one module-level chain so they run in issue order.
let discoveryChain: Promise<unknown> = Promise.resolve();
function enqueueDiscovery(op: () => Promise<unknown>) {
  discoveryChain = discoveryChain.then(op, op);
}

export function useDiscovery(): Map<string, DiscoveredDevice> {
  const [devices, setDevices] = useState<Map<string, DiscoveredDevice>>(new Map());

  useEffect(() => {
    enqueueDiscovery(() => invoke('start_discovery').catch(console.error));

    const unlistenFound = listen<DiscoveredDevice>('obx://discovered', (e) => {
      setDevices((prev) => new Map(prev).set(e.payload.deviceId, e.payload));
    });

    const unlistenLost = listen<{ deviceId: string }>('obx://lost', (e) => {
      setDevices((prev) => {
        const next = new Map(prev);
        next.delete(e.payload.deviceId);
        return next;
      });
    });

    return () => {
      enqueueDiscovery(() => invoke('stop_discovery').catch(console.error));
      unlistenFound.then((fn) => fn());
      unlistenLost.then((fn) => fn());
    };
  }, []);

  return devices;
}
