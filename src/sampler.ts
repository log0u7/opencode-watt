import type { EnergySample, PowerSample, Sample } from "./probes.js";

export type TickResult = {
  raw_j: number;
  attributed_j: number;
  per_source: Record<string, { raw_j: number; attributed_j: number }>;
};

export type WattReading = { source: string; id: string; watts: number; at: number };

type Sight = { sample: Sample; at: number };

const DEFAULT_BASELINE_WINDOW = 30;
// A power span longer than this is a clock jump (suspended process resuming),
// not a real sampling interval: integrating it would inflate the energy.
const MAX_POWER_SPAN_S = 3600;

// Integrates probe samples into energy (joules) per tick.
// - energy counters: accrue the exact delta between sightings (wrap-aware)
// - power samples: trapezoidal integration over the sighting span
// - idle baseline: rolling mean of rates seen on idle ticks (busyCount === 0),
//   subtracted per meter with a floor at zero when subtract_idle is set
export class EnergyIntegrator {
  private last = new Map<string, Sight>();
  private readings = new Map<string, WattReading>();
  private baselines = new Map<string, number[]>();

  constructor(private readonly opts: { subtract_idle: boolean; baseline_window?: number }) {}

  tick(samples: Sample[], now: number, busyCount = 0): TickResult {
    let raw = 0;
    let attributed = 0;
    const perSource = new Map<string, { raw_j: number; attributed_j: number }>();
    for (const s of samples) {
      const key = `${s.source}:${s.id}`;
      const prev = this.last.get(key);
      // Spans are measured between the readings themselves, so a slow meter
      // (process spawn) shifts its own next span instead of shrinking it.
      // `now` is the fallback for an injected probe that stamps nothing.
      const at = Number.isFinite(s.at) ? s.at : now;
      this.last.set(key, { sample: s, at });
      if (!prev) continue;

      const span = (at - prev.at) / 1000;
      // A non-positive span means the clock stepped backwards (or two readings
      // share a stamp): resync without accruing, and never derive a rate that
      // would poison the idle baseline.
      if (span <= 0) continue;

      let accrual: number;
      let rate: number;

      if (s.kind === "energy") {
        const p = prev.sample as EnergySample;
        let delta = s.joules - p.joules;
        if (delta < 0) {
          const wrapMax = s.wrap_max_j ?? p.wrap_max_j;
          // A wrap only makes sense if the previous value was near the limit;
          // a drop from mid-range is a counter reset (reboot), not a wrap.
          if (wrapMax !== undefined && p.joules >= wrapMax * 0.5) {
            const wrapped = wrapMax - p.joules + s.joules;
            delta = wrapped >= 0 && wrapped <= wrapMax ? wrapped : 0;
          } else {
            delta = 0;
          }
        }
        accrual = delta;
        rate = delta / span;
      } else {
        // Power is area under the curve: an implausibly long span would inflate
        // it, so treat it as a clock jump and skip this interval.
        if (span > MAX_POWER_SPAN_S) continue;
        const p = prev.sample as PowerSample;
        accrual = ((p.watts + s.watts) / 2) * span;
        rate = s.watts;
      }

      this.readings.set(key, { source: s.source, id: s.id, watts: rate, at });
      raw += accrual;
      // First derivable rate seeds the baseline: without it a session that starts
      // while the host is already busy would be charged the whole machine.
      if (busyCount === 0 || !this.baselines.has(key)) {
        this.recordBaseline(key, rate);
      }
      let attributedAccrual: number;
      if (this.opts.subtract_idle) {
        const baseline = this.medianBaseline(key);
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
    return [...this.readings.values()];
  }

  // How many baseline samples the least-warm meter has collected. Used by the
  // report to disclose that idle subtraction is still converging.
  baselineProgress(): { filled: number; window: number } {
    const window = this.opts.baseline_window ?? DEFAULT_BASELINE_WINDOW;
    let filled = this.baselines.size === 0 ? 0 : window;
    for (const ring of this.baselines.values()) {
      filled = Math.min(filled, ring.length);
    }
    return { filled, window };
  }

  private recordBaseline(key: string, rate: number): void {
    const window = this.opts.baseline_window ?? DEFAULT_BASELINE_WINDOW;
    const ring = this.baselines.get(key) ?? [];
    ring.push(rate);
    if (ring.length > window) ring.shift();
    this.baselines.set(key, ring);
  }

  // Median, not mean: one idle tick polluted by another process (a compile,
  // an app launch) must not inflate the baseline for the next window.
  private medianBaseline(key: string): number | null {
    const ring = this.baselines.get(key);
    if (!ring || ring.length === 0) return null;
    const sorted = [...ring].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
}
