import type { FuelModel, TireModel, LlmToolResult } from '@iracing-engineer/types';

/**
 * LLM tools expose current race state to the reasoning model. They read the M3
 * model snapshots (the same source the rule engine uses) — the engineer never
 * fabricates fuel/tire figures (FR-007). When a model is not yet available, the
 * tool returns a well-formed `available: false` result (FR-008).
 *
 * NOTE (contract deviation): the tool contract's example fields (per-tire wear %,
 * temperatures, exact fuel lapsRemaining schema) are aspirational; M5's M3 state
 * carries the fields returned below. We report what is genuinely modeled rather
 * than inventing per-tire wear that M3 does not compute.
 */
export interface ToolContext {
  getFuelModel: () => FuelModel | null;
  getTireModel: () => TireModel | null;
}

export interface OpenAiToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, never>; required: [] };
  };
}

function schema(name: string, description: string): OpenAiToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, required: [] } } };
}

export function getFuelStatus(ctx: ToolContext): LlmToolResult {
  const m = ctx.getFuelModel();
  if (!m) return { available: false, reason: 'fuel model not yet available' };
  return {
    available: true,
    data: {
      lapsRemaining: m.lapsRemaining,
      burnRatePerLap: Number(m.burnRatePerLap.toFixed(2)),
      fuelRemainingLiters: Number(m.fuelRemaining.toFixed(1)),
      fuelDeficitLiters: Number(m.fuelDeficit.toFixed(1)),
      dataSource: m.dataSource,
      confidence: m.confidenceLevel,
    },
  };
}

export function getTireStatus(ctx: ToolContext): LlmToolResult {
  const m = ctx.getTireModel();
  if (!m) return { available: false, reason: 'tire model not yet available' };
  if (m.lapAge <= 0) return { available: false, reason: 'no flying lap yet' };
  return {
    available: true,
    data: {
      compound: m.compound,
      lapAge: m.lapAge,
      degradationSignal: m.degradationSignal,
      degradationConfidence: m.degradationConfidence,
      paceDegradationTrend: Number(m.paceDegradationTrend.toFixed(3)),
      setsRemaining: m.setsRemaining,
    },
  };
}

export interface Tools {
  schemas: OpenAiToolSchema[];
  run(name: string): LlmToolResult;
}

export function createTools(ctx: ToolContext): Tools {
  const schemas = [
    schema(
      'get_fuel_status',
      'Current fuel state: laps of fuel remaining, burn rate per lap, fuel remaining and deficit to finish.',
    ),
    schema(
      'get_tire_status',
      'Current tire state: compound, laps on this set (lap age), and pace-degradation signal.',
    ),
  ];
  const run = (name: string): LlmToolResult => {
    switch (name) {
      case 'get_fuel_status':
        return getFuelStatus(ctx);
      case 'get_tire_status':
        return getTireStatus(ctx);
      default:
        return { available: false, reason: `unknown tool: ${name}` };
    }
  };
  return { schemas, run };
}
