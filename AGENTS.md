# Repository Guidelines

## Project Overview

`pi-reversa` is a Pi Coding Agent package that integrates the [Reversa](https://www.npmjs.com/package/reversa) reverse-engineering framework: native `/reversa-*` skill aliases, `/reversa-auto` unattended launcher, and a blocking `reversa_orchestrate` tool that runs whole pipelines in isolated child sessions.

- Stack: Node.js ESM (`"type": "module"`), plain JS + JSDoc (no TypeScript).
- Shape: thin extension package — not the Reversa skill source of truth.
- Dependency: `reversa@1.2.56` (skills live under `node_modules/reversa/agents/`).
- Peer: `@earendil-works/pi-coding-agent` (Pi SDK; version `*`).
- Package manager: npm only (`package-lock.json` lockfileVersion 3). No yarn/pnpm/bun lockfiles.

## Architecture and Key Paths

| Path | Role |
| --- | --- |
| `extensions/reversa.js` | Extension entry: registers `reversa_orchestrate`, `/reversa-auto`, and skill aliases on `session_start` |
| `extensions/lib/` | Pipeline engine, isolation, sandbox, state, interview, skill-block helpers |
| `scripts/prepare-skills.js` | Copies `node_modules/reversa/agents/` → `packaged-skills/` (dereference) |
| `packaged-skills/` | **Generated, gitignored.** What `package.json` `pi.skills` points at and what ships |
| `skills/` | Dev symlink → `../reversa/agents` (sibling checkout). Not the published skill tree |
| `test/` | Node native tests for extension, isolation contract, orchestrator/sandbox |
| `.agents/skills/` | Maintainer TUI skills (`tui-design`, `tui-refactor`, `tui-validator`); not part of the npm package |

**Tools (only these two are package-owned):**

- `reversa_orchestrate` — sequential, blocking; pipelines `discovery` \| `migrate` \| `docs` only.
- `reversa_git` — per-child read-only git; no shell. Allowed subcommands are policy-gated in `extensions/lib/guarded-tools.js`.

**Automatable pipelines** (see `extensions/lib/pipelines.js`): `discovery`, `migrate`, `docs`. Destructive pipelines (`forward`, `new`) are intentionally excluded — they end in coding that writes real project source.

**Child isolation (non-negotiable):** each stage runs with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, in-memory session. Tools: `read`, `grep`, `find`, `ls`, `edit`, `write`, `reversa_git`. No `bash`. No host subagent machinery (`pi-subagents` is not a dependency; `test/isolation.test.js` forbids those strings in `extensions/`).

**Sandbox write roots:** `.reversa/` plus the active workflow folder under `.specs/` (defaults: `.specs/discovery`, `.specs/migration`, `.specs/docs`, `.specs/forward`, `.specs/new`, `.specs/bugs`, `.specs/refactor`). Regression-check may also edit existing `.specs/forward/*/regression-watch.md` files. Dual gate: lexical containment + canonical symlink check. Sandbox violations stop the pipeline.

**Runtime control paths (created in the target project, not this repo):**

- `.reversa/state.json` — phase, completed stages, interview answers, schema v3 `folders` map / `output_folder` projection
- `.reversa/config.toml` — `[specs]` granularity / custom folders
- `.reversa/context/surface.json` — Scout modules
- `.reversa/runs/<runId>/` — raw output for each stage run

## Development Workflow

```bash
npm install                          # Node >= 22.19.0 (engines.node)
npm run prepare-skills               # regenerate packaged-skills/ from reversa
npm test                             # prepare-skills && node --test
npm run prepack                      # same as prepare-skills (before pack/publish)
pi install /path/to/pi-reversa       # local Pi install from this checkout
```

After changing the extension or skills: `/reload` inside Pi.

**Not configured:** lint, formatter, typecheck, CI (no `.github/`), coverage, bundler. Quality gate is local `npm test`.

**Publish surface** (`package.json` `files`): `extensions/`, `packaged-skills/`, `README.md`, `LICENSE`. `scripts/` and `test/` are not published.

Recommended companion for `/reversa-auto` interviews: `pi install npm:@juicesharp/rpiv-ask-user-question`.

## Code Conventions

- ESM only; Node builtins via `node:` prefixes.
- JSDoc on exported functions (`@param`, `@returns`, `@typedef`). No `.ts`.
- Named exports in `extensions/lib/*`; default export is the extension factory result from `extensions/reversa.js`.
- Errors: throw (including `WriteOutsideSandboxError`); use out-of-band `.violations` when the agent loop swallows tool errors.
- Async: `async/await`, optional `AbortSignal`; fan-out via orchestrator concurrency (default 3).
- State writes: atomic temp + rename in `reversa-state.js`.
- Test seams: optional `deps` injection / lazy SDK load where present.
- Naming: commands kebab-case (`reversa-auto`); tools snake_case (`reversa_orchestrate`); lib files kebab-case.
- Operator-facing strings in the extension are mixed pt/en; Reversa skill bodies are Portuguese. Prefer matching existing copy when touching notifications (tests assert some English strings in `test/extension.test.js`).

## Testing and Quality Gates

- Runner: Node built-in `node:test` + `node:assert/strict`.
- Files: `test/extension.test.js`, `test/isolation.test.js`, `test/orchestrator.test.js`.
- Pattern: `mkdtempSync` / `withTempDir`, hand-rolled Pi harness mocks (`createHarness`), no Jest/Mocha/Vitest.
- `npm test` always regenerates `packaged-skills/` first; a fresh clone without `prepare-skills` cannot load packaged skills.
- Focused run (after prepare-skills): `node --test test/isolation.test.js`.
- Isolation contract: extension sources must not mention `pi-subagents`, `.pi/agents`, `subagents.json`, or `agent/chains`; package must not declare `pi.agents`.

## Runtime and Tooling Constraints

- Node `>=22.19.0`.
- npm only for install/lockfile discipline.
- Do not hand-edit `packaged-skills/`; regenerate via `prepare-skills` or fix skills upstream in the `reversa` package / sibling `../reversa` tree that `skills/` points at.
- Do not treat `skills/` as the Pi load path — Pi loads `./packaged-skills` from package metadata.
- `typebox` is imported by the extension but not a direct dependency; it is expected via the Pi peer/transitive graph. Tests need a usable install of the peer ecosystem.
- `IDEATION_UI_UX.md` is analytical only, not runtime policy.
- `.atl/`, `node_modules/`, `*.tgz`, and `packaged-skills/` are gitignored local/generated artifacts.

## Agent Operating Notes

- Prefer editing `extensions/**` and `test/**` for package behavior. Reversa agent skill content is owned by the `reversa` dependency / sibling repo, not this package’s published logic.
- Never wire host subagent APIs into this extension; isolation is a product invariant, not a style preference.
- Do not add `bash` (or equivalent unrestricted shell) to child sessions; git goes through `reversa_git` only.
- Do not expand automatable `PIPELINE_IDS` to `forward` or `new` without an explicit product decision — sandbox exists to block arbitrary project writes.
- Keep sandbox roots closed: untrusted folder values must pass `isSafeOutputFolder()` / `isSafeRelativeFolder()` (reject `.`, `..`, absolute paths, control chars, `.reversa` prefix). Prefer `state.folders` from `reversa/paths/layout.js`.
- Maintainer TUI skills under `.agents/skills/` and `skills-lock.json` are orthogonal to Reversa packaging; change them only when working on TUI tooling.
- Nested `AGENTS.md` under `node_modules/` belongs to dependencies; ignore for this package’s policy.
