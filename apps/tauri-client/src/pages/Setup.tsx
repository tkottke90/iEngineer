import { useEffect, useState } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { AudioDeviceTestPanel, PersonalityPanel, SettingsTabs } from '@iracing-engineer/ui';
import type { PersonalityValue } from '@iracing-engineer/ui';
import { DebugPanel } from './DebugPanel.js';
import { HotkeysTab } from './HotkeysTab.js';
import { isCloudLlmUrl } from '../constants.js';

interface ConnectionTestResult {
  service: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

type TestState = ConnectionTestResult | 'running' | null;

interface AudioDevice {
  name: string;
  direction: 'input' | 'output';
  isDefault: boolean;
}

interface UnavailableDevice {
  deviceType: 'input' | 'output';
  savedName: string;
}

interface VoiceProfileState {
  filename: string;
  uploadedAt: string;
  durationSeconds: number;
}

interface VoiceProfileResult extends VoiceProfileState {
  testClipUrl: string; // ephemeral — display/confirmation only, never stored
}

// Mirrors src-tauri/src/state.rs AppConfig (M10 — deprecated M4 string traits
// removed; LLM + telemetry-logging + first_launch_seen fields added).
interface AppConfig {
  redis_url: string;
  hub_url: string;
  // Unused in M10 and hidden from the UI (FR-007/E4), but carried through the
  // form state so Save never wipes a stored M4 token (T008/U3).
  connection_token: string;
  audio_input_device: string | null;
  audio_output_device: string | null;
  ptt_hotkey: string;
  openness: number;
  warmth: number;
  energy: number;
  conscientiousness: number;
  assertiveness: number;
  llm_base_url: string;
  llm_model: string;
  llm_api_key: string;
  telemetry_logging_enabled: boolean;
  telemetry_log_dir: string;
  first_launch_seen: boolean;
}

type ConnStatus = 'checking' | 'connected' | 'disconnected';

const STATUS_COLOR: Record<ConnStatus, string> = {
  connected: '#22c55e', // green
  disconnected: '#ef4444', // red
  checking: '#9ca3af', // gray
};

function StatusBadge({ status }: { status: ConnStatus }) {
  const label =
    status === 'connected' ? 'Connected' : status === 'checking' ? 'Checking…' : 'Disconnected';
  return (
    <span
      class={`conn-status ${status}`}
      style={{ color: STATUS_COLOR[status], fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      ● {label}
    </span>
  );
}

export type SetupTabId =
  | 'audio'
  | 'connection'
  | 'hotkeys'
  | 'personality'
  | 'debug'
  | 'voice'
  | 'logging';

interface SetupProps {
  /** Open a specific tab first — the /diagnostics redirect passes "debug". */
  initialTab?: SetupTabId;
}

export function Setup({ initialTab }: SetupProps = {}) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  // Single lifted form state (T008): every tab renders views over this object,
  // so unsaved edits survive tab switches. Seeded from get_config() on mount.
  const [formState, setFormState] = useState<AppConfig | null>(null);
  const [redisStatus, setRedisStatus] = useState<ConnStatus>('checking');
  const [hubStatus, setHubStatus] = useState<ConnStatus>('checking');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<UnavailableDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});
  // Dismissing the hint hides it for this session only; first_launch_seen is
  // set on successful Save (T020/I1).
  const [hintDismissed, setHintDismissed] = useState(false);
  const [logWarning, setLogWarning] = useState<string | null>(null);
  const [loggingError, setLoggingError] = useState<string | null>(null);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileState | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [hubSyncWarning, setHubSyncWarning] = useState<string | null>(null);

  const patch = (partial: Partial<AppConfig>) =>
    setFormState((prev) => (prev ? { ...prev, ...partial } : prev));

