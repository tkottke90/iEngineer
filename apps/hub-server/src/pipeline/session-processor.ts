import type { Redis } from "ioredis";
import type { RaceStateManager } from "../state/race-state.js";
import type { EventBus } from "../events/bus.js";
import type { EventDetector } from "../events/detector.js";

export class SessionProcessor {
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly state: RaceStateManager,
    private readonly bus: EventBus,
    private readonly detector: EventDetector,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    // TODO: XREADGROUP on telemetry:session stream
    // Each message (15 Hz):
    //   - update field CarState for all cars
    //   - update HeroState if source=driver
    //   - on lap completion: update fuel model, tire model
    //   - run detector.checkPositionChanges(), checkPitEvents(), checkGapThresholds(), checkFlags()
    console.log("SessionProcessor started");
  }

  stop(): void {
    this.running = false;
  }
}
