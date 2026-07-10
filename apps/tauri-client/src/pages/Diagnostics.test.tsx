// FR-030 redirect test (M10 T009 — Constitution VI): the Diagnostics page must
// land in the Settings panel with the Debug tab active, not a blank page.
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { Diagnostics } from './Diagnostics.js';

const DEFAULT_CONFIG = {
  redis_url: 'redis://localhost:6379',
  hub_url: 'http://localhost:5173',
  connection_token: '',
  audio_input_device: null,
  audio_output_device: null,
  ptt_hotkey: '',
  openness: 3,
  warmth: 3,
  energy: 3,
  conscientiousness: 3,
  assertiveness: 3,
  llm_base_url: 'https://lemonade.tdkottke.com/v1',
  llm_model: 'user.Ornith-1.0-35B-GGUF',
  llm_api_key: '',
  telemetry_logging_enabled: false,
  telemetry_log_dir: '/tmp/logs/telemetry',
  first_launch_seen: false,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    switch (cmd) {
      case 'get_config':
        return Promise.resolve(DEFAULT_CONFIG);
      case 'list_audio_devices':
      case 'list_telemetry_fields':
      case 'get_watchlist':
      case 'get_audio_device_status':
        return Promise.resolve([]);
      case 'check_redis':
      case 'check_hub':
        return Promise.resolve(false);
      case 'get_iracing_status':
        return Promise.resolve('Disconnected');
      case 'get_session_data':
      case 'get_focused_car_data':
        return Promise.resolve(null);
      case 'get_sdk_debug':
        return Promise.resolve({});
      default:
        return Promise.resolve(null);
    }
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe('Diagnostics (FR-030 redirect)', () => {
  it('renders the Settings panel with the Debug tab active', async () => {
    const { getByRole, getAllByRole } = render(<Diagnostics />);

    // Settings loads its config asynchronously; wait for the tab bar.
    await waitFor(() => {
      expect(getAllByRole('tab').length).toBe(7);
    });

    // It IS the settings page (all seven tabs present)…
    const labels = getAllByRole('tab').map((t) => t.textContent);
    expect(labels).toEqual([
      'Audio',
      'Connection',
      'Hotkeys',
      'Personality',
      'Debug',
      'Voice',
      'Logging',
    ]);

    // …with the Debug tab active, showing the absorbed diagnostics content.
    expect(getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected')).toBe('true');
    expect(getByRole('tab', { name: 'Audio' }).getAttribute('aria-selected')).toBe('false');
    await waitFor(() => {
      expect(getByRole('heading', { name: 'Connection Status' })).toBeTruthy();
    });
  });
});
