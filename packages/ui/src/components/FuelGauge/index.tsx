import { h } from "preact";
import type { FuelModel } from "@iracing-engineer/types";

interface FuelGaugeProps {
  model: FuelModel;
}

export function FuelGauge({ model }: FuelGaugeProps) {
  const pct = Math.min(100, Math.max(0, (model.fuelRemaining / model.fuelToFinish) * 100));
  const isDeficit = model.fuelDeficit > 0;

  return (
    <div class="fuel-gauge">
      <div class="fuel-bar">
        <div class="fuel-fill" style={{ width: `${pct}%` }} />
      </div>
      <div class="fuel-stats">
        <span>{model.fuelRemaining.toFixed(1)}L remaining</span>
        <span>{model.burnRatePerLap.toFixed(3)}L/lap</span>
        <span>{model.lapsRemaining.toFixed(1)} laps</span>
        {isDeficit && <span class="deficit">+{model.fuelDeficit.toFixed(2)}L needed</span>}
      </div>
      <div class="fuel-meta">
        <span class={`confidence-${model.confidenceLevel}`}>{model.confidenceLevel}</span>
        <span class="source">{model.dataSource}</span>
      </div>
    </div>
  );
}
