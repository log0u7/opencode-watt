import { execFile as nodeExecFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export type ExecResult = { ok: true; stdout: string } | { ok: false; code: string };
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
export type ReadFn = (path: string) => string;
export type ListFn = (path: string) => string[];

export type ProbeStatus = "ok" | "absent" | "denied" | "unreachable" | "error";

export type PowerSample = { kind: "power"; source: string; id: string; watts: number; at: number };
export type EnergySample = {
  kind: "energy";
  source: string;
  id: string;
  joules: number;
  wrap_max_j?: number;
  at: number;
};
export type Sample = PowerSample | EnergySample;

export type Probe = { source: string; sample: (now: number) => Promise<ProbeResult> };
export type ProbeResult = { samples: Sample[]; status: ProbeStatus };

// Default node implementations (injectable for tests).

export function nodeExec(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        const code =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "ENOENT"
            : (error as { killed?: boolean }).killed
              ? "TIMEOUT"
              : "EXIT";
        resolve({ ok: false, code });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

export const nodeRead: ReadFn = (path) => readFileSync(path, "utf8");
export const nodeList: ListFn = (path) => readdirSync(path);

// Failure handling: transient failures (unreachable/error) retry after a short
// backoff (first failure retries once, then every 10 ticks). Permanent ones
// (absent/denied) disable the probe for the process lifetime.
class Guard {
  private failures = 0;
  private last: ProbeStatus = "ok";

  static readonly retry = (g: Guard) => g.failures < 2 || g.failures % 10 === 1;

  constructor(private readonly canAttempt: (g: Guard) => boolean = Guard.retry) {}

  get status(): ProbeStatus {
    return this.last;
  }

  get failed(): boolean {
    return this.last !== "ok";
  }

  async run(attempt: () => Promise<ProbeResult>): Promise<ProbeResult> {
    if (this.last === "absent" || this.last === "denied") {
      return { samples: [], status: this.last };
    }
    if (this.last !== "ok" && !this.canAttempt(this)) {
      return { samples: [], status: this.last };
    }
    const res = await attempt();
    if (res.status === "ok") {
      this.failures = 0;
      this.last = "ok";
    } else {
      this.failures++;
      this.last = res.status;
    }
    return res;
  }
}

const MJ = 1e6; // microjoules -> joules

// Parsers (pure, unit-testable).

export function parseNvidiaCsv(stdout: string): { gpu: string; name: string; watts: number }[] {
  const rows: { gpu: string; name: string; watts: number }[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const [gpu, name, watts] = parts as [string, string, string];
    const w = Number(watts);
    if (!gpu || !Number.isFinite(w) || w < 0) continue;
    rows.push({ gpu, name, watts: w });
  }
  return rows;
}

export function parseRocmJson(stdout: string): { gpu: string; watts: number }[] {
  try {
    const parsed = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
    const rows: { gpu: string; watts: number }[] = [];
    for (const [gpu, fields] of Object.entries(parsed)) {
      const power = fields?.Power;
      if (typeof power !== "string") continue;
      const m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(power);
      const w = m ? Number(m[1]) : Number.NaN;
      if (Number.isFinite(w)) rows.push({ gpu, watts: w });
    }
    return rows;
  } catch {
    return [];
  }
}

export function parsePromResponse(body: string): number[] {
  try {
    const parsed = JSON.parse(body) as {
      status?: string;
      data?: { result?: { value?: [number, string] }[] };
    };
    if (parsed.status !== "success") return [];
    const out: number[] = [];
    for (const r of parsed.data?.result ?? []) {
      const raw = r.value?.[1];
      const v = raw === undefined ? Number.NaN : Number(raw);
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

export function parseRaplText(
  text: string,
): { path: string; name: string | null; uj: number | null; max_uj: number | null }[] {
  const zones: { path: string; name: string | null; uj: number | null; max_uj: number | null }[] =
    [];
  let current: {
    path: string;
    name: string | null;
    uj: number | null;
    max_uj: number | null;
  } | null = null;
  for (const line of text.split("\n")) {
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "ZONE") {
      current = { path: value, name: null, uj: null, max_uj: null };
      zones.push(current);
    } else if (key === "NAME" && current) {
      current.name = value || null;
    } else if (key === "UJ" && current) {
      const n = Number(value);
      current.uj = Number.isFinite(n) && value !== "" ? n : null;
    } else if (key === "MAX" && current) {
      const n = Number(value);
      current.max_uj = Number.isFinite(n) && value !== "" ? n : null;
    }
  }
  return zones;
}

function statusFromExec(code: string): ProbeStatus {
  if (code === "ENOENT") return "absent";
  if (code === "TIMEOUT") return "unreachable";
  return "error";
}

// Guarded probe factory shared by exec-backed probes.

function guardedProbe(source: string, run: (now: number) => Promise<ProbeResult>): Probe {
  const guard = new Guard();
  return {
    source,
    sample: async (now: number) => {
      const res = await guard.run(() => run(now));
      return res;
    },
  };
}

export function nvidiaSmiProbe(exec: ExecFn, target: string, timeoutMs: number): Probe {
  const source = `nvidia-smi@${target}`;
  return guardedProbe(source, async (now) => {
    const res = await exec(
      "nvidia-smi",
      ["--query-gpu=index,name,power.draw", "--format=csv,noheader,nounits"],
      timeoutMs,
    );
    if (!res.ok) return { samples: [], status: statusFromExec(res.code) };
    const samples: Sample[] = parseNvidiaCsv(res.stdout).map((r) => ({
      kind: "power",
      source,
      id: `gpu${r.gpu}`,
      watts: r.watts,
      at: now,
    }));
    return { samples, status: "ok" };
  });
}

export function rocmSmiProbe(exec: ExecFn, target: string, timeoutMs: number): Probe {
  const source = `rocm-smi@${target}`;
  return guardedProbe(source, async (now) => {
    const res = await exec("rocm-smi", ["--showpower", "--json"], timeoutMs);
    if (!res.ok) return { samples: [], status: statusFromExec(res.code) };
    const samples: Sample[] = parseRocmJson(res.stdout).map((r) => ({
      kind: "power",
      source,
      id: r.gpu,
      watts: r.watts,
      at: now,
    }));
    return { samples, status: "ok" };
  });
}

function joulesFromUj(uj: number): number {
  return uj / MJ;
}

export function raplProbes(list: ListFn, read: ReadFn, target: string): Probe[] {
  const source = `rapl@${target}`;
  const base = "/sys/class/powercap";
  let zones: string[];
  try {
    zones = list(base).filter((n) => /^intel-rapl:\d+$/.test(n));
  } catch {
    return [];
  }
  if (zones.length === 0) return [];
  const guard = new Guard(() => true); // rapl: any failure is permanent (denied/absent)
  return [
    {
      source,
      sample: async (now) => {
        const res = await guard.run(async () => {
          const samples: Sample[] = [];
          for (const zone of zones) {
            try {
              read(`${base}/${zone}/name`);
              const uj = Number(read(`${base}/${zone}/energy_uj`).trim());
              if (!Number.isFinite(uj)) continue;
              let wrapMax: number | undefined;
              try {
                const max = Number(read(`${base}/${zone}/max_energy_range_uj`).trim());
                if (Number.isFinite(max) && max > 0) wrapMax = max / MJ;
              } catch {
                // optional
              }
              samples.push({
                kind: "energy",
                source,
                id: zone,
                joules: joulesFromUj(uj),
                ...(wrapMax !== undefined ? { wrap_max_j: wrapMax } : {}),
                at: now,
              });
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "EACCES" || code === "EPERM") {
                return { samples: [], status: "denied" as ProbeStatus };
              }
              if (code === "ENOENT") {
                return { samples: [], status: "absent" as ProbeStatus };
              }
              throw error;
            }
          }
          return { samples, status: (samples.length > 0 ? "ok" : "absent") as ProbeStatus };
        });
        return res;
      },
    },
  ];
}

export function hwmonProbes(list: ListFn, read: ReadFn, target: string): Probe[] {
  const source = `hwmon@${target}`;
  const base = "/sys/class/hwmon";
  let chips: string[];
  try {
    chips = list(base).filter((n) => /^hwmon\d+$/.test(n));
  } catch {
    return [];
  }
  if (chips.length === 0) return [];
  const candidates = ["power1_input", "power1_average", "power2_input", "power2_average"];
  return [
    {
      source,
      sample: async (now) => {
        const samples: Sample[] = [];
        for (const chip of chips) {
          for (const file of candidates) {
            try {
              const uw = Number(read(`${base}/${chip}/${file}`).trim());
              if (!Number.isFinite(uw) || uw < 0) continue;
              samples.push({
                kind: "power",
                source,
                id: `${chip}:${file}`,
                watts: uw / MJ,
                at: now,
              });
            } catch {
              // missing file or unreadable chip: skip
            }
          }
        }
        return { samples, status: (samples.length > 0 ? "ok" : "absent") as ProbeStatus };
      },
    },
  ];
}

// SSH remote probes: one batched ssh call per tick shared by all section probes.

const SEP_NVIDIA = "===WATT-NVIDIA===";
const SEP_ROCM = "===WATT-ROCM===";
const SEP_RAPL = "===WATT-RAPL===";
const SEP_HWMON = "===WATT-HWMON===";

const RAPL_SCRIPT =
  "for z in /sys/class/powercap/intel-rapl:*; do " +
  'echo "$z" | grep -Eq "intel-rapl:[0-9]+$" || continue; ' +
  'echo "ZONE $z"; ' +
  'echo "NAME $(cat $z/name 2>/dev/null)"; ' +
  'echo "UJ $(cat $z/energy_uj 2>/dev/null)"; ' +
  'echo "MAX $(cat $z/max_energy_range_uj 2>/dev/null)"; ' +
  "done";

const HWMON_SCRIPT =
  "for h in /sys/class/hwmon/hwmon*; do " +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: remote shell parameter expansion
  "b=${h##*/}; " +
  "for f in $h/power1_input $h/power1_average $h/power2_input $h/power2_average; do " +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: remote shell parameter expansion
  '[ -e "$f" ] && echo "P $b:${f##*/} $(cat $f 2>/dev/null)"; ' +
  "done; done";

function section(stdout: string, sep: string, next: string): string {
  const start = stdout.indexOf(sep);
  if (start === -1) return "";
  const from = start + sep.length;
  const end = next === "" ? stdout.length : stdout.indexOf(next, from);
  const slice = end === -1 ? stdout.slice(from) : stdout.slice(from, end);
  return slice.replace(/^\n/, "").replace(/\n$/, "");
}

export type SshTarget = { host: string; country?: string; timeout_ms?: number };

export function sshProbes(exec: ExecFn, target: SshTarget): Probe[] {
  const host = target.host;
  const timeout = target.timeout_ms ?? 3000;
  const script = [
    `echo ${SEP_NVIDIA}; nvidia-smi --query-gpu=index,name,power.draw --format=csv,noheader,nounits 2>/dev/null`,
    `echo ${SEP_ROCM}; rocm-smi --showpower --json 2>/dev/null`,
    `echo ${SEP_RAPL}; ${RAPL_SCRIPT} 2>/dev/null`,
    `echo ${SEP_HWMON}; ${HWMON_SCRIPT} 2>/dev/null`,
  ].join("; ");

  // One ssh exec per tick, shared across the section probes.
  let batchAt = -1;
  let batch: Promise<{ ok: boolean; stdout: string }> | null = null;
  let lastStdout = "";
  const guard = new Guard();

  const runBatch = (now: number): Promise<{ ok: boolean; stdout: string }> => {
    if (batchAt === now && batch) return batch;
    batchAt = now;
    batch = guard
      .run(async () => {
        const res = await exec("ssh", [host, script], timeout);
        if (!res.ok) {
          lastStdout = "";
          // ssh reports connection failures as a non-zero exit (255)
          return {
            samples: [],
            status: res.code === "EXIT" ? "unreachable" : statusFromExec(res.code),
          };
        }
        lastStdout = res.stdout;
        return { samples: [], status: "ok" as ProbeStatus };
      })
      .then(() => ({ ok: guard.status === "ok", stdout: lastStdout }));
    return batch;
  };

  const make = (
    source: string,
    extract: (stdout: string, now: number) => { samples: Sample[]; status: ProbeStatus },
  ): Probe => ({
    source,
    sample: async (now: number) => {
      const res = await runBatch(now);
      if (!res.ok) return { samples: [], status: guard.status };
      return extract(res.stdout, now);
    },
  });

  return [
    make(`nvidia-smi@${host}`, (stdout, now) => {
      const text = section(stdout, SEP_NVIDIA, SEP_ROCM);
      if (text.trim() === "") return { samples: [], status: "absent" };
      const samples: Sample[] = parseNvidiaCsv(text).map((r) => ({
        kind: "power",
        source: `nvidia-smi@${host}`,
        id: `gpu${r.gpu}`,
        watts: r.watts,
        at: now,
      }));
      return { samples, status: "ok" };
    }),
    make(`rocm-smi@${host}`, (stdout, now) => {
      const text = section(stdout, SEP_ROCM, SEP_RAPL);
      if (text.trim() === "") return { samples: [], status: "absent" };
      const samples: Sample[] = parseRocmJson(text).map((r) => ({
        kind: "power",
        source: `rocm-smi@${host}`,
        id: r.gpu,
        watts: r.watts,
        at: now,
      }));
      return { samples, status: "ok" };
    }),
    make(`rapl@${host}`, (stdout, now) => {
      const text = section(stdout, SEP_RAPL, SEP_HWMON);
      const zones = parseRaplText(text);
      if (zones.length === 0) return { samples: [], status: "absent" };
      const samples: Sample[] = [];
      for (const z of zones) {
        if (z.uj === null) continue;
        const id = z.path.split("/").pop() ?? z.path;
        samples.push({
          kind: "energy",
          source: `rapl@${host}`,
          id,
          joules: z.uj / MJ,
          ...(z.max_uj !== null && z.max_uj > 0 ? { wrap_max_j: z.max_uj / MJ } : {}),
          at: now,
        });
      }
      return {
        samples,
        status: (samples.length > 0 ? "ok" : "denied") as ProbeStatus,
      };
    }),
    make(`hwmon@${host}`, (stdout, now) => {
      const text = section(stdout, SEP_HWMON, "");
      const samples: Sample[] = [];
      for (const line of text.split("\n")) {
        const [key, id, value] = line.trim().split(/\s+/);
        if (key !== "P" || !id) continue;
        const uw = Number(value);
        if (!Number.isFinite(uw) || uw < 0) continue;
        samples.push({ kind: "power", source: `hwmon@${host}`, id, watts: uw / MJ, at: now });
      }
      return { samples, status: (samples.length > 0 ? "ok" : "absent") as ProbeStatus };
    }),
  ];
}

// Prometheus / VictoriaMetrics instant queries.

export type PromQuery = { name: string; query: string };
export type PromTarget = {
  base_url: string;
  country?: string;
  queries: PromQuery[];
  auth_token_env?: string;
  timeout_ms?: number;
};

export function promProbe(
  fetchFn: (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>,
  target: PromTarget,
): Probe {
  const base = target.base_url.replace(/\/+$/, "");
  let hostPart = base;
  try {
    hostPart = new URL(base).host;
  } catch {
    // keep raw base as fallback
  }
  const source = `prom@${hostPart}`;
  const guard = new Guard();

  const headers: Record<string, string> = {};
  if (target.auth_token_env && process.env[target.auth_token_env]) {
    headers.Authorization = `Bearer ${process.env[target.auth_token_env]}`;
  }

  return {
    source,
    sample: async (now) => {
      const res = await guard.run(async () => {
        const samples: Sample[] = [];
        try {
          for (const q of target.queries) {
            const url = `${base}/api/v1/query?query=${encodeURIComponent(q.query)}`;
            const resp = await fetchFn(url, { headers });
            if (!resp.ok) {
              return { samples: [], status: "error" as ProbeStatus };
            }
            const body = await resp.json();
            const values = parsePromResponse(JSON.stringify(body));
            values.forEach((watts, i) => {
              samples.push({
                kind: "power",
                source,
                id: values.length === 1 ? q.name : `${q.name}:${i}`,
                watts,
                at: now,
              });
            });
          }
        } catch {
          return { samples: [], status: "unreachable" as ProbeStatus };
        }
        return { samples, status: "ok" };
      });
      return res;
    },
  };
}
