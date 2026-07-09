import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { EngineerEventOutcome, Tier3Type } from '@iracing-engineer/types';
import { getPool } from '../db/client.js';
import { logger } from '../logger.js';

export interface RecordEventInput {
  sessionId: string;
  tier3Type: Tier3Type;
  prompt: string;
  // M10 T043 (FR-029): the LLM resolved for THIS call — from hub:config:llm or
  // the engineer-config fallback. Required so a runtime model switch stays
  // auditable per event.
  llmModel: string;
  llmBaseUrl: string;
}

export interface FinalizeEventInput {
  response: string | null;
  latencyMs: number | null;
  toolsCalled: string[];
  outcome: EngineerEventOutcome;
}

/**
 * Insert a provisional engineer_events row BEFORE the engineer acts on the LLM
 * response (FR-022, SC-008). The provisional `outcome` is `error`, so a row that
 * is never finalized (crash mid-synthesis) reads truthfully as a failure.
 *
 * Fail-closed on audit: if the pre-write throws, this logs a structured error and
 * rethrows so the caller (tier3-synthesizer) skips synthesis rather than acting
 * on an unaudited interaction.
 */
export async function recordEvent(
  input: RecordEventInput,
  pool: Pool = getPool(),
): Promise<string> {
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO engineer_events (id, session_id, tier3_type, prompt, tools_called, outcome, llm_model, llm_base_url)
       VALUES ($1, $2, $3, $4, '{}', 'error', $5, $6)`,
      [id, input.sessionId, input.tier3Type, input.prompt, input.llmModel, input.llmBaseUrl],
    );
    return id;
  } catch (err) {
    logger.error('[engineer] audit pre-write failed — skipping synthesis (fail-closed)', {
      component: 'engineer',
      event: 'audit_prewrite_failed',
      tier3Type: input.tier3Type,
      sessionId: input.sessionId,
      error: String(err),
    });
    throw err;
  }
}

/**
 * Update the row with the final response, latency, tools, and outcome AFTER
 * synthesis. A finalize failure is logged but NOT thrown — the clip has already
 * been produced, so crashing here would be worse than a missing outcome update.
 */
export async function finalizeEvent(
  id: string,
  input: FinalizeEventInput,
  pool: Pool = getPool(),
): Promise<void> {
  try {
    await pool.query(
      `UPDATE engineer_events
         SET response = $2, latency_ms = $3, tools_called = $4, outcome = $5
       WHERE id = $1`,
      [id, input.response, input.latencyMs, input.toolsCalled, input.outcome],
    );
  } catch (err) {
    logger.error('[engineer] audit finalize failed', {
      component: 'engineer',
      event: 'audit_finalize_failed',
      id,
      outcome: input.outcome,
      error: String(err),
    });
  }
}
