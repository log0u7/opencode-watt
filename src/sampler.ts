import type { EnergySample, PowerSample, Sample } from "./probes.js";

export type TickResult = {
  raw_j: number;
  attributed_j: number;
  per_source: Record<string, { raw_j: number; attributed_j: number }>;
};

export type WattReading = { source: string; id: string; watts: number; at: number };

type Sight = { sample: Sample; at: number };

const DEFAULT_BASELINE_WINDOW = 30;

// Integrates probe samples into energy (joules) per tick.
// - energy counters: accrue the exact delta between sightings (wrap-aware)
// - power samples: trapezoidal integration over the sighting span
// - idle baseline: rolling mean of rates seen on idle ticks (busyCount === 0),
//   subtracted per meter with a floor at zero when subtract_idle is set
export class EnergyIntegrator {
  private last = new Map<string, Sight>();
  private rates = new Map<string, number>();
  private baselines = new Map<string, number[]>();

  constructor(private readonly opts: { subtract_idle: boolean; baseline_window?: number }) {}

  tick(samples: Sample[], now: number, busyCount = 0): TickResult {
    let raw = 0;
    let attributed = 0;
    const perSource = new Map<string, { raw_j: number; attributed_j: number }>();
    for (const s of samples) {
      const key = `${s.source}:${s.id}`;
      const prev = this.last.get(key);
      this.last.set(key, { sample: s, at: now });
      if (!prev) continue;

      const span = Math.max(1e-9, (now - prev.at) / 1000);
      let accrual: number;
      let rate: number;

      if (s.kind === "energy") {
        const p = prev.sample as EnergySample;
        let delta = s.joules - p.joules;
        if (delta < 0) {
          const wrapMax = s.wrap_max_j ?? p.wrap_max_j;
          if (wrapMax !== undefined) {
            const wrapped = wrapMax - p.joules + s.joules;
            delta = wrapped >= 0 && wrapped <= wrapMax ? wrapped : 0;
          } else {
            delta = 0;
          }
        }
        accrual = delta;
        rate = delta / span;
      } else {
        const p = prev.sample as PowerSample;
        accrual = ((p.watts + s.watts) / 2) * span;
        rate = s.watts;
      }

      this.rates.set(key, rate);
      raw += accrual;
      if (busyCount === 0) {
        this.recordBaseline(key, rate);
      }
      let attributedAccrual: number;
      if (this.opts.subtract_idle) {
        const baseline = this.meanBaseline(key);
        attributedAccrual = Math.max(0, accrual - (baseline ?? 0) * span);
      } else {
        attributedAccrual = accrual;
      }
      attributed += attributedAccrual;
      const ps = perSource.get(s.source) ?? { raw_j: 0, attributed_j: 0 };
      ps.raw_j += accrual;
      ps.attributed_j += attributedAccrual;
      perSource.set(s.source, ps);
    }
    return { raw_j: raw, attributed_j: attributed, per_source: Object.fromEntries(perSource) };
  }

  lastWatts(): WattReading[] {
    const out: WattReading[] = [];
    for (const [key, rate] of this.rates) {
      const sight = this.last.get(key);
      if (!sight) continue;
      const sep = key.indexOf(":");
      out.push({
        source: key.slice(0, sep),
        id: key.slice(sep + 1),
        watts: rate,
        at: sight.at,
      });
    }
    return out;
  }

  private recordBaseline(key: string, rate: number): void {
    const window = this.opts.baseline_window ?? DEFAULT_BASELINE_WINDOW;
    const ring = this.baselines.get(key) ?? [];
    ring.push(rate);
    if (ring.length > window) ring.shift();
    this.baselines.set(key, ring);
  }

  private meanBaseline(key: string): number | null {
    const ring = this.baselines.get(key);
    if (!ring || ring.length === 0) return null;
    return ring.reduce((a, b) => a + b, 0) / ring.length;
  }
}
