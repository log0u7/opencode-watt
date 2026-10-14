# opencode-watt

[![CI](https://github.com/log0u7/opencode-watt/actions/workflows/ci.yml/badge.svg)](https://github.com/log0u7/opencode-watt/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log0u7/opencode-watt)](https://www.npmjs.com/package/@log0u7/opencode-watt)
[![Node.js](https://img.shields.io/node/v/@log0u7/opencode-watt?logo=node.js&logoColor=white)](https://www.npmjs.com/package/@log0u7/opencode-watt)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/log0u7/opencode-watt/dev/typescript?logo=typescript&logoColor=white)](https://github.com/log0u7/opencode-watt/blob/main/package.json)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Electric power and cost of **local LLM inference** for [OpenCode](https://opencode.ai).

The plugin samples power meters on the machines doing inference, integrates energy
while sessions are busy, subtracts the measured idle baseline, and prices the
result with a configurable electricity tariff.

No LLM gateway (llama.cpp, Ollama, vLLM) exposes power through its API; the only
reliable sources are host-level meters. This plugin reads them directly:

| Source | What | Where |
| --- | --- | --- |
| `nvidia-smi` | per-GPU watts | local or SSH |
| `rocm-smi` | AMD GPU watts | local or SSH |
| RAPL (`/sys/class/powercap`) | CPU package energy counters | local or SSH |
| hwmon (`/sys/class/hwmon`) | generic `power*_input`/`power*_average` (amdgpu, nvme, ...) | local or SSH |
| Prometheus / VictoriaMetrics | instant-vector queries (e.g. `DCGM_FI_DEV_GPU_POWER`) | HTTP |

Meters degrade gracefully: absent binaries report `absent`, root-only RAPL
reports `denied`, unreachable SSH hosts back off and retry. NPU power has no
standard Linux interface and is out of scope.

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@log0u7/opencode-watt"]
}
```

Or from a local checkout: point the plugin entry at `dist/index.js` after `pnpm build`.

## Configure

All options are optional; pass them in the plugin tuple:

```jsonc
{
  "plugin": [
    ["@log0u7/opencode-watt", {
      "interval_ms": 1000,          // sampling period while a session is busy
      "idle_interval_ms": 10000,    // sampling period while idle (baseline)
      "tail_ms": 5000,              // keep busy-rate sampling briefly after idle
      "subtract_idle": true,        // subtract measured idle baseline
      "country": null,              // null: auto-detect from timezone; fallback FR
      "price_per_kwh": null,        // null: built-in per-country table
      "currency": null,             // null: table currency
      "windows": [                  // optional time-of-use rates (HP/HC)
        { "start": "22:00", "end": "06:00", "price_per_kwh": 0.1696 }
      ],
      "ssh": [
        { "host": "inference-box", "country": "FR", "timeout_ms": 3000 }
      ],
      "prom": [
        {
          "base_url": "http://inference-box:8428",
          "country": "DE",
          "queries": [{ "name": "gpu0", "query": "DCGM_FI_DEV_GPU_POWER{gpu=\"0\"}" }],
          "auth_token_env": "PROM_TOKEN"
        }
      ],
      "meters": null,
      "wall_factor": 1,
      "daily_budget_kwh": null
    ]
  }
}
```

`ssh_control` (default `true`) reuses one SSH connection across ticks
(`ControlMaster`) instead of paying a handshake per sample. Set it to `false` to
disable connection reuse for a given run (or per target with
`"control_master": false`).

Each target becomes a meter source named after its host (`prom@host[:port][/path]`,
`nvidia-smi@host`, ...). Use distinct hosts for `ssh` targets: two entries with
the same host collide on the same source and are counted as one meter. `prom`
targets on the same host stay distinct as long as their paths or ports differ
(`http://vm:8428/prom` and `http://vm:8428/vm` are two meters).

`meters` is an optional allowlist of source prefixes (`"meters": ["nvidia-smi"]`
keeps nvidia-smi on every target, local and remote, and drops rocm-smi, RAPL and
hwmon). Use it when two meters report the same device: on an AMD host,
`rocm-smi` and the amdgpu hwmon entry both expose the GPU and would double-count
it (`"meters": ["rocm-smi"]` keeps one). Default `null`: every available meter.

`daily_budget_kwh` triggers a TUI toast once per day as soon as attributed
energy for the day crosses the threshold. Default `null`: no budget.

`wall_factor` prices the wall draw on top of measured energy (PSU losses and
friends), clamped to [1, 2]: the kWh stays measured, only the money scales.
Default `1`: price the kWh as measured.

`power_cost` takes a `format` argument: `text` (default) or `json` (the same
report as structured data: meters, rate, currencies, baseline,
session/day/totals, probe statuses, budget).

Pricing precedence per meter: explicit `price_per_kwh` > `windows` match at
sample time > built-in `TARIFFS[country]` (approximate retail averages, early
2026) > FR fallback. Remote targets can declare their own `country`: energy is
priced where the hardware consumes it. Cost is accumulated per tick at the
resolved rate, so sessions spanning HP/HC windows sum correctly. When targets
declare different countries the day/all totals add costs in different
currencies; the report lists them (`currencies: EUR, USD (totals mix
currencies)`) and the per-source figures give the exact currency, but the
totals themselves are not converted.

## Use

- **`power_cost` tool**: ask the model, or call it directly. Args: `scope` =
  `session` (default) | `today` | `all`, `format` = `text` (default) | `json`.
  Shows watts per meter, kWh (raw and attributed), cost, active rate, baseline
  warm-up, daily budget, and probe statuses.
- **Toast**: when a session ends having consumed more than 1 Wh, a TUI toast
  shows the session's kWh and cost.
- **State**: `$XDG_DATA_HOME/opencode-watt/state.json` (default
  `~/.local/share/opencode-watt/state.json`), atomic writes, sessions pruned
  after 30 days.

Attribution is per busy session: when several sessions generate concurrently
the device power is split equally between them. Energy attributed to no session
(idle, tail) is still counted in the daily totals.

### What the number covers

`nvidia-smi`/`rocm-smi` report GPU board power, RAPL reports CPU package energy
plus the DRAM subzone when the host exposes it (`intel-rapl:*:dram`), which is
where most of an LLM inference moves (KV cache, weights). PSU losses (roughly
10% at the wall), fans and the board itself are **not** covered, so the reported
kWh is a lower bound of the machine's wall draw, not a meter reading.

When two meters report the same device (AMD host: `rocm-smi` and the amdgpu
hwmon entry), use the `meters` allowlist to keep one.

The idle baseline is the median of the idle-rate samples seen so far, robust to
one idle tick polluted by another process. While the window is still filling,
`power_cost` reports it (`baseline: 3/30 samples`): the first reading seeds it,
so a session started while the host was already busy is not charged the whole
machine.

Sampling backs off exponentially (up to 60 s) while no meter reports `ok`, so a
machine without any readable meter costs almost nothing to watch.

The state file assumes a single writer per machine: run one OpenCode instance
per host (its `state.json` path follows `XDG_DATA_HOME`, so different machines
are separate by construction). Two instances on the same host would both sample
the same meters and overwrite each other's totals.

## Development

```sh
pnpm install
pnpm verify   # biome + typecheck + vitest
pnpm build    # tsc -> dist/
```

Node 22 via mise, pnpm 11.

## Non-goals (v1)

- NPU power (no standard Linux interface)
- Windows/macOS probes
- Fetching electricity prices from the network (spot APIs are a possible v2)
- Per-process power attribution
- Carbon intensity
