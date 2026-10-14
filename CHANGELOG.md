# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- DRAM energy via the RAPL `dram` subzone (`intel-rapl:*:dram`), reported as a
  separate meter: on long contexts the KV cache moves most of the energy.
- `meters` option: allowlist of source prefixes, to keep a single GPU meter on
  hosts where two meters report the same device (AMD: `rocm-smi` + amdgpu
  hwmon).
- `power_cost` accepts `format: "json"` returning the report as structured data
  (meters, rate, baseline, session/day/totals, probe statuses, budget); the
  default stays human-readable text.
- `daily_budget_kwh` option: a TUI toast warns once per day when attributed
  energy crosses the configured threshold.
- `wall_factor` option (default 1, clamped to [1, 2]): prices the wall draw on
  top of measured energy (PSU losses and friends); the kWh stays measured, only
  the money is scaled.
- README documents the single-writer assumption for `state.json` (one OpenCode
  instance per machine).
- Biome configuration migrated to the 2.5.x schema (silences a warning on
  every CI run).

### Changed

- Idle baseline is now the median of the idle-rate window instead of the mean:
  one idle tick polluted by another process (compile, app launch) no longer
  inflates the baseline and under-states the session cost.

## [0.1.1] - 2026-10-14

### Fixed

- A single failing meter no longer discards the whole sampling tick: a probe that
  throws now reports `error` for that tick while the other meters keep accruing
  energy (the previous `Promise.all` dropped every reading of the tick).
- Deleted sessions are removed from the busy set (`session.deleted`), so an
  abandoned session can no longer absorb energy or dilute the split across the
  sessions that are still running.
- Sampling spans are measured between the readings themselves, not between tick
  starts: a slow `nvidia-smi` spawn no longer shrinks the integrated interval.
- The idle baseline is seeded by the first derivable rate, so a session that
  starts while the host is already busy is no longer charged the whole machine
  until the first idle tick.

### Changed

- sysfs reads are non-blocking (`node:fs/promises`) instead of `readFileSync` on
  the OpenCode server event loop.
- RAPL zone names and wrap limits are resolved once, and the hwmon directory is
  resolved until its power files are known (then re-checked every 60 s): a host
  with 11 hwmon chips and no power sensor goes from 44 failed reads per tick to
  none.
- SSH probes pass `-n -o BatchMode=yes` (a passphrase prompt can no longer block
  a tick for the whole timeout) and reuse one connection via `ControlMaster`;
  `ssh_control` (default `true`) disables the reuse, per target via
  `control_master: false`.
- Sampling backs off exponentially up to 60 s while no meter reports `ok`, so a
  machine with no readable meter stops paying for probes that return nothing.
- Meter formats now have a single implementation shared by the local and the SSH
  probes (`nvidiaSamples`, `rocmSamples`, `raplSamples`, `hwmonSamples`,
  `promValues`); the Prometheus parser reads the response body directly instead
  of re-serialising it.
- `power_cost` reports the idle baseline warm-up (`baseline: 3/30 samples`).

## [0.1.0] - 2026-10-12

### Added

- Dual-export plugin entry for OpenCode 2: one published package runs on both
  OpenCode 1.18 and 2.x (official migration pattern, "Support V1 and V2 from
  one package"). v1 hosts call `server()` (unchanged); v2 hosts call `setup()`
  (`Plugin.define`). Both entries drive the same engine.

## [0.0.0] - 2026-09-29

### Added

- `power_cost` tool: watts per meter, kWh (raw + attributed), cost, active rate, probe statuses; scopes session/today/all.
- Power probes: nvidia-smi, rocm-smi, RAPL (`/sys/class/powercap` energy counters with wrap handling), hwmon `power*_input`/`power*_average`, SSH targets (one batched ssh call per tick), Prometheus/VictoriaMetrics instant queries.
- Idle baseline subtraction (rolling mean of idle rates per meter, floor at zero).
- Geolocation tariffs: built-in per-country retail table, timezone auto-detection, per-target `country` override, optional time-of-use windows (HP/HC) with midnight wrap.
- Session attribution: busy windows tracked from `session.status` events, equal split across concurrent sessions, per-session model from `chat.message`.
- TUI toast on `session.idle` when a session consumed more than 1 Wh.
- JSON state at `$XDG_DATA_HOME/opencode-watt/state.json` with atomic writes and 30-day session pruning.
