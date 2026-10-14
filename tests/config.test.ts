import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";

describe("normalizeConfig()", () => {
  it("returns sane defaults for an empty config", () => {
    const cfg = normalizeConfig(undefined);
    expect(cfg.interval_ms).toBe(1000);
    expect(cfg.idle_interval_ms).toBe(10000);
    expect(cfg.tail_ms).toBe(5000);
    expect(cfg.subtract_idle).toBe(true);
    expect(cfg.ssh_control).toBe(true);
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
      ssh_control: false,
      prom: [{ base_url: "http://x:8428", queries: [{ name: "g", query: "q" }] }],
    });
    expect(cfg.interval_ms).toBe(2000);
    expect(cfg.subtract_idle).toBe(false);
    expect(cfg.ssh_control).toBe(false);
    expect(cfg.country).toBe("DE");
    expect(cfg.price_per_kwh).toBe(0.3);
    expect(cfg.windows).toHaveLength(1);
    expect(cfg.ssh[0]?.host).toBe("box");
    expect(cfg.prom[0]?.base_url).toBe("http://x:8428");
  });

  it("keeps only non-empty strings in meters", () => {
    expect(normalizeConfig({ meters: ["nvidia-smi", 42, ""] }).meters).toEqual(["nvidia-smi"]);
    expect(normalizeConfig({ meters: [] }).meters).toBeNull();
    expect(normalizeConfig({ meters: "nvidia" }).meters).toBeNull();
    expect(normalizeConfig(undefined).meters).toBeNull();
  });

  it("clamps the wall factor into [1, 2]", () => {
    expect(normalizeConfig({ wall_factor: 1.15 }).wall_factor).toBeCloseTo(1.15, 6);
    expect(normalizeConfig({ wall_factor: 3 }).wall_factor).toBe(2);
    expect(normalizeConfig({ wall_factor: 0.5 }).wall_factor).toBe(1);
    expect(normalizeConfig({ wall_factor: "big" }).wall_factor).toBe(1);
    expect(normalizeConfig(undefined).wall_factor).toBe(1);
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

  it("clamps a numeric interval up to the floor instead of resetting it", () => {
    expect(normalizeConfig({ interval_ms: 10 }).interval_ms).toBe(200);
  });

  it("normalizes country to an upper-case ISO alpha-2 code or null", () => {
    expect(normalizeConfig({ country: "de" }).country).toBe("DE");
    expect(normalizeConfig({ country: "Germany" }).country).toBeNull();
    expect(normalizeConfig({ country: "F1" }).country).toBeNull();
    expect(normalizeConfig({ country: 42 }).country).toBeNull();
  });

  it("trims and deduplicates meter prefixes", () => {
    expect(normalizeConfig({ meters: ["  nvidia-smi ", "nvidia-smi", "rocm-smi"] }).meters).toEqual(
      ["nvidia-smi", "rocm-smi"],
    );
    expect(normalizeConfig({ meters: ["   ", ""] }).meters).toBeNull();
  });

  it("drops a rate window with a negative price", () => {
    const cfg = normalizeConfig({
      windows: [
        { start: "22:00", end: "06:00", price_per_kwh: -0.2 },
        { start: "22:00", end: "06:00", price_per_kwh: 0 },
      ],
    });
    expect(cfg.windows).toHaveLength(1);
    expect(cfg.windows[0]?.price_per_kwh).toBe(0);
  });

  it("drops an ssh target whose host could inject ssh arguments", () => {
    const cfg = normalizeConfig({
      ssh: [{ host: "-oProxyCommand=touch /tmp/pwned" }, { host: "a b" }, { host: "good-host" }],
    });
    expect(cfg.ssh).toHaveLength(1);
    expect(cfg.ssh[0]?.host).toBe("good-host");
  });

  it("drops a prom target whose base_url is not http(s)", () => {
    const cfg = normalizeConfig({
      prom: [
        { base_url: "ftp://vm:8428", queries: [] },
        { base_url: "vm:8428", queries: [] },
        { base_url: "https://vm:8428", queries: [] },
      ],
    });
    expect(cfg.prom).toHaveLength(1);
    expect(cfg.prom[0]?.base_url).toBe("https://vm:8428");
  });
});
