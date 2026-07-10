import { useEffect, useState } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// T023/E1: the FR-012 banner must survive tab unmount/remount (SettingsTabs
// renders only the active tab). Module-level so navigating away and back still
// shows the last failed-binding state; cleared only on a successful bind.
let lastBannerError: string | null = null;

interface HotkeysTabProps {
  pttHotkey: string;
  onBound: (key: string) => void;
}

/** Map a browser keydown to a global-shortcut key name. Bare modifiers don't
 *  bind; unknown named keys pass through best-effort (backend parse failure
 *  maps to the key-conflict code). */
export function eventToShortcut(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  if (/^F\d{1,2}$/.test(e.key)) return e.key;
  if (e.key === ' ') return 'Space';
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export function HotkeysTab({ pttHotkey, onBound }: HotkeysTabProps) {
  const [listening, setListening] = useState(false);
  const [transientMsg, setTransientMsg] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(lastBannerError);
  const [keepWarning, setKeepWarning] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [pttActive, setPttActive] = useState(false);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      try {
        // T023/A1: press/release from the global-shortcut handler — the
        // SC-003 confirmation signal (fires even when the sim has focus).
        unlisteners.push(
          await listen<{ active: boolean }>('ptt:state', (e) => {
            if (!cancelled) setPttActive(e.payload.active);
          }),
        );
        // T022/U2: bound-but-not-persisted warning.
        unlisteners.push(
          await listen<{ reason: string }>('ptt:save-failed', (e) => {
            if (!cancelled)
              setSaveWarning(
                `PTT key bound for this session, but saving failed: ${e.payload.reason} — the binding will revert on restart.`,
              );
          }),
        );
      } catch (err) {
        console.error('ptt event listeners failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  const startBinding = () => {
    setListening(true);
    setTransientMsg(null);
    const hadPrevious = pttHotkey !== '';

    const onKey = (e: KeyboardEvent) => {
      const key = eventToShortcut(e);
      if (!key) return;
      e.preventDefault();
      window.removeEventListener('keydown', onKey, true);
      invoke('submit_ptt_key', { key }).catch(console.error);
    };
    window.addEventListener('keydown', onKey, true);

    invoke<string>('bind_ptt_hotkey')
      .then((keyName) => {
        lastBannerError = null;
        setBanner(null);
        setKeepWarning(null);
        onBound(keyName);
      })
      .catch((err) => {
        const code = String(err);
        // FR-012/A1 partition: transient interaction outcomes never show the
        // persistent banner; a failed REBIND with the old key restored gets a
        // dismissable warning (voice queries still work); only registration
        // failures leaving NO working binding qualify for the banner.
        if (code === 'ptt:timeout') {
          setTransientMsg('No key pressed — try again');
        } else if (code === 'ptt:capture-in-progress') {
          setTransientMsg('PTT is currently active — release the key first, then rebind.');
        } else if (code === 'ptt:accessibility-denied') {
          lastBannerError = code;
          setBanner(code);
        } else if (code === 'ptt:key-conflict') {
          if (hadPrevious) {
            setKeepWarning(
              `Couldn't bind the new key: this key is already bound by the OS — keeping ${pttHotkey}`,
            );
          } else {
            lastBannerError = code;
            setBanner(code);
          }
        } else {
          setTransientMsg(code);
        }
      })
      .finally(() => {
        setListening(false);
        window.removeEventListener('keydown', onKey, true);
      });
  };

  const bannerMessage =
    banner === 'ptt:accessibility-denied'
      ? IS_MAC
        ? 'Voice queries disabled — PTT key could not be registered: Accessibility permission required — open System Preferences → Privacy & Security → Accessibility'
        : 'Voice queries disabled — PTT key could not be registered: Could not register the PTT key — the OS rejected the binding. Try a different key or run the app as administrator.'
      : banner === 'ptt:key-conflict'
        ? 'Voice queries disabled — PTT key could not be registered: This key is already bound by the OS — try a different key'
        : null;

  return (
    <section>
      <h2>Push-to-Talk</h2>

      {/* FR-012 persistent banner — NOT dismissable; cleared only by a successful bind. */}
      {bannerMessage && (
        <div
          role="alert"
          data-testid="ptt-error-banner"
          style={{
            background: '#7f1d1d',
            color: '#fecaca',
            padding: '0.5rem 0.75rem',
            borderRadius: '4px',
            marginBottom: '0.75rem',
          }}
        >
          {bannerMessage}
          {banner === 'ptt:accessibility-denied' && IS_MAC && (
            <div style={{ marginTop: '0.4rem' }}>
              <button onClick={() => invoke('open_accessibility_settings').catch(console.error)}>
                Open Accessibility Settings
              </button>
            </div>
          )}
        </div>
      )}

      {/* A1: rebind failed but the previous working key was restored — dismissable. */}
      {keepWarning && (
        <p role="status" data-testid="ptt-keep-warning" style={{ color: '#f59e0b' }}>
          {keepWarning}{' '}
          <button style={{ fontSize: '0.75rem' }} onClick={() => setKeepWarning(null)}>
            ×
          </button>
        </p>
      )}

      {/* U2: bound for this session, persistence failed — dismissable. */}
      {saveWarning && (
        <p role="status" style={{ color: '#f59e0b' }}>
          {saveWarning}{' '}
          <button style={{ fontSize: '0.75rem' }} onClick={() => setSaveWarning(null)}>
            ×
          </button>
        </p>
      )}

      {/* F4: never-configured soft prompt — dismissable, NOT the FR-012 banner. */}
      {pttHotkey === '' && !promptDismissed && !bannerMessage && (
        <p data-testid="ptt-first-run-prompt" style={{ color: '#9ca3af' }}>
          No PTT key set — click 'Set PTT Key' to bind one.{' '}
          <button style={{ fontSize: '0.75rem' }} onClick={() => setPromptDismissed(true)}>
            ×
          </button>
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {pttHotkey !== '' && (
          <label>
            Key binding <input value={pttHotkey} readOnly style={{ width: '6rem' }} />
          </label>
        )}
        <button onClick={startBinding} disabled={listening}>
          Set PTT Key
        </button>
        {listening && <span style={{ color: '#9ca3af' }}>Listening for key…</span>}
        {/* T023/A1: the PTT-active indicator — the US3-2/SC-003 confirmation
            signal, driven by the global shortcut's press/release (works while
            the sim has focus). The mic meter cannot confirm this. */}
        <span
          aria-label="PTT active indicator"
          data-testid="ptt-indicator"
          data-active={pttActive}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.3rem',
            color: pttActive ? '#22c55e' : '#4b5563',
            fontWeight: 600,
          }}
        >
          ● PTT
        </span>
      </div>

      {transientMsg && (
        <p data-testid="ptt-transient" style={{ color: '#9ca3af', marginTop: '0.5rem' }}>
          {transientMsg}
        </p>
      )}

      <p style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.75rem' }}>
        Stream Deck: configure a button to send a keyboard key (e.g. F14) and bind it here —
        the passthrough maps buttons to keypresses, no bespoke integration needed.
      </p>
    </section>
  );
}
