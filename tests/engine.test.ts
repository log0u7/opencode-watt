import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeConfig } from "../src/config.js";
import { buildProbes, createEngine, type EngineHost } from "../src/engine.js";
import type { Probe, ProbeResult } from "../src/probes.js";
import { dayKey } from "../src/store.js";

const dirs: string[] = [];

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-watt-engine-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const host: EngineHost = { log: async () => {}, notify: async () => {} };

const powerProbe = (source: string, watts: number, delayMs = 0): Probe => ({
  source,
  sample: async (now: number): Promise<ProbeResult> => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      samples: [{ kind: "power", source, id: "gpu0", watts, at: now }],
      status: "ok",
    };
  },
});

const busyCfg = (extra: Record<string, unknown> = {}) =>
  normalizeConfig({ interval_ms: 250, tail_ms: 0, subtract_idle: false, ...extra });

describe("buildProbes() meters filter", () => {
  it("keeps every local source by default", () => {
    const { probes } = buildProbes(normalizeConfig({}));
    const sources = probes.map((p) => p.source);
    expect(sources).toContain("nvidia-smi@local");
    expect(sources).toContain("rocm-smi@local");
    expect(sources).toContain("rapl@local");
    expect(sources).toContain("hwmon@local");
  });

  it("keeps only the sources matching the configured prefixes", () => {
    const { probes, countries } = buildProbes(
      normalizeConfig({ meters: ["nvidia-smi"], ssh: [{ host: "box" }] }),
    );
    // The prefix applies to every target, local and remote alike.
    expect(probes.map((p) => p.source)).toEqual(["nvidia-smi@local", "nvidia-smi@box"]);
    expect(countries.get("nvidia-smi@box")).toBeNull();
  });

  it("keeps remote prefixes including their country mapping", () => {
    const { probes, countries } = buildProbes(
      normalizeConfig({ meters: ["nvidia-smi"], ssh: [{ host: "box", country: "FR" }] }),
    );
    expect(probes.map((p) => p.source)).toContain("nvidia-smi@box");
    expect(countries.get("nvidia-smi@box")).toBe("FR");
  });
});

describe("createEngine() tick isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps accruing the other meters when one probe throws", async () => {
    const boom: Probe = {
      source: "boom",
      sample: async (): Promise<ProbeResult> => {
        throw new Error("probe exploded");
      },
    };
    const engine = createEngine(busyCfg(), host, tmpStatePath(), [powerProbe("ok", 40000), boom]);

    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(250); // first sighting
    await vi.advanceTimersByTimeAsync(250); // 40000 W * 0.25 s = 10000 J
    await vi.advanceTimersByTimeAsync(250); // 30000 J total over three accrual ticks

    expect(engine.state.sessions.s1?.raw_j).toBeCloseTo(30_000, 6);
    expect(engine.state.probe_status.ok).toBe("ok");
    expect(engine.state.probe_status.boom).toBe("error");
    await engine.dispose();
  });
});

// Real timers: the assertion depends on wall-clock probe latency, which fake
// timers cannot reproduce faithfully.
describe("createEngine() sample timestamps", () => {
  it("integrates over the real sampling span, not the tick start", async () => {
    let call = 0;
    const jittery: Probe = {
      source: "jitter",
      sample: async (now: number): Promise<ProbeResult> => {
        await new Promise((r) => setTimeout(r, call === 0 ? 100 : 400));
        call++;
        return {
          samples: [{ kind: "power", source: "jitter", id: "gpu0", watts: 1000, at: now }],
          status: "ok",
        };
      },
    };
    const engine = createEngine(busyCfg(), host, tmpStatePath(), [jittery]);

    engine.handleStatus("s1", "busy");
    // First reading lands 100 ms after its tick, the second 400 ms after its
    // own tick: the true gap between the two readings is ~650 ms. Stamping
    // both with their tick start would give a 250 ms span (250 J instead of
    // ~650 J), so the bounds separate the two behaviours.
    await new Promise((r) => setTimeout(r, 900));
    expect(engine.state.days[dayKey(new Date())]?.raw_j).toBeGreaterThan(450);
    expect(engine.state.days[dayKey(new Date())]?.raw_j).toBeLessThan(800);
    await engine.dispose();
  });
});

describe("createEngine() session lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a deleted session from the busy set and from state", async () => {
    const engine = createEngine(busyCfg(), host, tmpStatePath(), [powerProbe("s", 40000)]);
    engine.handleStatus("a", "busy");
    engine.handleStatus("b", "busy");
    await vi.advanceTimersByTimeAsync(250); // first sighting

    engine.forget("a");
    await vi.advanceTimersByTimeAsync(250); // tick: 10000 J, all to b
    await vi.advanceTimersByTimeAsync(250); // plus the 5000 J shared before the delete

    expect(engine.state.sessions.a).toBeUndefined();
    expect(engine.state.sessions.b?.attributed_j).toBeCloseTo(25_000, 6);
    await engine.dispose();
  });

  it("keeps the session entry when the status simply leaves busy", async () => {
    const engine = createEngine(busyCfg(), host, tmpStatePath(), [powerProbe("s", 40000)]);
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(250);
    engine.handleStatus("s1", "idle");
    expect(engine.state.sessions.s1?.last_active).toBeGreaterThan(0);
    await engine.dispose();
  });
});

