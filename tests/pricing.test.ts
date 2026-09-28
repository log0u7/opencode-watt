import { describe, expect, it } from "vitest";

import {
  cost,
  detectCountry,
  resolveRate,
  systemTimezone,
  type PricingConfig,
  TARIFFS,
} from "../src/pricing.js";

const at = (h: number, m = 0) => {
  const d = new Date("2026-09-28T00:00:00Z");
  d.setUTCHours(h, m);
  return d;
};

describe("TARIFFS table", () => {
  it("has FR with EUR currency and a plausible retail price", () => {
    const fr = TARIFFS.FR;
    expect(fr).toBeDefined();
    expect(fr.currency).toBe("EUR");
    expect(fr.kwh).toBeGreaterThan(0.1);
    expect(fr.kwh).toBeLessThan(0.5);
  });

  it("has several countries with non-EUR currencies", () => {
    expect(TARIFFS.GB.currency).toBe("GBP");
    expect(TARIFFS.US.currency).toBe("USD");
    expect(TARIFFS.CH.currency).toBe("CHF");
  });
});

describe("cost()", () => {
  it("converts 1 kWh of joules at the given rate", () => {
    expect(cost(3_600_000, { price_per_kwh: 0.2, currency: "EUR", label: "x" })).toBeCloseTo(
      0.2,
      10,
    );
  });

  it("is zero for zero joules", () => {
    expect(cost(0, { price_per_kwh: 0.2, currency: "EUR", label: "x" })).toBe(0);
  });
});

describe("detectCountry()", () => {
  it("maps known IANA zones", () => {
    expect(detectCountry("Europe/Paris")).toBe("FR");
    expect(detectCountry("Europe/Berlin")).toBe("DE");
    expect(detectCountry("Europe/Zurich")).toBe("CH");
    expect(detectCountry("Europe/London")).toBe("GB");
    expect(detectCountry("America/New_York")).toBe("US");
    expect(detectCountry("America/Los_Angeles")).toBe("US");
  });

  it("returns null for unknown zones", () => {
    expect(detectCountry("Asia/Tokyo")).toBeNull();
    expect(detectCountry("")).toBeNull();
  });

  it("systemTimezone() returns a string or null without throwing", () => {
    expect(typeof systemTimezone() === "string" || systemTimezone() === null).toBe(true);
  });
});

describe("resolveRate() precedence", () => {
  it("uses the meter country tariff first", () => {
    const rate = resolveRate({}, at(12), "DE", "UTC");
    expect(rate.label).toBe("DE");
    expect(rate.currency).toBe("EUR");
  });

  it("meter country beats configured country", () => {
    const rate = resolveRate({ country: "FR" }, at(12), "IT", "UTC");
    expect(rate.label).toBe("IT");
  });

  it("configured country beats detected timezone", () => {
    const rate = resolveRate({ country: "ES" }, at(12), undefined, "UTC");
    expect(rate.label).toBe("ES");
  });

  it("explicit price_per_kwh wins over table and country", () => {
    const rate = resolveRate({ price_per_kwh: 0.3 }, at(12), "DE", "UTC");
    expect(rate.price_per_kwh).toBe(0.3);
    expect(rate.label).toBe("custom");
    expect(rate.currency).toBe("EUR");
  });

  it("explicit currency overrides the table currency", () => {
    const rate = resolveRate({ price_per_kwh: 0.3, currency: "CHF" }, at(12), undefined, "UTC");
    expect(rate.currency).toBe("CHF");
  });

  it("falls back to FR when nothing resolves", () => {
    const rate = resolveRate({}, at(12), undefined, "UTC");
    expect(rate.label).toBe("FR");
    expect(rate.currency).toBe("EUR");
  });
});

describe("resolveRate() time-of-use windows", () => {
  const cfg: PricingConfig = {
    windows: [
      { start: "22:00", end: "06:00", price_per_kwh: 0.1696 },
      { start: "07:30", end: "09:00", price_per_kwh: 0.27 },
    ],
  };

  it("matches an overnight window crossing midnight", () => {
    const rate = resolveRate(cfg, at(23), undefined, "UTC");
    expect(rate.price_per_kwh).toBe(0.1696);
    const early = resolveRate(cfg, at(3), undefined, "UTC");
    expect(early.price_per_kwh).toBe(0.1696);
  });

  it("matches the first window when two match", () => {
    const rate = resolveRate(
      {
        windows: [
          { start: "07:30", end: "09:00", price_per_kwh: 0.27 },
          { start: "08:00", end: "08:30", price_per_kwh: 0.5 },
        ],
      },
      at(8),
      undefined,
      "UTC",
    );
    expect(rate.price_per_kwh).toBe(0.27);
  });

  it("falls back to the country tariff outside windows", () => {
    const rate = resolveRate(cfg, at(12), undefined, "UTC");
    expect(rate.label).toBe("FR");
    expect(rate.price_per_kwh).toBe(TARIFFS.FR.kwh);
  });

  it("window edge: start included, end excluded", () => {
    expect(resolveRate(cfg, at(22), undefined, "UTC").price_per_kwh).toBe(0.1696);
    expect(resolveRate(cfg, at(6), undefined, "UTC").price_per_kwh).toBe(TARIFFS.FR.kwh);
  });

  it("explicit price still beats windows", () => {
    const rate = resolveRate({ ...cfg, price_per_kwh: 0.1 }, at(23), undefined, "UTC");
    expect(rate.price_per_kwh).toBe(0.1);
  });
});
