import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { Pool } from 'pg';
import { recordEvent, finalizeEvent } from '../../../src/engineer/engineer-events.js';
import { logger } from '../../../src/logger.js';

interface QueryCall {
  text: string;
  values?: unknown[];
}

// Minimal fake Pool that records queries and can be told to fail a statement.
function fakePool(failOn?: 'INSERT' | 'UPDATE'): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (failOn && text.includes(failOn)) throw new Error('db boom');
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as Pool, calls };
}

// Capture logger.error output for the duration of `fn`.
async function captureError(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const orig = logger.error;
  (logger as unknown as { error: (m: string) => void }).error = (m: string) => logs.push(String(m));
  try {
    await fn();
  } finally {
    (logger as unknown as { error: typeof logger.error }).error = orig;
  }
  return logs;
}

describe('engineer-events — recordEvent (FR-022 write-before-act)', () => {
  it('INSERTs a provisional row with outcome=error, the resolved LLM fields (T043/FR-029), and returns a uuid', async () => {
    const { pool, calls } = fakePool();
    const id = await recordEvent(
      {
        sessionId: 's1',
        tier3Type: 'driver-query',
        prompt: 'p',
        llmModel: 'audit-model',
        llmBaseUrl: 'http://llm.example/v1',
      },
      pool,
    );
    expect(id).to.match(/^[0-9a-f-]{36}$/);
    expect(calls).to.have.length(1);
    expect(calls[0].text).to.include('INSERT INTO engineer_events');
    expect(calls[0].text).to.include("'error'"); // provisional outcome
    expect(calls[0].text).to.include('llm_model');
    expect(calls[0].text).to.include('llm_base_url');
    expect(calls[0].values).to.deep.equal([
      id,
      's1',
      'driver-query',
      'p',
      'audit-model',
      'http://llm.example/v1',
    ]);
  });

  it('fail-closed: logs and rethrows when the pre-write fails', async () => {
    const { pool } = fakePool('INSERT');
    let threw = false;
    const logs = await captureError(async () => {
      try {
        await recordEvent(
          { sessionId: 's1', tier3Type: 'pit-entry', prompt: 'p', llmModel: 'm', llmBaseUrl: 'x' },
          pool,
        );
      } catch {
        threw = true;
      }
    });
    expect(threw, 'recordEvent must rethrow so the caller skips synthesis').to.be.true;
    expect(logs.some((l) => l.includes('audit pre-write failed'))).to.be.true;
  });
});

describe('engineer-events — finalizeEvent', () => {
  it('UPDATEs the row with response, latency, tools, and outcome', async () => {
    const { pool, calls } = fakePool();
    await finalizeEvent(
      'id-1',
      { response: 'ok', latencyMs: 1234, toolsCalled: ['get_fuel_status'], outcome: 'synthesized' },
      pool,
    );
    expect(calls[0].text).to.include('UPDATE engineer_events');
    expect(calls[0].values).to.deep.equal(['id-1', 'ok', 1234, ['get_fuel_status'], 'synthesized']);
  });

  it('does NOT throw when the finalize fails (clip already produced) but logs', async () => {
    const { pool } = fakePool('UPDATE');
    const logs = await captureError(async () => {
      await finalizeEvent(
        'id-1',
        { response: 'ok', latencyMs: 1, toolsCalled: [], outcome: 'synthesized' },
        pool,
      );
    });
    expect(logs.some((l) => l.includes('audit finalize failed'))).to.be.true;
  });
});
