// Build-time shim: a plugin's `import ... from 'react'` resolves here, so the
// plugin shares the Console's single React instance instead of bundling its own
// (two Reacts in one page => "Invalid hook call"). At runtime this reads the React
// the Console put on `window.__OPENBRICX__`.
const React = (globalThis as any).__OPENBRICX__?.react;
if (!React) {
  throw new Error('OpenBricx host React unavailable — plugin loaded outside the Console?');
}

export default React;
export const {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useContext,
  useReducer,
  useLayoutEffect,
  useImperativeHandle,
  useId,
  useSyncExternalStore,
  useTransition,
  useDeferredValue,
  useDebugValue,
  createContext,
  createElement,
  cloneElement,
  isValidElement,
  Children,
  Fragment,
  StrictMode,
  Component,
  PureComponent,
  memo,
  forwardRef,
  lazy,
  Suspense,
  startTransition,
  createRef,
  version,
} = React;
