import { describe, expect, it, vi } from "vitest";

import {
  type ExecFn,
  type ExecResult,
  hwmonProbes,
  nvidiaSmiProbe,
  parseNvidiaCsv,
  parsePromResponse,
  parseRocmJson,
  promProbe,
  type ReadFn,
  raplProbes,
  rocmSmiProbe,
  type ListFn,
  sshProbes,
} from "../src/probes.js";

const okExec =
  (stdout: string): ExecFn =>
  async () =>
    ({ ok: true, stdout }) as ExecResult;
const errExec =
  (code: string): ExecFn =>
  async () =>
    ({ ok: false, code }) as ExecResult;

describe("parseNvidiaCsv()", () => {
  it("parses index,name,watts rows", () => {
    const rows = parseNvidiaCsv("0, NVIDIA GeForce RTX 3090, 47.21\n1, TITAN, 120.00");
    expect(rows).toEqual([
      { gpu: "0", name: "NVIDIA GeForce RTX 3090", watts: 47.21 },
      { gpu: "1", name: "TITAN", watts: 120 },
    ]);
  });

  it("skips [N/A] and [Not Supported] and garbage", () => {
    const rows = parseNvidiaCsv("0, A, [N/A]\n1, B, [Not Supported]\n2, C, notanumber\n3, D, 5");
    expect(rows).toEqual([{ gpu: "3", name: "D", watts: 5 }]);
  });
});

describe("parseRocmJson()", () => {
  it("parses card Power fields", () => {
    const rows = parseRocmJson('{"card0": {"Power": "12.345 W"}, "card1": {"Power": "3.0 W"}}');
    expect(rows).toEqual([
      { gpu: "card0", watts: 12.345 },
      { gpu: "card1", watts: 3 },
    ]);
  });

  it("returns empty on garbage", () => {
    expect(parseRocmJson("not json")).toEqual([]);
    expect(parseRocmJson('{"card0": {"Power": "[N/A]"}}')).toEqual([]);
  });
});

describe("parsePromResponse()", () => {
  it("extracts instant vector values", () => {
    const rows = parsePromResponse(
      JSON.stringify({
        status: "success",
        data: { result: [{ metric: { gpu: "0" }, value: [123, "47.5"] }] },
      }),
    );
    expect(rows).toEqual([47.5]);
  });

  it("returns empty on non-success or malformed", () => {
    expect(parsePromResponse('{"status":"error"}')).toEqual([]);
    expect(parsePromResponse("nope")).toEqual([]);
  });
});

