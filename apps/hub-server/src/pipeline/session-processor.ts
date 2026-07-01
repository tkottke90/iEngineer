import type Redis from 'ioredis';
import type { CarState, HeroState, SessionState } from '@iracing-engineer/types';
import { SessionFlags } from '@iracing-engineer/types';
import * as raceState from '../state/race-state.js';
import { publishEvent } from './event-bus.js';
import { withSpan } from '../telemetry.js';
import type { FuelModelEngine } from '../models/fuel-model.js';
import type { TireModelEngine } from '../models/tire-model.js';
import type { GapModelEngine } from '../models/gap-model.js';
import { logger } from '../logger.js';

interface DriverInfo {
  carIdx: number;
  userName: string;
  carNumber: string;
  teamName: string;
  carClassID: number;
}

function emptyCarState(carIdx: number, info: DriverInfo): CarState {
  return {
    carIdx,
    driverName: info.userName,
    carNumber: info.carNumber,
    teamName: info.teamName,
    carClassId: info.carClassID,
    lapDistPct: 0,
    trackSurface: 0,
    position: 0,
    classPosition: 0,
    lapCompleted: 0,
    lastLapTime: 0,
    bestLapTime: 0,
    estimatedLapTime: 0,
    gapToLeader: 0,
    onPitRoad: false,
    tireCompound: 'Unknown',
    fastRepairsUsed: 0,
    pitEntryTime: null,
    pitExitTime: null,
    lastPitLap: null,
    lapsSinceLastPit: null,
    estimatedPitDuration: null,
  };
}

export class SessionProcessor {
  private commandConn: Redis;
  private fuelModel: FuelModelEngine;
  private tireModel: TireModelEngine;
  private gapModel: GapModelEngine;
  private prevLapCompleted: Record<number, number> = {};
  private prevOnPitRoad: Record<number, boolean> = {};
  private prevPosition: Record<number, number> = {};
  private prevFuelLevel: number | null = null;
  private prevFlags = 0;
  private prevPitWindowOpen = false;
  private prevDegradationSignal = 'nominal';

  constructor(commandConn: Redis, fuelModel: FuelModelEngine, tireModel: TireModelEngine, gapModel: GapModelEngine) {
    this.commandConn = commandConn;
    this.fuelModel = fuelModel;
    this.tireModel = tireModel;
    this.gapModel = gapModel;
  }

  seedFieldState(drivers: DriverInfo[]): void {
    for (const d of drivers) {
      raceState.updateCarState(d.carIdx, emptyCarState(d.carIdx, d));
    }
  }

  evaluatePitWindow(): { pitWindowOpen: boolean } {
    const fuel = this.fuelModel.getSnapshot();
    const tire = this.tireModel.getSnapshot();
    // FR-029: pitWindowOpen = fuelDeficit ≤ 0 AND (degradationSignal !== "nominal" OR lapAge > 5)
    const pitWindowOpen = fuel.fuelDeficit <= 0 && (tire.degradationSignal !== 'nominal' || tire.lapAge > 5);
    return { pitWindowOpen };
  }

  async onSessionTelemetry(payload: string): Promise<void> {
    return withSpan('hub.session-processor.cycle', { eventCount: 0 }, () => this._onSessionTelemetryInner(payload));
  }

