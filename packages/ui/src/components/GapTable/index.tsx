import { h } from "preact";
import type { GapModel } from "@iracing-engineer/types";

interface GapTableProps {
  gaps: GapModel[];
}

export function GapTable({ gaps }: GapTableProps) {
  return (
    <table class="gap-table">
      <thead>
        <tr>
          <th>Car</th>
          <th>Gap</th>
          <th>Trend</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {gaps.map((g) => (
          <tr key={`${g.leadCarIdx}-${g.trailCarIdx}`}>
            <td>{g.leadCarIdx} → {g.trailCarIdx}</td>
            <td>{g.gapSeconds.toFixed(3)}s</td>
            <td>{g.closingRate > 0 ? "▼" : "▲"} {Math.abs(g.closingRate).toFixed(2)}s/lap</td>
            <td class={`status-${g.battleStatus}`}>{g.battleStatus}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
