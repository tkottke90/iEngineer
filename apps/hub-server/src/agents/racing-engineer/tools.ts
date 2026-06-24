import type { RaceState } from "@iracing-engineer/types";

export const RACING_ENGINEER_TOOLS = [
  {
    name: "get_fuel_model",
    description: "Get the current fuel model including burn rate, laps remaining, and any deficit.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_tire_model",
    description: "Get the current tire model including compound, lap age, and degradation signal.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_gap_model",
    description: "Get gap and battle status to cars immediately ahead and behind.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["ahead", "behind", "both"] },
      },
      required: ["direction"],
    },
  },
  {
    name: "get_field_positions",
    description: "Get the current race positions for the full field or a specific range.",
    input_schema: {
      type: "object",
      properties: {
        positions: { type: "string", description: "e.g. 'top5' or 'p1-p10'" },
      },
      required: [],
    },
  },
  {
    name: "get_recent_events",
    description: "Get the most recent race events (pit stops, position changes, flags).",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 5 },
      },
      required: [],
    },
  },
] as const;

export function handleToolCall(name: string, input: unknown, state: RaceState): unknown {
  switch (name) {
    case "get_fuel_model":
      return state.hero ? { note: "FuelModel not yet attached to HeroState" } : null;
    case "get_tire_model":
      return state.hero ? { compound: state.hero.tireCompound, lapAge: state.hero.lapCompleted } : null;
    case "get_gap_model":
      return state.signals.activeBattles;
    case "get_field_positions":
      return Object.values(state.field).sort((a, b) => a.position - b.position).slice(0, 10);
    case "get_recent_events":
      return [];
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