  private async _onSessionTelemetryInner(payload: string): Promise<void> {
    const cycleStart = Date.now();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload);
    } catch (err) {
      logger.error('[hub] Failed to parse session telemetry', {
        reason: err instanceof Error ? err.message : String(err),
        payloadLength: payload.length,
        // Truncated snippet so the log stays readable but shows what arrived.
        payloadSnippet: payload.slice(0, 200),
      });
      return;
    }

    const snapshot = raceState.getSnapshot();
    const session = snapshot.session;
    if (!session) return;

    const sessionId = session.sessionId;
    const sessionTime = (data.sessionTime as number) ?? 0;
    const playerCarIdx = (session as any).playerCarIdx as number | null;

    // Parse arrays
    const lapCompleted = (data.carIdxLapCompleted as number[]) ?? [];
    const positions = (data.carIdxPosition as number[]) ?? [];
    const classPositions = (data.carIdxClassPosition as number[]) ?? [];
    const lapDistPcts = (data.carIdxLapDistPct as number[]) ?? [];
    const onPitRoads = (data.carIdxOnPitRoad as boolean[]) ?? [];
    const f2Times = (data.carIdxF2Time as number[]) ?? [];
    const lastLapTimes = (data.carIdxLastLapTime as number[]) ?? [];
    const bestLapTimes = (data.carIdxBestLapTime as number[]) ?? [];
    const estTimes = (data.carIdxEstTime as number[]) ?? [];
    const trackSurfaces = (data.carIdxTrackSurface as number[]) ?? [];

    // Detect position duplicates
    const positionSeen: Record<number, number[]> = {};
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      if (pos > 0) {
        positionSeen[pos] = positionSeen[pos] ?? [];
        positionSeen[pos].push(i);
      }
    }
    for (const [pos, idxes] of Object.entries(positionSeen)) {
      if (idxes.length > 1) {
        logger.warn('[hub] Duplicate position detected', { duplicatePosition: pos, carIdxes: idxes });
      }
    }

    const eventCount: string[] = [];

    // Auto-seed any car that appears in the telemetry arrays but isn't in the field yet
    const numCars = Math.max(lapCompleted.length, positions.length, onPitRoads.length);
    for (let i = 0; i < numCars; i++) {
      if (!snapshot.field[i]) {
        raceState.updateCarState(i, emptyCarState(i, { carIdx: i, userName: `Car ${i}`, carNumber: String(i), teamName: '', carClassID: 0 }));
      }
    }

    // Update all cars in field
    for (let carIdx = 0; carIdx < numCars; carIdx++) {
      const existingCar = raceState.getSnapshot().field[carIdx];
      if (!existingCar) continue;

      const newLap = lapCompleted[carIdx] ?? existingCar.lapCompleted;
      const newOnPit = onPitRoads[carIdx] ?? existingCar.onPitRoad;
      const newPos = positions[carIdx] ?? existingCar.position;

      let pitEntryTime = existingCar.pitEntryTime;
      let pitExitTime = existingCar.pitExitTime;
      let lastPitLap = existingCar.lastPitLap;
      let estimatedPitDuration = existingCar.estimatedPitDuration;

      // Pit road transitions
      const prevPit = this.prevOnPitRoad[carIdx] ?? false;
      if (newOnPit && !prevPit) {
        // Pit entry
        pitEntryTime = sessionTime;
        lastPitLap = newLap;
        const isHero = carIdx === playerCarIdx;
        const eventType = isHero ? 'hero:pit_entry' : 'competitor:pit_entry';
        eventCount.push(eventType);
        await publishEvent(
          { type: eventType, sessionId, sessionTime, lapNumber: newLap, lapDistPct: lapDistPcts[carIdx] ?? 0, payload: { lapNumber: newLap, carIdx } },
          this.commandConn, sessionId, cycleStart,
        );
      } else if (!newOnPit && prevPit) {
        // Pit exit
        pitExitTime = sessionTime;
        estimatedPitDuration = pitEntryTime !== null ? sessionTime - pitEntryTime : null;
        if (carIdx === playerCarIdx) {
          this.fuelModel.onPitExit(data.fuelLevel as number ?? 0);
          this.tireModel.onPitStop((data.carIdxTireCompound as string[] ?? [])[carIdx] ?? 'Unknown');
        }
        const isHero = carIdx === playerCarIdx;
        const eventType = isHero ? 'hero:pit_exit' : 'competitor:pit_exit';
        eventCount.push(eventType);
        await publishEvent(
          { type: eventType, sessionId, sessionTime, lapNumber: newLap, lapDistPct: lapDistPcts[carIdx] ?? 0, payload: { lapNumber: newLap, carIdx, estimatedPitDuration } },
          this.commandConn, sessionId, cycleStart,
        );
      }
      this.prevOnPitRoad[carIdx] = newOnPit;

      // Position changes
      const prevPos = this.prevPosition[carIdx] ?? 0;
      if (prevPos > 0 && newPos > 0 && newPos !== prevPos) {
        const isHero = carIdx === playerCarIdx;
        const eventType = isHero ? 'hero:position_change' : 'competitor:position_change';
        eventCount.push(eventType);
        await publishEvent(
          { type: eventType, sessionId, sessionTime, lapNumber: newLap, lapDistPct: lapDistPcts[carIdx] ?? 0, payload: { carIdx, from: prevPos, to: newPos } },
          this.commandConn, sessionId, cycleStart,
        );
      }
      this.prevPosition[carIdx] = newPos;

      // Lap completions (hero only)
      const prevLap = this.prevLapCompleted[carIdx] ?? -1;
      if (carIdx === playerCarIdx && newLap > prevLap && prevLap >= 0) {
        const fuelEnd = (data.fuelLevel as number) ?? 0;
        const fuelStart = this.prevFuelLevel ?? fuelEnd;
        const isOutlap = (existingCar.lapsSinceLastPit ?? 1) === 0;
        const isInlap = newOnPit;
        this.fuelModel.onLapCompletion(fuelStart, fuelEnd, lastLapTimes[carIdx] ?? 90, isOutlap, isInlap);
        this.tireModel.onLapCompletion(lastLapTimes[carIdx] ?? 90, isOutlap, isInlap);

        // Write fuel/tire KV snapshots (FR-008)
        const fuelSnap = this.fuelModel.getSnapshot();
        const tireSnap = this.tireModel.getSnapshot();
        await this.commandConn.setex(`hub:fuel-model:${sessionId}`, 7200, JSON.stringify(fuelSnap));
        await this.commandConn.setex(`hub:tire-model:${sessionId}`, 7200, JSON.stringify(tireSnap));

        // Check fuel critical
        if (fuelSnap.lapsRemaining !== null && fuelSnap.lapsRemaining < 1.0) {
          eventCount.push('hero:fuel_critical');
          await publishEvent(
            { type: 'hero:fuel_critical', sessionId, sessionTime, lapNumber: newLap, lapDistPct: lapDistPcts[carIdx] ?? 0, payload: { lapsRemaining: fuelSnap.lapsRemaining, fuelRemaining: fuelSnap.fuelRemaining } },
            this.commandConn, sessionId, cycleStart,
          );
        }
      }
      if (carIdx === playerCarIdx) this.prevLapCompleted[carIdx] = newLap;

      const lapsSinceLastPit = lastPitLap !== null ? newLap - lastPitLap : null;

      raceState.updateCarState(carIdx, {
        lapCompleted: newLap,
        position: newPos,
        classPosition: classPositions[carIdx] ?? existingCar.classPosition,
        lapDistPct: lapDistPcts[carIdx] ?? existingCar.lapDistPct,
        onPitRoad: newOnPit,
        gapToLeader: f2Times[carIdx] ?? existingCar.gapToLeader,
        lastLapTime: lastLapTimes[carIdx] ?? existingCar.lastLapTime,
        bestLapTime: bestLapTimes[carIdx] ?? existingCar.bestLapTime,
        estimatedLapTime: estTimes[carIdx] ?? existingCar.estimatedLapTime,
        trackSurface: trackSurfaces[carIdx] ?? existingCar.trackSurface,
        lapsSinceLastPit,
        pitEntryTime,
        pitExitTime,
        lastPitLap,
        estimatedPitDuration,
      });
    }

    // Session flags → phase machine
    const flags = (data.sessionFlags as number) ?? 0;
    const prevPhase = session.sessionPhase;
    const newPhase = this._derivePhase(prevPhase, flags);
    if (newPhase !== prevPhase) {
      raceState.setSession({ ...snapshot.session!, sessionPhase: newPhase, flags });
      eventCount.push('session:phase_change');
      await publishEvent(
        { type: 'session:phase_change', sessionId, sessionTime, lapNumber: lapCompleted[playerCarIdx ?? 0] ?? 0, lapDistPct: 0, payload: { from: prevPhase, to: newPhase } },
        this.commandConn, sessionId, cycleStart,
      );
    } else {
      raceState.setSession({ ...snapshot.session!, flags,
        lapsRemaining: (data.sessionLapsRemain as number) === -1 ? null : (data.sessionLapsRemain as number) ?? session.lapsRemaining,
        timeRemaining: (data.sessionTimeRemain as number) ?? session.timeRemaining,
      });
    }

    // Flag events
    if ((flags & SessionFlags.caution) && !(this.prevFlags & SessionFlags.caution)) {
      eventCount.push('session:flag_yellow');
      await publishEvent({ type: 'session:flag_yellow', sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: {} }, this.commandConn, sessionId, cycleStart);
    }
    if ((flags & SessionFlags.green) && !(this.prevFlags & SessionFlags.green) && prevPhase === 'Caution') {
      eventCount.push('session:flag_green');
      await publishEvent({ type: 'session:flag_green', sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: {} }, this.commandConn, sessionId, cycleStart);
    }
    if ((flags & SessionFlags.checkered) && !(this.prevFlags & SessionFlags.checkered)) {
      eventCount.push('session:flag_checkered');
      await publishEvent({ type: 'session:flag_checkered', sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: {} }, this.commandConn, sessionId, cycleStart);
    }
    if ((flags & SessionFlags.blue) && playerCarIdx !== null) {
      await publishEvent({ type: 'hero:blue_flag', sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: {} }, this.commandConn, sessionId, cycleStart);
    }
    this.prevFlags = flags;

    // Hero state — re-fetch snapshot after auto-seed so playerCarIdx is present
    const freshField = raceState.getSnapshot().field;
    if (playerCarIdx !== null && freshField[playerCarIdx]) {
      const heroBase = freshField[playerCarIdx];
      raceState.setHeroState({
        ...heroBase,
        fuelLevel: (data.fuelLevel as number) ?? 0,
        fuelUsePerHour: (data.fuelUsePerHour as number) ?? 0,
        brake: (data.brake as number) ?? 0,
        throttle: (data.throttle as number) ?? 0,
        latAccel: (data.latAccel as number) ?? 0,
        longAccel: (data.longAccel as number) ?? 0,
        speed: (data.speed as number) ?? 0,
        gear: (data.gear as number) ?? 0,
        waterTemp: (data.waterTemp as number) ?? 0,
        oilTemp: (data.oilTemp as number) ?? 0,
        incidentCount: (data.incidentCount as number) ?? 0,
        lapDeltaToBest: (data.lapDeltaToBestLap_DD as number) ?? 0,
        lapCurrentTime: (data.lapCurrentLapTime as number) ?? 0,
        safeWindowOpen: raceState.getSnapshot().signals.safeWindowOpen,
      } as HeroState);

      // Update fuel model context
      const lapsRemain = (data.sessionLapsRemain as number) === -1 ? null : (data.sessionLapsRemain as number);
      const timeRemain = (data.sessionTimeRemain as number) ?? null;
      this.fuelModel.setSessionContext({ lapsRemaining: lapsRemain, timeRemaining: timeRemain });

      // Track fuel level for next lap completion's fuelStart value
      this.prevFuelLevel = (data.fuelLevel as number) ?? null;
    }

    // Gap model
    const currentSnap = raceState.getSnapshot();
    const gapResult = this.gapModel.update(currentSnap.field, { ...currentSnap.session!, estimatedLapTime: estTimes[playerCarIdx ?? 0] ?? 90 } as any);
    const activeBattles = this.gapModel.getEntries().filter(e => e.battleStatus === 'battle' || e.battleStatus === 'closing').map(e => ({ leadCarIdx: e.leadCarIdx, trailCarIdx: e.trailCarIdx }));
    raceState.updateSignals({ activeBattles });

    // Gap events
    for (const evt of gapResult.events) {
      await publishEvent({ type: evt.type as any, sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: evt.payload }, this.commandConn, sessionId, cycleStart);
    }

    // pitWindowOpen
    const { pitWindowOpen } = this.evaluatePitWindow();
    if (pitWindowOpen && !this.prevPitWindowOpen) {
      const fuel = this.fuelModel.getSnapshot();
      const tire = this.tireModel.getSnapshot();
      eventCount.push('hero:pit_window_open');
      await publishEvent({ type: 'hero:pit_window_open', sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: { lapAge: tire.lapAge, fuelDeficit: fuel.fuelDeficit } }, this.commandConn, sessionId, cycleStart);
    }
    this.prevPitWindowOpen = pitWindowOpen;
    raceState.updateSignals({ pitWindowOpen });

    // Degradation signal event
    const tireSnap = this.tireModel.getSnapshot();
    if (tireSnap.degradationSignal !== this.prevDegradationSignal && (tireSnap.degradationSignal === 'watch' || tireSnap.degradationSignal === 'critical')) {
      eventCount.push('hero:pace_degradation');
      await publishEvent({ type: 'hero:pace_degradation', sessionId, sessionTime, lapNumber: 0, lapDistPct: 0, payload: { signal: tireSnap.degradationSignal, trend: tireSnap.paceDegradationTrend } }, this.commandConn, sessionId, cycleStart);
    }
    this.prevDegradationSignal = tireSnap.degradationSignal;

    // Write race state KV snapshot (FR-007)
    await raceState.writeKvSnapshot(this.commandConn, sessionId);

    const cycleLatencyMs = Date.now() - cycleStart;

    if (eventCount.length > 0) {
      logger.debug('[hub] Session processor cycle', { cycleLatencyMs, eventCount: eventCount.length, sessionTime });
    } else {
      // FR-028: no-event cycle log
      logger.debug('[hub] Session processor cycle (no events)', { cycleLatencyMs, eventCount: 0, sessionTime });
    }
  }

  private _derivePhase(current: string, flags: number): string {
    switch (current) {
      case 'PreSession':
        if (flags & (SessionFlags.startGo | SessionFlags.startReady)) return 'Formation';
        break;
      case 'Formation':
        if (flags & SessionFlags.green) return 'Racing';
        break;
      case 'Racing':
        if (flags & SessionFlags.checkered) return 'PostRace';
        if (flags & (SessionFlags.caution | SessionFlags.cautionWaving)) return 'Caution';
        break;
      case 'Caution':
        if (flags & SessionFlags.checkered) return 'PostRace';
        if (flags & SessionFlags.green) return 'Racing';
        break;
    }
    return current;
  }
}
