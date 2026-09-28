import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";

describe("normalizeConfig()", () => {
  it("returns sane defaults for an empty config", () => {
    const cfg = normalizeConfig(undefined);
    expect(cfg.interval_ms).toBe(1000);
    expect(cfg.idle_interval_ms).toBe(10000);
    expect(cfg.tail_ms).toBe(5000);
    expect(cfg.subtract_idle).toBe(true);
    expect(cfg.country).toBeNull();
    expect(cfg.price_per_kwh).toBeNull();
    expect(cfg.currency).toBeNull();
    expect(cfg.windows).toEqual([]);
    expect(cfg.ssh).toEqual([]);
    expect(cfg.prom).toEqual([]);
  });

  it("keeps valid values", () => {
    const cfg = normalizeConfig({
      interval_ms: 2000,
      subtract_idle: false,
      country: "DE",
      price_per_kwh: 0.3,
      windows: [{ start: "22:00", end: "06:00", price_per_kwh: 0.2 }],
      ssh: [{ host: "box", timeout_ms: 500 }],
      prom: [{ base_url: "http://x:8428", queries: [{ name: "g", query: "q" }] }],
    });
    expect(cfg.interval_ms).toBe(2000);
    expect(cfg.subtract_idle).toBe(false);
    expect(cfg.country).toBe("DE");
    expect(cfg.price_per_kwh).toBe(0.3);
    expect(cfg.windows).toHaveLength(1);
    expect(cfg.ssh[0]?.host).toBe("box");
    expect(cfg.prom[0]?.base_url).toBe("http://x:8428");
  });

  it("replaces invalid values with defaults", () => {
    const cfg = normalizeConfig({
      interval_ms: -5,
      idle_interval_ms: "fast",
      tail_ms: null,
      subtract_idle: "yes",
      price_per_kwh: "cheap",
      windows: [{ start: "25:00", end: "06:00", price_per_kwh: 0.2 }, "junk"],
      ssh: [{ timeout_ms: 1000 }, "junk"],
      prom: [{ base_url: "" }, "junk"],
    });
    expect(cfg.interval_ms).toBe(1000);
    expect(cfg.idle_interval_ms).toBe(10000);
    expect(cfg.tail_ms).toBe(5000);
    expect(cfg.subtract_idle).toBe(true);
    expect(cfg.price_per_kwh).toBeNull();
    expect(cfg.windows).toEqual([]);
    expect(cfg.ssh).toEqual([]);
    expect(cfg.prom).toEqual([]);
  });

  it("clamps intervals to a sane minimum", () => {
    const cfg = normalizeConfig({ interval_ms: 10, idle_interval_ms: 0 });
    expect(cfg.interval_ms).toBeGreaterThanOrEqual(200);
    expect(cfg.idle_interval_ms).toBeGreaterThanOrEqual(1000);
  });
});
