import type { Redis } from "ioredis";
import type { RaceStateManager } from "../state/race-state.js";
import type { EventBus } from "../events/bus.js";

const LATERAL_G_THRESHOLD = 0.4;
const THROTTLE_THRESHOLD = 0.7;
const INCIDENT_LONG_G_THRESHOLD = 2.5;

export class LiveProcessor {
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly state: RaceStateManager,
    private readonly bus: EventBus,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    const group = "live-processor";
    const consumer = "hub-1";

    // TODO: create consumer group if not exists (handle BUSYGROUP)
    // TODO: XREADGROUP loop at 60 Hz budget
    // Each message: update safeWindowOpen signal, detect incidents
    console.log("LiveProcessor started");
  }

  stop(): void {
    this.running = false;
  }

  private evaluateSafeWindow(latAccel: number, throttle: number, recentBrake: number): boolean {
    return (
      Math.abs(latAccel) < LATERAL_G_THRESHOLD &&
      throttle > THROTTLE_THRESHOLD &&
      recentBrake === 0
    );
  }

  private detectIncident(longAccel: number): boolean {
    return Math.abs(longAccel) > INCIDENT_LONG_G_THRESHOLD;
  }
}