describe("createEngine() idle baseline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds the baseline so a busy-only run does not attribute full host power", async () => {
    const engine = createEngine(busyCfg({ subtract_idle: true }), host, tmpStatePath(), [
      powerProbe("s", 40000),
    ]);
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(750); // three derivable ticks, never idle

    const entry = engine.state.sessions.s1;
    expect(entry?.raw_j).toBeGreaterThan(0);
    expect(entry?.attributed_j).toBeLessThan(entry?.raw_j ?? 0);
    await engine.dispose();
  });

  it("reports the baseline warm-up progress while the window is not full", async () => {
    const engine = createEngine(busyCfg({ subtract_idle: true }), host, tmpStatePath(), [
      powerProbe("s", 40000),
    ]);
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(750);

    const out = await engine.report("session", "s1");
    expect(out).toMatch(/baseline: \d+\/30 samples/);
    await engine.dispose();
  });
});

describe("createEngine() reportData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns structured data with meters, rate, baseline and session", async () => {
    const engine = createEngine(busyCfg({ subtract_idle: true }), host, tmpStatePath(), [
      powerProbe("s", 40000),
    ]);
    engine.handleStatus("s1", "busy");
    engine.setModel("s1", "prov/mdl");
    await vi.advanceTimersByTimeAsync(750);

    const data = await engine.reportData("session", "s1");
    expect(data.scope).toBe("session");
    expect(data.meters.some((m) => m.source === "s")).toBe(true);
    expect(data.rate.currency).toBe("EUR");
    expect(data.baseline).not.toBeNull();
    expect(data.session?.model).toBe("prov/mdl");
    // The seeded baseline equals the busy sample here, so attribution floors
    // at zero by design; raw energy is unaffected.
    expect(data.session?.raw_kwh).toBeGreaterThan(0);
    expect(data.probes.s).toBe("ok");
    await engine.dispose();
  });

  it("returns day totals for the today scope and null session", async () => {
    const engine = createEngine(busyCfg(), host, tmpStatePath(), [powerProbe("s", 40000)]);
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(500);
    const data = await engine.reportData("today", "s1");
    expect(data.session).toBeNull();
    expect(data.day?.attributed_kwh).toBeGreaterThan(0);
    await engine.dispose();
  });

  it("toasts once per day when the daily budget is exceeded", async () => {
    const notified: string[] = [];
    const engine = createEngine(
      busyCfg({ daily_budget_kwh: 0.001 }),
      {
        log: async () => {},
        notify: async (m) => {
          notified.push(m);
        },
      },
      tmpStatePath(),
      [powerProbe("s", 40000)],
    );
    engine.handleStatus("s1", "busy");
    // 0.001 kWh = 3600 J; each busy tick accrues 10000 J
    await vi.advanceTimersByTimeAsync(750);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("budget");

    await vi.advanceTimersByTimeAsync(2000); // more ticks over budget
    expect(notified).toHaveLength(1); // still once per day
    await engine.dispose();
  });

  it("does not toast when no budget is configured", async () => {
    const notified: string[] = [];
    const engine = createEngine(
      busyCfg(),
      {
        log: async () => {},
        notify: async (m) => {
          notified.push(m);
        },
      },
      tmpStatePath(),
      [powerProbe("s", 40000)],
    );
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toHaveLength(0);
    await engine.dispose();
  });
});

describe("createEngine() sampling backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const absent: Probe = { source: "nope", sample: async () => ({ samples: [], status: "absent" }) };

  it("backs off when no meter is available", async () => {
    const calls = { n: 0 };
    const counting: Probe = {
      source: "nope",
      sample: async () => {
        calls.n++;
        return { samples: [], status: "absent" as const };
      },
    };
    const engine = createEngine(
      normalizeConfig({ interval_ms: 250, idle_interval_ms: 1000, tail_ms: 0 }),
      host,
      tmpStatePath(),
      [counting],
    );
    // tick at t=0 misses -> next delay is 2x the idle interval (2000 ms)
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.n).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls.n).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.n).toBe(2);
    await engine.dispose();
  });

  it("keeps the configured rate when a meter reports ok", async () => {
    const engine = createEngine(busyCfg(), host, tmpStatePath(), [powerProbe("s", 40000), absent]);
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(250); // first sighting
    await vi.advanceTimersByTimeAsync(1000); // 4 more ticks at 250 ms
    expect(engine.state.probe_status.s).toBe("ok");
    expect(engine.state.days[dayKey(new Date())]?.raw_j).toBeGreaterThan(0);
    await engine.dispose();
  });

  it("samples at the tail rate briefly after the last session leaves busy", async () => {
    const calls = { n: 0 };
    const counting: Probe = {
      source: "tail",
      sample: async (now: number) => {
        calls.n++;
        return {
          samples: [{ kind: "power", source: "tail", id: "gpu0", watts: 10, at: now }],
          status: "ok" as const,
        };
      },
    };
    const engine = createEngine(
      normalizeConfig({ interval_ms: 250, idle_interval_ms: 1000, tail_ms: 400 }),
      host,
      tmpStatePath(),
      [counting],
    );
    engine.handleStatus("s1", "busy");
    await vi.advanceTimersByTimeAsync(250); // busy ticks at t=0 and t=250
    const afterBusy = calls.n;

    engine.handleStatus("s1", "idle"); // tailUntil = 250 + 400 = 650
    await vi.advanceTimersByTimeAsync(700); // tail ticks at t=500 and t=900
    expect(calls.n).toBe(afterBusy + 2);

    await vi.advanceTimersByTimeAsync(1000); // past the window: idle tick at t=1900
    expect(calls.n).toBe(afterBusy + 3);

    await engine.dispose();
  });
});
