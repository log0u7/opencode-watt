import { describe, expect, it } from "vitest";

import { formatSnapshot, snapshotFromReport } from "../src/rpc.js";

describe("snapshotFromReport", () => {
  it("sums live meter watts and keeps the day totals", () => {
    const s = snapshotFromReport({
      meters: [{ watts: 100 }, { watts: 42.5 }],
      day: { attributed_kwh: 0.05, cost: 0.0123 },
      rate: { currency: "EUR" },
      budget: { budget_kwh: 2, attributed_kwh: 0.05 },
    });
    expect(s.watts).toBe(142.5);
    expect(s.day_kwh).toBe(0.05);
    expect(s.day_cost).toBe(0.0123);
    expect(s.currency).toBe("EUR");
    expect(s.budget_kwh).toBe(2);
    expect(s.budget_used_ratio).toBeCloseTo(0.025);
  });

  it("reports null watts when no meter reports", () => {
    const s = snapshotFromReport({
      meters: [],
      day: null,
      rate: { currency: "EUR" },
      budget: null,
    });
    expect(s.watts).toBeNull();
    expect(s.day_kwh).toBeNull();
    expect(s.day_cost).toBeNull();
    expect(s.budget_used_ratio).toBeNull();
  });

  it("ignores non-finite meter readings", () => {
    const s = snapshotFromReport({
      meters: [{ watts: Number.NaN }, { watts: 50 }],
      day: null,
      rate: { currency: "USD" },
      budget: null,
    });
    expect(s.watts).toBe(50);
  });

  it("budget ratio is null for a zero budget", () => {
    const s = snapshotFromReport({
      meters: [],
      day: null,
      rate: { currency: "EUR" },
      budget: { budget_kwh: 0, attributed_kwh: 0 },
    });
    expect(s.budget_used_ratio).toBeNull();
  });
});

describe("formatSnapshot", () => {
  it("formats watts, kWh and cost", () => {
    const text = formatSnapshot({
      watts: 142.5,
      day_kwh: 0.05,
      day_cost: 0.0123,
      currency: "EUR",
      budget_kwh: null,
      budget_used_ratio: null,
    });
    expect(text).toContain("143 W");
    expect(text).toContain("0.050 kWh");
    expect(text).toContain("€0.01");
  });

  it("adds the budget share when a budget is set", () => {
    const text = formatSnapshot({
      watts: null,
      day_kwh: 0.5,
      day_cost: 0.1,
      currency: "EUR",
      budget_kwh: 2,
      budget_used_ratio: 0.25,
    });
    expect(text).toContain("25% of 2 kWh budget");
    expect(text).not.toContain("W ·");
  });

  it("returns null when there is nothing to show", () => {
    expect(
      formatSnapshot({
        watts: null,
        day_kwh: null,
        day_cost: null,
        currency: null,
        budget_kwh: null,
        budget_used_ratio: null,
      }),
    ).toBeNull();
  });
});
