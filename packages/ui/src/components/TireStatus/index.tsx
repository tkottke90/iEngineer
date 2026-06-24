import { h } from "preact";
import type { TireModel } from "@iracing-engineer/types";

interface TireStatusProps {
  model: TireModel;
}

const signalColor = { nominal: "green", watch: "yellow", critical: "red" } as const;

export function TireStatus({ model }: TireStatusProps) {
  return (
    <div class="tire-status">
      <span class="compound-badge">{model.compound}</span>
      <span class="lap-age">{model.lapAge} laps</span>
      <span class={`degradation-signal signal-${signalColor[model.degradationSignal]}`}>
        {model.degradationSignal}
      </span>
      <span class="pace-delta">
        {model.paceDegradationTrend > 0 ? "+" : ""}{model.paceDegradationTrend.toFixed(3)}s
      </span>
      <span class={`confidence-${model.degradationConfidence}`}>
        {model.degradationConfidence}
      </span>
    </div>
  );
}
