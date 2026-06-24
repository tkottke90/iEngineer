import { db } from "../client.js";

export async function recordFuelStint(data: {
  sessionId: string;
  carIdx: number;
  stintNumber: number;
  startLap: number;
  endLap: number;
  startFuel: number;
  endFuel: number;
  burnRatePerLap: number;
}): Promise<void> {
  await db`
    INSERT INTO stint_fuel_data
      (session_id, car_idx, stint_number, start_lap, end_lap, start_fuel, end_fuel, burn_rate_per_lap)
    VALUES
      (${data.sessionId}, ${data.carIdx}, ${data.stintNumber}, ${data.startLap}, ${data.endLap},
       ${data.startFuel}, ${data.endFuel}, ${data.burnRatePerLap})
  `;
}

export async function recordTireStint(data: {
  sessionId: string;
  carIdx: number;
  stintNumber: number;
  compound: string;
  startLap: number;
  endLap: number;
  degradationSignal: string;
}): Promise<void> {
  await db`
    INSERT INTO tire_stint_data
      (session_id, car_idx, stint_number, compound, start_lap, end_lap, degradation_signal)
    VALUES
      (${data.sessionId}, ${data.carIdx}, ${data.stintNumber}, ${data.compound},
       ${data.startLap}, ${data.endLap}, ${data.degradationSignal})
  `;
}

export async function getFuelHistory(
  trackName: string,
  carClassId: number,
  limit = 10,
): Promise<number[]> {
  const rows = await db<{ burn_rate_per_lap: number }[]>`
    SELECT sfd.burn_rate_per_lap
    FROM stint_fuel_data sfd
    JOIN sessions s ON s.session_id = sfd.session_id
    WHERE s.track_name = ${trackName}
    ORDER BY sfd.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.burn_rate_per_lap);
}
