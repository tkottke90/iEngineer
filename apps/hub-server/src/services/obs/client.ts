import OBSWebSocket from "obs-websocket-js";
import { EventEmitter } from "node:events";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
const OUTAGE_ALERT_MS = 30_000;

export class OBSClient extends EventEmitter {
  private obs = new OBSWebSocket();
  private connected = false;
  private knownScenes = new Set<string>();
  private lastOurScene: string | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private disconnectedAt: number | null = null;

  constructor(
    private readonly url: string = process.env.OBS_WS_URL ?? "ws://localhost:4455",
    private readonly password: string = process.env.OBS_WS_PASSWORD ?? "",
  ) {
    super();
    this.obs.on("CurrentProgramSceneChanged", ({ sceneName }) => {
      // Detect operator override (scene change we didn't initiate)
      if (sceneName !== this.lastOurScene) {
        this.emit("operator_override", sceneName);
      }
    });
    this.obs.on("ConnectionClosed", () => this.handleDisconnect());
  }

  async connect(): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (!this.connected) {
      try {
        await this.obs.connect(this.url, this.password);
        this.connected = true;
        this.disconnectedAt = null;
        this.emit("connected");
        console.log("OBS WebSocket connected");
      } catch {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  disconnect(): void {
    this.obs.disconnect();
    this.connected = false;
  }

  async switchScene(sceneName: string): Promise<void> {
    this.lastOurScene = sceneName;
    await this.obs.call("SetCurrentProgramScene", { sceneName });
  }

  async getCurrentScene(): Promise<string> {
    const { currentProgramSceneName } = await this.obs.call("GetCurrentProgramScene");
    return currentProgramSceneName;
  }

  onSceneChange(handler: (sceneName: string) => void): () => void {
    this.on("operator_override", handler);
    return () => this.off("operator_override", handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.disconnectedAt = Date.now();
    this.emit("disconnected");
    setTimeout(() => {
      if (!this.connected && this.disconnectedAt) {
        const outageMs = Date.now() - this.disconnectedAt;
        if (outageMs > OUTAGE_ALERT_MS) {
          this.emit("sustained_outage");
        }
      }
    }, OUTAGE_ALERT_MS);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.reconnectTimeout = setTimeout(() => this.connect(), MIN_BACKOFF_MS);
  }
}
