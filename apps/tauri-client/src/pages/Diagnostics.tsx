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

// ── Field categorisation ──────────────────────────────────────────────────────
type Category = 'Camera' | 'Car Details' | 'Device Details' | 'Misc' | 'Pits' | 'Race Details' | 'Session Details' | 'Team';

const CATEGORIES: Category[] = [
  'Camera',
  'Car Details',
  'Device Details',
  'Misc',
  'Pits',
  'Race Details',
  'Session Details',
  'Team',
];

const CAMERA_PREFIXES    = ['Cam', 'Replay'];
const DEVICE_PREFIXES    = ['CpuUsage', 'GpuUsage', 'Chan', 'VidCap'];
const SESSION_PREFIXES   = ['Session', 'RadioTransmit', 'Air', 'TrackTemp', 'Weather', 'Wind', 'Fog', 'Solar', 'Is'];
const SESSION_EXACT      = new Set(['Skies', 'Precipitation']);
const PITS_PREFIXES      = ['OnPitRoad', 'PitRepairLeft', 'PitOptRepairLeft', 'PitstopActive', 'FastRepair', 'PitSv', 'dp'];
const RACE_PREFIXES      = ['CarIdx', 'Lap', 'RaceLaps', 'Pace', 'TrackSurface', 'PlayerCar', 'PlayerTire'];
const TEAM_PREFIXES      = ['DC'];
const CAR_PREFIXES       = ['Throttle', 'Brake', 'Clutch', 'Handbrake', 'SteeringWheel', 'Fuel', 'Oil',
                            'Water', 'Manifold', 'Shift', 'dc', 'LF', 'LR', 'RF', 'RR', 'CF',
                            'CR', 'LatAccel', 'LongAccel', 'VertAccel', 'Velocity', 'Yaw', 'Pitch',
                            'Roll', 'Engine', 'PushToPass', 'Energy', 'CarLeft'];
const CAR_EXACT          = new Set(['Speed', 'RPM', 'Gear', 'Voltage']);

