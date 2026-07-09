// T023 tests: the FR-012/A1 banner partition and E1 persistence-across-remount.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/preact';
import { HotkeysTab, eventToShortcut } from './HotkeysTab.js';

// Mutable per-test behavior for bind_ptt_hotkey.
let bindBehavior: () => Promise<string> = () => Promise.resolve('F14');

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === 'bind_ptt_hotkey') return bindBehavior();
    return Promise.resolve(null);
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

beforeEach(() => {
  cleanup();
  // Clear the module-level banner memory between tests by binding successfully.
  bindBehavior = () => Promise.resolve('F14');
});

async function clickSetKey(getByRole: ReturnType<typeof render>['getByRole']) {
  (getByRole('button', { name: 'Set PTT Key' }) as HTMLButtonElement).click();
}

describe('HotkeysTab — FR-012/A1 error partition', () => {
  it('E1: the accessibility-denied banner persists across unmount/remount, cleared only by a successful bind', async () => {
    bindBehavior = () => Promise.reject('ptt:accessibility-denied');
    const first = render(<HotkeysTab pttHotkey="" onBound={() => {}} />);
    await clickSetKey(first.getByRole);
    await waitFor(() => expect(first.getByTestId('ptt-error-banner')).toBeTruthy());
    expect(first.getByTestId('ptt-error-banner').textContent).toContain(
      'Voice queries disabled',
    );
    first.unmount();

    // Remount (simulates navigating to another tab and back) — still visible.
    const second = render(<HotkeysTab pttHotkey="" onBound={() => {}} />);
    expect(second.getByTestId('ptt-error-banner')).toBeTruthy();
    second.unmount();

    // A successful bind clears it for subsequent mounts.
    bindBehavior = () => Promise.resolve('F15');
    const third = render(<HotkeysTab pttHotkey="" onBound={() => {}} />);
    await clickSetKey(third.getByRole);
    await waitFor(() => expect(third.queryByTestId('ptt-error-banner')).toBeNull());
  });

  it('A1: a key-conflict REBIND with a previous working key shows the dismissable keeping-warning, NOT the banner', async () => {
    bindBehavior = () => Promise.reject('ptt:key-conflict');
    const { getByRole, getByTestId, queryByTestId } = render(
      <HotkeysTab pttHotkey="F13" onBound={() => {}} />,
    );
    await clickSetKey(getByRole);
    await waitFor(() => expect(getByTestId('ptt-keep-warning')).toBeTruthy());
    expect(getByTestId('ptt-keep-warning').textContent).toContain('keeping F13');
    expect(
      queryByTestId('ptt-error-banner'),
      'voice queries still work — "disabled" banner would be false',
    ).toBeNull();
  });

  it('A1: a key-conflict FIRST-EVER bind (no previous key) qualifies for the banner', async () => {
    bindBehavior = () => Promise.reject('ptt:key-conflict');
    const { getByRole, getByTestId } = render(<HotkeysTab pttHotkey="" onBound={() => {}} />);
    await clickSetKey(getByRole);
    await waitFor(() => expect(getByTestId('ptt-error-banner')).toBeTruthy());
    // Reset module banner state for other tests.
    bindBehavior = () => Promise.resolve('F15');
    await clickSetKey(getByRole);
    await waitFor(() => expect(getByRole('button', { name: 'Set PTT Key' })).toBeTruthy());
  });

  it('A1: ptt:timeout shows only the inline transient message — never the banner', async () => {
    bindBehavior = () => Promise.reject('ptt:timeout');
    const { getByRole, getByTestId, queryByTestId } = render(
      <HotkeysTab pttHotkey="F13" onBound={() => {}} />,
    );
    await clickSetKey(getByRole);
    await waitFor(() => expect(getByTestId('ptt-transient')).toBeTruthy());
    expect(getByTestId('ptt-transient').textContent).toContain('No key pressed');
    expect(queryByTestId('ptt-error-banner')).toBeNull();
  });

  it('F4: the never-configured prompt is a dismissable soft prompt, not a banner', async () => {
    const { getByTestId, queryByTestId } = render(<HotkeysTab pttHotkey="" onBound={() => {}} />);
    expect(getByTestId('ptt-first-run-prompt').textContent).toContain('No PTT key set');
    expect(queryByTestId('ptt-error-banner')).toBeNull();
  });
});

describe('eventToShortcut', () => {
  it('maps F-keys, letters, and space; ignores bare modifiers', () => {
    expect(eventToShortcut({ key: 'F14' } as KeyboardEvent)).toBe('F14');
    expect(eventToShortcut({ key: 'a' } as KeyboardEvent)).toBe('A');
    expect(eventToShortcut({ key: ' ' } as KeyboardEvent)).toBe('Space');
    expect(eventToShortcut({ key: 'Shift' } as KeyboardEvent)).toBeNull();
    expect(eventToShortcut({ key: 'Control' } as KeyboardEvent)).toBeNull();
  });
});
