I now have a full picture of the repository structure and workflow. Here is the complete handoff.

---

## 1. Findings

### Repository Overview
- **Name/version**: `pi-reversa@0.1.0` — a Pi Coding Agent extension package for the Reversa reverse-engineering framework.
- **License**: MIT (Copyright 2026 Sandeco).
- **Module system**: ESM (`"type": "module"`).
- **Package manager**: npm (lockfileVersion 3 `package-lock.json`, **no** other lockfiles like `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`).

### Scripts (`package.json`)

| Script | Command | Purpose |
|--------|---------|---------|
| `prepare-skills` | `node scripts/prepare-skills.js` | Copies skill files from the `reversa` npm dependency into `packaged-skills/` |
| `test` | `npm run prepare-skills && node --test` | Regenerates packaged skills, then runs all tests using Node's native test runner |
| `prepack` | `npm run prepare-skills` | Ensures `packaged-skills/` is fresh before `npm pack`/`npm publish` |

### `scripts/prepare-skills.js` behavior (observed at `/home/diogo/dev/pi-reversa/scripts/prepare-skills.js`)
1. Resolves the `reversa` dependency's `package.json` via `createRequire`
2. Derives the reversa root directory from that path
3. Reads source from `<reversa-root>/agents/`
4. Destroys and recreates `<project-root>/packaged-skills/`
5. Copies the entire `agents/` tree recursively with symlink dereferencing
6. Throws if the source directory does not exist

### Test layout and runner
- **Location**: `test/` with 3 files:
  - `test/extension.test.js` — 12 tests covering command registration, skill alias expansion, conflict warnings, /reversa-auto, reversa_orchestrate isolation, and the real Reversa CLI contract
  - `test/isolation.test.js` — 3 tests asserting extension source never references `pi-subagents` machinery and the package declares no `pi.agents`
  - `test/orchestrator.test.js` — 20+ tests covering sandbox guard, guarded write/edit tools, reversa_git read-only enforcement, specs persistence, pipeline execution (discovery, docs), resume logic, fan-out, sandbox violations, output folder safety
- **Runner**: `node --test` (Node.js built-in test runner, no Jest/Mocha/Vitest)
- **Precondition**: tests require `npm run prepare-skills` to run first (bundled into the `test` script)
- All tests use `node:assert/strict` for assertions
- Test harness mocks the Pi extension API via a `createHarness` factory in `test/extension.test.js`

### `engines.node` and lockfiles
- **engines.node**: `>=22.19.0` — requires Node.js 22.19+
- **Lockfile**: `package-lock.json` only (npm, lockfileVersion 3)
- **No**: `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `.nvmrc`, `.node-version`

### CI
- **No CI**: No `.github/` directory, no `.gitlab-ci.yml`, no `Jenkinsfile`, no CircleCI, no Travis config
- **No custom git hooks**: Only the default `.sample` hooks in `.git/hooks/`

### Lint / Format / Typecheck tooling
- **None present**: No `.eslintrc*`, `.prettier*`, `tsconfig.json`, `jsconfig.json`, `biome.json`, `oxlintrc.*`, or any other lint/format/type-check configuration
- Code is plain JavaScript with JSDoc type annotations (e.g., `@param`, `@returns`, `@typedef`)
- No `devDependencies` in `package.json` at all — all tooling is zero-config or missing

### `files` field (what gets published)
```json
"files": [
  "extensions/",
  "packaged-skills/",
  "README.md",
  "LICENSE"
]
```
- `scripts/` is **not** published — `prepare-skills.js` is only used during dev/test/prepack
- `test/` is **not** published
- `packaged-skills/` is gitignored and generated at prepack time

### Dependencies
| Type | Package | Version |
|------|---------|---------|
| dependency | `reversa` | `1.2.56` |
| peerDependency | `@earendil-works/pi-coding-agent` | `*` |

- Implicit dependencies (used via imports but not declared): `typebox` (for tool parameter schemas), `@earendil-works/pi-coding-agent` tool factories (`createWriteToolDefinition`, `createEditToolDefinition`)

### Pi metadata
```json
"pi": {
  "extensions": ["./extensions/reversa.js"],
  "skills": ["./packaged-skills"]
}
```

### Extension architecture
- **Entry point**: `extensions/reversa.js` exports `createReversaPiExtension()` (called at load time)
- **Library modules** (`extensions/lib/`):
  - `guarded-tools.js` — sandboxed `write`/`edit` tools + `reversa_git` read-only git tool
  - `interview.js` — `/reversa-auto` launcher prompt builder and pipeline argument parser
  - `orchestrator.js` — pipeline execution engine (fan-out, concurrency, progress reporting)
  - `pipelines.js` — declarative pipeline definitions (discovery, migrate, docs)
  - `reversa-state.js` — `.reversa/state.json` and `.reversa/config.toml` persistence
  - `skill-block.js` — YAML frontmatter stripper and `<skill>` block builder
  - `subagent.js` — isolated in-process child session runner

### Skills management (separate from Reversa)
- `skills/` (root dir) — contains user-level TUI skills (tui-design, tui-refactor, tui-validator)
- `.agents/skills/` — mirrors these TUI skills for the agent
- `.claude/skills/` — Claude-specific skill links
- `skills-lock.json` — locks TUI skill sources and hashes
- `.sm/lock.json` — skill manager sync state
- These are **not** Reversa skills; Reversa skills live in the `reversa` npm dependency and get copied to `packaged-skills/`

### Install / Dev workflow (from README)
```bash
# Production install
pi install pi-reversa

# Dev from local checkout
pi install /path/to/pi-reversa

