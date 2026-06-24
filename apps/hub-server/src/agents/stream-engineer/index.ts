import type { EventBus } from "../../events/bus.js";
import type { RaceStateManager } from "../../state/race-state.js";
import type { OBSClient } from "../../services/obs/client.js";
import type { RaceEvent, BroadcastPlan } from "@iracing-engineer/types";
import { ShotQueue, ShotTier } from "./shot-queue.js";
import { CutWindowMonitor } from "./cut-window.js";
import { BroadcastPlanManager } from "./broadcast-plan.js";
import { StreamSessionMemory } from "./session-memory.js";
import { CameraSelector } from "./camera-select.js";

const MANUAL_HOLD_MS = 60_000;

export class StreamEngineerAgent {
  private shotQueue = new ShotQueue();
  private cutWindow = new CutWindowMonitor();
  private memory = new StreamSessionMemory();
  private planManager: BroadcastPlanManager;
  private cameraSelector = new CameraSelector();
  private unsubscribe: (() => void) | null = null;
  private manualHoldUntil = 0;
  private lastCutAt = 0;
  private evalInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly state: RaceStateManager,
    private readonly obs: OBSClient,
    plan: BroadcastPlan | null,
  ) {
    this.planManager = new BroadcastPlanManager(plan);
    this.obs.onSceneChange((scene) => this.handleOBSOverride(scene));
  }

  start(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.handleEvent(event));
    this.evalInterval = setInterval(() => this.evaluate(), 500);
    console.log("StreamEngineerAgent started");
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.evalInterval) clearInterval(this.evalInterval);
  }

  private handleEvent(event: RaceEvent): void {
    switch (event.type) {
      case "session:flag_red":
      case "session:safety_car_deployed":
      case "hero:incident":
        this.shotQueue.enqueue({ scene: "incident", cameraName: "", reason: event.type, tier: ShotTier.IMMEDIATE });
        break;
      case "hero:pit_entry":
        this.shotQueue.enqueue({ scene: "pit", cameraName: "", reason: "hero pit entry", tier: ShotTier.IMMEDIATE });
        break;
      case "gap:battle":
        this.shotQueue.enqueue({ scene: "battle", cameraName: "", reason: "battle developing", tier: ShotTier.EVENT_DRIVEN });
        break;
      default:
        break;
    }
  }

  private async evaluate(): Promise<void> {
    const inManualHold = Date.now() < this.manualHoldUntil;
    const timeSinceLastCut = (Date.now() - this.lastCutAt) / 1000;
    const state = this.state.getState();
    const cutWindowOpen = this.cutWindow.update(state, null, timeSinceLastCut);

    const shot = this.shotQueue.processNext(
      inManualHold ? false : cutWindowOpen,
      timeSinceLastCut,
    );
    if (!shot) return;

    // Tier 1 overrides manual hold
    if (inManualHold && shot.tier !== ShotTier.IMMEDIATE) return;

    try {
      await this.obs.switchScene(shot.scene);
      this.memory.recordCut({ scene: shot.scene, cameraType: "unknown", carIdx: null, timestamp: Date.now() });
      this.lastCutAt = Date.now();
    } catch {
      // OBS outage handled in OBSClient
    }
  }

  private handleOBSOverride(scene: string): void {
    this.manualHoldUntil = Date.now() + MANUAL_HOLD_MS;
  }
}
