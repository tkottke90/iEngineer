import { useEffect, useState } from 'preact/hooks';

interface BlackoutZone {
  id: string;
  startPct: number;
  endPct: number;
  label: string;
}

export function Debrief() {
  const [zones, setZones] = useState<BlackoutZone[]>([]);

  useEffect(() => {
    // TODO: fetch debrief data from hub server
    // TODO: load blackout zones from local SQLite via Tauri invoke
  }, []);

  return (
    <div class="debrief">
      <section>
        <h2>Lap Times</h2>
        {/* TODO: render lap time chart */}
        <p class="placeholder">Lap time chart — connect to hub after session.</p>
      </section>

      <section>
        <h2>Fuel Model vs Actual</h2>
        {/* TODO: render fuel chart */}
        <p class="placeholder">Fuel model comparison — requires completed session data.</p>
      </section>

      <section>
        <h2>Radio Blackout Zones</h2>
        <p class="help-text">
          Mark sections of the track where engineer messages should be suppressed. Zones defined by
          lap distance percentage (0–1).
        </p>
        {zones.length === 0 && <p class="placeholder">No blackout zones configured.</p>}
        {zones.map((z) => (
          <div key={z.id} class="zone-row">
            <span>{z.label}</span>
            <span>
              {(z.startPct * 100).toFixed(0)}% – {(z.endPct * 100).toFixed(0)}%
            </span>
            <button onClick={() => setZones((prev) => prev.filter((z2) => z2.id !== z.id))}>
              Remove
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setZones((prev) => [
              ...prev,
              { id: crypto.randomUUID(), startPct: 0.1, endPct: 0.2, label: 'New zone' },
            ])
          }
        >
          + Add Zone
        </button>
      </section>
    </div>
  );
}
