import { describe, it } from 'mocha';
import { expect } from 'chai';
import { parseEntries } from '../../../src/redis/consumer.js';

describe('consumer parseEntries — wire formats', () => {
  it('uses the `payload` field for events streams (JSON blob)', () => {
    const raw: [string, string[]][] = [['1-1', ['payload', '{"active":true,"ts":123}']]];
    const [entry] = parseEntries(raw);
    expect(JSON.parse(entry.payload)).to.deep.equal({ active: true, ts: 123 });
  });

  it('reconstructs a typed tick from field-per-column telemetry (the Rust publisher format)', () => {
    // Mirrors publish_session/publish_live: _ts + named fields, all string-valued.
    const raw: [string, string[]][] = [
      [
        '2-1',
        [
          '_ts',
          '1719619200456',
          'FuelLevel',
          '28.5',
          'SessionFlags',
          '0',
          'CarIdxOnPitRoad',
          'false',
          'CarIdxPosition',
          '[1,3,2,4]',
          'OilTemp',
          '', // Unavailable → null
        ],
      ],
    ];
    const [entry] = parseEntries(raw);
    const tick = JSON.parse(entry.payload);
    expect(tick._ts).to.equal(1719619200456);
    expect(tick.FuelLevel).to.equal(28.5);
    expect(tick.SessionFlags).to.equal(0);
    expect(tick.CarIdxOnPitRoad).to.equal(false);
    expect(tick.CarIdxPosition).to.deep.equal([1, 3, 2, 4]);
    expect(tick.OilTemp).to.equal(null);
  });

  it('never yields an empty payload for a non-empty telemetry entry (regression for the parse-error spam)', () => {
    const raw: [string, string[]][] = [['3-1', ['_ts', '1', 'FuelLevel', '10']]];
    const [entry] = parseEntries(raw);
    expect(entry.payload).to.not.equal('');
    expect(() => JSON.parse(entry.payload)).to.not.throw();
  });
});
