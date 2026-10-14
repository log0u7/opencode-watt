import type { WattConfig } from "./config.js";
import { cost, resolveRate } from "./pricing.js";
import {
  hwmonProbes,
  type Probe,
  type ProbeStatus,
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

export const WH_TO_J = 3600;
export const JOULES_PER_KWH = 3_600_000;
const SAVE_INTERVAL_MS = 60_000;
const EXEC_TIMEOUT_MS = 5000;
const MAX_MISS_STREAK = 6; // 2**6 = 64x the configured interval

// Mirrors the SDK `SessionStatus["type"]` union (idle | retry | busy).
export type SessionStatusType = "idle" | "retry" | "busy";

export const kwh = (joules: number): string => (joules / JOULES_PER_KWH).toFixed(4);

export function buildProbes(cfg: WattConfig): {
  probes: Probe[];
  countries: Map<string, string | null>;
} {
  const probes: Probe[] = [
    nvidiaSmiProbe(nodeExec, "local", EXEC_TIMEOUT_MS),
    rocmSmiProbe(nodeExec, "local", EXEC_TIMEOUT_MS),
  ];
  probes.push(...raplProbes(nodeList, nodeRead, "local"));
  probes.push(...hwmonProbes(nodeList, nodeRead, "local"));
  const countries = new Map<string, string | null>();
  for (const target of cfg.ssh) {
    for (const p of sshProbes(nodeExec, {
      ...target,
      control_master: target.control_master ?? cfg.ssh_control,
    })) {
      probes.push(p);
      countries.set(p.source, target.country ?? null);
    }
  }
  for (const target of cfg.prom) {
    const p = promProbe(promFetch(target.timeout_ms ?? EXEC_TIMEOUT_MS), target);
    probes.push(p);
    countries.set(p.source, target.country ?? null);
  }
  // Optional allowlist of source prefixes: lets a host keep a single GPU meter
  // when two of them report the same device (e.g. rocm-smi and amdgpu hwmon).
  const wanted = cfg.meters;
  if (wanted) {
    const kept = probes.filter((p) => wanted.some((m) => p.source.startsWith(m)));
    probes.length = 0;
    probes.push(...kept);
    for (const source of countries.keys()) {
      if (!kept.some((p) => p.source === source)) countries.delete(source);
    }
  }
  return { probes, countries };
}

export function promFetch(timeout: number) {
  return async (url: string, init?: { headers?: Record<string, string> }) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
}

export type EngineHost = {
  log: (level: "info" | "warn" | "error", message: string) => Promise<void>;
  notify: (message: string) => Promise<void>;
};

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(
  cfg: WattConfig,
  host: EngineHost,
  stateFile = statePath(),
  injectedProbes?: Probe[],
) {
  const state: State = loadState(stateFile, Date.now());
  const integrator = new EnergyIntegrator({ subtract_idle: cfg.subtract_idle });
  const { probes, countries } = injectedProbes
    ? { probes: injectedProbes, countries: new Map<string, string | null>() }
    : buildProbes(cfg);

  const busy = new Set<string>();
  let tailUntil = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;
  let misses = 0;

  const log = host.log;

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
      const started = Date.now();
      // Each probe is stamped when its own reading lands, so a slow meter
      // (nvidia-smi spawns a process) shifts only its own integration span.
      // A probe that throws is isolated: it reports "error" for this tick
      // instead of dropping every other meter.
      const settled = await Promise.all(
        probes.map(async (p) => {
          try {
            const result = await p.sample(started);
            return { source: p.source, result, at: Date.now() };
          } catch {
            return {
              source: p.source,
              result: { samples: [], status: "error" as ProbeStatus },
              at: Date.now(),
            };
          }
        }),
      );
      const samples: Sample[] = [];
      for (const { source, result, at } of settled) {
        state.probe_status[source] = result.status;
        for (const s of result.samples) samples.push({ ...s, at });
      }
      const now = started;
      const meterOk = settled.some(({ result }) => result.status === "ok");
      if (!meterOk && samples.length === 0) misses++;
      else misses = 0;
      const res = integrator.tick(samples, now, busy.size);
      const dk = dayKey(new Date(now));
      const existing = state.days[dk];
      const day = existing ?? { raw_j: 0, attributed_j: 0, cost: 0, budget_warned: false };
      if (!existing) state.days[dk] = day;
      day.raw_j += res.raw_j;
      day.attributed_j += res.attributed_j;
      const share = busy.size > 0 ? 1 / busy.size : 0;
      for (const [source, ps] of Object.entries(res.per_source)) {
        const rate = rateFor(source, new Date(now));
        day.cost += cost(ps.attributed_j, rate, cfg.wall_factor);
        for (const sessionID of busy) {
          const entry = ensureEntry(sessionID);
          entry.raw_j += ps.raw_j * share;
          entry.attributed_j += ps.attributed_j * share;
          entry.cost += cost(ps.attributed_j * share, rate, cfg.wall_factor);
        }
      }
      // Daily budget: warn once per day, exactly when the threshold is crossed.
      const budget = cfg.daily_budget_kwh ?? null;
      if (budget !== null && !day.budget_warned && day.attributed_j > budget * JOULES_PER_KWH) {
        day.budget_warned = true;
        await host.notify(
          `opencode-watt daily budget: ${kwh(day.attributed_j)} of ${budget.toFixed(3)} kWh today (${day.cost.toFixed(3)} ${rateFor(undefined, new Date(now)).currency})`,
        );
      }
    } catch (error) {
      await log("warn", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    persist();
    schedule();
  };

  const schedule = (override?: number): void => {
    if (disposed) return;
    const base =
      busy.size > 0 ? cfg.interval_ms : Date.now() < tailUntil ? cfg.tail_ms : cfg.idle_interval_ms;
    // No meter reports ok: stop burning CPU on probes that report nothing.
    const backoff = Math.min(base * 2 ** Math.min(misses, MAX_MISS_STREAK), 60_000);
    timer = setTimeout(() => {
      void tick();
    }, override ?? backoff);
  };

  schedule(0);
  void log("info", `opencode-watt started with ${probes.length} meter source(s)`);

  const handleStatus = (sessionID: string, status: SessionStatusType): void => {
    // "retry" (provider 429/5xx backoff) is still active: keeping the session
    // busy preserves its imputation and the tail instead of dropping it mid-turn.
    if (status === "busy" || status === "retry") {
      busy.add(sessionID);
      ensureEntry(sessionID);
      tailUntil = 0;
    } else if (busy.delete(sessionID)) {
      const entry = state.sessions[sessionID];
      if (entry) entry.last_active = Date.now();
      if (busy.size === 0) tailUntil = Date.now() + cfg.tail_ms;
    }
  };

  // A deleted session must never stay in the busy set: it would keep
  // receiving energy and dilute the split across the real sessions.
  const forget = (sessionID: string): void => {
    busy.delete(sessionID);
    delete state.sessions[sessionID];
    if (busy.size === 0) tailUntil = Date.now() + cfg.tail_ms;
    persist(true);
  };

  const handleIdle = async (sessionID: string): Promise<void> => {
    busy.delete(sessionID);
    const entry = state.sessions[sessionID];
    if (entry && entry.attributed_j > WH_TO_J) {
      const rate = rateFor(undefined, new Date());
      const message = `${kwh(entry.attributed_j)} kWh · ${entry.cost.toFixed(4)} ${rate.currency} this session`;
      try {
        await host.notify(message);
      } catch {
        // notification may be unavailable (headless runs); cost is still tracked in state
      }
    }
    persist(true);
  };

  const setModel = (sessionID: string, model: string): void => {
    ensureEntry(sessionID).model = model;
  };

  type ReportData = {
    scope: "session" | "today" | "all";
    meters: { source: string; id: string; watts: number; age_s: number }[];
    rate: ReturnType<typeof resolveRate>;
    currencies: string[];
    baseline: { filled: number; window: number } | null;
    session: {
      attributed_kwh: number;
      cost: number;
      raw_kwh: number;
      model: string | null;
    } | null;
    day: { attributed_kwh: number; cost: number; raw_kwh: number } | null;
    totals: { attributed_kwh: number; cost: number; raw_kwh: number } | null;
    probes: Record<string, string>;
    budget: { budget_kwh: number; attributed_kwh: number } | null;
  };

  async function reportData(
    scope: "session" | "today" | "all",
    sessionID: string,
  ): Promise<ReportData> {
    const now = Date.now();
    const rate = rateFor(undefined, new Date(now));
    // Every source may tariff in its own country's currency; the day/all totals
    // add those costs anyway, so surface the set instead of hiding the mixing.
    const currencies = [
      ...new Set([rate.currency, ...probes.map((p) => rateFor(p.source, new Date(now)).currency)]),
    ];
    const sessionEntry = state.sessions[sessionID] ?? null;
    const dayEntry = state.days[dayKey(new Date(now))] ?? null;
    let totals: ReportData["totals"] = null;
    if (scope === "all") {
      let attributed = 0;
      let raw = 0;
      let costTotal = 0;
      for (const day of Object.values(state.days)) {
        attributed += day.attributed_j;
        raw += day.raw_j;
        costTotal += day.cost;
      }
      totals = {
        attributed_kwh: attributed / JOULES_PER_KWH,
        cost: costTotal,
        raw_kwh: raw / JOULES_PER_KWH,
      };
    }
    const budget = cfg.daily_budget_kwh
      ? {
          budget_kwh: cfg.daily_budget_kwh,
          attributed_kwh: (dayEntry?.attributed_j ?? 0) / JOULES_PER_KWH,
        }
      : null;
    return {
      scope,
      meters: integrator.lastWatts().map((m) => ({
        source: m.source,
        id: m.id,
        watts: m.watts,
        age_s: (now - m.at) / 1000,
      })),
      rate,
      currencies,
      baseline: cfg.subtract_idle && probes.length > 0 ? integrator.baselineProgress() : null,
      session:
        scope === "session" && sessionEntry
          ? {
              attributed_kwh: sessionEntry.attributed_j / JOULES_PER_KWH,
              cost: sessionEntry.cost,
              raw_kwh: sessionEntry.raw_j / JOULES_PER_KWH,
              model: sessionEntry.model,
            }
          : null,
      day:
        scope === "today" && dayEntry
          ? {
              attributed_kwh: dayEntry.attributed_j / JOULES_PER_KWH,
              cost: dayEntry.cost,
              raw_kwh: dayEntry.raw_j / JOULES_PER_KWH,
            }
          : null,
      totals,
      probes: { ...state.probe_status },
      budget,
    };
  }

  async function report(scope: "session" | "today" | "all", sessionID: string): Promise<string> {
    const data = await reportData(scope, sessionID);
    const lines: string[] = [`power_cost (${scope})`];
    if (probes.length === 0) {
      lines.push(
        "no meters found: configure ssh/prom targets in the plugin options, or check probe statuses below",
      );
    } else if (data.meters.length === 0) {
      lines.push("no samples yet (waiting for the first sampling tick)");
    } else {
      for (const m of data.meters) {
        lines.push(`now: ${m.source}:${m.id} ${m.watts.toFixed(1)} W (age ${m.age_s.toFixed(1)}s)`);
      }
    }
    lines.push(
      `rate: ${data.rate.price_per_kwh.toFixed(4)} ${data.rate.currency}/kWh (${data.rate.label}${cfg.subtract_idle ? ", idle subtracted" : ""})`,
    );
    if (data.currencies.length > 1) {
      lines.push(`currencies: ${data.currencies.join(", ")} (totals mix currencies)`);
    }
    if (data.baseline) {
      lines.push(`baseline: ${data.baseline.filled}/${data.baseline.window} samples`);
    }
    if (data.session) {
      lines.push(
        `session: ${kwh(data.session.attributed_kwh * JOULES_PER_KWH)} kWh · ${data.session.cost.toFixed(4)} ${data.rate.currency} (raw ${kwh(data.session.raw_kwh * JOULES_PER_KWH)} kWh${data.session.model ? `, model ${data.session.model}` : ""})`,
      );
    } else if (data.scope === "session") {
      lines.push("session: no energy recorded yet");
    }
    if (data.day) {
      lines.push(
        `today: ${kwh(data.day.attributed_kwh * JOULES_PER_KWH)} kWh · ${data.day.cost.toFixed(4)} ${data.rate.currency} (raw ${kwh(data.day.raw_kwh * JOULES_PER_KWH)} kWh)`,
      );
    } else if (data.scope === "today") {
      lines.push("today: no energy recorded yet (raw 0.0000 kWh)");
    }
    if (data.totals) {
      lines.push(
        `all: ${kwh(data.totals.attributed_kwh * JOULES_PER_KWH)} kWh · ${data.totals.cost.toFixed(4)} ${data.rate.currency} (raw ${kwh(data.totals.raw_kwh * JOULES_PER_KWH)} kWh)`,
      );
    }
    if (data.budget) {
      lines.push(
        `budget: ${data.budget.attributed_kwh.toFixed(4)} / ${data.budget.budget_kwh.toFixed(4)} kWh today`,
      );
    }
    const statuses = Object.entries(data.probes);
    if (statuses.length > 0) {
      lines.push(`probes: ${statuses.map(([source, status]) => `${source}=${status}`).join(", ")}`);
    }
    return lines.join("\n");
  }

  const dispose = async (): Promise<void> => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    persist(true);
  };

  return { state, handleStatus, handleIdle, forget, setModel, report, reportData, dispose };
}
