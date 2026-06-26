export function now(): number {
  return performance.now();
}

export interface Stats {
  mean: number;
  p50: number;
  p95: number;
}

export function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? sorted[sorted.length - 1];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  return { mean, p50, p95 };
}

export function fmt(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}
