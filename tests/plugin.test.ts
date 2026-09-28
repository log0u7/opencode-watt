import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WattPlugin, type WattPluginOptions } from "../src/plugin.js";
import type { Probe, ProbeResult } from "../src/probes.js";
import type { State } from "../src/store.js";

type AnyPlugin = Parameters<typeof WattPlugin>[0];

const dirs: string[] = [];

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-watt-plugin-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function fakeInput() {
  return {
    client: {
      tui: { showToast: vi.fn(async () => {}) },
      app: { log: vi.fn(async () => {}) },
    },
    project: { id: "p" },
    directory: "/d",
    worktree: "/d",
  } as unknown as AnyPlugin & { client: { tui: { showToast: ReturnType<typeof vi.fn> } } };
}

function powerProbe(source: string, watts: number, calls?: { n: number }): Probe {
  return {
    source,
    sample: async (now: number): Promise<ProbeResult> => {
      if (calls) calls.n++;
      return {
        samples: [{ kind: "power", source, id: "gpu0", watts, at: now }],
        status: "ok",
      };
    },
  };
}

const statusEvent = (sessionID: string, type: "busy" | "idle") =>
  ({ event: { type: "session.status", properties: { sessionID, status: { type } } } }) as never;

const idleEvent = (sessionID: string) =>
  ({ event: { type: "session.idle", properties: { sessionID } } }) as never;

function baseOpts(statePath: string, probes: Probe[]): Partial<WattPluginOptions> {
  return {
    interval_ms: 250,
    idle_interval_ms: 250,
    tail_ms: 0,
    subtract_idle: false,
    price_per_kwh: 0.2,
    state_path: statePath,
    probes,
  } as Partial<WattPluginOptions>;
}

describe("WattPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accrues energy while a session is busy and toasts on idle", async () => {
    const input = fakeInput();
    const statePath = tmpStatePath();
    const hooks = await WattPlugin(input, baseOpts(statePath, [powerProbe("s", 40000)]));

    await hooks.event?.(statusEvent("s1", "busy"));
    await vi.advanceTimersByTimeAsync(250); // first sighting
    await vi.advanceTimersByTimeAsync(250); // 40000 W * 0.25 s = 10000 J
    await vi.advanceTimersByTimeAsync(250); // 20000 J total
    await hooks.event?.(idleEvent("s1"));

    expect(input.client.tui.showToast).toHaveBeenCalledTimes(1);
    const firstCall = input.client.tui.showToast.mock.calls[0]?.[0] as
      | { body: { message: string } }
      | undefined;
    expect(firstCall?.body.message).toContain("0.0083 kWh");
    expect(existsSync(statePath)).toBe(true);
  });

  it("stays silent on idle when the session used less than 1 Wh", async () => {
    const input = fakeInput();
    const hooks = await WattPlugin(input, baseOpts(tmpStatePath(), [powerProbe("s", 100)]));
    await hooks.event?.(statusEvent("s1", "busy"));
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await hooks.event?.(idleEvent("s1"));
    expect(input.client.tui.showToast).not.toHaveBeenCalled();
  });

  it("handles events and ticking with no meters without crashing", async () => {
    const statePath = tmpStatePath();
    const hooks = await WattPlugin(fakeInput(), baseOpts(statePath, []));
    await hooks.event?.(statusEvent("s1", "busy"));
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await hooks.event?.(idleEvent("s1"));
    expect(existsSync(statePath)).toBe(true);
  });

  it("reports session energy and model through power_cost", async () => {
    const statePath = tmpStatePath();
    const hooks = await WattPlugin(fakeInput(), baseOpts(statePath, [powerProbe("s", 36000)]));
    await hooks["chat.message"]?.(
      { sessionID: "s1", model: { providerID: "prov", modelID: "mdl" } } as never,
      { message: {}, parts: [] } as never,
    );
    await hooks.event?.(statusEvent("s1", "busy"));
    await vi.advanceTimersByTimeAsync(250); // first sighting
    await vi.advanceTimersByTimeAsync(250); // 2 accrual ticks x 9000 J = 18000 J = 0.0050 kWh

    const out = (await hooks.tool?.power_cost.execute(
      { scope: "session" } as never,
      {
        sessionID: "s1",
      } as never,
    )) as string;
    expect(out).toContain("prov/mdl");
    expect(out).toContain("0.0050 kWh");
  });

  it("splits attributed energy across concurrent busy sessions", async () => {
    const statePath = tmpStatePath();
    const hooks = await WattPlugin(fakeInput(), baseOpts(statePath, [powerProbe("s", 72000)]));
    await hooks.event?.(statusEvent("a", "busy"));
    await hooks.event?.(statusEvent("b", "busy"));
    await vi.advanceTimersByTimeAsync(250); // first sighting
    await vi.advanceTimersByTimeAsync(250); // 2 accrual ticks x 18000 J = 36000 J -> 18000 J each

    for (const sid of ["a", "b"]) {
      const out = (await hooks.tool?.power_cost.execute(
        { scope: "session" } as never,
        {
          sessionID: sid,
        } as never,
      )) as string;
      expect(out).toContain("0.0050 kWh");
    }
  });

  it("answers 'no meters' when nothing is available", async () => {
    const hooks = await WattPlugin(fakeInput(), baseOpts(tmpStatePath(), []));
    const out = (await hooks.tool?.power_cost.execute(
      { scope: "all" } as never,
      {
        sessionID: "s1",
      } as never,
    )) as string;
    expect(out).toContain("no meters");
  });

  it("persists state across plugin restarts", async () => {
    const statePath = tmpStatePath();
    const first = await WattPlugin(fakeInput(), baseOpts(statePath, [powerProbe("s", 36000)]));
    await first.event?.(statusEvent("s1", "busy"));
    await vi.advanceTimersByTimeAsync(250); // first sighting
    await vi.advanceTimersByTimeAsync(250); // 9000 J
    await first.dispose?.();

    const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
    expect(state.sessions.s1?.attributed_j).toBeGreaterThan(17000);

    const second = await WattPlugin(fakeInput(), baseOpts(statePath, [powerProbe("s", 36000)]));
    const out = (await second.tool?.power_cost.execute(
      { scope: "all" } as never,
      {
        sessionID: "s2",
      } as never,
    )) as string;
    expect(out).toContain("0.0050 kWh");
    await second.dispose?.();
  });

  it("stops sampling after dispose", async () => {
    const calls = { n: 0 };
    const hooks = await WattPlugin(
      fakeInput(),
      baseOpts(tmpStatePath(), [powerProbe("s", 10, calls)]),
    );
    await vi.advanceTimersByTimeAsync(250);
    const afterFirst = calls.n;
    await hooks.dispose?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.n).toBe(afterFirst);
  });
});
