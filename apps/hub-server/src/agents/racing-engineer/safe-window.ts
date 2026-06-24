import { EventEmitter } from "node:events";

const LATERAL_G_THRESHOLD = 0.4;
const THROTTLE_THRESHOLD = 0.7;
const BRAKE_LOOKBACK_METERS = 150;

interface BlackoutZone {
  id: string;
  startPct: number;
  endPct: number;
}

export class SafeWindowMonitor extends EventEmitter {
  private _isOpen = false;
  private blackoutZones: BlackoutZone[] = [];
  private recentBrakePositions: number[] = [];

  get isOpen(): boolean {
    return this._isOpen;
  }

  update(latAccel: number, throttle: number, brake: number, lapDistPct: number, speed: number): void {
    // Track recent brake positions (approximate via lapDistPct)
    if (brake > 0) {
      this.recentBrakePositions.push(lapDistPct);
    }
    // Prune positions more than ~150m back (rough: 150m / track_length as pct)
    // TODO: use actual track length to convert meters to pct
    this.recentBrakePositions = this.recentBrakePositions.slice(-10);

    const inBlackout = this.blackoutZones.some(
      (z) => lapDistPct >= z.startPct && lapDistPct <= z.endPct,
    );
    const recentBrake = this.recentBrakePositions.length > 0;

    const wasOpen = this._isOpen;
    this._isOpen =
      !inBlackout &&
      Math.abs(latAccel) < LATERAL_G_THRESHOLD &&
      throttle > THROTTLE_THRESHOLD &&
      !recentBrake;

    if (this._isOpen && !wasOpen) this.emit("safe_window_open");
    if (!this._isOpen && wasOpen) this.emit("safe_window_closed");
  }

  addBlackoutZone(startPct: number, endPct: number): string {
    const id = crypto.randomUUID();
    this.blackoutZones.push({ id, startPct, endPct });
    return id;
  }

  removeBlackoutZone(id: string): void {
    this.blackoutZones = this.blackoutZones.filter((z) => z.id !== id);
  }
}
