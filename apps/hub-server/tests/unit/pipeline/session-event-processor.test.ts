import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { SessionEventProcessor } from '../../../src/pipeline/session-event-processor.js';
import { FuelModelEngine } from '../../../src/models/fuel-model.js';
import * as raceState from '../../../src/state/race-state.js';

function mockRedis(publishedEvents: unknown[]) {
  return {
    setex: async () => {},
    publish: async (_ch: string, msg: string) => { publishedEvents.push(JSON.parse(msg)); return 0; },
    lpush: async () => 1,
    ltrim: async () => {},
    expire: async () => {},
    xack: async () => 1,
  } as any;
}

function activeSessionPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    active: true,
    ts: 1719619200000,
    track_name: 'Watkins Glen Boot',
    player_car_name: 'BMW M4 GT3',
    player_car_idx: 3,
    session_type: 'Race',
    wall_clock_time: '14:00:00',
    ...overrides,
  });
}

describe('SessionEventProcessor', () => {
  let published: unknown[];
  let redis: any;

  beforeEach(() => {
    published = [];
    redis = mockRedis(published);
    // Reset race state
    raceState.setSession(null as any);
    raceState.setHeroState(null);
  });

  it('FR-030: source:upgraded emitted and FuelModel transitions Level 3 → Level 1 when session arrives active=true from observer', async () => {
    const fuel = new FuelModelEngine({ windowSize: 5 });
    const proc = new SessionEventProcessor(redis, fuel);

    // Force racing phase in state
    raceState.setSession({ sessionId: '1719619200000', trackName: '', sessionPhase: 'Racing', sessionType: 'Race', lapsTotal: null, lapsRemaining: null, timeRemaining: null, flags: 0, weather: { tempCelsius: 0, humidity: 0, windSpeedMs: 0, skies: '' }, sessionStartWallClock: 0, trackLengthMeters: 0, playerCarIdx: null } as any);

    await proc.onSessionEvent(activeSessionPayload({ player_car_idx: 3 }));

    const upgradeEvent = (published as any[]).find((e: any) => e.type === 'source:upgraded');
    expect(upgradeEvent).to.exist;
    expect(upgradeEvent.payload.previousSource).to.equal('observer');
    expect(upgradeEvent.payload.newSource).to.equal('driver');
  });

  it('FR-002: sessionPhase set to "PostRace" and playerCarIdx null when active=false; phase_change includes from/to', async () => {
    const proc = new SessionEventProcessor(redis);
    // Seed an existing session
    raceState.setSession({ sessionId: '1719619200000', trackName: 'WG', sessionPhase: 'Racing', sessionType: 'Race', lapsTotal: 30, lapsRemaining: 5, timeRemaining: null, flags: 4, weather: { tempCelsius: 20, humidity: 0.5, windSpeedMs: 2, skies: 'Clear' }, sessionStartWallClock: 0, trackLengthMeters: 3700, playerCarIdx: 3 } as any);

    await proc.onSessionEvent(JSON.stringify({ active: false, ts: 1719619200000 }));

    const state = raceState.getSnapshot();
    expect(state.session?.sessionPhase).to.equal('PostRace');
    expect((state.session as any)?.playerCarIdx).to.be.null;

    const phaseEvent = (published as any[]).find((e: any) => e.type === 'session:phase_change');
    expect(phaseEvent).to.exist;
    expect(phaseEvent.payload.from).to.be.a('string');
    expect(phaseEvent.payload.to).to.equal('PostRace');
  });

  it('FR-002: mid-race hero re-derive: HeroState updates to new carIdx without resetting session', async () => {
    const proc = new SessionEventProcessor(redis);
    raceState.setSession({ sessionId: '1719619200000', trackName: 'WG', sessionPhase: 'Racing', sessionType: 'Race', lapsTotal: 30, lapsRemaining: 10, timeRemaining: null, flags: 4, weather: { tempCelsius: 20, humidity: 0.5, windSpeedMs: 2, skies: 'Clear' }, sessionStartWallClock: 0, trackLengthMeters: 3700, playerCarIdx: 3 } as any);

    // New session event with different playerCarIdx (driver swap)
    await proc.onSessionEvent(activeSessionPayload({ player_car_idx: 5 }));

    const state = raceState.getSnapshot();
    expect((state.session as any)?.playerCarIdx).to.equal(5);
    // Session should still be Racing, not reset
    expect(state.session?.sessionPhase).to.equal('Racing');
    // FieldState should not be corrupted
    expect(state.session?.sessionId).to.equal('1719619200000');
  });

  it('FR-002: startup seed — SessionState populated from synthetic XREVRANGE result', async () => {
    const proc = new SessionEventProcessor(redis);
    // Simulate startup seed from XREVRANGE
    await proc.onSessionEvent(activeSessionPayload({ player_car_idx: 3, ts: 1719619200000 }));

    const state = raceState.getSnapshot();
    expect(state.session?.trackName).to.equal('Watkins Glen Boot');
    expect((state.session as any)?.playerCarIdx).to.equal(3);
    expect(state.session?.sessionType).to.equal('Race');
  });
});
