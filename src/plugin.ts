import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { normalizeConfig, type WattConfig } from "./config.js";
import { cost, resolveRate } from "./pricing.js";
import {
  hwmonProbes,
  type Probe,
  raplProbes,
  type Sample,
  nvidiaSmiProbe,
  nodeExec,
  nodeList,
  nodeRead,
  promProbe,
  rocmSmiProbe,
  sshProbes,
} from "./probes.js";
import { EnergyIntegrator } from "./sampler.js";
import { dayKey, loadState, saveState, statePath, type SessionEntry, type State } from "./store.js";

export type WattPluginOptions = WattConfig & {
  state_path?: string;
  probes?: Probe[];
};

const WH_TO_J = 3600;
const JOULES_PER_KWH = 3_600_000;
const SAVE_INTERVAL_MS = 60_000;
const EXEC_TIMEOUT_MS = 5000;

function buildProbes(cfg: WattConfig): { probes: Probe[]; countries: Map<string, string | null> } {
  const probes: Probe[] = [
    nvidiaSmiProbe(nodeExec, "local", EXEC_TIMEOUT_MS),
    rocmSmiProbe(nodeExec, "local", EXEC_TIMEOUT_MS),
  ];
  probes.push(...raplProbes(nodeList, nodeRead, "local"));
  probes.push(...hwmonProbes(nodeList, nodeRead, "local"));
  const countries = new Map<string, string | null>();
  for (const target of cfg.ssh) {
    for (const p of sshProbes(nodeExec, target)) {
      probes.push(p);
      countries.set(p.source, target.country ?? null);
    }
  }
  for (const target of cfg.prom) {
    const p = promProbe(promFetch(target.timeout_ms ?? EXEC_TIMEOUT_MS), target);
    probes.push(p);
    countries.set(p.source, target.country ?? null);
  }
  return { probes, countries };
}

function promFetch(timeout: number) {
  return async (url: string, init?: { headers?: Record<string, string> }) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
}

const kwh = (joules: number): string => (joules / JOULES_PER_KWH).toFixed(4);

