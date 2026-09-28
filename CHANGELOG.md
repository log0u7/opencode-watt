# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `power_cost` tool: watts per meter, kWh (raw + attributed), cost, active rate, probe statuses; scopes session/today/all.
- Power probes: nvidia-smi, rocm-smi, RAPL (`/sys/class/powercap` energy counters with wrap handling), hwmon `power*_input`/`power*_average`, SSH targets (one batched ssh call per tick), Prometheus/VictoriaMetrics instant queries.
- Idle baseline subtraction (rolling mean of idle rates per meter, floor at zero).
- Geolocation tariffs: built-in per-country retail table, timezone auto-detection, per-target `country` override, optional time-of-use windows (HP/HC) with midnight wrap.
- Session attribution: busy windows tracked from `session.status` events, equal split across concurrent sessions, per-session model from `chat.message`.
- TUI toast on `session.idle` when a session consumed more than 1 Wh.
- JSON state at `$XDG_DATA_HOME/opencode-watt/state.json` with atomic writes and 30-day session pruning.
