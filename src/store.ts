import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export type DayEntry = {
  raw_j: number;
  attributed_j: number;
  cost: number;
  budget_warned?: boolean;
};

export type SessionEntry = {
  model: string | null;
  started: number;
  last_active: number;
  raw_j: number;
  attributed_j: number;
  cost: number;
};

export type State = {
  version: 1;
  days: Record<string, DayEntry>;
  sessions: Record<string, SessionEntry>;
  probe_status: Record<string, string>;
};

export function freshState(): State {
  return { version: 1, days: {}, sessions: {}, probe_status: {} };
}

export function statePath(dataHome?: string): string {
  const home = dataHome ?? process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  return `${home}/opencode-watt/state.json`;
}

export function dayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A missing numeric field defaults to 0; a present one must be a finite,
// non-negative number (otherwise the entry is corruption and is dropped).
const nonNeg = (v: unknown): number | null =>
  v === undefined ? 0 : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

function normalizeDay(v: unknown): DayEntry | null {
  if (!isPlainObject(v)) return null;
  const raw_j = nonNeg(v.raw_j);
  const attributed_j = nonNeg(v.attributed_j);
  const cost = nonNeg(v.cost);
  if (raw_j === null || attributed_j === null || cost === null) return null;
  const day: DayEntry = { raw_j, attributed_j, cost };
  if (v.budget_warned === true) day.budget_warned = true;
  return day;
}

function normalizeSession(v: unknown): SessionEntry | null {
  if (!isPlainObject(v)) return null;
  const started = nonNeg(v.started);
  const last_active = nonNeg(v.last_active);
  const raw_j = nonNeg(v.raw_j);
  const attributed_j = nonNeg(v.attributed_j);
  const cost = nonNeg(v.cost);
  if (
    started === null ||
    last_active === null ||
    raw_j === null ||
    attributed_j === null ||
    cost === null
  ) {
    return null;
  }
  return {
    model: typeof v.model === "string" ? v.model : null,
    started,
    last_active,
    raw_j,
    attributed_j,
    cost,
  };
}

export function loadState(path: string, now: number): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return freshState();
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) return freshState();
  const clean = freshState();
  if (isPlainObject(parsed.days)) {
    for (const [key, value] of Object.entries(parsed.days)) {
      const day = normalizeDay(value);
      if (day) clean.days[key] = day;
    }
  }
  if (isPlainObject(parsed.sessions)) {
    for (const [key, value] of Object.entries(parsed.sessions)) {
      const session = normalizeSession(value);
      if (session) clean.sessions[key] = session;
    }
  }
  if (isPlainObject(parsed.probe_status)) {
    for (const [key, value] of Object.entries(parsed.probe_status)) {
      if (typeof value === "string") clean.probe_status[key] = value;
    }
  }
  for (const id of Object.keys(clean.sessions)) {
    if ((clean.sessions[id]?.last_active ?? 0) < now - SESSION_TTL_MS) {
      delete clean.sessions[id];
    }
  }
  return clean;
}

export function saveState(path: string, state: State): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  // Write to a temp file, flush it to disk, then rename: a crash mid-write
  // leaves the previous good state intact instead of a truncated file. The
  // state file is owner-only (0600), forced regardless of umask.
  const fd = openSync(tmp, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