# Recommended companion
pi install npm:@juicesharp/rpiv-ask-user-question
```

### What is NOT present
- No TypeScript compilation step
- No bundler (webpack, rollup, esbuild, etc.)
- No minification
- No code coverage tooling
- No pre-commit hooks (only git default samples)
- No `.npmrc`, `.nvmrc`, `.node-version`
- No `.env` or dotenv usage
- No Dockerfile or container config
- No changelog or version management beyond `package.json` `version` field

---

## 2. Supporting Paths

- `/home/diogo/dev/pi-reversa/package.json` — all scripts, deps, engines, files, pi metadata
- `/home/diogo/dev/pi-reversa/package-lock.json` — lockfileVersion 3, npm
- `/home/diogo/dev/pi-reversa/scripts/prepare-skills.js` — skill copy script
- `/home/diogo/dev/pi-reversa/test/extension.test.js` — extension tests (12)
- `/home/diogo/dev/pi-reversa/test/isolation.test.js` — isolation tests (3)
- `/home/diogo/dev/pi-reversa/test/orchestrator.test.js` — orchestrator tests (20+)
- `/home/diogo/dev/pi-reversa/extensions/reversa.js` — extension entry point
- `/home/diogo/dev/pi-reversa/extensions/lib/*.js` — 7 library modules
- `/home/diogo/dev/pi-reversa/README.md` — install + usage docs
- `/home/diogo/dev/pi-reversa/IDEATION_UI_UX.md` — UI/UX analysis report (not a development workflow artifact)
- `/home/diogo/dev/pi-reversa/.gitignore` — ignores `node_modules/`, `packaged-skills/`, `.atl/`, `*.tgz`
- `/home/diogo/dev/pi-reversa/LICENSE` — MIT
- `/home/diogo/dev/pi-reversa/skills-lock.json` — TUI skill lock
- `/home/diogo/dev/pi-reversa/.sm/lock.json` — skill manager lock

---

## 3. Exact Commands and Source of Claims

All claims derived from static file reads. No commands were executed. Sources:

| Claim | Evidence |
|-------|----------|
| Scripts are `prepare-skills`, `test`, `prepack` | `package.json` L6-9 |
| `prepare-skills` copies `reversa/agents/` → `packaged-skills/` | `scripts/prepare-skills.js` L7-15 |
| Tests use `node --test` | `package.json` L7: `"test": "npm run prepare-skills && node --test"` |
| `engines.node >= 22.19.0` | `package.json` L27 |
| Only `package-lock.json`, no other lockfiles | `find` for `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb` returned zero results |
| No CI | `find` for `.github/**/*` returned zero results |
| No lint/format/typecheck configs | `find` for `.eslintrc*`, `.prettier*`, `tsconfig*` returned zero results |
| `files` field contents | `package.json` L22-26 |
| `packaged-skills/` is gitignored | `.gitignore` L4 |
| `test/` directory has 3 test files | `find` results: `extension.test.js`, `isolation.test.js`, `orchestrator.test.js` |
| zero `devDependencies` | `package.json` has no `devDependencies` key |
| License is MIT | `LICENSE` content and `package.json` L15 |
| No custom git hooks | `.git/hooks/` contains only `.sample` files |

---

## 4. Conflicts / Uncertainties

1. **`packaged-skills/` is empty/missing at rest**: It is gitignored and generated. A fresh checkout has no `packaged-skills/` directory until `npm run prepare-skills` is run. Tests will fail without it. This is by design but worth noting for onboarding.

2. **Implicit `typebox` dependency**: `extensions/reversa.js` and `extensions/lib/guarded-tools.js` import `Type` from `typebox`, but `typebox` is not listed in `dependencies`. It is presumably provided transitively through `@earendil-works/pi-coding-agent` (the peer dependency). This means tests outside the Pi runtime environment need the peer dependency installed.

3. **No version pinning for peer dependency**: `@earendil-works/pi-coding-agent` is `"*"` — any version accepted. Breaking changes in the host agent could silently break this extension.

4. **The `skills` directory at root** contains TUI skills (tui-design, tui-refactor, tui-validator) that appear to be development-environment skills for the maintainer, not part of the pi-reversa package itself. They are not referenced in `package.json` or `files`.

---

## 5. Recommended AGENTS.md Clauses for Development Workflow

```markdown
## pi-reversa development workflow

- Run `npm run prepare-skills` before any test run or manual testing. `packaged-skills/` is gitignored and must be generated from the installed `reversa` dependency.
- Tests use Node's built-in test runner: `npm test` (which includes `prepare-skills`).
- Node >= 22.19.0 required.
- This is an ESM-only package (`"type": "module"`). Use `import`/`export`, not `require`.
- No lint, format, or typecheck tooling is configured. JSDoc annotations serve as the type documentation.
- The `reversa` dependency must be installed (`npm install`) before `prepare-skills` can run; it reads `reversa/agents/` from `node_modules`.
- `packaged-skills/` is the published artifact. Never edit it directly — changes to Reversa skills belong upstream in the `reversa` package.
- The extension entry is `extensions/reversa.js`. It registers at `session_start` and loads skill aliases from the Pi command registry.
- CI is not configured. All quality gates are local: `npm test` must pass.
- `test/extension.test.js` has hardcoded English notification strings (see tests L144, L235-238). If notification copy changes, update these tests.
- The `skills/` and `.agents/skills/` directories are maintainer-local TUI skills, not part of the package. Do not modify them unless working on TUI tooling.
- To publish: `npm run prepack` ensures fresh `packaged-skills/`, then `npm publish`. Only `extensions/`, `packaged-skills/`, `README.md`, and `LICENSE` ship.
```

---