export const WattPlugin: Plugin = async (input, rawOptions) => {
  const options = (rawOptions ?? {}) as Partial<WattPluginOptions>;
  const cfg = normalizeConfig(options);
  const stateFile = options?.state_path ?? statePath();
  const client = input.client;
  const state: State = loadState(stateFile, Date.now());
  const integrator = new EnergyIntegrator({ subtract_idle: cfg.subtract_idle });
  const injected = options?.probes;
  const { probes, countries } = injected
    ? { probes: injected, countries: new Map<string, string | null>() }
    : buildProbes(cfg);

  const busy = new Set<string>();
  let tailUntil = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;

  const log = async (level: "info" | "warn" | "error", message: string): Promise<void> => {
    try {
      await client.app.log({ body: { service: "opencode-watt", level, message } });
    } catch {
      // logging is best-effort
    }
  };

  const ensureEntry = (sessionID: string): SessionEntry => {
    let entry = state.sessions[sessionID];
    if (!entry) {
      const now = Date.now();
      entry = { model: null, started: now, last_active: now, raw_j: 0, attributed_j: 0, cost: 0 };
      state.sessions[sessionID] = entry;
    }
    return entry;
  };

  const persist = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastSave < SAVE_INTERVAL_MS) return;
    lastSave = now;
    try {
      saveState(stateFile, state);
    } catch {
      // state persistence is best-effort
    }
  };

  const rateFor = (source: string | undefined, at: Date) =>
    resolveRate(cfg, at, source === undefined ? undefined : (countries.get(source) ?? undefined));

  const tick = async (): Promise<void> => {
    if (disposed) return;
    try {
      const now = Date.now();
      const results = await Promise.all(probes.map(async (p) => ({ p, r: await p.sample(now) })));
      const samples: Sample[] = [];
      for (const { p, r } of results) {
        samples.push(...r.samples);
        state.probe_status[p.source] = r.status;
      }
      const res = integrator.tick(samples, now, busy.size);
      const dk = dayKey(new Date(now));
      const existing = state.days[dk];
      const day = existing ?? { raw_j: 0, attributed_j: 0, cost: 0 };
      if (!existing) state.days[dk] = day;
      day.raw_j += res.raw_j;
      day.attributed_j += res.attributed_j;
      const share = busy.size > 0 ? 1 / busy.size : 0;
      for (const [source, ps] of Object.entries(res.per_source)) {
        const rate = rateFor(source, new Date(now));
        day.cost += cost(ps.attributed_j, rate);
        for (const sessionID of busy) {
          const entry = ensureEntry(sessionID);
          entry.raw_j += ps.raw_j * share;
          entry.attributed_j += ps.attributed_j * share;
          entry.cost += cost(ps.attributed_j * share, rate);
        }
      }
    } catch (error) {
      await log("warn", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    persist();
    schedule();
  };

  const schedule = (override?: number): void => {
    if (disposed) return;
    const delay =
      override ??
      (busy.size > 0
        ? cfg.interval_ms
        : Date.now() < tailUntil
          ? cfg.tail_ms
          : cfg.idle_interval_ms);
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  schedule(0);
  void log("info", `opencode-watt started with ${probes.length} meter source(s)`);

  const hooks: Hooks = {
    tool: {
      power_cost: tool({
        description:
          "Report electric power and cost of local LLM inference measured by opencode-watt (watts now, kWh and money per session/day/all).",
        args: {
          scope: tool.schema
            .enum(["session", "today", "all"])
            .optional()
            .describe("Report scope: current session (default), today, or all recorded days"),
        },
        execute: (args, context) => report(args.scope ?? "session", context.sessionID),
      }),
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          const { sessionID, status } = event.properties;
          if (status.type === "busy") {
            busy.add(sessionID);
            ensureEntry(sessionID);
            tailUntil = 0;
          } else if (busy.delete(sessionID)) {
            const entry = state.sessions[sessionID];
            if (entry) entry.last_active = Date.now();
            if (busy.size === 0) tailUntil = Date.now() + cfg.tail_ms;
          }
        } else if (event.type === "session.idle") {
          const { sessionID } = event.properties;
          busy.delete(sessionID);
          const entry = state.sessions[sessionID];
          if (entry && entry.attributed_j > WH_TO_J) {
            const rate = rateFor(undefined, new Date());
            const message = `${kwh(entry.attributed_j)} kWh · ${entry.cost.toFixed(4)} ${rate.currency} this session`;
            try {
              await client.tui.showToast({
                body: { title: "power_cost", message, variant: "info" },
              });
            } catch {
              // TUI may be unavailable (headless runs); cost is still tracked in state
            }
          }
          persist(true);
        }
      } catch (error) {
        await log(
          "warn",
          `event handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    "chat.message": async (msg) => {
      if (msg.model) {
        ensureEntry(msg.sessionID).model = `${msg.model.providerID}/${msg.model.modelID}`;
      }
    },
    dispose: async () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      persist(true);
    },
  };

  async function report(scope: "session" | "today" | "all", sessionID: string): Promise<string> {
    const lines: string[] = [`power_cost (${scope})`];
    const now = Date.now();
    const meters = integrator.lastWatts();
    if (probes.length === 0) {
      lines.push(
        "no meters found: configure ssh/prom targets in the plugin options, or check probe statuses below",
      );
    } else if (meters.length === 0) {
      lines.push("no samples yet (waiting for the first sampling tick)");
    } else {
      for (const m of meters) {
        const age = ((now - m.at) / 1000).toFixed(1);
        lines.push(`now: ${m.source}:${m.id} ${m.watts.toFixed(1)} W (age ${age}s)`);
      }
    }
    const rate = rateFor(undefined, new Date());
    lines.push(
      `rate: ${rate.price_per_kwh.toFixed(4)} ${rate.currency}/kWh (${rate.label}${cfg.subtract_idle ? ", idle subtracted" : ""})`,
    );

    const sessionEntry = state.sessions[sessionID];
    if (scope === "session") {
      if (!sessionEntry) {
        lines.push("session: no energy recorded yet");
      } else {
        lines.push(
          `session: ${kwh(sessionEntry.attributed_j)} kWh · ${sessionEntry.cost.toFixed(4)} ${rate.currency} (raw ${kwh(sessionEntry.raw_j)} kWh${sessionEntry.model ? `, model ${sessionEntry.model}` : ""})`,
        );
      }
    } else if (scope === "today") {
      const day = state.days[dayKey(new Date(now))];
      lines.push(
        `today: ${day ? `${kwh(day.attributed_j)} kWh · ${day.cost.toFixed(4)} ${rate.currency}` : "no energy recorded yet"} (raw ${kwh(day?.raw_j ?? 0)} kWh)`,
      );
    } else {
      let attributed = 0;
      let raw = 0;
      let costTotal = 0;
      for (const day of Object.values(state.days)) {
        attributed += day.attributed_j;
        raw += day.raw_j;
        costTotal += day.cost;
      }
      lines.push(
        `all: ${kwh(attributed)} kWh · ${costTotal.toFixed(4)} ${rate.currency} (raw ${kwh(raw)} kWh)`,
      );
    }

    const statuses = Object.entries(state.probe_status);
    if (statuses.length > 0) {
      lines.push(`probes: ${statuses.map(([source, status]) => `${source}=${status}`).join(", ")}`);
    }
    return lines.join("\n");
  }

  return hooks;
};