describe("nvidiaSmiProbe()", () => {
  it("returns power samples with source and gpu ids", async () => {
    const probe = nvidiaSmiProbe(okExec("0, RTX, 47.2\n1, RTX, 100"), "local", 1000);
    const res = await probe.sample(1000);
    expect(res.status).toBe("ok");
    expect(res.samples).toEqual([
      { kind: "power", source: "nvidia-smi@local", id: "gpu0", watts: 47.2, at: 1000 },
      { kind: "power", source: "nvidia-smi@local", id: "gpu1", watts: 100, at: 1000 },
    ]);
  });

  it("marks absent on ENOENT and stops calling the binary", async () => {
    const exec = vi.fn(errExec("ENOENT")) as unknown as ExecFn;
    const probe = nvidiaSmiProbe(exec, "local", 1000);
    await probe.sample(1);
    const res = await probe.sample(2);
    expect(res.status).toBe("absent");
    expect(res.samples).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("maps timeouts to unreachable and backs off", async () => {
    const exec = vi.fn(errExec("TIMEOUT")) as unknown as ExecFn;
    const probe = nvidiaSmiProbe(exec, "local", 1000);
    await probe.sample(1);
    await probe.sample(2);
    await probe.sample(3);
    expect(exec).toHaveBeenCalledTimes(2); // tick 3 within backoff window skipped
    expect((await probe.sample(3)).status).toBe("unreachable");
  });
});

describe("rocmSmiProbe()", () => {
  it("parses rocm json output", async () => {
    const probe = rocmSmiProbe(okExec('{"card0": {"Power": "12 W"}}'), "local", 1000);
    const res = await probe.sample(1);
    expect(res.samples).toEqual([
      { kind: "power", source: "rocm-smi@local", id: "card0", watts: 12, at: 1 },
    ]);
  });

  it("marks absent on ENOENT", async () => {
    const probe = rocmSmiProbe(errExec("ENOENT"), "local", 1000);
    expect((await probe.sample(1)).status).toBe("absent");
  });
});

describe("raplProbes()", () => {
  const zones = (name: string) => {
    const files: Record<string, string> = {
      "/sys/class/powercap": "intel-rapl:0\nintel-rapl:0:0\n",
      "/sys/class/powercap/intel-rapl:0/name": "package-0\n",
      "/sys/class/powercap/intel-rapl:0/energy_uj": "1000000\n",
      "/sys/class/powercap/intel-rapl:0/max_energy_range_uj": "262143328850\n",
    };
    return files[name];
  };
  const readFn: ReadFn = (p) => {
    const c = zones(p);
    if (c === undefined) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return c;
  };
  const listFn: ListFn = (p) => {
    const c = zones(p);
    if (c === undefined) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return c.trim().split("\n");
  };

  it("emits one energy sample per top-level package zone with wrap max", async () => {
    const probes = raplProbes(listFn, readFn, "local");
    expect(probes).toHaveLength(1);
    const res = await probes[0].sample(1);
    expect(res.status).toBe("ok");
    expect(res.samples).toEqual([
      {
        kind: "energy",
        source: "rapl@local",
        id: "intel-rapl:0",
        joules: 1,
        wrap_max_j: 262143.32885,
        at: 1,
      },
    ]);
  });

  it("marks denied on EACCES and stops reading", async () => {
    const denying: ReadFn = (p) => {
      if (p.endsWith("/energy_uj")) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return "package-0\n";
    };
    const reads = vi.fn(denying) as unknown as ReadFn;
    const probes = raplProbes(listFn, reads, "local");
    const first = await probes[0].sample(1);
    expect(first.status).toBe("denied");
    expect(first.samples).toEqual([]);
    const second = await probes[0].sample(2);
    expect(second.status).toBe("denied");
    expect(reads).toHaveBeenCalledTimes(2); // name + energy reads once, then dead
  });
});

describe("hwmonProbes()", () => {
  const files: Record<string, string> = {
    "/sys/class/hwmon": "hwmon0\nhwmon1\n",
    "/sys/class/hwmon/hwmon0/name": "amdgpu\n",
    "/sys/class/hwmon/hwmon0/power1_average": "25000000\n",
    "/sys/class/hwmon/hwmon1/name": "nvme\n",
    "/sys/class/hwmon/hwmon1/power1_input": "3000000\n",
    "/sys/class/hwmon/hwmon1/temp1_input": "40000\n",
  };
  const readFn: ReadFn = (p) => {
    const c = files[p];
    if (c === undefined) throw new Error("missing");
    return c;
  };
  const listFn: ListFn = (p) => (files[p] ?? "").trim().split("\n").filter(Boolean);

  it("emits microwatt power files as watts, skipping others", async () => {
    const probes = hwmonProbes(listFn, readFn, "local");
    expect(probes).toHaveLength(1);
    const all = (await Promise.all(probes.map((p) => p.sample(1)))).flatMap((r) => r.samples);
    expect(all).toContainEqual({
      kind: "power",
      source: "hwmon@local",
      id: "hwmon0:power1_average",
      watts: 25,
      at: 1,
    });
    expect(all).toContainEqual({
      kind: "power",
      source: "hwmon@local",
      id: "hwmon1:power1_input",
      watts: 3,
      at: 1,
    });
    expect(all.every((s) => s.kind === "power" && !s.id.includes("temp1"))).toBe(true);
  });
});

describe("sshProbes()", () => {
  it("batches probes into one ssh call and splits sections", async () => {
    let calls = 0;
    const exec: ExecFn = async (_f, args) => {
      calls++;
      expect(args[0]).toBe("ricinus");
      expect(args[1]).toContain("===WATT-NVIDIA===");
      return {
        ok: true,
        stdout:
          "===WATT-NVIDIA===\n0, RTX, 47\n===WATT-ROCM===\n===WATT-RAPL===\nZONE /sys/class/powercap/intel-rapl:0\nNAME package-0\nUJ 2000000\nMAX 262143328850\n===WATT-HWMON===\n",
      } as ExecResult;
    };
    const probes = sshProbes(exec, { host: "ricinus", timeout_ms: 1000 });
    const all = (await Promise.all(probes.map((p) => p.sample(1)))).flatMap((r) => r.samples);
    expect(calls).toBe(1);
    expect(all).toContainEqual({
      kind: "power",
      source: "nvidia-smi@ricinus",
      id: "gpu0",
      watts: 47,
      at: 1,
    });
    expect(all).toContainEqual({
      kind: "energy",
      source: "rapl@ricinus",
      id: "intel-rapl:0",
      joules: 2,
      wrap_max_j: 262143.32885,
      at: 1,
    });
  });

  it("maps connection failure to unreachable", async () => {
    const probes = sshProbes(errExec("EXIT"), { host: "down", timeout_ms: 100 });
    const res = await Promise.all(probes.map((p) => p.sample(1)));
    expect(res.every((r) => r.status === "unreachable" && r.samples.length === 0)).toBe(true);
  });
});

describe("promProbe()", () => {
  const cfg = {
    base_url: "http://vm:8428",
    queries: [{ name: "gpu0", query: 'DCGM_FI_DEV_GPU_POWER{gpu="0"}' }],
  };

  it("queries and parses instant vectors", async () => {
    let url = "";
    const fetchFn = async (u: string) => {
      url = u;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          data: { result: [{ metric: {}, value: [1, "47.5"] }] },
        }),
      };
    };
    const probe = promProbe(fetchFn, cfg);
    const res = await probe.sample(1);
    expect(url).toContain("/api/v1/query?query=");
    expect(res.status).toBe("ok");
    expect(res.samples).toEqual([
      { kind: "power", source: "prom@vm:8428", id: "gpu0", watts: 47.5, at: 1 },
    ]);
  });

  it("maps fetch failure to unreachable and non-200 to error", async () => {
    const down = promProbe(async () => {
      throw new Error("refused");
    }, cfg);
    expect((await down.sample(1)).status).toBe("unreachable");

    const bad = promProbe(
      async () => ({ ok: false, status: 503, json: async () => ({}) }) as never,
      cfg,
    );
    expect((await bad.sample(1)).status).toBe("error");
  });
});
