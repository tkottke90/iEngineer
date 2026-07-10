import { Setup } from './Setup.js';

/**
 * FR-030 (M10 T009): the Diagnostics page is now a thin redirect into the
 * Settings page with the Debug tab active. The former diagnostics content
 * lives in DebugPanel.tsx, rendered inside that tab — existing nav entries
 * that open "Diagnostics" keep working and land on the same content.
 */
export function Diagnostics() {
  return <Setup initialTab="debug" />;
}
