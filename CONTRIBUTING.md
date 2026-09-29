# Contributing to opencode-watt

Thanks for contributing. This document covers the workflow, quality bar, and conventions.

## Workflow (trunk-based)

- `main` is the only branch: protected (PRs required, no force pushes), always deployable, tagged `vX.Y.Z` for releases.
- Branch from `main`, name it `feat/...`, `fix/...`, or `docs/...` (max three words, hyphenated), open a PR back into `main`.
- Keep branches short-lived: merge or drop within days, rebase onto `main` when needed.
- Merge style: the maintainer merges with `--no-ff` (personal preference while the project is single-maintainer; revisit squash or fast-forward when outside contributors arrive).
- Releases: date-stamp the changelog, bump `package.json`, commit `chore(release): X.Y.Z`, tag `vX.Y.Z` and push: the publish workflow publishes to npm via trusted publishing.
- Hotfixes are just fixes: branch from `main`, PR, merge, tag a patch release.

## Reviews

- The maintainer reviews every PR. For dependency PRs, see the Dependabot section below.

## Dependency PRs (Dependabot)

Dependabot prepares, humans decide. It opens grouped PRs weekly (7-day supply-chain cooldown): minors/patches, vitest coupled with `@vitest/*`, and GitHub Actions bumps. It rebases on `@dependabot rebase` and closes superseded PRs. It never merges.

A dependency PR merges only when:

- CI is green (quality matrix + coverage gate, gitleaks on push).
- No breaking change to our usage. For majors: coupled deps arrive together (vitest with `@vitest/coverage-v8`), and upstream breaking changes are checked against our hooks and tools.
- `@types/node` never exceeds the max Node version actually tested in CI (currently 24).
- Security patches are always accepted.

Merge flow: review the diff, then `gh pr review --approve` and `gh pr merge --merge`. The branch ruleset requires maintainer approval for bot-authored PRs. Workflow-file bumps can't merge through the gh token (`workflow` scope): either run `gh auth refresh -s workflow` once (interactive), or locally merge with `--no-ff` and push inside a brief ruleset window (disable ruleset, push, re-enable).

## Tests are mandatory

Every behavior change ships with tests, written test-first (red-green-refactor):

1. Write the failing test that demands the change (red).
2. Implement the minimal code that makes it pass (green).
3. Refactor with tests green.

CI enforces a coverage gate (90% lines/functions, 80% branches) via `pnpm verify`; a PR without tests or below the threshold fails. Unit tests use real filesystem (temp dirs) and real SQLite: no mocks. Mocks are allowed only at true network/tool boundaries (mDNS, external CLIs).

```sh
pnpm test:coverage   # full suite with coverage report
pnpm verify          # biome + typecheck + tests (coverage gate)
pnpm build:check     # tsc build + pack dry-run
```

## Commits

Conventional Commits: `type(scope): summary`. Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Optional scopes: `store`, `tools`, `hooks`, `ci`.

## Conventions

- TypeScript strict; no `any`, no non-null assertions, no enums (use const objects), no star or aliased imports.
- Prefer functional array methods over loops; early returns over `else`.
- Secrets never appear in code, tests, fixtures, logs, or the memory store.
- Every PR updates `CHANGELOG.md` under `[Unreleased]` (Keep a Changelog format).

## Release process (maintainer)

1. Confirm CI green on `main` and changelog accurate.
2. Move `[Unreleased]` to a dated `## [X.Y.Z] - YYYY-MM-DD` section; bump `package.json` version; commit `chore(release): X.Y.Z`.
3. `git tag vX.Y.Z && git push origin main --tags`: the publish workflow publishes to npm via trusted publishing.

## Security

Never open public issues for vulnerabilities: see [SECURITY.md](SECURITY.md).
