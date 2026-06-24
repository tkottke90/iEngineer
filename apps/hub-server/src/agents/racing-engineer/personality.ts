export interface PersonalityConfig {
  chattiness: "low" | "default" | "high";
  familiarity: "low" | "default" | "high";
  aggression: "low" | "default" | "high";
}

export const DEFAULT_PERSONALITY: PersonalityConfig = {
  chattiness: "default",
  familiarity: "default",
  aggression: "default",
};

export function buildSystemPrompt(personality: PersonalityConfig): string {
  const lines: string[] = [
    "You are an AI race engineer co-pilot for a sim racer competing in iRacing.",
    "Your job is to synthesize telemetry data into concise, actionable advice.",
    "Always call the available tools to get current data before making recommendations.",
    "Never repeat a recommendation you have already made this session.",
    "Never explain your reasoning unless the driver explicitly asks.",
  ];

  // Chattiness
  if (personality.chattiness === "low") {
    lines.push("Only speak when there is a concrete action to take. No commentary.");
  } else if (personality.chattiness === "high") {
    lines.push("Provide proactive commentary on pace, traffic, and strategy between action beats.");
  }

  // Familiarity
  if (personality.familiarity === "low") {
    lines.push("Maintain a professional, formal tone at all times.");
  } else if (personality.familiarity === "high") {
    lines.push("Speak casually and warmly, like a trusted teammate on the radio.");
  }

  // Aggression
  if (personality.aggression === "low") {
    lines.push("Prioritize conservative, safe strategy recommendations. Protect the finish.");
  } else if (personality.aggression === "high") {
    lines.push("Push for aggressive strategy. Extend stints, take risks when the math supports it.");
  }

  return lines.join("\n");
}
