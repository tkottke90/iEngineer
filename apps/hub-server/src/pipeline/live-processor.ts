import type Redis from 'ioredis';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import * as raceState from '../state/race-state.js';
import { publishEvent } from './event-bus.js';

const tracer = trace.getTracer('hub-server');

const _G_MS2 = 9.80665; // 1g in m/s² — kept for the accel-unit conversion planned in M6
const BRAKE_THRESHOLD = 0.05;
const LATACCEL_LIMIT = 0.4; // g
const THROTTLE_MIN = 0.7;
const SAFE_DISTANCE_M = 150;
const INCIDENT_LONG_ACCEL_G = 3.0;
const INCIDENT_SPEED_DROP_MS = 20;
const INCIDENT_WINDOW_S = 0.5;

interface LiveTick {
  brake: number;
  throttle: number;
  latAccel: number;
  longAccel: number;
  speed: number;
  sessionTime?: number;
  lapDistPct?: number;
}

export class LiveProcessor {
  private commandConn: Redis;
  private eventCallback?: (type: string) => void;
  private source: 'driver' | 'observer' = 'observer';
  private latestTick: LiveTick | null = null;
  private brakeDistanceBuffer = 0;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private lastTickMs = 0;

  // Incident detection state
  private incidentSpikeTime: number | null = null;
  private incidentSpikeSpeed: number | null = null;

  constructor(commandConn: Redis, eventCallback?: (type: string) => void) {
    this.commandConn = commandConn;
    this.eventCallback = eventCallback;
  }

  setSource(source: 'driver' | 'observer'): void {
    this.source = source;
  }

  onLiveTelemetry(payload: string): void {
    try {
      this.latestTick = JSON.parse(payload) as LiveTick;
    } catch {
      // ignore parse errors
    }
  }

  start(): void {
    this.lastTickMs = Date.now();
    this.intervalHandle = setInterval(() => {
      const now = Date.now();
      const deltaTime_s = (now - this.lastTickMs) / 1000;
      this.lastTickMs = now;
      this.tick(deltaTime_s);
    }, 16);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  tick(deltaTime_s: number): void {
    tracer.startActiveSpan('hub.live-processor.cycle', (span) => {
      try {
        this._tick(deltaTime_s);
        span.setAttribute('safeWindowOpen', raceState.getSnapshot().signals.safeWindowOpen);
        span.setStatus({ code: SpanStatusCode.OK });
      } finally {
        span.end();
      }
    });
  }

  private _tick(deltaTime_s: number): void {
    const t = this.latestTick;

    if (this.source === 'observer' || !t) {
      raceState.updateSignals({ safeWindowOpen: false, cutWindowOpen: false });
      return;
    }

    // FR-022: brake distance buffer
    if (t.brake > BRAKE_THRESHOLD) {
      this.brakeDistanceBuffer = 0;
    } else {
      // speed is in m/s (iRacing SDK Speed field)
      this.brakeDistanceBuffer += t.speed * deltaTime_s;
    }

    // FR-021: three conditions
    const latAccelOk = Math.abs(t.latAccel) < LATACCEL_LIMIT;
    const throttleOk = t.throttle > THROTTLE_MIN;
    const distanceOk = this.brakeDistanceBuffer >= SAFE_DISTANCE_M;

    const safeWindowOpen = latAccelOk && throttleOk && distanceOk;
    // cutWindowOpen is a stub = safeWindowOpen until M6
    raceState.updateSignals({ safeWindowOpen, cutWindowOpen: safeWindowOpen });

    // FR-031: incident detection (|LongAccel| > 3g then speed drop > 20 m/s within 0.5s)
    const longAccelG = Math.abs(t.longAccel);
    const sessionTime = t.sessionTime ?? 0;

    if (longAccelG > INCIDENT_LONG_ACCEL_G && this.incidentSpikeTime === null) {
      this.incidentSpikeTime = sessionTime;
      this.incidentSpikeSpeed = t.speed;
    } else if (this.incidentSpikeTime !== null && this.incidentSpikeSpeed !== null) {
      const elapsed = sessionTime - this.incidentSpikeTime;
      const speedDrop = this.incidentSpikeSpeed - t.speed;
      if (elapsed <= INCIDENT_WINDOW_S && speedDrop > INCIDENT_SPEED_DROP_MS) {
        // Emit incident
        this.eventCallback?.('hero:incident');
        const snap = raceState.getSnapshot();
        const sessionId = snap.session?.sessionId ?? '';
        publishEvent(
          {
            type: 'hero:incident',
            sessionId,
            sessionTime,
            lapNumber: 0,
            lapDistPct: t.lapDistPct ?? 0,
            payload: { longAccel: t.longAccel, speedDrop, sessionTime },
          },
          this.commandConn,
          sessionId,
          Date.now(),
        ).catch(() => {});
        this.incidentSpikeTime = null;
        this.incidentSpikeSpeed = null;
      } else if (elapsed > INCIDENT_WINDOW_S) {
        // Window passed — reset
        this.incidentSpikeTime = null;
        this.incidentSpikeSpeed = null;
      }
    }
  }
}
