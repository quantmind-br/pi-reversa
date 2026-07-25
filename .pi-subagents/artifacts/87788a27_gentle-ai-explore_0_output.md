Now I have a thorough understanding of the project. Here is the handoff.

---

## 1. Findings

### Project Purpose
- **pi-reversa** is a Pi Coding Agent extension package that integrates the [Reversa](https://www.npmjs.com/package/reversa) reverse-engineering framework as native slash commands within Pi. It runs fully autonomous discovery, migration, or documentation pipelines via isolated in-process child sessions.
- Version `0.1.0`, ESM module (`"type": "module"`), requires Node `>=22.19.0`.

### Package Configuration (`package.json`)
- **`pi` block:** declares one extension (`./extensions/reversa.js`) and one skills directory (`./packaged-skills`).
- **Keywords:** `pi-package`, `pi-coding-agent`, `reversa`, `reverse-engineering`, `agent-skills`.
- **`files` array:** ships `extensions/`, `packaged-skills/`, `README.md`, `LICENSE`.
- **Dependency:** `reversa` at exactly `1.2.56` (npm package).
- **Peer dependency:** `@earendil-works/pi-coding-agent` at `*` — the Pi SDK, injected at runtime.
- **No `pi.agents` block** — established by isolation test (`test/isolation.test.js:22`). There is no host subagent mechanism coupling.

### Extension Architecture (`extensions/reversa.js`)
- Exports `createReversaPiExtension()` (invoked as default export at module level).
- On `session_start` event:
  1. Scans all Pi commands for `skill:reversa` / `skill:reversa-*` entries.
  2. Registers alias slash commands (`/reversa`, `/reversa-scout`, etc.) — strips the `skill:` prefix.
  3. Builds a `skillIndex` `Map<string, { path, baseDir, description }>` used by the orchestrator.
  4. Registers `/reversa-auto` — the autonomous launcher command.
- **Conflict handling:** warns once when another extension already owns an alias; falls back to `/skill:reversa-*`.
- **Idle detection:** if Pi is idle, sends the skill block directly; if busy, queues as `followUp`.

### Two Registered Tools
1. **`reversa_orchestrate`** (registered at factory-creation time, before `session_start`):
   - Execution mode: `sequential` — blocks until the pipeline finishes.
   - Parameters: `pipeline` (union of `discovery`, `migrate`, `docs`), `user_name`, `project`, `chat_language`, `doc_language`, `doc_level` (essencial/completo/detalhado), `specs_choice` (auto/module/use-case/endpoint/hybrid/feature/custom), optional `custom_folders` and `resume`.
   - Calls `runPipeline()` from `./lib/orchestrator.js`.
   - Does nothing if no model is selected (returns error message).

2. **`reversa_git`** (created per child session within `subagent.js`):
   - Read-only git tool (no `bash` available in subagents).
   - Allowed subcommands: `log`, `show`, `diff`, `blame`, `ls-files`, `rev-parse`, `shortlog`, `describe`, `status`, `tag`, `branch`, `remote`, `config`.
   - Per-subcommand policies enforce read-only forms (e.g., `branch` rejects positional arguments; `tag` requires `--list`; `remote` only allows `show`/`get-url`; `config` requires `--get`/`--get-all`/etc.).
   - Forbidden args: `--output`, `-o`, `--exec`, `>`, `>>`. Max output: 200KB.

### Extension Libraries (`extensions/lib/`)

| File | Purpose |
|---|---|
| `pipelines.js` | Declarative pipeline definitions (discovery: 7 stages, migrate: 6 stages, docs: 4 stages). Each stage has `id`, `skill`, `label`, `fanOut`, `optional`, `task`. Destructive pipelines (`forward`, `new`) are deliberately excluded. |
| `orchestrator.js` | Core pipeline runner. Expands stages with fan-out, builds tasks, runs subagents with concurrency control (DEFAULT=3), writes per-stage output to `.reversa/runs/<runId>/<key>.md`, handles resume/skip, sandbox violation detection, spec organization after Scout. |
| `subagent.js` | Creates isolated child sessions via Pi SDK. Key isolation parameters: `noExtensions: true`, `noSkills: true`, `noPromptTemplates: true`, `noThemes: true`, `SessionManager.inMemory`. Tools allowed: `read`, `grep`, `find`, `ls`, `edit`, `write`, `reversa_git` — no `bash`, no host delegation tools. |
| `guarded-tools.js` | `WriteOutsideSandboxError` class + sandbox guard (`createSandboxGuard`) with lexical + canonical (symlink-aware) containment checks. `createGuardedFileTools` shadows builtin `write`/`edit` with sandboxed versions. Violations recorded out-of-band on `.violations` array (the Pi agent loop catches tool exceptions). `createGitReadTool` builds the `reversa_git` tool definition. |
| `reversa-state.js` | Reads/writes `.reversa/state.json` (atomic writes). Reads Scout's `surface.json`. Scans `.reversa/config.toml` for `[specs]` section. `isSafeOutputFolder()` rejects `.`, `..`, absolute paths, control chars, `.reversa` prefix. `outputFolder()` falls back to `_reversa_sdd`. |
| `interview.js` | Builds the launcher prompt for `/reversa-auto`. Adapts to `ask_user_question` availability (widget vs numbered menu). Tracks known/missing fields from state. |
| `skill-block.js` | Strips YAML frontmatter from `SKILL.md` and wraps body in `<skill name="..." location="...">` block. |

### Pipelines
- **`discovery`** (7 stages): Scout → Archaeologist (fanOut: modules) → Detective → Architect → Writer → Reviewer (optional) → Regression check (optional, reference-driven).
- **`migrate`** (6 stages): Paradigm Advisor → Curator → Strategist → Designer → Screen Translator → Inspector (optional).
- **`docs`** (4 stages): Docs Mapper → Docs Analyst → Docs Storyteller → Docs Publisher.
- `PIPELINE_IDS` = `["discovery", "migrate", "docs"]` — the only pipelines exposed to `reversa_orchestrate`.

### How `packaged-skills/` Is Produced
- `scripts/prepare-skills.js`: resolves the `reversa` npm dependency via `createRequire`, copies `node_modules/reversa/agents/` → `packaged-skills/` (removes target first, then `cpSync` with `dereference: true`).
- Runs on `npm test` and `npm pack`/`prepack`.
- Is `.gitignore`d — not committed.
- The `skills` directory at project root is a symlink (or directory) containing the same agent skills — used for development. The `skills-lock.json` tracks three *separate* TUI skills sourced from `/home/diogo/dev/skills`.

### Skills Symlink vs packaged-skills
- `skills/` at repo root: contains Reversa agent skills (e.g., `reversa/SKILL.md`, `reversa-scout/SKILL.md`, etc.) — at least 60+ skill directories. These appear to be the development-time skills, possibly symlinked from the `reversa` dependency.
- `packaged-skills/`: produced at prepack/test time, NOT committed (gitignored). Identical structure.
- `.agents/skills/`: three additional TUI skills (`tui-design`, `tui-refactor`, `tui-validator`) tracked in `skills-lock.json`, sourced from `/home/diogo/dev/skills`.
- `.claude/skills/`: contains `tui-validator/` — used for Claude Code compatibility.
- The `pi.skills` config points to `./packaged-skills` (the produced directory). The `pi.extensions` points to `./extensions/reversa.js`.

### Relationship to `reversa` Dependency and `@earendil-works/pi-coding-agent`
- `reversa` (1.2.56): provides the agent skill definitions (`node_modules/reversa/agents/`), the core `SKILL.md` orchestrator prompt, and a CLI (`node_modules/reversa/bin/reversa.js`). The CLI is **installation/maintenance only** — pi-reversa does not invoke `reversa run` (confirmed by test: `test/extension.test.js:191-199` verifies the CLI rejects `run` as unknown).
- `@earendil-works/pi-coding-agent` (peer): provides Pi SDK types (`ExtensionAPI`, `ToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`, `getAgentDir`).

### Subagent Isolation Model
- Each pipeline stage runs in an in-process child session:
  - `noExtensions: true` — no host extensions loaded, no pi-reversa recursion.
  - `noSkills: true`, `noPromptTemplates: true`, `noThemes: true`.
  - `SessionManager.inMemory` — never touches `~/.pi/agent/sessions`.
  - Custom `write`/`edit` tools shadow builtins with sandbox guard.
  - No `bash` — git archaeology via `reversa_git`.
  - Namespaces are **disjoint**: `pi-subagents` is not a dependency; no host delegation tool referenced anywhere in extension source (verified by `test/isolation.test.js`).
- The parent package **never** exposes agents to the host mechanism (`pi.agents` is undefined).

### Important Runtime Paths
| Path | Purpose |
|---|---|
| `.reversa/` | Control directory: `state.json`, `config.toml`, `context/surface.json`, `runs/<runId>/` |
| `.reversa/state.json` | Persisted state: `phase`, `completed[]`, `output_folder`, interview answers |
| `.reversa/config.toml` | `[specs]` section with `granularity` and `custom_folders` |
| `.reversa/context/surface.json` | Scout output: `modules[]`, `organization_suggestion` |
| `.reversa/runs/<runId>/` | Raw per-stage output (one `.md` per run key) |
| `_reversa_sdd/` | Default output folder for specs (configurable via `output_folder` in state) |
| `_reversa_forward/` | Forward-cycle regression watch files (`<feature>/regression-watch.md`) |
| `_reversa_docs/` | Docs pipeline mini-site output (extra root for `docs` pipeline only) |
| `packaged-skills/` | Copied from `node_modules/reversa/agents/` at prepack/test |

### Sandbox Model
- **Lexical gate:** resolved path must sit under one of the sandbox roots (`.reversa`, `_reversa_sdd` or configured output folder, `_reversa_forward`, plus `_reversa_docs` for docs pipeline).
- **Canonical gate:** symlink resolution must not escape the canonical form of those roots.
- `output_folder` from state is untrusted input — `isSafeOutputFolder()` rejects values that could widen the sandbox (`.`, `..`, absolute paths, control chars, `.reversa` prefix).
- Sandbox violations are the **only** events (alongside abort) that stop the pipeline loop. The orchestrator checks `.violations` out-of-band on each child result.

### Testing
- 3 test files with ~30 test cases covering: extension registration, alias conflict handling, sandbox guards, git tool allowlisting, pipeline execution (ordered stages, fan-out, resume, failure resilience, sandbox violations), state I/O, specs section persistence, isolation contract verification, launcher prompt adaptation.

---

## 2. Supporting Paths
- `/home/diogo/dev/pi-reversa/package.json` — project identity, pi config, dependencies
- `/home/diogo/dev/pi-reversa/README.md` — user-facing documentation
- `/home/diogo/dev/pi-reversa/extensions/reversa.js` — extension entry point (tools + commands)
- `/home/diogo/dev/pi-reversa/extensions/lib/orchestrator.js` — pipeline execution engine
- `/home/diogo/dev/pi-reversa/extensions/lib/pipelines.js` — pipeline stage definitions
- `/home/diogo/dev/pi-reversa/extensions/lib/subagent.js` — isolated child session creation
- `/home/diogo/dev/pi-reversa/extensions/lib/guarded-tools.js` — sandbox, write/edit guards, git tool
- `/home/diogo/dev/pi-reversa/extensions/lib/reversa-state.js` — state/config I/O, output folder safety
- `/home/diogo/dev/pi-reversa/extensions/lib/interview.js` — launcher prompt builder
- `/home/diogo/dev/pi-reversa/extensions/lib/skill-block.js` — SKILL.md → prompt block
- `/home/diogo/dev/pi-reversa/scripts/prepare-skills.js` — packaged-skills production
- `/home/diogo/dev/pi-reversa/skills-lock.json` — TUI skill lockfile
- `/home/diogo/dev/pi-reversa/.gitignore` — ignores `packaged-skills/`
- `/home/diogo/dev/pi-reversa/test/extension.test.js` — extension registration tests
- `/home/diogo/dev/pi-reversa/test/isolation.test.js` — isolation contract tests
- `/home/diogo/dev/pi-reversa/test/orchestrator.test.js` — orchestrator, sandbox, state tests

---

## 3. Exact Commands Run and Source of Each Claim
- `read /home/diogo/dev/pi-reversa/package.json` → project configuration, pi block, dependencies
- `read /home/diogo/dev/pi-reversa/README.md` → user docs, isolation claims
- `read /home/diogo/dev/pi-reversa/extensions/reversa.js` → extension structure, tool/command registration
- `read /home/diogo/dev/pi-reversa/scripts/prepare-skills.js` → how packaged-skills is produced
- `read /home/diogo/dev/pi-reversa/extensions/lib/pipelines.js` → pipeline stage tables
- `read /home/diogo/dev/pi-reversa/extensions/lib/orchestrator.js` → pipeline execution, sandbox roots, report building
- `read /home/diogo/dev/pi-reversa/extensions/lib/subagent.js` → child session isolation parameters
- `read /home/diogo/dev/pi-reversa/extensions/lib/guarded-tools.js` → sandbox guard, write/edit overrides, git tool
- `read /home/diogo/dev/pi-reversa/extensions/lib/reversa-state.js` → state I/O, output folder safety
- `read /home/diogo/dev/pi-reversa/extensions/lib/interview.js` → launcher prompt
- `read /home/diogo/dev/pi-reversa/extensions/lib/skill-block.js` → skill block construction
- `read /home/diogo/dev/pi-reversa/skills/reversa/SKILL.md` → Reversa orchestrator skill body
- `read /home/diogo/dev/pi-reversa/test/extension.test.js` → extension tests
- `read /home/diogo/dev/pi-reversa/test/isolation.test.js` → isolation contract tests
- `read /home/diogo/dev/pi-reversa/test/orchestrator.test.js` → orchestrator and sandbox tests
- `find /home/diogo/dev/pi-reversa/skills` → skills directory listing
- `find /home/diogo/dev/pi-reversa/node_modules/reversa/agents/**/SKILL.md` → Reversa dependency skills

---

## 4. Conflicts / Uncertainties
- The `skills/` directory at repo root appears to contain the same Reversa agent skills as `node_modules/reversa/agents/`. It is unclear whether `skills/` is a symlink to `node_modules/reversa/agents/` or a separate copy. The `find` command treated it as a regular directory (returned entries without "symlink" indicators), but `ls` was not available to confirm. The relationship between `skills/` and `packaged-skills/` is that `packaged-skills/` is the "official" packaged version (copied at prepack), while `skills/` may be a convenience symlink/copy for development.
- The `skills-lock.json` tracks three TUI skills sourced from `/home/diogo/dev/skills` — this is a separate external skills repository. These skills are NOT Reversa agents; they are terminal UI design/refactor/validation skills. Their presence in `.agents/skills/` and `.claude/skills/` suggests they are loaded into the host agent for non-Reversa work.
- The `pi.skills` config points to `./packaged-skills` — but it's unclear whether Pi also loads the `.agents/skills/` directory. The `skills-lock.json` seems to track local skills for the `.agents/skills/` path.
- The `IDEATION_UI_UX.md` is a UI/UX analysis out-of-scope for architecture but confirms the package has no owned UI surface — it's purely a Pi extension.

---

## 5. Recommended AGENTS.md Clauses for Architecture
```markdown
## pi-reversa Architecture

### Package identity
- pi-reversa is a Pi Coding Agent extension package. It ships one extension (`extensions/reversa.js`) and packaged Reversa skills (`packaged-skills/`).
- Dependencies: `reversa` (1.2.56, runtime), `@earendil-works/pi-coding-agent` (peer, Pi SDK).
- `packaged-skills/` is gitignored; produced by `scripts/prepare-skills.js` from `node_modules/reversa/agents/`.

### Tools registered (never `bash`, never host delegation)
- `reversa_orchestrate`: runs a full pipeline (`discovery`, `migrate`, or `docs`) end-to-end in one blocking call.
- `reversa_git`: read-only git archaeology tool, created per child session. No shell access.

### Command registration
- On `session_start`, every `skill:reversa-*` command gets a native `/reversa-*` alias.
- `/reversa-auto`: autonomous launcher that interviews the user then calls `reversa_orchestrate` once.

### Subagent isolation (non-configurable)
- Every pipeline stage runs in an in-process child session with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `SessionManager.inMemory`.
- Tools allowed: `read`, `grep`, `find`, `ls`, `edit`, `write`, `reversa_git`.
- Write/edit are sandbox-guarded. `bash` and host delegation tools are absent.

### Sandbox write roots
- `.reversa/`, configured output folder (default `_reversa_sdd/`), `_reversa_forward/`.
- `_reversa_docs/` additionally for the `docs` pipeline.
- Dual guard: lexical containment + canonical symlink check. Violations stop the pipeline.

### State and runtime paths
- `.reversa/state.json`: phase, completed[], output_folder, interview answers.
- `.reversa/config.toml`: [specs] granularity + custom_folders.
- `.reversa/context/surface.json`: Scout output (modules).
- `.reversa/runs/<runId>/`: raw per-stage output.

### Destructive pipelines are not automatable
- `forward` and `new` pipelines are excluded from `PIPELINE_IDS`; they require guided `reversa-coding`.
```

---