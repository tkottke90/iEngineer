import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { getPool, runMigrations, closePool } from '../../../src/db/client.js';
import { recordEvent, finalizeEvent } from '../../../src/engineer/engineer-events.js';

// Integration test — requires a running Postgres (infra/docker-compose.yml).
// Run via `npm run test:integration`. Skips gracefully if Postgres is unreachable.
describe('engineer-events — Postgres round-trip', function () {
  this.timeout(10000);
  let available = false;

  before(async function () {
    try {
      await getPool().query('SELECT 1');
      await runMigrations();
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[skip] Postgres unreachable — skipping engineer_events integration test');
      this.skip();
    }
  });

  after(async function () {
    if (available) await closePool();
  });

  it('records a provisional row then finalizes it (SC-008)', async () => {
    const sessionId = `it-${Date.now()}`;
    const id = await recordEvent({
      sessionId,
      tier3Type: 'driver-query',
      prompt: 'do we pit this lap?',
    });

    const provisional = await getPool().query('SELECT * FROM engineer_events WHERE id = $1', [id]);
    expect(provisional.rowCount).to.equal(1);
    expect(provisional.rows[0].outcome).to.equal('error'); // provisional
    expect(provisional.rows[0].session_id).to.equal(sessionId);

    await finalizeEvent(id, {
      response: 'Box this lap, fuel is tight.',
      latencyMs: 4200,
      toolsCalled: ['get_fuel_status'],
      outcome: 'synthesized',
    });

    const final = await getPool().query('SELECT * FROM engineer_events WHERE id = $1', [id]);
    expect(final.rows[0].outcome).to.equal('synthesized');
    expect(final.rows[0].latency_ms).to.equal(4200);
    expect(final.rows[0].tools_called).to.deep.equal(['get_fuel_status']);
    expect(final.rows[0].response).to.include('Box this lap');
  });
});
