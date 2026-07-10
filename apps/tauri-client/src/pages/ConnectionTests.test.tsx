// Repro for manual-testing finding 3.1.2: "Test Redis button does nothing".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, cleanup } from '@testing-library/preact';
import { Setup } from './Setup.js';

// No Vitest globals in this project → testing-library's auto-cleanup does not
// register; without this, renders accumulate across tests.
beforeEach(cleanup);

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
  first_launch_seen: true,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    switch (cmd) {
      case 'get_config':
        return Promise.resolve(DEFAULT_CONFIG);
      case 'list_audio_devices':
      case 'get_audio_device_status':
        return Promise.resolve([]);
      case 'check_redis':
        return Promise.resolve(true);
      case 'check_hub':
        return Promise.resolve(false);
      case 'check_llm':
        return Promise.resolve({
          service: 'llm',
          ok: true,
          latencyMs: 42,
          error: null,
        });
      case 'get_voice_profile':
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe('Connection tab Test buttons (finding 3.1.2)', () => {
  it('Test Redis shows a visible result after clicking', async () => {
    const { getByRole, getByTestId } = render(<Setup initialTab="connection" />);
    await waitFor(() => getByRole('button', { name: 'Test Redis' }));

    fireEvent.click(getByRole('button', { name: 'Test Redis' }));

    await waitFor(() => {
      expect(getByTestId('test-result-redis').textContent).toContain('✓');
    });
  });

  it('Test Hub shows a failure result; Test LLM shows latency', async () => {
    const { getByRole, getByTestId } = render(<Setup initialTab="connection" />);
    await waitFor(() => getByRole('button', { name: 'Test Hub' }));

    fireEvent.click(getByRole('button', { name: 'Test Hub' }));
    await waitFor(() => {
      expect(getByTestId('test-result-hub').textContent).toContain('✗');
    });

    fireEvent.click(getByRole('button', { name: 'Test LLM' }));
    await waitFor(() => {
      expect(getByTestId('test-result-llm').textContent).toContain('42ms');
    });
  });
});
