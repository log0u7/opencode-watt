# Security Policy

## Reporting a vulnerability

Do not open a public issue for security problems.

Use GitHub private vulnerability reporting: repository page -> Security -> Report a vulnerability. Include reproduction steps, affected versions, and impact. You will get an acknowledgment within 72 hours.

## Scope

- The plugin runs locally with your user privileges. Report anything that lets memory entries escape the local store, execute code, or read files beyond intended scope.
- The store intentionally contains model-written text. Treat untrusted-content handling (injection from saved entries into future sessions) as in scope.

## Hardening notes

- The store refuses entries that look like common API-key formats, but this is best-effort: do not save credentials through the model.
- Data path: `~/.local/share/opencode-watt/memory.db` (honors `XDG_DATA_HOME`), created with restrictive permissions (umask 077).
