import { describe, expect, it } from "vitest";

import { EnergyIntegrator, type Sample } from "../src/sampler.js";

const power = (id: string, watts: number, at: number): Sample => ({
  kind: "power",
  source: "s",
  id,
  watts,
  at,
});

const energy = (id: string, joules: number, at: number, wrapMax?: number): Sample => ({
  kind: "energy",
  source: "s",
  id,
  joules,
  ...(wrapMax !== undefined ? { wrap_max_j: wrapMax } : {}),
  at,
});

describe("EnergyIntegrator", () => {
  it("accrues counter deltas in joules", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    itg.tick([energy("c", 1_000_000, 0)], 0);
    const t1 = itg.tick([energy("c", 3_000_000, 1000)], 1000);
    expect(t1.raw_j).toBeCloseTo(2_000_000, 6);
  });

  it("ignores the first counter sighting (unknown interval)", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    const t0 = itg.tick([energy("c", 9_000_000, 0)], 0);
    expect(t0.raw_j).toBe(0);
  });

  it("handles counter wrap using wrap_max_j", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    const max = 262_143.32885;
    itg.tick([energy("c", 250_000, 0, max)], 0);
    const t1 = itg.tick([energy("c", 1_000, 1000, max)], 1000);
    expect(t1.raw_j).toBeCloseTo(max - 250_000 + 1_000, 3);
  });

  it("drops a decreasing counter without wrap_max", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    itg.tick([energy("c", 250_000, 0)], 0);
    const t1 = itg.tick([energy("c", 1_000, 1000)], 1000);
    expect(t1.raw_j).toBe(0);
  });

  it("integrates power samples trapezoidally", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    itg.tick([power("g", 10, 0)], 0);
    const t1 = itg.tick([power("g", 20, 2000)], 2000);
    expect(t1.raw_j).toBeCloseTo(((10 + 20) / 2) * 2, 6);
  });

  it("no accrual before a second power sample", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    const t0 = itg.tick([power("g", 10, 0)], 0);
    expect(t0.raw_j).toBe(0);
  });

  it("skipped ticks still accrue the full counter delta", () => {
    const itg = new EnergyIntegrator({ subtract_idle: false });
    itg.tick([energy("c", 100, 0)], 0);
    itg.tick([], 1000); // probe missing this tick
    const t2 = itg.tick([energy("c", 300, 2000)], 2000);
    expect(t2.raw_j).toBeCloseTo(200, 6);
  });

  describe("idle baseline subtraction", () => {
    it("subtracts the baseline from busy ticks", () => {
      const itg = new EnergyIntegrator({ subtract_idle: true });
      // idle (busyCount=0 default): two power ticks establish a 10 W baseline
      itg.tick([power("g", 10, 0)], 0);
      itg.tick([power("g", 10, 1000)], 1000);
      const busy = itg.tick([power("g", 50, 3000)], 3000, 1);
      expect(busy.raw_j).toBeCloseTo(60, 6); // (10+50)/2 * 2
      expect(busy.attributed_j).toBeCloseTo(60 - 10 * 2, 6);
    });

    it("floors at zero when busy power is below baseline", () => {
      const itg = new EnergyIntegrator({ subtract_idle: true });
      itg.tick([power("g", 100, 0)], 0);
      itg.tick([power("g", 100, 1000)], 1000);
      const busy = itg.tick([power("g", 50, 2000)], 2000, 1);
      expect(busy.attributed_j).toBe(0);
      expect(busy.raw_j).toBeGreaterThan(0);
    });

    it("does not subtract when no baseline exists yet", () => {
      const itg = new EnergyIntegrator({ subtract_idle: true });
      itg.tick([power("g", 50, 0)], 0, 1);
      const busy = itg.tick([power("g", 50, 1000)], 1000, 1);
      expect(busy.attributed_j).toBeCloseTo(busy.raw_j, 6);
    });

    it("subtracts counter-derived rates too", () => {
      const itg = new EnergyIntegrator({ subtract_idle: true });
      // idle counter ticks: 10 J/s = 10 W
      itg.tick([energy("c", 0, 0)], 0);
      itg.tick([energy("c", 10, 1000)], 1000);
      const busy = itg.tick([energy("c", 50, 2000)], 2000, 1);
      expect(busy.raw_j).toBeCloseTo(40, 6);
      expect(busy.attributed_j).toBeCloseTo(40 - 10, 6);
    });

    it("skips subtraction when disabled", () => {
      const itg = new EnergyIntegrator({ subtract_idle: false });
      itg.tick([power("g", 10, 0)], 0);
      itg.tick([power("g", 10, 1000)], 1000);
      const busy = itg.tick([power("g", 50, 2000)], 2000, 1);
      expect(busy.attributed_j).toBeCloseTo(busy.raw_j, 6);
    });
  });

  describe("lastWatts()", () => {
    it("reports the latest watts per meter with age", () => {
      const itg = new EnergyIntegrator({ subtract_idle: false });
      itg.tick([power("g", 10, 1000), energy("c", 1_000_000, 1000)], 1000, 1);
      itg.tick([power("g", 20, 3000), energy("c", 3_000_000, 3000)], 3000, 1);
      const watts = itg.lastWatts();
      const g = watts.find((w) => w.id === "g");
      const c = watts.find((w) => w.id === "c");
      expect(g?.watts).toBe(20);
      expect(c?.watts).toBeCloseTo(1_000_000, 6); // 2e6 J over 2 s
      expect(g?.at).toBe(3000);
    });

    it("omits meters sighted only once (no rate yet)", () => {
      const itg = new EnergyIntegrator({ subtract_idle: false });
      itg.tick([energy("c", 1_000_000, 1000)], 1000);
      expect(itg.lastWatts()).toEqual([]);
    });
  });
});
