import type { EventBus } from "../../events/bus.js";
import type { RaceStateManager } from "../../state/race-state.js";
import type { LLMClient } from "../../services/llm/client.js";
import type { STTHandler } from "../../services/stt/handler.js";
import type { RaceEvent } from "@iracing-engineer/types";
import { MessageQueue, MessageTier } from "./message-queue.js";
import { SafeWindowMonitor } from "./safe-window.js";
import type { PersonalityConfig } from "./personality.js";

export class RacingEngineerAgent {
  private queue = new MessageQueue();
  private safeWindow = new SafeWindowMonitor();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly state: RaceStateManager,
    private readonly llm: LLMClient,
    private readonly personality: PersonalityConfig,
  ) {}

  start(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.handleEvent(event));
    console.log("RacingEngineerAgent started");
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private handleEvent(event: RaceEvent): void {
    switch (event.type) {
      case "hero:fuel_critical":
        this.queue.enqueue("Box now — fuel critical.", MessageTier.IMMEDIATE);
        break;
      case "hero:blue_flag":
        this.queue.enqueue("Blue flag — let the leader past.", MessageTier.IMMEDIATE);
        break;
      case "session:safety_car_deployed":
        this.queue.enqueue("Safety car deployed.", MessageTier.IMMEDIATE);
        break;
      case "hero:pit_window_open":
        this.queue.enqueue("Pit window is open.", MessageTier.SAFE_WINDOW);
        break;
      case "hero:pit_entry":
        // Trigger Tier 3 pit lane briefing via LLM
        this.queuePitBriefing();
        break;
      case "gap:battle":
        this.queue.enqueue("Battle developing behind.", MessageTier.SAFE_WINDOW);
        break;
      default:
        break;
    }
  }

  private async queuePitBriefing(): Promise<void> {
    // TODO: assemble context, call LLM, queue response as Tier 3
  }
}
