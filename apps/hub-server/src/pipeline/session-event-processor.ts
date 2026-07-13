import type Redis from 'ioredis';
import type { SessionEvent } from '@iracing-engineer/types';
import * as raceState from '../state/race-state.js';
import { publishEvent } from './event-bus.js';
import type { FuelModelEngine } from '../models/fuel-model.js';
import { logger } from '../logger.js';

export class SessionEventProcessor {
  private commandConn: Redis;
  private fuelModel?: FuelModelEngine;
  private previousSource: 'driver' | 'observer' = 'observer';

  constructor(commandConn: Redis, fuelModel?: FuelModelEngine) {
    this.commandConn = commandConn;
    this.fuelModel = fuelModel;
  }

  setFuelModel(fm: FuelModelEngine): void {
    this.fuelModel = fm;
  }

  async onSessionEvent(payload: string): Promise<void> {
    let event: SessionEvent & { driver_info?: { drivers?: Array<{ carIdx: number; userName: string; carNumber: string; teamName: string; carClassID: number }> } };
    try {
      event = JSON.parse(payload);
    } catch (err) {
      logger.error('[hub] Failed to parse SessionEvent', {
        reason: err instanceof Error ? err.message : String(err),
        payloadLength: payload.length,
        payloadSnippet: payload.slice(0, 200),
      });
      return;
    }

    const snapshot = raceState.getSnapshot();
    const prevPhase = snapshot.session?.sessionPhase ?? 'PreSession';

    if (!event.active) {
      // Session ended
      const session = snapshot.session ?? {} as any;
      raceState.setSession({ ...session, sessionPhase: 'PostRace', playerCarIdx: null } as any);
      const sessionId = session.sessionId ?? String(event.ts);
      const detectedAt = Date.now();
      await publishEvent(
        {
          type: 'session:phase_change',
          sessionId,
          sessionTime: 0,
          lapNumber: 0,
          lapDistPct: 0,
          payload: { from: prevPhase, to: 'PostRace' },
        },
        this.commandConn,
        sessionId,
        detectedAt,
      );
      logger.info('[hub] Session ended', { sessionId });
      return;
    }

    const sessionId = String(event.ts);
    const playerCarIdx = event.player_car_idx ?? null;

    const existingSession = snapshot.session;
    const prevPlayerCarIdx = (existingSession as any)?.playerCarIdx ?? null;

    // Detect mode upgrade (observer → driver)
    const wasObserver = this.previousSource === 'observer';
    const isNowDriver = playerCarIdx !== null;
    if (wasObserver && isNowDriver && existingSession?.sessionPhase === 'Racing') {
      this.previousSource = 'driver';
      const detectedAt = Date.now();
      await publishEvent(
        {
          type: 'source:upgraded',
          sessionId,
          sessionTime: 0,
          lapNumber: 0,
          lapDistPct: 0,
          payload: { previousSource: 'observer', newSource: 'driver', lapNumber: 0, sessionTime: 0 },
        },
        this.commandConn,
        sessionId,
        detectedAt,
      );
    }

    if (isNowDriver) this.previousSource = 'driver';

    raceState.setSession({
      sessionId,
      trackName: event.track_name ?? existingSession?.trackName ?? 'Unknown',
      trackLengthMeters: existingSession?.trackLengthMeters ?? 0,
      sessionType: event.session_type ?? existingSession?.sessionType ?? 'Unknown',
      sessionPhase: existingSession?.sessionPhase ?? 'PreSession',
      lapsTotal: existingSession?.lapsTotal ?? null,
      lapsRemaining: existingSession?.lapsRemaining ?? null,
      timeRemaining: existingSession?.timeRemaining ?? null,
      flags: existingSession?.flags ?? 0,
      // Placeholder until the first weather-bearing telemetry frame
      // (007 FR-016: only ever visible pre-weather, never a mid-session regression).
      weather: existingSession?.weather ?? {
        tempCelsius: 0,
        trackTempCelsius: 0,
        humidity: 0,
        windSpeedMs: 0,
        windDirRad: 0,
        skies: 'Clear',
        precipitation: 0,
        fogLevel: 0,
      },
      sessionStartWallClock: event.ts,
      playerCarIdx,
    } as any);

    logger.info('[hub] Session started', { sessionId, trackName: event.track_name, heroCarIdx: playerCarIdx });

    // Mid-race re-derive: hero carIdx changed
    if (existingSession?.sessionPhase === 'Racing' && prevPlayerCarIdx !== null && prevPlayerCarIdx !== playerCarIdx) {
      logger.warn('[hub] Hero carIdx changed during race', { from: prevPlayerCarIdx, to: playerCarIdx });
    }
  }
}
