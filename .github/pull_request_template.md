## Summary

Describe the change and why it is needed.

## Tests (mandatory)

State the red-green flow: which test did you write first that failed, and what made it pass? Link the test file.

## Coverage

CI enforces the coverage gate (90% lines/functions). Confirm `pnpm verify` passes locally with the gate.

## Linked Issue

Use `Fixes #...` or `Refs #...` when available.  
If no issue exists, include a short rationale/scope summary.

## OpenCode Validation

- Current production released OpenCode version tested:
- Why this version is relevant to the fix:

## Quality Checklist

- [ ] I wrote the failing test first (red), then made it pass (green)
- [ ] I ran `pnpm run typecheck`
- [ ] I ran `pnpm run build`
- [ ] I ran `pnpm test` (coverage gate passes)
- [ ] I updated `CHANGELOG.md` under `[Unreleased]`
- [ ] This change is focused and avoids unrelated behavior changes
- [ ] I updated docs when user-facing workflow, tool, or config behavior changed
