# Security Policy

## Reporting a vulnerability

Do not open a public issue for security problems.

Use GitHub private vulnerability reporting: repository page -> Security -> Report a vulnerability. Include reproduction steps, affected versions, and impact. You will get an acknowledgment within 72 hours.

## Scope

- The plugin runs locally with your user privileges. It shells out to local meter binaries (`nvidia-smi`, `rocm-smi`) and, when configured, `ssh` and Prometheus HTTP endpoints. Report anything that lets a configuration value execute code, inject extra arguments into a subprocess, or read files beyond the intended meter paths.
- The state file holds only energy and cost counters; report anything that leaks a credential (for example a Prometheus `auth_token_env` value) into it or into logs.

## Hardening notes

- No credential is stored. Prometheus auth is read from an environment variable named by config and sent only as a request header.
- Data path: `~/.local/share/opencode-watt/state.json` (honors `XDG_DATA_HOME`), written atomically (temp file + rename).
