# Repository Guidelines

## Project Overview

`pi-reversa` is a Pi Coding Agent package that integrates the [Reversa](https://www.npmjs.com/package/reversa) reverse-engineering framework: native `/reversa-*` skill aliases, `/reversa-auto` unattended launcher, and a blocking `reversa_orchestrate` tool that runs whole pipelines in isolated child sessions.

- Stack: Node.js ESM (`"type": "module"`), plain JS + JSDoc (no TypeScript).
- Shape: thin extension package — not the Reversa skill source of truth.
- Dependency: `reversa` (skills live under `node_modules/reversa/agents/`).
- Peer: `@earendil-works/pi-coding-agent` (Pi SDK; version `*`).
- Package manager: npm only (`package-lock.json` lockfileVersion 3). No yarn/pnpm/bun lockfiles.

## Architecture & Data Flow

**Top-level flow:** the Pi host loads `extensions/reversa.js` → registers 2 host tools (`reversa_code_intel`, `reversa_orchestrate`) and 10 slash commands (7 entry aliases + `/reversa-auto`, `/reversa-cbm`, `/reversa-models`) on `session_start` → user invokes `/reversa-auto` or `reversa_orchestrate` → `runPipeline()` acquires a lock, expands stages, resolves dependencies, and fans out each stage into an in-process child `AgentSession` → each child runs inside a strict sandbox (no `bash`, guarded write/edit, read-only `reversa_git`) and writes declared workflow outputs under the active `.specs/` root → the orchestrator collects outputs, runs in-process controller stages (preflight, quality gates, finalize), persists stage transcript markdown, `run.json`, and CBM events into `.reversa/runs/<runId>/`, and writes pipeline state to `.reversa/state.json`.

**Three pipelines** (declared in `extensions/lib/pipelines.js`):
- `discovery` (8 stages) — loaded from a materialized JSON workflow via `workflow-adapter.js`
- `migrate` (10 stages) — declarative: preflight → paradigm-advisor → curator → strategist → designer-topology → designer-architecture → screen-translator-mode → screen-translator-generation → inspector → finalize
- `docs` (7 stages) — config → vendor → mapper → analyst → storyteller → publisher → smoke

Destructive pipelines (`forward`, `new`) are intentionally excluded — they end in coding that writes real project source.

**Three package-owned tools:**
- `reversa_orchestrate` — sequential, blocking; pipelines `discovery` | `migrate` | `docs` only.
- `reversa_code_intel` — curated codebase-memory queries. 8 actions: `architecture`, `search_symbols`, `search_code`, `trace_calls`, `trace_data_flow`, `snippet`, `change_impact`, `status`. Lazy-boots a `CodeIntelSession`, indexes + materializes on first use, graceful fallback on failure.
- `reversa_git` — per-child read-only git; no shell. Allowed subcommands are policy-gated in `extensions/lib/guarded-tools.js`.

**Pipeline stage shape** (declared in `pipelines.js`):

|Field|Description|
|---|---|
|`id`|Stable key used in `.reversa/state.json` → `completed`|
|`skill`|Packaged skill alias, or `null` for controller/reference stages|
|`label`|Human label shown in progress updates|
|`fanOut`|`"modules"` \|`"units"` \|`null` — parallelize per Scout module/writer unit|
|`optional`|Stage may fail without aborting at that stage; does **not** make the failure acceptable to downstream consumers|
|`dependsOn`|Stage ids that must have succeeded before this stage runs|
|`failPipeline`|`false` suppresses the immediate abort at that stage only|
|`kind`|`"agent"` (default) or `"controller"` (runs `runControllerStage` in-process)|
|`handler`|Controller handler name when `kind === "controller"`|
|`args`|Optional skill args for unattended modes|

**Abort rule** — inside `runPipeline()`:

```js
if (stage.failPipeline !== false && !stage.optional) { status = "failed"; aborted = true; break; }
```

`optional` / `failPipeline: false` prevent only the immediate abort; a failed stage does not enter `succeededStageIds`, so a mandatory consumer may still abort. Example: a hard `docs-vendor` failure is tolerated locally but blocks mandatory `docs-mapper`; final `docs-smoke` failure yields `completed_with_gaps` with the site intact.

**Child isolation (non-negotiable):** each stage runs with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, in-memory session. Tools: `read`, `grep`, `find`, `ls`, `edit`, `write`, `reversa_git`, `reversa_code_intel` (defined in `SUBAGENT_TOOLS` in `extensions/lib/subagent.js`). No `bash`. No host subagent machinery — `pi-subagents` is not a dependency; `test/isolation.test.js` forbids those strings in `extensions/`.

**Sandbox write roots:** `.reversa/` plus the active workflow folder under `.specs/` (defaults: `.specs/discovery`, `.specs/migration`, `.specs/docs`, `.specs/forward`, `.specs/new`, `.specs/bugs`, `.specs/refactor`). Regression-check may also edit existing `.specs/forward/*/regression-watch.md` files. Dual gate: lexical containment (`containsPath`) + canonical symlink check via `canonicalize`. Sandbox violations stop the pipeline.

**Code Intelligence Subsystem** — `extensions/lib/code-intelligence/` (11 modules) wraps `codebase-memory-mcp` as a curated, sandboxed tool. Linux x64/arm64 only. Flow: binary resolution → capability probing → project binding → lock → index → attestation → fingerprint → materialize → query dispatch with freshness gate:

|Module|Role|
|---|---|
|`config.js`|`CodeIntelligenceConfig`, TOML parser for `[code_intelligence]`, 7 env-var overrides|
|`binary.js`|Platform detection, binary candidate resolution across 5 paths, version probing|
|`capabilities.js`|8 curated actions + 15 upstream tools enumeration, capability probing via `--help`|
|`executor.js`|Thin spawn wrapper — no shell, stdin JSON, stdout JSON parsing, AbortSignal support|
|`errors.js`|`CodeIntelligenceError` class with code/message/details|
|`project.js`|`canonicalizeRoot`, `listProjects`, `resolveBoundProject`, `deriveProjectName`|
|`freshness.js`|`WorktreeFingerprint` (git HEAD + dirty signature + inventory signature), fingerprint comparison|
|`locks.js`|Lock path helper; actual locking via shared `extensions/lib/locks.js` (O_EXCL + stale recovery)|
|`materializer.js`|Serializes context bundle under `.reversa/context/codebase-memory/`. 512KB/file budget, 2MB total. Atomic writes via tmp+rename|
|`controller.js`|`createCodeIntelSession`, `ensureIndexedAndMaterialized`, `queryCodeIntel`, `statusSnapshot`. Strict freshness gating with auto-reindex|
|`index.js`|Barrel re-export|

The `reversa_code_intel` tool is available to both host and child sessions (same factory, separate session instances). Host session boot is eager; child sessions boot lazily on first query. Uses exclusive file locks for index safety, git-fingerprint-based freshness detection, and materializes context to `.reversa/context/codebase-memory/` for LLM consumption.

**Runtime control paths (created in the target project, not this repo):**
- `.reversa/state.json` — phase, completed stages, interview answers, schema v3 `folders` map / `output_folder` projection
- `.reversa/config.toml` — `[specs]` granularity / custom folders; `[code_intelligence]` section; `[models]` / `[models.<pipeline>]` per-stage model overrides plus the reserved `default` / `review` group keys
- `.reversa/context/surface.json` — Scout modules
- `.reversa/context/codebase-memory/` — materialized codebase-memory context bundle (architecture, schema, coverage, per-module payloads)
- `.reversa/cache/codebase-memory/` — attestation + index locks
- `.reversa/runs/<runId>/` — stage transcript markdown, `run.json` (pipeline metadata, status, warnings, usage), and CBM events

## Key Directories

|Directory|Purpose|
|---|---|
|`extensions/`|Extension entry (`reversa.js`) + `lib/` (pipeline engine, isolation, sandbox, state, code-intel, interview, models, skill-block, docs-assets)|
|`extensions/lib/code-intelligence/`|11-module adapter for `codebase-memory-mcp` native binary|
|`scripts/`|`prepare-skills.js` — copies Reversa agents + workflow into `packaged-skills/` and `extensions/generated/`|
|`packaged-skills/`|**Generated, gitignored.** What `package.json` `pi.skills` points at and what ships in the npm package (~50 Reversa skills)|
|`skills/`|Dev symlink → `../reversa/agents` (sibling checkout). Not the published skill tree|
|`test/`|Node native tests using `node:test` + `node:assert/strict` (~134 tests across 5 files)|
|`.agents/skills/`|Maintainer TUI skills (`tui-design`, `tui-refactor`, `tui-validator`); tracked by `skills-lock.json` + `shotgun-cli` (`.sm/lock.json`). Not part of the npm package|
|`.claude/skills/`|Synced copy of `.agents/skills/`|

## Important Files

|File|Role|
|---|---|
| `extensions/reversa.js` | Extension entry: registers 2 host tools (`reversa_code_intel`, `reversa_orchestrate`), 10 slash commands (7 entry aliases + auto/cbm/models), and skill aliases on `session_start` |
|`extensions/lib/pipelines.js`|Declarative pipeline tables: `discovery`, `migrate`, `docs` + stage shape typedef|
|`extensions/lib/orchestrator.js`|Core pipeline runner: `runPipeline()`, stage expansion, concurrency, dependency resolution, controller stages, migration auto-approval|
|`extensions/lib/subagent.js`|Isolated child `AgentSession` factory; defines `SUBAGENT_TOOLS` allowlist|
|`extensions/lib/guarded-tools.js`|Write/edit sandbox overrides + read-only `reversa_git` tool|
|`extensions/lib/reversa-state.js`|State I/O: `.reversa/state.json`, `config.toml` `[specs]`, `surface.json`, folder layout|
|`extensions/lib/code-intel-tool.js`|`reversa_code_intel` tool factory; delegates to `code-intelligence/` subsystem|
|`extensions/lib/interview.js`|`/reversa-auto` launcher prompt builder + pipeline arg parser|
|`extensions/lib/stage-models.js`|`[models]` config I/O + per-stage / review-group model resolution for `/reversa-models`|
|`extensions/lib/skill-block.js`|`stripFrontmatter()` + `buildSkillBlock()` for SKILL.md injection|
|`extensions/lib/docs-assets.js`|Vendor asset download + static HTML smoke testing for docs pipeline|
|`package.json`|v0.2.0, ESM, engines.node >=22.19.0. `pi.extensions` → `./extensions/reversa.js`, `pi.skills` → `./packaged-skills`|
|`.gitignore`|Excludes: `.atl/`, `node_modules/`, `*.tgz`, `packaged-skills/`, `extensions/generated/`, `.reversa/cache/`, `.reversa/context/codebase-memory/`|

## Development Commands

```bash
npm install                          # Node >= 22.19.0 (engines.node)
npm run prepare-skills               # regenerate packaged-skills/ from reversa
npm test                             # prepare-skills && node --test
npm run prepack                      # same as prepare-skills (before pack/publish)
pi install /path/to/pi-reversa       # local Pi install from this checkout
```

After changing the extension or skills: `/reload` inside Pi.

**Publish surface** (`package.json` `files`): `extensions/`, `packaged-skills/`, `README.md`, `LICENSE`. `scripts/` and `test/` are not published.

Recommended companion for `/reversa-auto` interviews: `pi install npm:@juicesharp/rpiv-ask-user-question`.

## Code Conventions & Common Patterns

- ESM only; Node builtins via `node:` prefixes.
- JSDoc on exported functions (`@param`, `@returns`, `@typedef`). No `.ts`.
- Named exports in `extensions/lib/*`; default export is the extension factory result from `extensions/reversa.js`.
- Errors: throw (including `WriteOutsideSandboxError`); use out-of-band `.violations` when the agent loop swallows tool errors.
- Async: `async/await`, optional `AbortSignal`; fan-out via orchestrator concurrency (default 3, `DEFAULT_FANOUT_CONCURRENCY`).
- State writes: atomic temp + rename in `reversa-state.js` and `controller.js` (`atomicWriteJson`).
- Test seams: optional `deps` injection / lazy SDK load where present.
- Naming: commands kebab-case (`reversa-auto`, `reversa-cbm`, `reversa-models`); tools snake_case (`reversa_orchestrate`, `reversa_code_intel`, `reversa_git`); lib files kebab-case.
- Operator-facing strings in the extension are mixed pt/en; Reversa skill bodies are Portuguese. Prefer matching existing copy when touching notifications.
- Prefer editing `extensions/**` and `test/**` for package behavior. Reversa agent skill content is owned by the `reversa` dependency / sibling repo.
- Never wire host subagent APIs into this extension; isolation is a product invariant.
- Do not add `bash` (or equivalent unrestricted shell) to child sessions; git goes through `reversa_git` only.

## Runtime/Tooling Preferences

- Node `>=22.19.0`.
- npm only for install/lockfile discipline. No yarn/pnpm/bun.
- Not configured: lint, formatter, typecheck, CI (no `.github/`), coverage, bundler. Quality gate is local `npm test`.
- Do not hand-edit `packaged-skills/`; regenerate via `prepare-skills` or fix skills upstream in the `reversa` package / sibling `../reversa` tree.
- Do not treat `skills/` as the Pi load path — Pi loads `./packaged-skills` from package metadata.
- `typebox` is imported by the extension but not a direct dependency; it is expected via the Pi peer/transitive graph.
- `codebase-memory-mcp` is a direct dependency used by the `code-intelligence/` subsystem (binary resolution, CLI execution). Linux x64/arm64 only.
- Do not expand automatable `PIPELINE_IDS` to `forward` or `new` without an explicit product decision — sandbox blocks arbitrary project writes.
- Keep sandbox roots closed: untrusted folder values must pass `isSafeOutputFolder()` / `isSafeRelativeFolder()` (reject `.`, `..`, absolute paths, control chars, `.reversa` prefix). Prefer `state.folders` from `reversa/paths/layout.js`.
- `.atl/`, `node_modules/`, `*.tgz`, and `packaged-skills/` are gitignored; `IDEATION_UI_UX.md` is analytical only, not runtime policy.
- Maintainer TUI skills under `.agents/skills/` and `skills-lock.json` are orthogonal to Reversa packaging.

## Testing & QA

- Runner: Node built-in `node:test` + `node:assert/strict`.
- Files: `test/extension.test.js` (~26 tests), `test/isolation.test.js` (3 tests), `test/orchestrator.test.js` (~81 tests), `test/code-intel.test.js` (~7 tests), `test/stage-models.test.js` (~17 tests). Total: ~134 tests.
- Pattern: `mkdtempSync` / `withTempDir`, hand-rolled Pi harness mocks (`createHarness`), no Jest/Mocha/Vitest.
- Key mock patterns:
  - `createHarness` — mocks Pi host API (command registration, tool registry, event handlers, notifications)
  - `satisfyingSubagent` — simulated pipeline stages that materialize declared outputs
  - `withPipeline` — ephemeral synthetic pipeline definitions
  - `scriptedUI` — drives TUI select dialogs
  - `waitFor` — polls async contracts
- `npm test` always regenerates `packaged-skills/` first; a fresh clone without `prepare-skills` cannot load packaged skills.
- Focused run (after prepare-skills): `node --test test/isolation.test.js`.
- Isolation contract: extension sources must not mention `pi-subagents`, `.pi/agents`, `subagents.json`, or `agent/chains`; package must not declare `pi.agents`.
- Tests assert against structural/string contracts; pipeline tests inject a fake `runSubagent` that inspects task content and returns synthetic results.
