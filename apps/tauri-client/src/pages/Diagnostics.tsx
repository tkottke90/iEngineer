import { useState, useEffect } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

type ConnectionStatus = 'Connected' | 'Disconnected' | 'Connecting';

interface SessionInfo {
  track_name: string;
  session_type: string;
  car_name: string;
  wall_clock_time: string;
}

type TelemetryValue =
  | { Float: number }
  | { Double: number }
  | { Int: number }
  | { Bool: boolean }
  | { Bitfield: number }
  | { Char: string }
  | { FloatArray: number[] }
  | { IntArray: number[] }
  | 'Unavailable';

interface TelemetryField {
  name: string;
  description: string;
  unit: string;
  var_type: string;
  value: TelemetryValue;
}

function formatValue(v: TelemetryValue): string {
  if (v === 'Unavailable') return 'Unavailable';
  if ('Float' in v) return v.Float.toFixed(3);
  if ('Double' in v) return v.Double.toFixed(3);
  if ('Int' in v) return String(v.Int);
  if ('Bool' in v) return v.Bool ? 'true' : 'false';
  if ('Bitfield' in v) return `0x${v.Bitfield.toString(16)}`;
  if ('Char' in v) return v.Char;
  if ('FloatArray' in v) return v.FloatArray.map((n) => n.toFixed(2)).join(', ');
  if ('IntArray' in v) return v.IntArray.join(', ');
  return '—';
}

export function Diagnostics() {
  const [status, setStatus] = useState<ConnectionStatus>('Disconnected');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [fields, setFields] = useState<TelemetryField[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [tickValues, setTickValues] = useState<Record<string, TelemetryValue>>({});

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    (async () => {
      // ── Initialise from current state ──────────────────────────────────────
      const s = await invoke<ConnectionStatus>('get_iracing_status').catch(() => 'Disconnected' as ConnectionStatus);
      setStatus(s);

      const sess = await invoke<SessionInfo | null>('get_session_data').catch(() => null);
      setSession(sess);

      const wl = await invoke<string[]>('get_watchlist').catch(() => []);
      setWatchlist(wl);

      // If already connected, populate field browser
      if (s === 'Connected') {
        const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
        setFields(f);
      }

      // ── Live event listeners ───────────────────────────────────────────────
      unlisteners.push(
        await listen<ConnectionStatus>('iracing://status-changed', async (e) => {
          setStatus(e.payload);
          if (e.payload === 'Connected') {
            // Populate field browser as soon as we connect (avoids race with session-changed)
            const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
            setFields(f);
          } else {
            setFields([]);
            setSession(null);
          }
        }),
      );

      unlisteners.push(
        await listen<SessionInfo | null>('iracing://session-changed', async (e) => {
          setSession(e.payload);
          if (e.payload) {
            // Re-enumerate — new session may expose different fields
            const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
            setFields(f);
          }
        }),
      );

      unlisteners.push(
        await listen<Record<string, TelemetryValue>>('iracing://telemetry-tick', (e) => {
          setTickValues(e.payload);
        }),
      );
    })();

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, []);

  // ── Add / remove watchlist helpers ────────────────────────────────────────
  async function addToWatchlist(name: string) {
    if (watchlist.includes(name)) return;
    const next = [...watchlist, name];
    await invoke('set_watchlist', { fields: next });
    setWatchlist(next);
  }

  async function removeFromWatchlist(name: string) {
    const next = watchlist.filter((n) => n !== name);
    await invoke('set_watchlist', { fields: next });
    setWatchlist(next);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const statusColor =
    status === 'Connected' ? '#22c55e' : status === 'Connecting' ? '#eab308' : '#ef4444';

  return (
    <div style={{ padding: '1rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>

      {/* ── Connection Status ───────────────────────────────────────────── */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Connection Status</h2>
        <span
          style={{
            display: 'inline-block',
            padding: '0.25rem 0.75rem',
            borderRadius: '9999px',
            background: statusColor,
            color: '#fff',
            fontWeight: 'bold',
          }}
        >
          {status}
        </span>
      </section>

      {/* ── Session Info ────────────────────────────────────────────────── */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Session Info</h2>
        {session ? (
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {[
                ['Track', session.track_name],
                ['Session', session.session_type],
                ['Car', session.car_name],
                ['Time', session.wall_clock_time],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td style={{ paddingRight: '1rem', color: '#888' }}>{label}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: '#888', margin: 0 }}>No active session</p>
        )}
      </section>

      {/* ── Field Browser ───────────────────────────────────────────────── */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Field Browser</h2>
        {fields.length === 0 ? (
          <p style={{ color: '#888', margin: 0 }}>
            {status === 'Connected'
              ? 'No active session — enter a session to browse fields'
              : 'Connect to iRacing to browse fields'}
          </p>
        ) : (
          <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid #333' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#1a1a1a', position: 'sticky', top: 0 }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Name</th>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Value</th>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Unit</th>
                  <th style={{ padding: '0.25rem 0.5rem' }}></th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.name} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ padding: '0.2rem 0.5rem' }} title={f.description}>{f.name}</td>
                    <td style={{ padding: '0.2rem 0.5rem' }}>{formatValue(f.value)}</td>
                    <td style={{ padding: '0.2rem 0.5rem', color: '#888' }}>{f.unit}</td>
                    <td style={{ padding: '0.2rem 0.5rem' }}>
                      {!watchlist.includes(f.name) && (
                        <button onClick={() => addToWatchlist(f.name)}>+</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Watchlist ───────────────────────────────────────────────────── */}
      <section>
        <h2 style={{ margin: '0 0 0.5rem' }}>Watchlist</h2>
        {watchlist.length === 0 ? (
          <p style={{ color: '#888', margin: 0 }}>
            Add fields from the browser above to watch them live
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #333' }}>
            <thead>
              <tr style={{ background: '#1a1a1a' }}>
                <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Field</th>
                <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Live Value</th>
                <th style={{ padding: '0.25rem 0.5rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((name) => {
                const tv = tickValues[name];
                const display = tv !== undefined ? formatValue(tv) : '—';
                return (
                  <tr key={name} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ padding: '0.2rem 0.5rem' }}>{name}</td>
                    <td
                      style={{
                        padding: '0.2rem 0.5rem',
                        color: display === 'Unavailable' ? '#ef4444' : undefined,
                      }}
                    >
                      {display}
                    </td>
                    <td style={{ padding: '0.2rem 0.5rem' }}>
                      <button onClick={() => removeFromWatchlist(name)}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
