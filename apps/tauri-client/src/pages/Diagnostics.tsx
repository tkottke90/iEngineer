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

interface LogEntry {
  ts: string;
  msg: string;
}

function nowHMS(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const MAX_LOG = 50;

export function Diagnostics() {
  const [status, setStatus] = useState<ConnectionStatus>('Disconnected');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [fields, setFields] = useState<TelemetryField[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [tickValues, setTickValues] = useState<Record<string, TelemetryValue>>({});
  const [log, setLog] = useState<LogEntry[]>([{ ts: nowHMS(), msg: 'Diagnostics mounted' }]);

  function addLog(msg: string) {
    setLog((prev) => [{ ts: nowHMS(), msg }, ...prev].slice(0, MAX_LOG));
  }

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    // ── Try each event listener independently; failures are logged, not fatal ──
    const registerListeners = async () => {
      try {
        unlisteners.push(
          await listen<ConnectionStatus>('iracing://status-changed', async (e) => {
            if (cancelled) return;
            addLog(`EVENT status → ${e.payload}`);
            setStatus(e.payload);
            if (e.payload === 'Connected') {
              const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
              if (!cancelled) { setFields(f); addLog(`fields: ${f.length}`); }
            } else {
              setFields([]);
              setSession(null);
            }
          }),
        );
        addLog('event OK: status-changed');
      } catch (e) {
        addLog(`event FAIL: status-changed (${String(e)})`);
      }

      try {
        unlisteners.push(
          await listen<SessionInfo | null>('iracing://session-changed', async (e) => {
            if (cancelled) return;
            const info = e.payload;
            addLog(info ? `EVENT session → ${info.track_name}` : 'EVENT session → null');
            setSession(info);
            if (info) {
              const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
              if (!cancelled) { setFields(f); addLog(`fields: ${f.length}`); }
            }
          }),
        );
        addLog('event OK: session-changed');
      } catch (e) {
        addLog(`event FAIL: session-changed (${String(e)})`);
      }

      try {
        unlisteners.push(
          await listen<Record<string, TelemetryValue>>('iracing://telemetry-tick', (e) => {
            if (!cancelled) setTickValues(e.payload);
          }),
        );
        addLog('event OK: telemetry-tick');
      } catch (e) {
        addLog(`event FAIL: telemetry-tick (${String(e)})`);
      }
    };

    // ── Initial state sync via invoke (reliable regardless of event status) ──
    const syncState = async () => {
      addLog('syncing initial state...');

      const s = await invoke<ConnectionStatus>('get_iracing_status').catch((e) => {
        addLog(`invoke error (status): ${String(e)}`);
        return 'Disconnected' as ConnectionStatus;
      });
      if (cancelled) return;
      setStatus(s);
      addLog(`status: ${s}`);

      const sess = await invoke<SessionInfo | null>('get_session_data').catch((e) => {
        addLog(`invoke error (session): ${String(e)}`);
        return null;
      });
      if (cancelled) return;
      setSession(sess);
      addLog(sess ? `session: ${sess.track_name} / ${sess.session_type}` : 'session: none');

      const wl = await invoke<string[]>('get_watchlist').catch(() => []);
      if (!cancelled) setWatchlist(wl);

      if (s === 'Connected' || sess !== null) {
        const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
        if (!cancelled) { setFields(f); addLog(`fields: ${f.length}`); }
      }

      addLog('init done');
    };

    // Register listeners first, then sync — run them in order but independently
    (async () => {
      await registerListeners();
      await syncState();
    })();

    // ── 2-second polling fallback (catches status/session if events don't fire) ──
    const poll = setInterval(async () => {
      if (cancelled) return;
      const s = await invoke<ConnectionStatus>('get_iracing_status').catch(() => null);
      if (s === null || cancelled) return;
      setStatus(s);

      const sess = await invoke<SessionInfo | null>('get_session_data').catch(() => null);
      if (cancelled) return;
      setSession(sess);

      if (s === 'Connected' || sess !== null) {
        const f = await invoke<TelemetryField[]>('list_telemetry_fields').catch(() => []);
        if (!cancelled) setFields(f);
      } else {
        setFields([]);
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
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

      {/* ── Debug Log ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Debug Log</h2>
        <div
          style={{
            maxHeight: '180px',
            overflowY: 'auto',
            border: '1px solid #333',
            background: '#0a0a0a',
            padding: '0.25rem 0.5rem',
          }}
        >
          {log.map((e, i) => (
            <div key={i} style={{ fontSize: '0.75rem', lineHeight: '1.5', color: '#aaa' }}>
              <span style={{ color: '#555', marginRight: '0.5rem' }}>{e.ts}</span>
              {e.msg}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
