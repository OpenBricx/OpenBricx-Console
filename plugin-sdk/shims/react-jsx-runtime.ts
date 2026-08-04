// Build-time shim for the automatic JSX runtime. A plugin's compiled JSX emits
// imports from 'react/jsx-runtime'; they resolve here and read the Console's React,
// keeping a single React instance across host and plugin.
const rt = (globalThis as any).__OPENBRICX__?.jsxRuntime;
if (!rt) {
  throw new Error('OpenBricx host jsx-runtime unavailable — plugin loaded outside the Console?');
}

export const jsx = rt.jsx;
export const jsxs = rt.jsxs;
export const Fragment = rt.Fragment;
