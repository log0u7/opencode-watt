import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export type DayEntry = { raw_j: number; attributed_j: number; cost: number };

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

export function loadState(path: string, now: number): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return freshState();
  }
  const state = parsed as State | null;
  if (state?.version !== 1 || !state?.days || typeof state.days !== "object") {
    return freshState();
  }
  const clean = freshState();
  clean.days = state.days;
  clean.sessions = state.sessions ?? {};
  clean.probe_status = state.probe_status ?? {};
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
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}
