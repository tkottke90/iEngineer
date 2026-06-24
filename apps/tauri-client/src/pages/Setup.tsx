import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { invoke } from "@tauri-apps/api/core";

interface AudioDevice {
  name: string;
  direction: "input" | "output";
  isDefault: boolean;
}

export function Setup() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [redisUrl, setRedisUrl] = useState("redis://localhost:6379");
  const [hubUrl, setHubUrl] = useState("http://localhost:3000");
  const [pttKey, setPttKey] = useState("F13");
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected">("disconnected");

  useEffect(() => {
    invoke<AudioDevice[]>("list_audio_devices").then(setDevices).catch(console.error);
    invoke("get_connection_status").then((s: unknown) => {
      setConnectionStatus(s as "connected" | "disconnected");
    }).catch(console.error);
  }, []);

  const inputDevices = devices.filter((d) => d.direction === "input");
  const outputDevices = devices.filter((d) => d.direction === "output");

  return (
    <div class="setup">
      <section>
        <h2>Connection</h2>
        <label>Redis URL <input value={redisUrl} onInput={(e) => setRedisUrl((e.target as HTMLInputElement).value)} /></label>
        <label>Hub URL <input value={hubUrl} onInput={(e) => setHubUrl((e.target as HTMLInputElement).value)} /></label>
        <span class={`status ${connectionStatus}`}>{connectionStatus}</span>
      </section>

      <section>
        <h2>Audio Devices</h2>
        <label>Microphone
          <select>
            {inputDevices.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </label>
        <label>Playback
          <select>
            {outputDevices.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </label>
      </section>

      <section>
        <h2>Push-to-Talk</h2>
        <label>Key binding
          <input value={pttKey} readOnly placeholder="Press key..." />
        </label>
      </section>
    </div>
  );
}
