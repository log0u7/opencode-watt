import type { RateWindow } from "./pricing.js";
import type { PromTarget, SshTarget } from "./probes.js";

export type WattConfig = {
  interval_ms: number;
  idle_interval_ms: number;
  tail_ms: number;
  subtract_idle: boolean;
  country: string | null;
  price_per_kwh: number | null;
  currency: string | null;
  windows: RateWindow[];
  ssh: SshTarget[];
  prom: PromTarget[];
};

const num = (v: unknown, def: number, min: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? v : def;

const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const hhMm = (v: unknown): v is string =>
  typeof v === "string" && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(v);

const validWindow = (w: unknown): w is RateWindow =>
  typeof w === "object" &&
  w !== null &&
  hhMm((w as RateWindow).start) &&
  hhMm((w as RateWindow).end) &&
  typeof (w as RateWindow).price_per_kwh === "number" &&
  Number.isFinite((w as RateWindow).price_per_kwh);

const validSsh = (t: unknown): t is SshTarget =>
  typeof t === "object" &&
  t !== null &&
  typeof (t as SshTarget).host === "string" &&
  (t as SshTarget).host.length > 0;

const validProm = (t: unknown): t is PromTarget =>
  typeof t === "object" &&
  t !== null &&
  typeof (t as PromTarget).base_url === "string" &&
  (t as PromTarget).base_url.length > 0 &&
  Array.isArray((t as PromTarget).queries) &&
  ((t as PromTarget).queries as PromTarget["queries"]).every(
    (q) => typeof q?.name === "string" && typeof q?.query === "string",
  );

export function normalizeConfig(raw: unknown): WattConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const windows = Array.isArray(r.windows) ? r.windows.filter(validWindow) : [];
  const ssh = Array.isArray(r.ssh) ? r.ssh.filter(validSsh) : [];
  const prom = Array.isArray(r.prom) ? r.prom.filter(validProm) : [];
  return {
    interval_ms: num(r.interval_ms, 1000, 200),
    idle_interval_ms: num(r.idle_interval_ms, 10000, 1000),
    tail_ms: num(r.tail_ms, 5000, 0),
    subtract_idle: bool(r.subtract_idle, true),
    country: str(r.country),
    price_per_kwh:
      typeof r.price_per_kwh === "number" && Number.isFinite(r.price_per_kwh) && r.price_per_kwh > 0
        ? r.price_per_kwh
        : null,
    currency: str(r.currency),
    windows,
    ssh,
    prom,
  };
}
