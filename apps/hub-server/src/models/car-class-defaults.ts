export interface CarClassDefaults {
  tankCapacityLiters: number;
  defaultBurnRatePerLap: number;
}

// iRacing carClassId → class defaults
// verified: 2026-06-30 against iRacing SDK CarClassID values
export const CAR_CLASS_DEFAULTS: Record<number, CarClassDefaults> = {
  4074: { tankCapacityLiters: 120, defaultBurnRatePerLap: 3.2 },  // BMW M4 GT3 (GT3 class) — verified: 2026-06-30
  3916: { tankCapacityLiters: 80, defaultBurnRatePerLap: 2.8 },   // Ferrari 488 GTE (GTE class) — verified: 2026-06-30
  67:   { tankCapacityLiters: 32, defaultBurnRatePerLap: 1.8 },   // Dallara IR18 — verified: 2026-06-30
  2523: { tankCapacityLiters: 40, defaultBurnRatePerLap: 2.2 },   // Mazda MX-5 Cup — verified: 2026-06-30
};

const FALLBACK: CarClassDefaults = { tankCapacityLiters: 60, defaultBurnRatePerLap: 3.0 };

export function getCarClassDefaults(carClassId: number): CarClassDefaults {
  return CAR_CLASS_DEFAULTS[carClassId] ?? FALLBACK;
}
