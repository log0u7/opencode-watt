import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dayKey, loadState, saveState, statePath, type State } from "../src/store.js";

const DAY = 24 * 3600 * 1000;

function freshEntry(): State {
  return {
    version: 1,
    days: {},
    sessions: {},
    probe_status: {},
  };
}

const dirs: string[] = [];

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-watt-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("dayKey()", () => {
  it("formats a local YYYY-MM-DD key", () => {
    expect(dayKey(new Date("2026-09-28T20:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("statePath()", () => {
  const OLD = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD };
  });

  it("uses the explicit data home when given", () => {
    expect(statePath("/data")).toBe("/data/opencode-watt/state.json");
  });

  it("prefers XDG_DATA_HOME over HOME", () => {
    process.env.XDG_DATA_HOME = "/xdg";
    process.env.HOME = "/home/u";
    expect(statePath()).toBe("/xdg/opencode-watt/state.json");
  });

  it("falls back to HOME and tolerates a missing HOME", () => {
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = "/home/u";
    expect(statePath()).toBe("/home/u/.local/share/opencode-watt/state.json");
    delete process.env.HOME;
    expect(statePath()).toBe("/.local/share/opencode-watt/state.json");
  });
});

describe("loadState()", () => {
  it("returns a fresh state when the file is missing", () => {
    const state = loadState(tmpFile("missing.json"), 0);
    expect(state.version).toBe(1);
    expect(state.days).toEqual({});
    expect(state.sessions).toEqual({});
  });

  it("round-trips through saveState", () => {
    const path = tmpFile("state.json");
    const state = loadState(path, 0);
    state.days["2026-09-28"] = { raw_j: 100, attributed_j: 90, cost: 0.01 };
    state.sessions.s1 = {
      model: "m",
      started: 1,
      last_active: 2,
      raw_j: 10,
      attributed_j: 9,
      cost: 0.001,
    };
    state.probe_status["nvidia-smi@local"] = "absent";
    saveState(path, state);

    const loaded = loadState(path, 0);
    expect(loaded.days["2026-09-28"]?.cost).toBe(0.01);
    expect(loaded.sessions.s1?.model).toBe("m");
    expect(loaded.probe_status["nvidia-smi@local"]).toBe("absent");
  });

  it("returns a fresh state on corrupt JSON", () => {
    const path = tmpFile("corrupt.json");
    writeFileSync(path, "{not json");
    const state = loadState(path, 0);
    expect(state.version).toBe(1);
    expect(state.days).toEqual({});
  });

  it("defaults missing sessions and probe_status fields", () => {
    const path = tmpFile("partial.json");
    writeFileSync(path, JSON.stringify({ version: 1, days: { "2026-09-28": { raw_j: 1 } } }));
    const state = loadState(path, 0);
    expect(state.sessions).toEqual({});
    expect(state.probe_status).toEqual({});
    expect(state.days["2026-09-28"]?.raw_j).toBe(1);
  });

  it("prunes sessions older than the retention window", () => {
    const path = tmpFile("stale.json");
    const stale = freshEntry();
    stale.sessions.old = {
      model: "m",
      started: 0,
      last_active: 0,
      raw_j: 1,
      attributed_j: 1,
      cost: 0,
    };
    stale.sessions.recent = {
      model: "m",
      started: DAY,
      last_active: 2 * DAY,
      raw_j: 1,
      attributed_j: 1,
      cost: 0,
    };
    saveState(path, stale);
    const state = loadState(path, 31 * DAY); // SESSION_TTL_MS = 30 days, strictly expired
    expect(state.sessions.old).toBeUndefined();
    expect(state.sessions.recent?.started).toBe(DAY);
  });

  it("returns a fresh state on wrong version", () => {
    const path = tmpFile("wrong-version.json");
    writeFileSync(path, JSON.stringify({ version: 99, days: 1 }));
    expect(loadState(path, 0).days).toEqual({});
  });

  it("prunes sessions idle for more than 30 days", () => {
    const path = tmpFile("prune.json");
    const now = 1_800_000_000_000;
    const state: State = freshEntry();
    state.sessions.old = {
      model: null,
      started: now - 40 * DAY,
      last_active: now - 31 * DAY,
      raw_j: 1,
      attributed_j: 1,
      cost: 0,
    };
    state.sessions.recent = {
      model: null,
      started: now - 2 * DAY,
      last_active: now - DAY,
      raw_j: 2,
      attributed_j: 2,
      cost: 0,
    };
    saveState(path, state);

    const loaded = loadState(path, now);
    expect(loaded.sessions.old).toBeUndefined();
    expect(loaded.sessions.recent).toBeDefined();
  });

  it("keeps days untouched by pruning", () => {
    const path = tmpFile("days.json");
    const state: State = freshEntry();
    state.days["2020-01-01"] = { raw_j: 5, attributed_j: 5, cost: 0.1 };
    saveState(path, state);
    expect(loadState(path, Date.now()).days["2020-01-01"]).toBeDefined();
  });

  it("does not crash and empties sessions when sessions is not an object", () => {
    const path = tmpFile("bad-sessions.json");
    writeFileSync(path, JSON.stringify({ version: 1, days: {}, sessions: 42, probe_status: {} }));
    const state = loadState(path, 0);
    expect(state.sessions).toEqual({});
  });

  it("does not crash and empties probe_status when it is not an object", () => {
    const path = tmpFile("bad-status.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, days: {}, sessions: {}, probe_status: "nope" }),
    );
    const state = loadState(path, 0);
    expect(state.probe_status).toEqual({});
  });

  it("ignores a session entry with a negative or non-finite field", () => {
    const path = tmpFile("bad-session.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        days: {},
        sessions: {
          neg: { model: "m", started: 1, last_active: 2, raw_j: -5, attributed_j: 1, cost: 0 },
          nan: { model: "m", started: 1, last_active: 2, raw_j: "x", attributed_j: 1, cost: 0 },
          ok: { model: "m", started: 1, last_active: 2, raw_j: 1, attributed_j: 1, cost: 0 },
        },
        probe_status: {},
      }),
    );
    const state = loadState(path, 0);
    expect(state.sessions.neg).toBeUndefined();
    expect(state.sessions.nan).toBeUndefined();
    expect(state.sessions.ok).toBeDefined();
  });

  it("ignores a day entry that is not an object", () => {
    const path = tmpFile("bad-day.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, days: { bad: 7, ok: { raw_j: 1, attributed_j: 1, cost: 0 } } }),
    );
    const state = loadState(path, 0);
    expect(state.days.bad).toBeUndefined();
    expect(state.days.ok).toBeDefined();
  });
});

describe("saveState() atomicity", () => {
  it("leaves no temp file behind", () => {
    const path = tmpFile("atomic.json");
    saveState(path, freshEntry());
    const sibling = path.replace(/\.json$/, ".json.tmp");
    expect(() => readFileSync(sibling)).toThrow();
    expect(() => readFileSync(path)).not.toThrow();
  });

  it("writes the state file with owner-only permissions", () => {
    const path = tmpFile("mode.json");
    saveState(path, freshEntry());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("overwrites previous content", () => {
    const path = tmpFile("overwrite.json");
    const state = freshEntry();
    state.days.d1 = { raw_j: 1, attributed_j: 1, cost: 0 };
    saveState(path, state);
    state.days.d2 = { raw_j: 2, attributed_j: 2, cost: 0 };
    saveState(path, state);
    const raw = JSON.parse(readFileSync(path, "utf8")) as State;
    expect(Object.keys(raw.days)).toEqual(["d1", "d2"]);
  });
});