  useEffect(() => {
    invoke<AudioDevice[]>('list_audio_devices').then(setDevices).catch(console.error);
    invoke<AppConfig>('get_config').then(setFormState).catch(console.error);
    // T015/U1: startup-time unavailable-device events fire before this page
    // exists and are not replayed — mount-time state comes from the query; the
    // event subscription below covers live changes only.
    invoke<UnavailableDevice[]>('get_audio_device_status')
      .then(setUnavailable)
      .catch(console.error);
    // T037/E4: voice profile state lives in Redis, never in AppConfig — always
    // fetched on mount. Rejection = Redis unreachable (the I1 Err state).
    invoke<VoiceProfileState | null>('get_voice_profile')
      .then((profile) => {
        setVoiceProfile(profile);
        setVoiceStatus('ready');
      })
      .catch(() => setVoiceStatus('error'));

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      try {
        unlisteners.push(
          await listen<UnavailableDevice>('audio:device-unavailable', (e) => {
            if (cancelled) return;
            setUnavailable((prev) => [
              ...prev.filter((u) => u.deviceType !== e.payload.deviceType),
              e.payload,
            ]);
          }),
        );
        // T012/E2 → T015/E2: the mic level meter's data source. Always-on
        // device liveness — NOT a PTT indicator (that is the Hotkeys tab's).
        unlisteners.push(
          await listen<{ level: number }>('audio:mic-level', (e) => {
            if (!cancelled) setMicLevel(e.payload.level);
          }),
        );
        // T039: local save succeeded but the Redis hub sync failed —
        // dismissable, never blocks further saves (I3), and the local save is
        // never rolled back (C2). The next explicit Save retries (B2).
        unlisteners.push(
          await listen<{ reason: string }>('config:hub-sync-failed', (e) => {
            if (!cancelled)
              setHubSyncWarning(`Settings saved locally. Hub sync failed: ${e.payload.reason}`);
          }),
        );
        // T032/E2: each telemetry:log-warning reason gets its own message —
        // drain-timeout included (not optional).
        unlisteners.push(
          await listen<{ reason: string; dropped?: number; detail?: string; framesDiscarded?: number }>(
            'telemetry:log-warning',
            (e) => {
              if (cancelled) return;
              const p = e.payload;
              setLogWarning(
                p.reason === 'channel-full'
                  ? 'Logging buffer full — some frames were dropped'
                  : p.reason === 'disk-full'
                    ? `Disk write failed — logging stopped: ${p.detail ?? ''}`
                    : p.reason === 'drain-timeout'
                      ? `Logging stopped — ${p.framesDiscarded ?? 0} queued frames could not be flushed in time.`
                      : `Logging warning: ${p.reason}`,
              );
            },
          ),
        );
      } catch (err) {
        console.error('audio event listeners failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // T015: live device switch — applied immediately via set_audio_device (the
  // running capture/playback tasks re-init), while disk persistence waits for
  // the explicit Save button (save_config).
  const selectDevice = (deviceType: 'input' | 'output', deviceName: string) => {
    patch(
      deviceType === 'input'
        ? { audio_input_device: deviceName || null }
        : { audio_output_device: deviceName || null },
    );
    invoke('set_audio_device', { deviceName, deviceType })
      .then(() => {
        setDeviceError(null);
        setUnavailable((prev) => prev.filter((u) => u.deviceType !== deviceType));
      })
      .catch((e) => setDeviceError(String(e)));
  };

  // Live per-service connection status: check on mount and every 5s against the
  // current URL values (so a bad URL shows red as you type / after Save).
  const redisUrl = formState?.redis_url ?? '';
  const hubUrl = formState?.hub_url ?? '';
  useEffect(() => {
    if (!formState) return;
    let cancelled = false;
    const check = () => {
      invoke<boolean>('check_redis', { url: redisUrl })
        .then((ok) => !cancelled && setRedisStatus(ok ? 'connected' : 'disconnected'))
        .catch(() => !cancelled && setRedisStatus('disconnected'));
      invoke<boolean>('check_hub', { url: hubUrl })
        .then((ok) => !cancelled && setHubStatus(ok ? 'connected' : 'disconnected'))
        .catch(() => !cancelled && setHubStatus('disconnected'));
    };
    check();
    const id = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [redisUrl, hubUrl, formState !== null]);

  const handleSave = () => {
    if (!formState) return;
    // First successful explicit Save-button save suppresses the first-launch
    // LLM hint permanently (FR-007/U1 — the frontend sets the flag; the PTT
    // auto-save path never does, T022/A2).
    const toSave: AppConfig = { ...formState, first_launch_seen: true };
    invoke('save_config', { config: toSave })
      .then(() => {
        setFormState(toSave);
        setSaveError(null);
      })
      .catch((e) => setSaveError(String(e)));
  };

  if (!formState) {
    return <div class="setup">Loading settings…</div>;
  }

  const inputDevices = devices.filter((d) => d.direction === 'input');
  const outputDevices = devices.filter((d) => d.direction === 'output');

  const personality: PersonalityValue = {
    openness: formState.openness,
    warmth: formState.warmth,
    energy: formState.energy,
    conscientiousness: formState.conscientiousness,
    assertiveness: formState.assertiveness,
  };

  const unavailableInput = unavailable.find((u) => u.deviceType === 'input');
  const unavailableOutput = unavailable.find((u) => u.deviceType === 'output');

  const audioTab = (
    <section>
      <h2>Audio Devices</h2>
      {deviceError && (
        <p role="alert" style={{ color: '#ef4444' }}>
          {deviceError}
        </p>
      )}
      {unavailableInput && unavailableOutput && (
        <p role="alert" style={{ color: '#f59e0b' }}>
          Both saved audio devices are unavailable — please reselect your microphone and
          speaker.
        </p>
      )}
      <label>
        Microphone
        {inputDevices.length === 0 ? (
          <>
            <select disabled>
              <option>No audio input devices found</option>
            </select>
          </>
        ) : (
          <select
            value={formState.audio_input_device ?? ''}
            onChange={(e) => selectDevice('input', (e.target as HTMLSelectElement).value)}
          >
            <option value="">System default</option>
            {inputDevices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {unavailableInput && (
          <span style={{ color: '#f59e0b', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
            "{unavailableInput.savedName}" unavailable — using system default
          </span>
        )}
      </label>
      {/* T015/E2: mic level meter fed by audio:mic-level (Rust capture path) —
          confirms the SELECTED device is live, unlike a webview getUserMedia
          meter which may capture a different device. */}
      <div style={{ margin: '0.5rem 0' }}>
        <div
          aria-label="Microphone level"
          style={{
            width: '240px',
            height: '10px',
            background: '#1f2937',
            borderRadius: '5px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.round(Math.min(1, micLevel) * 100)}%`,
              height: '100%',
              background: micLevel > 0.02 ? '#22c55e' : '#374151',
              transition: 'width 80ms linear',
            }}
          />
        </div>
      </div>
      <label>
        Playback
        {outputDevices.length === 0 ? (
          <select disabled>
            <option>No audio output devices found</option>
          </select>
        ) : (
          <select
            value={formState.audio_output_device ?? ''}
            onChange={(e) => selectDevice('output', (e.target as HTMLSelectElement).value)}
          >
            <option value="">System default</option>
            {outputDevices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {unavailableOutput && (
          <span style={{ color: '#f59e0b', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
            "{unavailableOutput.savedName}" unavailable — using system default
          </span>
        )}
      </label>

      {/* FR-006 / T015-C3: "Test Playback" lives inside AudioDeviceTestPanel
          (M4), wired to the existing test_audio_playback() command — plays via
          the live device selection, no Save required. */}
      <AudioDeviceTestPanel
        hasOutputDevice={outputDevices.length > 0}
        onPlayTest={() => invoke('test_audio_playback')}
        pttHotkey={formState.ptt_hotkey}
      />
    </section>
  );

  // T020/G1 (FR-026/FR-009): full inline validation matrix — URL-format checks
  // on the three URL fields, non-empty on the model name, nothing on the
  // optional API key. Save is disabled while any message is present.
  const isValidUrl = (v: string) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  };
  const validationErrors: string[] = [
    ...(isValidUrl(formState.redis_url) ? [] : ['Redis URL is not a valid URL']),
    ...(isValidUrl(formState.hub_url) ? [] : ['Hub Server URL is not a valid URL']),
    ...(isValidUrl(formState.llm_base_url) ? [] : ['LLM Base URL is not a valid URL']),
    ...(formState.llm_model.trim() === ''
      ? ['LLM Model Name must not be blank — an empty model is not a valid configuration']
      : []),
  ];

  const runTest = (service: 'redis' | 'hub' | 'llm') => {
    setTestResults((prev) => ({ ...prev, [service]: 'running' }));
    const done = (result: ConnectionTestResult) =>
      setTestResults((prev) => ({ ...prev, [service]: result }));
    if (service === 'llm') {
      invoke<ConnectionTestResult>('check_llm', {
        baseUrl: formState.llm_base_url,
        model: formState.llm_model,
        apiKey: formState.llm_api_key,
      })
        .then(done)
        .catch((e) => done({ service, ok: false, latencyMs: null, error: String(e) }));
    } else {
      const cmd = service === 'redis' ? 'check_redis' : 'check_hub';
      const url = service === 'redis' ? formState.redis_url : formState.hub_url;
      invoke<boolean>(cmd, { url })
        .then((ok) =>
          done({ service, ok, latencyMs: null, error: ok ? null : 'not reachable' }),
        )
        .catch((e) => done({ service, ok: false, latencyMs: null, error: String(e) }));
    }
  };

  const TestButton = ({ service, label }: { service: 'redis' | 'hub' | 'llm'; label: string }) => {
    const result = testResults[service];
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
        <button onClick={() => runTest(service)} disabled={result === 'running'}>
          {label}
        </button>
        {result === 'running' && <span style={{ color: '#9ca3af' }}>…</span>}
        {result && result !== 'running' && (
          <span style={{ color: result.ok ? '#22c55e' : '#ef4444', fontSize: '0.85rem' }}>
            {result.ok
              ? `✓${result.latencyMs != null ? ` ${result.latencyMs}ms` : ''}`
              : `✗ ${result.error ?? 'failed'}`}
          </span>
        )}
      </span>
    );
  };

  const showFirstLaunchHint = !formState.first_launch_seen && !hintDismissed;
  const cloudLlmUrl = isCloudLlmUrl(formState.llm_base_url);

  const connField = (
    id: string,
    label: string,
    value: string,
    onValue: (v: string) => void,
    extra?: preact.ComponentChildren,
  ) => (
    <div
      class="conn-field"
      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}
    >
      <label htmlFor={id} style={{ width: '9rem' }}>
        {label}
      </label>
      <input
        id={id}
        type={id === 'llm-api-key' ? 'password' : 'text'}
        style={{ flex: 1 }}
        value={value}
        onInput={(e) => onValue((e.target as HTMLInputElement).value)}
      />
      {extra}
    </div>
  );

  const connectionTab = (
    <section>
      <h2>Connection</h2>
      {validationErrors.length > 0 && (
        <ul role="alert" style={{ color: '#ef4444', fontSize: '0.85rem', paddingLeft: '1.2rem' }}>
          {validationErrors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {connField(
        'redis-url',
        'Redis URL',
        formState.redis_url,
        (v) => patch({ redis_url: v }),
        <>
          <StatusBadge status={redisStatus} />
          <TestButton service="redis" label="Test Redis" />
        </>,
      )}
      {connField(
        'hub-url',
        'Hub Server URL',
        formState.hub_url,
        (v) => patch({ hub_url: v }),
        <>
          <StatusBadge status={hubStatus} />
          <TestButton service="hub" label="Test Hub" />
        </>,
      )}
      {showFirstLaunchHint && (
        <p
          style={{
            color: '#93c5fd',
            fontSize: '0.8rem',
            background: '#1e3a5f',
            padding: '0.4rem 0.6rem',
            borderRadius: '4px',
          }}
        >
          Default — update for your setup. The LLM fields below are pre-filled with
          developer-specific homelab defaults; saving them unchanged is fine for that setup.{' '}
          <button
            style={{ fontSize: '0.75rem' }}
            onClick={() => setHintDismissed(true)}
            aria-label="Dismiss hint"
          >
            ×
          </button>
        </p>
      )}
      {connField('llm-base-url', 'LLM API Base URL', formState.llm_base_url, (v) =>
        patch({ llm_base_url: v }),
      )}
      {cloudLlmUrl && (
        <p style={{ color: '#f59e0b', fontSize: '0.8rem' }}>
          API key is stored locally but not forwarded to the hub server — Tier 3 synthesis
          will fail if this endpoint requires authentication. Cloud API key forwarding is
          planned for a future milestone.
        </p>
      )}
      {connField('llm-model', 'LLM Model', formState.llm_model, (v) => patch({ llm_model: v }))}
      {connField(
        'llm-api-key',
        'LLM API Key',
        formState.llm_api_key,
        (v) => patch({ llm_api_key: v }),
        <TestButton service="llm" label="Test LLM" />,
      )}
    </section>
  );

  const hotkeysTab = (
    <HotkeysTab
      pttHotkey={formState.ptt_hotkey}
      onBound={(key) => patch({ ptt_hotkey: key })}
    />
  );

  const personalityTab = (
    <section>
      <h2>Engineer Personality</h2>
      <p style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: 0 }}>
        Five traits, each 1–5. Energy at 1 (Tranquil) keeps the engineer quiet — it suppresses
        Tier 2 alerts and Tier 3 commentary.
      </p>
      <PersonalityPanel value={personality} onChange={(v) => patch({ ...v })} />
      {/* T025/E2 (FR-014): visible the moment Energy hits 1 — no Save needed. */}
      {personality.energy === 1 && (
        <p role="status" style={{ color: '#f59e0b', fontSize: '0.85rem' }}>
          Quiet mode: Tier 2 and Tier 3 commentary will be suppressed.
        </p>
      )}
    </section>
  );

  const voiceTab = (
    <section>
      <h2>Voice Profile</h2>
      {/* I1 contract — three DISTINCT states from get_voice_profile():
          Ok(Some) = active profile; Ok(None) = no profile; Err = Redis down. */}
      {voiceStatus === 'loading' && <p style={{ color: '#9ca3af' }}>Loading…</p>}
      {voiceStatus === 'error' && (
        <p role="alert" style={{ color: '#ef4444' }}>
          Redis unreachable — profile status unavailable
        </p>
      )}
      {voiceStatus === 'ready' &&
        (voiceProfile ? (
          <p>
            Active profile: <code>{voiceProfile.filename}</code>
            <br />
            <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>
              Uploaded {voiceProfile.uploadedAt} — {voiceProfile.durationSeconds}s
            </span>
          </p>
        ) : (
          <p style={{ color: '#9ca3af' }}>Default voice (no profile uploaded)</p>
        ))}
      {voiceError && (
        <p role="alert" style={{ color: '#ef4444' }}>
          {voiceError}
        </p>
      )}
      <label style={{ display: 'block', margin: '0.5rem 0' }}>
        Upload Voice Profile (MP3, 3–60s)
        <input
          type="file"
          accept=".mp3,audio/mpeg"
          disabled={uploading}
          onChange={async (e) => {
            const input = e.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;
            setUploading(true);
            setVoiceError(null);
            try {
              // Webview file inputs expose bytes, not a filesystem path
              // (Tauri v2 sandbox) — same validation/timeout core as the
              // path-based contract command.
              const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
              const result = await invoke<VoiceProfileResult>('upload_voice_profile_data', {
                fileName: file.name,
                data: bytes,
              });
              // Show the result immediately from the upload response — no
              // remount / re-query needed (T037).
              setVoiceProfile({
                filename: result.filename,
                uploadedAt: result.uploadedAt,
                durationSeconds: result.durationSeconds,
              });
              setVoiceStatus('ready');
            } catch (err) {
              setVoiceError(String(err));
            } finally {
              setUploading(false);
              input.value = '';
            }
          }}
        />
      </label>
      {uploading && <p style={{ color: '#9ca3af' }}>Uploading…</p>}
      {/* U4: real-time Chatterbox synthesis via the existing M4 command — the
          hub's in-memory voice file switched at upload, so this plays the
          cloned voice. testClipUrl from the upload response is ephemeral and
          intentionally not reused here (C4). */}
      <button onClick={() => invoke('test_audio_playback').catch((e) => setVoiceError(String(e)))}>
        Test Voice
      </button>
    </section>
  );

  // T032/G2 (FR-019/U3): an unresolved sentinel path disables the toggle —
  // logging cannot be enabled with no valid destination.
  const logDirUnresolved = formState.telemetry_log_dir === '';
  const loggingTab = (
    <section>
      <h2>Telemetry Logging</h2>
      {logWarning && (
        <p role="alert" style={{ color: '#f59e0b' }}>
          {logWarning}{' '}
          <button style={{ fontSize: '0.75rem' }} onClick={() => setLogWarning(null)}>
            ×
          </button>
        </p>
      )}
      {loggingError && (
        <p role="alert" style={{ color: '#ef4444' }}>
          {loggingError}
        </p>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={formState.telemetry_logging_enabled}
          disabled={logDirUnresolved}
          onChange={(e) => {
            const enabled = (e.target as HTMLInputElement).checked;
            invoke('toggle_telemetry_logging', { enabled })
              .then(() => {
                setLoggingError(null);
                patch({ telemetry_logging_enabled: enabled });
              })
              .catch((err) => setLoggingError(String(err)));
          }}
        />
        Log raw session telemetry
      </label>
      <p style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
        Log directory (read-only):{' '}
        {logDirUnresolved ? (
          <span style={{ color: '#ef4444' }}>Log directory path could not be resolved</span>
        ) : (
          <code>{formState.telemetry_log_dir}</code>
        )}
      </p>
      <p style={{ fontSize: '0.75rem', color: '#6b7280' }}>
        One .ndjson file per session. Logging runs on an isolated write path — it never
        delays real-time alerts.
      </p>
    </section>
  );

  return (
    <div class="setup">
      {saveError && (
        <div
          role="alert"
          style={{
            background: '#7f1d1d',
            color: '#fecaca',
            padding: '0.5rem 0.75rem',
            borderRadius: '4px',
            marginBottom: '0.75rem',
          }}
        >
          {saveError}
          <span style={{ display: 'block', fontSize: '0.75rem', color: '#fca5a5' }}>
            Your changes are still in the form — fix the cause and click Save to retry.
          </span>
        </div>
      )}
      {hubSyncWarning && (
        <div
          role="status"
          style={{
            background: '#78350f',
            color: '#fde68a',
            padding: '0.5rem 0.75rem',
            borderRadius: '4px',
            marginBottom: '0.75rem',
          }}
        >
          {hubSyncWarning}{' '}
          <button style={{ fontSize: '0.75rem' }} onClick={() => setHubSyncWarning(null)}>
            ×
          </button>
        </div>
      )}
      <SettingsTabs
        initialTabId={initialTab}
        tabs={[
          { id: 'audio', label: 'Audio', content: audioTab },
          { id: 'connection', label: 'Connection', content: connectionTab },
          { id: 'hotkeys', label: 'Hotkeys', content: hotkeysTab },
          { id: 'personality', label: 'Personality', content: personalityTab },
          { id: 'debug', label: 'Debug', content: <DebugPanel /> },
          { id: 'voice', label: 'Voice', content: voiceTab },
          { id: 'logging', label: 'Logging', content: loggingTab },
        ]}
      />
      <div style={{ marginTop: '1rem', borderTop: '1px solid #333', paddingTop: '0.75rem' }}>
        <button onClick={handleSave} disabled={validationErrors.length > 0}>
          Save
        </button>
        {validationErrors.length > 0 && (
          <span style={{ color: '#9ca3af', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
            Fix the validation errors in the Connection tab to save.
          </span>
        )}
      </div>
    </div>
  );
}
