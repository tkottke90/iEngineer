import { useEffect, useState } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';

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
}

export function Setup() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [redisUrl, setRedisUrl] = useState('redis://localhost:6379');
  const [hubUrl, setHubUrl] = useState('http://localhost:3000');
  const [pttKey, _setPttKey] = useState('F13');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>(
    'disconnected',
  );
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    invoke<AudioDevice[]>('list_audio_devices').then(setDevices).catch(console.error);
    invoke('get_connection_status')
      .then((s: unknown) => {
        setConnectionStatus(s as 'connected' | 'disconnected');
      })
      .catch(console.error);
    // T028: load stored config (including Redis URL) from AppState on mount
    invoke<AppConfig>('get_config')
      .then((c) => {
        setConfig(c);
        setRedisUrl(c.redis_url);
        setHubUrl(c.hub_url);
      })
      .catch(console.error);
  }, []);

  const handleSave = () => {
    const updated: AppConfig = {
      ...(config ?? {
        redis_url: redisUrl,
        hub_url: hubUrl,
        connection_token: '',
        audio_input_device: null,
        audio_output_device: null,
        ptt_hotkey: pttKey,
      }),
      redis_url: redisUrl,
      hub_url: hubUrl,
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
        <label>
          Redis URL{' '}
          <input
            value={redisUrl}
            onInput={(e) => setRedisUrl((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Hub URL{' '}
          <input value={hubUrl} onInput={(e) => setHubUrl((e.target as HTMLInputElement).value)} />
        </label>
        <button onClick={handleSave}>Save</button>
        <span class={`status ${connectionStatus}`}>{connectionStatus}</span>
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
      </section>

      <section>
        <h2>Push-to-Talk</h2>
        <label>
          Key binding
          <input value={pttKey} readOnly placeholder="Press key..." />
        </label>
      </section>
    </div>
  );
}
