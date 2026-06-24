import type { RaceStateManager } from "../state/race-state.js";
import type { EventBus } from "../events/bus.js";
import type { PubSubManager } from "../redis/pubsub.js";

export class YamlProcessor {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly pubsub: PubSubManager,
    private readonly state: RaceStateManager,
    private readonly bus: EventBus,
  ) {}

  start(): void {
    this.unsubscribe = this.pubsub.subscribe("session:yaml", (raw) => {
      this.handleYaml(raw);
    });
    console.log("YamlProcessor started");
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private handleYaml(raw: string): void {
    // TODO: parse YAML session info
    // Update SessionState: track name, weather, driver roster, camera list, sector definitions
    // Emit session:phase_change if phase changed
  }
}