function categorizeField(name: string): Category {
  if (CAMERA_PREFIXES.some((p) => name.startsWith(p)))                             return 'Camera';
  if (DEVICE_PREFIXES.some((p) => name.startsWith(p)))                             return 'Device Details';
  if (SESSION_EXACT.has(name) || SESSION_PREFIXES.some((p) => name.startsWith(p))) return 'Session Details';
  if (PITS_PREFIXES.some((p) => name.startsWith(p)))                               return 'Pits';
  if (TEAM_PREFIXES.some((p) => name.startsWith(p)))                               return 'Team';
  if (RACE_PREFIXES.some((p) => name.startsWith(p)))                               return 'Race Details';
  if (CAR_EXACT.has(name)    || CAR_PREFIXES.some((p) => name.startsWith(p)))     return 'Car Details';
  return 'Misc';
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

// ── iRacing enum / bitfield decoders ─────────────────────────────────────────

function decodeEnum(v: number, map: Record<number, string>): string {
  return map[v] ?? `Unknown (${v})`;
}

function decodeBits(v: number, flags: [number, string][]): string {
  const active = flags.filter(([bit]) => (v & bit) !== 0).map(([, label]) => label);
  return active.length > 0 ? active.join(' · ') : 'None';
}

const SESSION_STATE: Record<number, string> = {
  0: 'Invalid', 1: 'Get In Car', 2: 'Warm Up', 3: 'Parade Laps',
  4: 'Racing', 5: 'Checkered', 6: 'Cool Down',
};

const TRK_LOC: Record<number, string> = {
  [-1]: 'Not In World', 0: 'Off Track', 1: 'In Pit Stall',
  2: 'Approaching Pits', 3: 'On Track',
};

const TRK_SURF: Record<number, string> = {
  [-1]: 'Not In World', 0: 'Undefined',
  1: 'Asphalt', 2: 'Asphalt 2', 3: 'Asphalt 3', 4: 'Asphalt 4',
  5: 'Concrete', 6: 'Concrete 2',
  7: 'Racing Dirt', 8: 'Racing Dirt 2',
  9: 'Paint', 10: 'Paint 2',
  11: 'Rumble Strip', 12: 'Rumble Strip 2', 13: 'Rumble Strip 3', 14: 'Rumble Strip 4',
  15: 'Grass', 16: 'Grass 2',
  17: 'Dirt', 18: 'Dirt 2',
  19: 'Sand', 20: 'Gravel', 21: 'Grasscrete', 22: 'Astroturf',
};

const PACE_MODE: Record<number, string> = {
  0: 'Single File Start', 1: 'Double File Start',
  2: 'Single File Restart', 3: 'Double File Restart', 4: 'Not Pacing',
};

const CAR_LEFT_RIGHT: Record<number, string> = {
  0: 'Off', 1: 'Clear', 2: 'Car Left', 3: 'Car Right',
  4: 'Cars Both Sides', 5: 'Two Cars Left', 6: 'Two Cars Right',
};

const SESSION_FLAGS: [number, string][] = [
  [0x00000001, 'Checkered'],     [0x00000002, 'White'],
  [0x00000004, 'Green'],         [0x00000008, 'Yellow'],
  [0x00000010, 'Red'],           [0x00000020, 'Blue'],
  [0x00000040, 'Debris'],        [0x00000080, 'Crossed'],
  [0x00000100, 'Yellow Waving'], [0x00000200, 'One Lap to Green'],
  [0x00000400, 'Green Held'],    [0x00000800, 'Ten to Go'],
  [0x00001000, 'Five to Go'],    [0x00002000, 'Random Waving'],
  [0x00004000, 'Caution'],       [0x00008000, 'Caution Waving'],
  [0x00010000, 'Black'],         [0x00020000, 'Disqualify'],
  [0x00040000, 'Serviceable'],   [0x00080000, 'Furled'],
  [0x00100000, 'Repair'],
  [0x10000000, 'Start Hidden'],  [0x20000000, 'Start Ready'],
  [0x40000000, 'Start Set'],     [0x80000000, 'Start Go'],
];

const ENGINE_WARNINGS: [number, string][] = [
  [0x01, 'Water Temp'], [0x02, 'Fuel Pressure'], [0x04, 'Oil Pressure'],
  [0x08, 'Stalled'],    [0x10, 'Pit Limiter'],   [0x20, 'Rev Limiter'],
  [0x40, 'Oil Temp'],
];

const CAMERA_STATE: [number, string][] = [
  [0x0001, 'Session Screen'], [0x0002, 'Scenic Active'],
  [0x0004, 'Cam Tool'],       [0x0008, 'UI Hidden'],
  [0x0010, 'Auto Shot'],      [0x0020, 'Temp Edits'],
  [0x0040, 'Key Accel'],      [0x0080, 'Key 10x Accel'],
  [0x0100, 'Mouse Aim'],
];

const PIT_SV_FLAGS: [number, string][] = [
  [0x01, 'LF Tyre'], [0x02, 'RF Tyre'], [0x04, 'LR Tyre'], [0x08, 'RR Tyre'],
  [0x10, 'Fuel'],    [0x20, 'Windshield'], [0x40, 'Fast Repair'],
];

const PACE_FLAGS: [number, string][] = [
  [0x01, 'End of Line'], [0x02, 'Free Pass'], [0x04, 'Waved Around'],
];

/** Drop-in replacement for formatValue that emits human-readable labels for
 *  known iRacing enum / bitfield variables instead of raw integers. */
function formatFieldValue(name: string, value: TelemetryValue): string {
  if (value === 'Unavailable') return 'Unavailable';

  const asInt = 'Int'      in value ? value.Int      : null;
  const asBit = 'Bitfield' in value ? value.Bitfield : null;
  const raw   = asInt ?? asBit;

  if (raw !== null) {
    switch (name) {
      case 'SessionState':         return decodeEnum(raw, SESSION_STATE);
      case 'SessionFlags':         return decodeBits(raw, SESSION_FLAGS);
      case 'TrackSurface':
      case 'CarIdxTrackSurface':   return decodeEnum(raw, TRK_LOC);
      case 'TrackSurfaceMaterial': return decodeEnum(raw, TRK_SURF);
      case 'PaceMode':             return decodeEnum(raw, PACE_MODE);
      case 'CarLeftRight':         return decodeEnum(raw, CAR_LEFT_RIGHT);
      case 'EngineWarnings':       return decodeBits(raw, ENGINE_WARNINGS);
      case 'CamCameraState':       return decodeBits(raw, CAMERA_STATE);
      case 'PitSvFlags':           return decodeBits(raw, PIT_SV_FLAGS);
      case 'CarIdxPaceFlags':      return decodeBits(raw, PACE_FLAGS);
    }
  }

  return formatValue(value);
}

// ── Camera Focus panel ────────────────────────────────────────────────────────
const FOCUSED_CAR_LABELS: Record<string, string> = {
  CarIdxPosition:      'Position',
  CarIdxClassPosition: 'Class Position',
  CarIdxLapCompleted:  'Laps Completed',
  CarIdxLapDistPct:    'Lap Progress',
  CarIdxF2Time:        'Gap to Leader',
  CarIdxEstTime:       'Est. Lap Time',
  CarIdxGear:          'Gear',
  CarIdxRPM:           'RPM',
  CarIdxTrackSurface:  'Track Position',
  CarIdxOnPitRoad:     'On Pit Road',
  CarIdxSteer:         'Steering Angle',
};

const FOCUSED_CAR_ORDER = Object.keys(FOCUSED_CAR_LABELS);

function formatFocusedValue(name: string, value: TelemetryValue): string {
  // Lap distance percentage → human-readable %
  if (name === 'CarIdxLapDistPct' && typeof value === 'object' && 'Float' in value) {
    return `${(value.Float * 100).toFixed(1)} %`;
  }
  return formatFieldValue(name, value);
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
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);
  const [focusedCar, setFocusedCar] = useState<{
    cam_car_idx: number;
    cam_group: number;
    cam_num: number;
    fields: Record<string, TelemetryValue>;
  } | null>(null);
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

      const fc = await invoke<typeof focusedCar>('get_focused_car_data').catch(() => null);
      if (!cancelled) setFocusedCar(fc ?? null);
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      unlisteners.forEach((u) => u());
    };
  }, []);

  // ── SDK debug dump ────────────────────────────────────────────────────────
  async function dumpSdkDebug() {
    const info = await invoke<Record<string, string>>('get_sdk_debug').catch(
      (): Record<string, string> => ({}),
    );
    const keys = Object.keys(info).sort();
    if (keys.length === 0) {
      addLog('[SDK] no data (not connected?)');
      return;
    }
    keys.forEach((k) => addLog(`[SDK] ${k}=${info[k]}`));
  }

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

      {/* ── Camera Focus ────────────────────────────────────────────────── */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Camera Focus</h2>
        {focusedCar ? (
          <>
            <table style={{ borderCollapse: 'collapse', marginBottom: '0.5rem' }}>
              <tbody>
                <tr>
                  <td style={{ paddingRight: '1rem', color: '#888' }}>Car Index</td>
                  <td>{focusedCar.cam_car_idx}</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: '1rem', color: '#888' }}>Camera Group</td>
                  <td>{focusedCar.cam_group}</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: '1rem', color: '#888' }}>Camera Number</td>
                  <td>{focusedCar.cam_num}</td>
                </tr>
              </tbody>
            </table>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', paddingRight: '1rem', color: '#888', fontWeight: 'normal' }}>Field</th>
                  <th style={{ textAlign: 'left', color: '#888', fontWeight: 'normal' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {FOCUSED_CAR_ORDER.filter((name) => name in focusedCar.fields).map((name) => (
                  <tr key={name}>
                    <td style={{ paddingRight: '1rem', color: '#aaa', fontSize: '0.85em' }}>
                      {FOCUSED_CAR_LABELS[name] ?? name}
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>
                      {formatFocusedValue(name, focusedCar.fields[name])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p style={{ color: '#888', margin: 0 }}>No camera focus data (iRacing not connected)</p>
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
          <>
            {/* Category filter tabs */}
            <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              {([null, ...CATEGORIES] as (Category | null)[]).map((cat) => {
                const label = cat ?? 'All';
                const count = cat ? fields.filter((f) => categorizeField(f.name) === cat).length : fields.length;
                const active = activeCategory === cat;
                return (
                  <button
                    key={label}
                    onClick={() => setActiveCategory(cat)}
                    style={{
                      padding: '0.15rem 0.5rem',
                      fontSize: '0.72rem',
                      background: active ? '#2563eb' : '#1a1a1a',
                      border: `1px solid ${active ? '#2563eb' : '#444'}`,
                      color: active ? '#fff' : '#aaa',
                      cursor: 'pointer',
                      borderRadius: '3px',
                    }}
                  >
                    {label} ({count})
                  </button>
                );
              })}
            </div>
            <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid #333' }}>
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
                  {fields
                    .filter((f) => !activeCategory || categorizeField(f.name) === activeCategory)
                    .map((f) => (
                      <tr key={f.name} style={{ borderTop: '1px solid #222' }}>
                        <td style={{ padding: '0.2rem 0.5rem' }} title={f.description}>{f.name}</td>
                        <td style={{ padding: '0.2rem 0.5rem' }}>{formatFieldValue(f.name, f.value)}</td>
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
          </>
        )}
      </section>

      {/* ── Watchlist ───────────────────────────────────────────────────── */}
      <section>
        <h2 style={{ margin: '0 0 0.5rem' }}>Watchlist</h2>
        {watchlist.length === 0 ? (
          <p style={{ color: '#888', margin: 0 }}>
            Add fields from the browser above to watch them live
          </p>
        ) : (() => {
          // Group watchlist by category (categories sorted alphabetically, fields within each group sorted alphabetically)
          const groups = CATEGORIES
            .map((cat) => ({
              category: cat,
              items: watchlist
                .filter((name) => categorizeField(name) === cat)
                .sort((a, b) => a.localeCompare(b)),
            }))
            .filter((g) => g.items.length > 0);

          return (
            <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #333' }}>
              <thead>
                <tr style={{ background: '#1a1a1a' }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Field</th>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Live Value</th>
                  <th style={{ padding: '0.25rem 0.5rem' }}></th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ category, items }) => (
                  <>
                    <tr key={`hdr-${category}`}>
                      <td
                        colSpan={3}
                        style={{
                          padding: '0.3rem 0.5rem',
                          fontSize: '0.68rem',
                          fontWeight: 'bold',
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: '#666',
                          background: '#111',
                          borderTop: '1px solid #333',
                        }}
                      >
                        {category}
                      </td>
                    </tr>
                    {items.map((name) => {
                      const tv = tickValues[name];
                      const display = tv !== undefined ? formatFieldValue(name, tv) : '—';
                      return (
                        <tr key={name} style={{ borderTop: '1px solid #1a1a1a' }}>
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
                  </>
                ))}
              </tbody>
            </table>
          );
        })()}
      </section>

      {/* ── Debug Log ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>
          Debug Log{' '}
          <button
            onClick={dumpSdkDebug}
            style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem', marginLeft: '0.5rem' }}
          >
            SDK Dump
          </button>
        </h2>
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
