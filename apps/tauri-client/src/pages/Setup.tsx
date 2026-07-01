import { useEffect, useState } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { AudioDeviceTestPanel } from '@iracing-engineer/ui';

interface AudioDevice {
  name: string;
  direction: 'input' | 'output';
  isDefault: boolean;
}

interface AppConfig {
  redis_url: string;
  hub_url: string;
  connection_token: string;
  audio_input_device: string | null;
  audio_output_device: string | null;
  ptt_hotkey: string;
  chattiness: string;
  familiarity: string;
  aggression: string;
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

export function Setup() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [redisUrl, setRedisUrl] = useState('redis://localhost:6379');
  const [hubUrl, setHubUrl] = useState('http://localhost:5173');
  const [pttKey, _setPttKey] = useState('F13');
  const [chattiness, setChattiness] = useState<'Default' | 'Low'>('Default');
  const [redisStatus, setRedisStatus] = useState<ConnStatus>('checking');
  const [hubStatus, setHubStatus] = useState<ConnStatus>('checking');
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    invoke<AudioDevice[]>('list_audio_devices').then(setDevices).catch(console.error);
    // Load stored config (including URLs) from AppState on mount.
    invoke<AppConfig>('get_config')
      .then((c) => {
        setConfig(c);
        setRedisUrl(c.redis_url);
        setHubUrl(c.hub_url);
        if (c.chattiness === 'Low' || c.chattiness === 'Default') setChattiness(c.chattiness);
      })
      .catch(console.error);
  }, []);

  // Live per-service connection status: check on mount and every 5s against the
  // current URL values (so a bad URL shows red as you type / after Save).
  useEffect(() => {
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
  }, [redisUrl, hubUrl]);

  const handleSave = () => {
    const updated: AppConfig = {
      ...(config ?? {
        redis_url: redisUrl,
        hub_url: hubUrl,
        connection_token: '',
        audio_input_device: null,
        audio_output_device: null,
        ptt_hotkey: pttKey,
        chattiness,
        familiarity: 'Default',
        aggression: 'Default',
      }),
      redis_url: redisUrl,
      hub_url: hubUrl,
      chattiness,
    };
    invoke('save_config', { config: updated })
      .then(() => setConfig(updated))
      .catch(console.error);
  };

  const inputDevices = devices.filter((d) => d.direction === 'input');
  const outputDevices = devices.filter((d) => d.direction === 'output');

  return (
    <div class="setup">
      <section>
        <h2>Connection</h2>
        <div
          class="conn-field"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}
        >
          <label htmlFor="redis-url" style={{ width: '9rem' }}>
            Redis URL
          </label>
          <input
            id="redis-url"
            style={{ flex: 1 }}
            value={redisUrl}
            onInput={(e) => setRedisUrl((e.target as HTMLInputElement).value)}
          />
          <StatusBadge status={redisStatus} />
        </div>
        <div
          class="conn-field"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}
        >
          <label htmlFor="hub-url" style={{ width: '9rem' }}>
            Hub Server URL
          </label>
          <input
            id="hub-url"
            style={{ flex: 1 }}
            value={hubUrl}
            onInput={(e) => setHubUrl((e.target as HTMLInputElement).value)}
          />
          <StatusBadge status={hubStatus} />
        </div>
        <button onClick={handleSave}>Save</button>
      </section>

      <section>
        <h2>Audio Devices</h2>
        <label>
          Microphone
          <select>
            {inputDevices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Playback
          <select>
            {outputDevices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <AudioDeviceTestPanel
          hasOutputDevice={outputDevices.length > 0}
          onPlayTest={() => invoke('test_audio_playback')}
          pttHotkey={config?.ptt_hotkey ?? pttKey}
        />
      </section>

      <section>
        <h2>Push-to-Talk</h2>
        <label>
          Key binding
          <input value={pttKey} readOnly placeholder="Press key..." />
        </label>
      </section>

      <section>
        <h2>Racing Engineer</h2>
        <label>
          Chattiness{' '}
          <select
            value={chattiness}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as 'Default' | 'Low';
              setChattiness(v);
            }}
          >
            <option value="Default">Default — all alerts</option>
            <option value="Low">Low — suppress Tier 2 alerts</option>
          </select>
        </label>
        <button onClick={handleSave}>Save</button>
      </section>
    </div>
  );
}
