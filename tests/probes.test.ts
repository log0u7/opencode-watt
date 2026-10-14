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
  promValues,
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

describe("promValues()", () => {
  it("reads the values straight off the parsed body", () => {
    expect(promValues({ status: "success", data: { result: [{ value: [123, "12"] }] } })).toEqual([
      12,
    ]);
  });

  it("ignores non-finite values", () => {
    expect(
      promValues({ status: "success", data: { result: [{ value: [1, "NaN"] }, {}] } }),
    ).toEqual([]);
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

  it("retries a transient failure after backoff instead of disabling the probe", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls++;
      return calls <= 2
        ? ({ ok: false, code: "TIMEOUT" } as ExecResult)
        : ({ ok: true, stdout: "0, RTX, 50" } as ExecResult);
    };
    const probe = nvidiaSmiProbe(exec, "local", 1000);
    let res = await probe.sample(1);
    for (let t = 2; t <= 12; t++) res = await probe.sample(t);
    expect(res.status).toBe("ok");
    expect(res.samples).toHaveLength(1);
    expect(calls).toBe(3); // 2 failures, then the retry once the backoff window elapsed
  });

  it("reports absent when the command succeeds but yields no rows", async () => {
    const probe = nvidiaSmiProbe(okExec(""), "local", 1000);
    const res = await probe.sample(1);
    expect(res.status).toBe("absent");
    expect(res.samples).toEqual([]);
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

  it("reports absent when the command succeeds but yields no rows", async () => {
    const probe = rocmSmiProbe(okExec("{}"), "local", 1000);
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

  it("reads the zone metadata once and only the counter afterwards", async () => {
    const read = vi.fn(readFn);
    const probes = raplProbes(listFn, read as unknown as ReadFn, "local");
    await probes[0].sample(1); // subzone name + max + energy_uj
    expect(read).toHaveBeenCalledTimes(3);

    await probes[0].sample(2); // energy_uj only
    expect(read).toHaveBeenCalledTimes(4);
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
    expect(reads).toHaveBeenCalledTimes(3); // subzone name + max + the denied energy read
  });

  it("marks denied when the zone listing is denied", async () => {
    const probes = raplProbes(
      () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      readFn,
      "local",
    );
    expect(await probes[0].sample(1)).toEqual({ samples: [], status: "denied" });
  });

  it("reports absent when no top-level package zone exists", async () => {
    const probes = raplProbes(() => ["intel-rapl-mmio"], readFn, "local");
    expect(await probes[0].sample(1)).toEqual({ samples: [], status: "absent" });
  });

  it("skips zones whose counter is unreadable and stays ok", async () => {
    const weird: ReadFn = (p) => {
      if (p.endsWith("/energy_uj")) return "garbage\n";
      return readFn(p);
    };
    const probes = raplProbes(listFn, weird, "local");
    const res = await probes[0].sample(1);
    expect(res.status).toBe("absent"); // no sample could be built
    expect(res.samples).toEqual([]);
  });

  it("emits the dram subzone alongside the package zone", async () => {
    const files: Record<string, string> = {
      "/sys/class/powercap": "intel-rapl:0\nintel-rapl:0:0\nintel-rapl:0:2\n",
      "/sys/class/powercap/intel-rapl:0/name": "package-0\n",
      "/sys/class/powercap/intel-rapl:0/energy_uj": "1000000\n",
      "/sys/class/powercap/intel-rapl:0/max_energy_range_uj": "262143328850\n",
      "/sys/class/powercap/intel-rapl:0:0/name": "core\n",
      "/sys/class/powercap/intel-rapl:0:2/name": "dram\n",
      "/sys/class/powercap/intel-rapl:0:2/energy_uj": "250000\n",
      "/sys/class/powercap/intel-rapl:0:2/max_energy_range_uj": "3000000\n",
    };
    const read: ReadFn = (p) => {
      const c = files[p];
      if (c === undefined) throw new Error("missing");
      return c;
    };
    const list: ListFn = (p) => (files[p] ?? "").trim().split("\n").filter(Boolean);

    const probes = raplProbes(list, read, "local");
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
      {
        kind: "energy",
        source: "rapl@local",
        id: "intel-rapl:0:dram",
        joules: 0.25,
        wrap_max_j: 3,
        at: 1,
      },
    ]);
  });

  it("drops a subzone whose name cannot be read", async () => {
    const files: Record<string, string> = {
      "/sys/class/powercap": "intel-rapl:0\nintel-rapl:0:0\n",
      "/sys/class/powercap/intel-rapl:0/name": "package-0\n",
      "/sys/class/powercap/intel-rapl:0/energy_uj": "1000000\n",
      "/sys/class/powercap/intel-rapl:0/max_energy_range_uj": "262143328850\n",
    };
    const read: ReadFn = (p) => {
      const c = files[p];
      if (c === undefined) throw new Error("missing");
      return c;
    };
    const list: ListFn = (p) => (files[p] ?? "").trim().split("\n").filter(Boolean);

    const probes = raplProbes(list, read, "local");
    const res = await probes[0].sample(1);
    expect(res.samples.map((s) => s.id)).toEqual(["intel-rapl:0"]);
  });

  it("maps an unexpected counter error to status error", async () => {
    const flaky: ReadFn = (p) => {
      if (p.endsWith("/energy_uj")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return readFn(p);
    };
    const probes = raplProbes(listFn, flaky, "local");
    expect((await probes[0].sample(1)).status).toBe("error");
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

  it("resolves the present files once instead of probing missing ones every tick", async () => {
    const read = vi.fn(readFn);
    const probes = hwmonProbes(listFn, read as unknown as ReadFn, "local");
    await probes[0].sample(1); // 2 chips x 4 candidates, then the 2 present files
    expect(read).toHaveBeenCalledTimes(10);

    await probes[0].sample(2); // only the 2 present files
    expect(read).toHaveBeenCalledTimes(12);
  });

  it("re-resolves after the refresh window so hot-plugged meters appear", async () => {
    const read = vi.fn(readFn);
    const probes = hwmonProbes(listFn, read as unknown as ReadFn, "local");
    await probes[0].sample(1);
    expect(read).toHaveBeenCalledTimes(10);

    await probes[0].sample(61_001); // sweep again, then the present files
    expect(read.mock.calls.length).toBe(20);
  });

  it("reports absent when no chip exposes power", async () => {
    const empty: Record<string, string> = { "/sys/class/hwmon": "hwmon0\n" };
    const probes = hwmonProbes(
      (p) => (empty[p] ?? "").split("\n"),
      () => {
        throw new Error("missing");
      },
      "local",
    );
    expect((await probes[0].sample(1)).status).toBe("absent");
  });

  it("reports absent when the hwmon directory cannot be listed", async () => {
    const probes = hwmonProbes(
      () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      readFn,
      "local",
    );
    expect((await probes[0].sample(1)).status).toBe("absent");
  });

  it("retries the listing after a transient error instead of freezing absent", async () => {
    let listings = 0;
    const list: ListFn = (p) => {
      listings++;
      if (listings === 1) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return listFn(p);
    };
    const probes = hwmonProbes(list, readFn, "local");
    expect((await probes[0].sample(1)).status).toBe("absent");
    const res = await probes[0].sample(2);
    expect(res.status).toBe("ok");
    expect(res.samples.length).toBeGreaterThan(0);
  });

  it("ignores a sensor whose value is not a finite number", async () => {
    const weird: ReadFn = (p) => (p.endsWith("power1_average") ? "  N/A  \n" : readFn(p));
    const probes = hwmonProbes(listFn, weird, "local");
    const res = await probes[0].sample(1);
    expect(res.samples.some((s) => s.id === "hwmon0:power1_average")).toBe(false);
    expect(res.status).toBe("ok"); // hwmon1 still reports
  });

  it("ignores a negative microwatt reading", async () => {
    const weird: ReadFn = (p) => (p.endsWith("power1_input") ? "-5\n" : readFn(p));
    const probes = hwmonProbes(listFn, weird, "local");
    const res = await probes[0].sample(1);
    expect(res.samples.some((s) => s.id === "hwmon1:power1_input")).toBe(false);
    expect(res.status).toBe("ok"); // hwmon0 still reports
  });
});

describe("sshProbes()", () => {
  it("batches probes into one ssh call and splits sections", async () => {
    let calls = 0;
    const exec: ExecFn = async (_f, args) => {
      calls++;
      expect(args.includes("ricinus")).toBe(true);
      expect(args[args.length - 1]).toContain("===WATT-NVIDIA===");
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

  it("maps an ssh timeout to unreachable and an unknown code to error", async () => {
    const probes = sshProbes(errExec("TIMEOUT"), { host: "slow", timeout_ms: 100 });
    const res = await Promise.all(probes.map((p) => p.sample(1)));
    expect(res.every((r) => r.status === "unreachable")).toBe(true);

    const probes2 = sshProbes(errExec("WHATEVER"), { host: "weird", timeout_ms: 100 });
    const res2 = await Promise.all(probes2.map((p) => p.sample(1)));
    expect(res2.every((r) => r.status === "error")).toBe(true);
  });

  it("never blocks on a passphrase prompt and reuses one connection", async () => {
    const args: string[][] = [];
    const exec: ExecFn = async (_f, a) => {
      args.push(a);
      return { ok: true, stdout: "===WATT-NVIDIA===\n" } as ExecResult;
    };
    const probes = sshProbes(exec, { host: "ricinus", timeout_ms: 1000 });
    await Promise.all(probes.map((p) => p.sample(1)));
    await Promise.all(probes.map((p) => p.sample(2)));

    expect(args).toHaveLength(2);
    expect(args.every((a) => a[0] === "-n")).toBe(true);
    expect(args.every((a) => a.includes("BatchMode=yes"))).toBe(true);
    expect(args.every((a) => a.includes("ControlMaster=auto"))).toBe(true);
    expect(args.every((a) => a.includes("ControlPersist=60"))).toBe(true);
    const last = args[args.length - 1] as string[];
    expect(last.includes("ricinus")).toBe(true);
    expect(last[last.length - 1]).toContain("===WATT-NVIDIA===");
  });

  it("drops connection reuse when control_master is disabled", async () => {
    const args: string[][] = [];
    const exec: ExecFn = async (_f, a) => {
      args.push(a);
      return { ok: true, stdout: "" } as ExecResult;
    };
    const probes = sshProbes(exec, { host: "ricinus", timeout_ms: 1000, control_master: false });
    await Promise.all(probes.map((p) => p.sample(1)));

    expect(args).toHaveLength(1);
    expect(args[0].some((a) => a.includes("ControlMaster"))).toBe(false);
    expect(args[0].includes("BatchMode=yes")).toBe(true);
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

  it("reports absent when the query returns no series", async () => {
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", data: { result: [] } }),
      }) as never;
    const probe = promProbe(fetchFn, cfg);
    expect((await probe.sample(1)).status).toBe("absent");
  });
});
