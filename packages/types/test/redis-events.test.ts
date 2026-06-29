import { expect } from 'chai';
import { isConnectionEvent, isSessionEvent } from '../src/redis-events.js';

describe('isConnectionEvent', () => {
  it('accepts a valid Connected event', () => {
    expect(isConnectionEvent({ status: 'Connected', ts: 1719619200000 })).to.be.true;
  });

  it('accepts a valid Disconnected event', () => {
    expect(isConnectionEvent({ status: 'Disconnected', ts: 0 })).to.be.true;
  });

  it('rejects missing ts', () => {
    expect(isConnectionEvent({ status: 'Connected' })).to.be.false;
  });

  it('rejects invalid status', () => {
    expect(isConnectionEvent({ status: 'Unknown', ts: 1000 })).to.be.false;
  });

  it('rejects null', () => {
    expect(isConnectionEvent(null)).to.be.false;
  });

  it('rejects non-object', () => {
    expect(isConnectionEvent('Connected')).to.be.false;
  });
});

describe('isSessionEvent', () => {
  it('accepts a valid active=true session event', () => {
    expect(
      isSessionEvent({
        active: true,
        ts: 1719619200000,
        track_name: 'Watkins Glen Boot',
        player_car_name: 'BMW M4 GT3',
        player_car_idx: 3,
        session_type: 'Race',
        wall_clock_time: '14:32:07',
      }),
    ).to.be.true;
  });

  it('accepts a valid active=false session event', () => {
    expect(isSessionEvent({ active: false, ts: 1719619200000 })).to.be.true;
  });

  it('rejects active=true without required fields', () => {
    expect(isSessionEvent({ active: true, ts: 1000 })).to.be.false;
  });

  it('rejects active=true with wrong player_car_idx type', () => {
    expect(
      isSessionEvent({
        active: true,
        ts: 1000,
        track_name: 'Spa',
        player_car_name: 'GT3',
        player_car_idx: '3', // string, should be number
        session_type: 'Race',
        wall_clock_time: '12:00:00',
      }),
    ).to.be.false;
  });

  it('rejects missing ts', () => {
    expect(isSessionEvent({ active: false })).to.be.false;
  });

  it('rejects null', () => {
    expect(isSessionEvent(null)).to.be.false;
  });
});
