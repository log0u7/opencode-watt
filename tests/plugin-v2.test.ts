import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";

import type { Probe } from "../src/probes.js";
import type { WattPluginOptions } from "../src/plugin.js";
import { pluginModule } from "../src/index.js";

const dirs: string[] = [];

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-watt-v2-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function powerProbe(source: string, watts: number): Probe {
  return {
    source,
    sample: async (now: number) => ({
      samples: [{ kind: "power", source, id: "gpu0", watts, at: now }],
      status: "ok",
    }),
  };
}

function baseOpts(statePath: string, probes: Probe[]): Partial<WattPluginOptions> {
  return {
    interval_ms: 250, // >= 200 floor enforced by normalizeConfig
    idle_interval_ms: 1000, // >= 1000 floor enforced by normalizeConfig
    tail_ms: 0,
    subtract_idle: false,
    price_per_kwh: 0.2,
    state_path: statePath,
    probes,
  } as Partial<WattPluginOptions>;
}

type TestEvent = { type: string; data: Record<string, unknown> };
type AddedTool = {
  name: string;
  description: string;
  input: { properties: Record<string, unknown> };
  execute: (
    input: { scope?: "session" | "today" | "all"; format?: "text" | "json" },
    context: { sessionID: string },
  ) => Promise<{ content?: string }>;
};

function fakeCtx(statePath: string, probes: Probe[]) {
  const added: AddedTool[] = [];
  const sessionHooks = new Map<
    string,
    (event: { sessionID: string; model: { providerID: string; id: string } }) => void
  >();
  const queue: TestEvent[] = [];
  let wake: (() => void) | undefined;

  const ctx = {
    location: { directory: "/d", project: { id: "p" } },
    options: baseOpts(statePath, probes),
    tool: {
      transform: async (fn: (editor: { add: (t: AddedTool & { id: string }) => void }) => void) =>
        fn({ add: (t) => added.push(t) }),
    },
    session: {
      hook: async (
        name: string,
        fn: typeof sessionHooks extends Map<string, infer F> ? F : never,
      ) => {
        sessionHooks.set(name, fn);
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          while (!signal.aborted) {
            const event = queue.shift();
            if (event) {
              yield event;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
    },
  } as unknown as Plugin.Context;

  const push = (event: TestEvent) => {
    queue.push(event);
    wake?.();
  };

  return { ctx, added, sessionHooks, push };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const busyEvent = (sessionID: string): TestEvent => ({
  type: "session.status",
  data: { sessionID, status: { type: "busy" } },
});

const idleStatusEvent = (sessionID: string): TestEvent => ({
  type: "session.status",
  data: { sessionID, status: { type: "idle" } },
});

const idleEvent = (sessionID: string): TestEvent => ({ type: "session.idle", data: { sessionID } });

const deletedEvent = (sessionID: string): TestEvent => ({
  type: "session.deleted",
  data: { sessionID },
});

describe("opencode-watt v2 setup", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.info).mockRestore();
    vi.mocked(console.warn).mockRestore();
  });

  it("registers power_cost, attributes model, accrues energy and reports", async () => {
    const statePath = tmpStatePath();
    const { ctx, added, sessionHooks, push } = fakeCtx(statePath, [powerProbe("s", 36000)]);

    const cleanup = await pluginModule.setup(ctx);

    const tool = added.find((t) => t.name === "power_cost");
    expect(tool).toBeDefined();
    // Doc sync guard: the tool description is what the model reads; it must
    // mention every user-facing capability (format json, daily budget toast).
    expect(tool?.description).toContain("json");
    expect(tool?.description).toContain("budget");
    const format = (tool as unknown as { input: { properties: Record<string, unknown> } }).input
      .properties.format as { enum?: string[] };
    expect(format?.enum).toEqual(["text", "json"]);

    const modelHook = sessionHooks.get("model.request");
    expect(modelHook).toBeDefined();
    modelHook?.({ sessionID: "s1", model: { providerID: "prov", id: "mdl" } });

    await push(busyEvent("s1"));
    await sleep(1300); // sighting + ~4 accrual ticks at 250 ms => ~36000 J

    const out = await tool?.execute({}, { sessionID: "s1" });
    expect(out?.content).toContain("session:");
    expect(out?.content).toMatch(/0\.00[89]|0\.01[0-4]/); // ~0.009-0.014 kWh (timing jitter)
    expect(out?.content).toContain("prov/mdl");
    expect(existsSync(statePath)).toBe(true);

    await cleanup?.();
  });

  it("logs session cost on idle when the session used more than 1 Wh", async () => {
    const statePath = tmpStatePath();
    const { ctx, push } = fakeCtx(statePath, [powerProbe("s", 40000)]);

    const cleanup = await pluginModule.setup(ctx);

    await push(busyEvent("s1"));
    await sleep(1300); // ~4 accruals x 10000 J = 40000 J > 1 Wh
    await push(idleStatusEvent("s1"));
    await push(idleEvent("s1"));
    await sleep(150);

    const logged = vi
      .mocked(console.info)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("kWh");
    expect(logged).toContain("this session");

    await cleanup?.();
  });

  it("handles events with no meters and empty state without crashing", async () => {
    const statePath = tmpStatePath();
    const { ctx, push } = fakeCtx(statePath, []);

    const cleanup = await pluginModule.setup(ctx);

    await push(busyEvent("s1"));
    await sleep(150);
    await push(idleEvent("s1"));
    await sleep(80);

    expect(existsSync(statePath)).toBe(true);
    await cleanup?.();
  });

  it("drops a deleted session from the busy set and from state", async () => {
    const statePath = tmpStatePath();
    const { ctx, push } = fakeCtx(statePath, [powerProbe("s", 40000)]);

    const cleanup = await pluginModule.setup(ctx);

    await push(busyEvent("s1"));
    await sleep(600);
    await push(deletedEvent("s1"));
    await sleep(150);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      sessions: Record<string, unknown>;
    };
    expect(state.sessions.s1).toBeUndefined();

    await cleanup?.();
  });
});
