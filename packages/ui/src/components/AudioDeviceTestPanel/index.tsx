import { useEffect, useRef, useState } from 'preact/hooks';
import { useMicLevel } from '../../hooks/useMicLevel.js';

type PlayState = 'idle' | 'loading' | 'success' | 'error';

const SYNTH_TIMEOUT_MS = 30_000;

export interface AudioDeviceTestPanelProps {
  /** Whether an output device is configured; disables the play button if false. */
  hasOutputDevice: boolean;
  /** Triggers the hub test-clip synthesis + playback (Tauri `test_audio_playback`). */
  onPlayTest: () => Promise<void>;
  /** The bound PTT hotkey, or empty/undefined if none. */
  pttHotkey?: string;
}

/**
 * Audio device test panel: playback test, mic input level meter, and PTT test.
 * Presentation-only — the host app injects the Tauri playback trigger so this
 * component (and packages/ui) stays Tauri-agnostic.
 */
export function AudioDeviceTestPanel({ hasOutputDevice, onPlayTest, pttHotkey }: AudioDeviceTestPanelProps) {
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const { level, error: micError } = useMicLevel(true);
  const [pttDetected, setPttDetected] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const fail = (detail: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    // eslint-disable-next-line no-console
    console.error('[AudioDeviceTestPanel] Play Test Clip failed:', detail);
    setErrorDetail(detail);
    setPlayState('error');
  };

  const handlePlay = () => {
    setErrorDetail(null);
    setPlayState('loading');
    // Transition to error if synthesis does not complete within 30s.
    timeoutRef.current = setTimeout(
      () => fail('No response within 30 seconds — hub or Chatterbox may be unreachable'),
      SYNTH_TIMEOUT_MS,
    );
    onPlayTest()
      .then(() => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setPlayState('success');
        setTimeout(() => setPlayState('idle'), 2000);
      })
      .catch((err: unknown) => {
        // The Tauri command rejects with the real reason (e.g. "hub returned 503",
        // "playback queue not ready", a connection error). Surface it verbatim.
        fail(err instanceof Error ? err.message : String(err));
      });
  };

  // PTT test: listen for the bound hotkey (browser keydown as the M4 stand-in).
  const pttBound = !!pttHotkey && pttHotkey.length > 0;
  useEffect(() => {
    if (!pttBound) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === pttHotkey!.toLowerCase() || e.code === pttHotkey) {
        setPttDetected(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pttBound, pttHotkey]);

  const levelPct = level != null ? Math.round(level * 100) : 0;

  return (
    <div class="audio-device-test-panel">
      <div class="test-row">
        <h3>Playback Test</h3>
        {!hasOutputDevice ? (
          <p class="hint">No audio device configured</p>
        ) : (
          <>
            <button onClick={handlePlay} disabled={playState === 'loading'}>
              {playState === 'loading' ? 'Synthesizing…' : 'Play Test Clip'}
            </button>
            {playState === 'success' && <span class="ok">✓ Played</span>}
            {playState === 'error' && (
              <span class="err">
                Audio synthesis failed — check Chatterbox service
                {errorDetail && <small class="err-detail"> ({errorDetail})</small>}
              </span>
            )}
          </>
        )}
      </div>

      <div class="test-row">
        <h3>Microphone Level</h3>
        {micError ? (
          <p class="hint" style={{ color: '#ef4444' }}>
            Microphone unavailable ({micError})
          </p>
        ) : level === null ? (
          <p class="hint" style={{ color: '#9ca3af' }}>Requesting microphone access…</p>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div
              class="mic-meter"
              aria-label="microphone level"
              style={{
                position: 'relative',
                flex: 1,
                height: '16px',
                background: '#e5e7eb',
                border: '1px solid #9ca3af',
                borderRadius: '4px',
                overflow: 'hidden',
              }}
            >
              <div
                class="mic-meter-fill"
                style={{
                  height: '100%',
                  width: `${levelPct}%`,
                  background: '#22c55e',
                  transition: 'width 60ms linear',
                }}
              />
            </div>
            <span style={{ width: '3rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {levelPct}%
            </span>
          </div>
        )}
      </div>

      <div class="test-row">
        <h3>Push-to-Talk Test</h3>
        {!pttBound ? (
          <p class="hint">No PTT key bound</p>
        ) : pttDetected ? (
          <span class="ok">PTT detected</span>
        ) : (
          <p class="hint">Press {pttHotkey} to test</p>
        )}
      </div>
    </div>
  );
}
