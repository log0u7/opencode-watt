import { execFile as nodeExecFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export type ExecResult = { ok: true; stdout: string } | { ok: false; code: string };
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
export type ReadFn = (path: string) => string | Promise<string>;
export type ListFn = (path: string) => string[] | Promise<string[]>;

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

// Default node implementations (injectable for tests). Async on purpose: the
// sampling loop runs inside the OpenCode server event loop.
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

export const nodeRead: ReadFn = async (path) => await readFile(path, "utf8");
export const nodeList: ListFn = async (path) => await readdir(path);

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
      // Count the skipped tick too: otherwise `failures` freezes just past the
      // retry threshold and the "every 10 ticks" branch is never reached.
      this.failures++;
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

function statusFromFsError(error: unknown): ProbeStatus {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return "denied";
  if (code === "ENOENT") return "absent";
  return "error";
}

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

export function promValues(body: unknown): number[] {
  const parsed = body as {
    status?: string;
    data?: { result?: { value?: [number, string] }[] };
  };
  if (parsed?.status !== "success") return [];
  const out: number[] = [];
  for (const r of parsed.data?.result ?? []) {
    const raw = r?.value?.[1];
    const v = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function parsePromResponse(body: string): number[] {
  try {
    return promValues(JSON.parse(body));
  } catch {
    return [];
  }
}

export type RaplZone = {
  path: string;
  id?: string;
  name: string | null;
  uj: number | null;
  max_uj: number | null;
};

export function parseRaplText(text: string): RaplZone[] {
  const zones: RaplZone[] = [];
  let current: RaplZone | null = null;
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

// hwmon lines as printed by the remote script: "P <chip>:<file> <microwatts>"
export function parseHwmonLines(text: string): { id: string; microwatts: number }[] {
  const out: { id: string; microwatts: number }[] = [];
  for (const line of text.split("\n")) {
    const [key, id, value] = line.trim().split(/\s+/);
    if (key !== "P" || !id) continue;
    const uw = Number(value);
    if (!Number.isFinite(uw) || uw < 0) continue;
    out.push({ id, microwatts: uw });
  }
  return out;
}

// Sample builders: one implementation per meter format, shared by the local
// probes and by the SSH section probes, so a format bug is fixed in one place.
export function nvidiaSamples(
  source: string,
  rows: { gpu: string; watts: number }[],
  at: number,
): Sample[] {
  return rows.map((r) => ({ kind: "power", source, id: `gpu${r.gpu}`, watts: r.watts, at }));
}

export function rocmSamples(
  source: string,
  rows: { gpu: string; watts: number }[],
  at: number,
): Sample[] {
  return rows.map((r) => ({ kind: "power", source, id: r.gpu, watts: r.watts, at }));
}

export function raplSamples(source: string, zones: RaplZone[], at: number): Sample[] {
  const samples: Sample[] = [];
  for (const z of zones) {
    if (z.uj === null) continue;
    const wrapMax = z.max_uj !== null && z.max_uj > 0 ? z.max_uj / MJ : undefined;
    samples.push({
      kind: "energy",
      source,
      id: z.id ?? z.path.split("/").pop() ?? z.path,
      joules: z.uj / MJ,
      ...(wrapMax !== undefined ? { wrap_max_j: wrapMax } : {}),
      at,
    });
  }
  return samples;
}

export function hwmonSamples(
  source: string,
  readings: { id: string; microwatts: number }[],
  at: number,
): Sample[] {
  return readings.map((r) => ({ kind: "power", source, id: r.id, watts: r.microwatts / MJ, at }));
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
    sample: async (now: number) => await guard.run(() => run(now)),
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
    const samples = nvidiaSamples(source, parseNvidiaCsv(res.stdout), now);
    return { samples, status: samples.length > 0 ? "ok" : "absent" };
  });
}

export function rocmSmiProbe(exec: ExecFn, target: string, timeoutMs: number): Probe {
  const source = `rocm-smi@${target}`;
  return guardedProbe(source, async (now) => {
    const res = await exec("rocm-smi", ["--showpower", "--json"], timeoutMs);
    if (!res.ok) return { samples: [], status: statusFromExec(res.code) };
    const samples = rocmSamples(source, parseRocmJson(res.stdout), now);
    return { samples, status: samples.length > 0 ? "ok" : "absent" };
  });
}

// Zone names and wrap limits never change, so they are resolved once on the
// first sighting; only the counter is read per tick.
export function raplProbes(list: ListFn, read: ReadFn, target: string): Probe[] {
  const source = `rapl@${target}`;
  const base = "/sys/class/powercap";
  const guard = new Guard(); // transient failures retry; absent/denied stay permanent
  type Zone = { path: string; id: string; max_uj: number | null };
  let zones: Zone[] | null = null;

  // Resolves once: the zone list and the wrap limits are constant, only the
  // counters move. Subzones are kept only for the dram domain: core/uncore
  // are already inside the package zone.
  const resolve = async (): Promise<{ status: ProbeStatus; zones?: Zone[] }> => {
    try {
      const zonesFound: Zone[] = [];
      const entries = await list(base);
      for (const entry of entries.filter((n) => /^intel-rapl:\d+(:\d+)?$/.test(n))) {
        const subzone = /:\d+$/.test(entry) && entry.split(":").length === 3;
        let id = entry;
        if (subzone) {
          let domain: string | null = null;
          try {
            domain = (await read(`${base}/${entry}/name`)).trim() || null;
          } catch {
            domain = null;
          }
          if (domain !== "dram") continue;
          id = `${entry.replace(/:\d+$/, "")}:dram`;
        }
        let maxUj: number | null = null;
        try {
          const max = Number((await read(`${base}/${entry}/max_energy_range_uj`)).trim());
          if (Number.isFinite(max)) maxUj = max;
        } catch {
          // optional
        }
        zonesFound.push({ path: `${base}/${entry}`, id, max_uj: maxUj });
      }
      return { status: zonesFound.length > 0 ? "ok" : "absent", zones: zonesFound };
    } catch (error) {
      return { status: statusFromFsError(error) };
    }
  };

  return [
    {
      source,
      sample: async (now) => {
        const res = await guard.run(async () => {
          if (zones === null) {
            const resolved = await resolve();
            if (resolved.status !== "ok" || !resolved.zones) {
              return { samples: [], status: resolved.status };
            }
            zones = resolved.zones;
          }
          const readings: RaplZone[] = [];
          for (const zone of zones) {
            try {
              const uj = Number((await read(`${zone.path}/energy_uj`)).trim());
              if (!Number.isFinite(uj)) continue;
              readings.push({
                path: zone.path,
                id: zone.id,
                name: null,
                uj,
                max_uj: zone.max_uj,
              });
            } catch (error) {
              return { samples: [], status: statusFromFsError(error) };
            }
          }
          const samples = raplSamples(source, readings, now);
          return { samples, status: samples.length > 0 ? "ok" : "absent" };
        });
        return res;
      },
    },
  ];
}

const HWMON_CANDIDATES = ["power1_input", "power1_average", "power2_input", "power2_average"];
const HWMON_REFRESH_MS = 60_000;

// sysfs is scanned only until the power files are known, then re-checked every
// HWMON_REFRESH_MS: a missing file must not be re-opened on every tick.
export function hwmonProbes(list: ListFn, read: ReadFn, target: string): Probe[] {
  const source = `hwmon@${target}`;
  const base = "/sys/class/hwmon";
  let chips: string[] | null = null;
  let paths: { id: string; path: string }[] | null = null;
  let resolvedAt = -Infinity;

  const readNumber = async (path: string): Promise<number | null> => {
    try {
      const value = Number((await read(path)).trim());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  return [
    {
      source,
      sample: async (now) => {
        if (chips === null) {
          try {
            const found = (await list(base)).filter((n) => /^hwmon\d+$/.test(n));
            if (found.length > 0) {
              chips = found;
              paths = null;
            }
          } catch {
            // transient listing error: stay unresolved and retry on the next tick
          }
          if (chips === null) return { samples: [], status: "absent" };
        }

        if (paths === null || now - resolvedAt > HWMON_REFRESH_MS) {
          const found: { id: string; path: string }[] = [];
          for (const chip of chips) {
            for (const file of HWMON_CANDIDATES) {
              const path = `${base}/${chip}/${file}`;
              if ((await readNumber(path)) !== null) found.push({ id: `${chip}:${file}`, path });
            }
          }
          paths = found;
          resolvedAt = now;
        }

        const readings: { id: string; microwatts: number }[] = [];
        for (const p of paths) {
          const uw = await readNumber(p.path);
          if (uw !== null && uw >= 0) readings.push({ id: p.id, microwatts: uw });
        }
        const samples = hwmonSamples(source, readings, now);
        return { samples, status: samples.length > 0 ? "ok" : "absent" };
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

// %C is expanded by ssh into a short hash of (local host, remote host, port,
// user), so one socket per target without clashing across hosts.
const SSH_CONTROL_PATH = `${tmpdir()}/opencode-watt-%C`;

function section(stdout: string, sep: string, next: string): string {
  const start = stdout.indexOf(sep);
  if (start === -1) return "";
  const from = start + sep.length;
  const end = next === "" ? stdout.length : stdout.indexOf(next, from);
  const slice = end === -1 ? stdout.slice(from) : stdout.slice(from, end);
  return slice.replace(/^\n/, "").replace(/\n$/, "");
}

export type SshTarget = {
  host: string;
  country?: string;
  timeout_ms?: number;
  control_master?: boolean;
};

export function sshProbes(exec: ExecFn, target: SshTarget): Probe[] {
  const host = target.host;
  const timeout = target.timeout_ms ?? 3000;
  const script = [
    `echo ${SEP_NVIDIA}; nvidia-smi --query-gpu=index,name,power.draw --format=csv,noheader,nounits 2>/dev/null`,
    `echo ${SEP_ROCM}; rocm-smi --showpower --json 2>/dev/null`,
    `echo ${SEP_RAPL}; ${RAPL_SCRIPT} 2>/dev/null`,
    `echo ${SEP_HWMON}; ${HWMON_SCRIPT} 2>/dev/null`,
  ].join("; ");

  // -n keeps stdin closed, BatchMode refuses to ask for a passphrase (a prompt
  // would otherwise block the whole tick), ControlMaster reuses one connection
  // across ticks instead of paying a handshake per sample.
  const args = ["-n", "-o", "BatchMode=yes"];
  if (target.control_master !== false) {
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${SSH_CONTROL_PATH}`,
      "-o",
      "ControlPersist=60",
    );
  }
  args.push(host, script);

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
        const res = await exec("ssh", args, timeout);
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
      const rows = parseNvidiaCsv(section(stdout, SEP_NVIDIA, SEP_ROCM));
      const samples = nvidiaSamples(`nvidia-smi@${host}`, rows, now);
      return { samples, status: samples.length > 0 ? "ok" : "absent" };
    }),
    make(`rocm-smi@${host}`, (stdout, now) => {
      const rows = parseRocmJson(section(stdout, SEP_ROCM, SEP_RAPL));
      const samples = rocmSamples(`rocm-smi@${host}`, rows, now);
      return { samples, status: samples.length > 0 ? "ok" : "absent" };
    }),
    make(`rapl@${host}`, (stdout, now) => {
      const zones = parseRaplText(section(stdout, SEP_RAPL, SEP_HWMON));
      if (zones.length === 0) return { samples: [], status: "absent" };
      const samples = raplSamples(`rapl@${host}`, zones, now);
      return { samples, status: samples.length > 0 ? "ok" : "denied" };
    }),
    make(`hwmon@${host}`, (stdout, now) => {
      const samples = hwmonSamples(
        `hwmon@${host}`,
        parseHwmonLines(section(stdout, SEP_HWMON, "")),
        now,
      );
      return { samples, status: samples.length > 0 ? "ok" : "absent" };
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
            const values = promValues(await resp.json());
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
        return { samples, status: samples.length > 0 ? "ok" : "absent" };
      });
      return res;
    },
  };
}
