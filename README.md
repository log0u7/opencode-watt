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
      ]
    }]
  ]
}
```

Pricing precedence per meter: explicit `price_per_kwh` > `windows` match at
sample time > built-in `TARIFFS[country]` (approximate retail averages, early
2026) > FR fallback. Remote targets can declare their own `country`: energy is
priced where the hardware consumes it. Cost is accumulated per tick at the
resolved rate, so sessions spanning HP/HC windows sum correctly.

## Use

- **`power_cost` tool**: ask the model, or call it directly. Args: `scope` =
  `session` (default) | `today` | `all`. Shows watts per meter, kWh (raw and
  attributed), cost, active rate, and probe statuses.
- **Toast**: when a session ends having consumed more than 1 Wh, a TUI toast
  shows the session's kWh and cost.
- **State**: `$XDG_DATA_HOME/opencode-watt/state.json` (default
  `~/.local/share/opencode-watt/state.json`), atomic writes, sessions pruned
  after 30 days.

Attribution is per busy session: when several sessions generate concurrently
the device power is split equally between them. Energy attributed to no session
(idle, tail) is still counted in the daily totals.

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
