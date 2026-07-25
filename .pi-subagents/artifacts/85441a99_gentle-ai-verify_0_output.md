## 1. FINDING rows

| Claim | Tag | Evidence |
|---|---|---|
| Document title is exactly `# Repository Guidelines`. | **Verified** | `AGENTS.md` first line. |
| Project is an ESM Node.js package using plain JavaScript rather than TypeScript. | **Verified** | `package.json` has `"type": "module"`; repository search found no `*.ts` or `*.tsx`; source is under `extensions/**/*.js`. |
| Direct dependency is `reversa@1.2.56`; Pi SDK is peer dependency `*`. | **Verified** | `package.json:dependencies`, `package.json:peerDependencies`; root entries agree with `package-lock.json`; installed `node_modules/reversa/package.json` reports `1.2.56`. |
| npm is the package manager; lockfile version is 3; no yarn/pnpm/bun lockfile exists. | **Verified** | `package-lock.json` has `"lockfileVersion": 3`; searches found no `yarn.lock`, `pnpm-lock.yaml`, or `bun.lock*`. `skills-lock.json` and `.sm/lock.json` are not package-manager lockfiles. |
| `extensions/reversa.js` is the extension entry and registers `reversa_orchestrate`, `/reversa-auto`, and Reversa aliases. | **Verified** | `package.json:pi.extensions`; `extensions/reversa.js` uses `registerTool`, `registerCommand`, and `session_start`. |
| `extensions/lib/` contains pipeline, isolation, sandbox, state, interview, and skill-block helpers. | **Verified** | `extensions/lib/{orchestrator,subagent,guarded-tools,reversa-state,interview,skill-block,pipelines}.js`. |
| `scripts/prepare-skills.js` copies installed Reversa agents into `packaged-skills/` with dereferencing. | **Verified** | `scripts/prepare-skills.js` resolves `reversa/package.json`, selects `agents`, and calls `cpSync(..., {recursive:true,dereference:true})`. |
| `packaged-skills/` is generated, gitignored, used by `pi.skills`, and included in the publish surface. | **Verified** | `.gitignore`; `package.json:pi.skills`; `package.json:files`; directory is correctly absent in the current checkout until generation. |
| `skills/` is the development skill tree linked to the sibling Reversa agents and is not the published load path. | **Verified** | Root enumeration identifies `skills` as a link-like entry; traversing it exposes the same Reversa agent structure as `/home/diogo/dev/reversa/agents`; `package.json:pi.skills` points to `./packaged-skills`, not `skills/`. |
| Test layout consists of extension, isolation, and orchestrator/sandbox tests. | **Verified** | `test/extension.test.js`, `test/isolation.test.js`, `test/orchestrator.test.js`. |
| `.agents/skills/` contains the three maintainer TUI skills and is outside npm publication. | **Verified** | `.agents/skills/{tui-design,tui-refactor,tui-validator}/SKILL.md`; absent from `package.json:files`; entries correspond to `skills-lock.json`. |
| The package owns only `reversa_orchestrate` and child-scoped `reversa_git` tools. | **Verified** | `extensions/reversa.js` registers `reversa_orchestrate`; `extensions/lib/subagent.js` supplies `reversa_git` from `guarded-tools.js`; `test/extension.test.js` and `test/isolation.test.js` assert the exposed-tool contract. |
| Automatable pipelines are exactly `discovery`, `migrate`, and `docs`; `forward` and `new` are excluded as destructive. | **Verified** | `extensions/lib/pipelines.js` defines only those three and exports `PIPELINE_IDS = Object.keys(PIPELINES)`; README explicitly documents the exclusion. |
| `reversa_orchestrate` is blocking/sequential at the Pi tool level, while module fan-out uses concurrency 3. | **Verified** | `extensions/reversa.js` sets `executionMode: "sequential"` and awaits `runPipeline`; `extensions/lib/orchestrator.js` exports `DEFAULT_FANOUT_CONCURRENCY = 3` and runs stages in order with bounded module fan-out. The later AGENTS.md convention correctly supplies this qualification. |
| Child sessions disable extensions, skills, prompt templates, and themes and use an in-memory session. | **Verified** | `extensions/lib/subagent.js`: `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `SessionManager.inMemory(cwd)`. |
| Child tool allowlist is `read`, `grep`, `find`, `ls`, `edit`, `write`, `reversa_git`, with no `bash`. | **Verified** | `extensions/lib/subagent.js:SUBAGENT_TOOLS`; asserted by `test/orchestrator.test.js`. |
| Host subagent machinery is excluded and `pi-subagents` is not a dependency. | **Verified** | `test/isolation.test.js` rejects the documented forbidden strings and checks dependencies; `package.json` has only `reversa` as a direct dependency. Static search found none of those forbidden strings in `extensions/`. |
| Sandbox roots and the docs-only extra root are as documented. | **Verified** | `extensions/lib/orchestrator.js:sandboxRoots` allows `.reversa`, safe output folder, `_reversa_forward`, and `PIPELINE_EXTRA_ROOTS.docs = ["_reversa_docs"]`; tests assert pipeline-aware roots. |
| Sandbox uses independent lexical and canonical/symlink containment gates. | **Verified** | `extensions/lib/guarded-tools.js:createSandboxGuard`; traversal and symlink-escape cases are covered in `test/orchestrator.test.js`. |
| Sandbox violations stop the pipeline. | **Verified** | `extensions/lib/orchestrator.js` records `sandboxViolation` and breaks the stage loop; tests cover pre-Scout and child-reported violations. |
| `.reversa/state.json` stores phase/completed state, interview answers, and output folder. | **Verified** | `extensions/lib/reversa-state.js`; `extensions/lib/orchestrator.js:mergeAnswers/runPipeline`; related tests inspect persisted state. |
| `.reversa/config.toml` stores `[specs]` granularity and optional custom folders. | **Verified** | `extensions/lib/reversa-state.js:readSpecsSection/writeSpecsSection`; tests cover creation, append, and preservation. |
| `.reversa/context/surface.json` provides Scout modules. | **Verified** | `extensions/lib/reversa-state.js:SURFACE_PATH/listScoutModules`; discovery pipeline and tests use it for fan-out. |
| `.reversa/runs/<runId>/` stores raw stage output. | **Verified** | `extensions/lib/orchestrator.js` creates the run directory and writes one Markdown result per concrete stage run; README documents the same path. |
| `npm install` is appropriate and requires Node `>=22.19.0`. | **Verified** | `package.json:engines.node`; matching root `package-lock.json` engine entry; npm lockfile and dependencies support installation. |
| `npm run prepare-skills` is supported. | **Verified** | `package.json:scripts.prepare-skills`. |
| `npm test` means preparation followed by Node’s native test runner. | **Verified** | `package.json:scripts.test` is `npm run prepare-skills && node --test`. |
| `npm run prepack` performs the same skill preparation before packaging. | **Verified** | `package.json:scripts.prepack` invokes `npm run prepare-skills`. |
| `pi install /path/to/pi-reversa` is the documented local-install command. | **Verified** | `README.md`, “For development from this checkout.” |
| `/reload` after extension or skill changes is documented. | **Verified** | `README.md` final instruction. |
| Companion install command is supported by repository documentation. | **Verified** | `README.md` documents `pi install npm:@juicesharp/rpiv-ask-user-question`; `extensions/lib/interview.js` emits the same recommendation. |
| No lint, formatter, typecheck, coverage, bundler, or CI configuration is present. | **Verified** | `package.json` contains only `prepare-skills`, `test`, and `prepack`; no `.github/` files were found; no other build-quality configuration appears in the inspected root. |
| npm publication contains only extensions, generated skills, README, and license. | **Verified** | `package.json:files`; `scripts/` and `test/` are absent from that list. |
| Source uses ESM, `node:` builtin imports, named library exports, and one extension default export. | **Verified** | Inspected `extensions/**/*.js`; named exports occur throughout `extensions/lib/`; only `extensions/reversa.js` has the package extension default export. |
| Exported source functions use JSDoc and test seams use injected dependencies where needed. | **Verified** | JSDoc precedes exported functions in `extensions/lib/*.js`; `extensions/lib/subagent.js` accepts optional `deps`; tests inject a mock SDK. |
| Errors, out-of-band `.violations`, optional abort signals, and atomic state writes are accurately described. | **Verified** | `guarded-tools.js`, `orchestrator.js`, `subagent.js`, and `reversa-state.js:atomicWrite`; corresponding cases are covered in `test/orchestrator.test.js`. |
| Operator-facing text is mixed Portuguese/English and English strings are asserted by tests. | **Verified** | `extensions/reversa.js` contains both languages; `test/extension.test.js` asserts English conflict, failure, and queued-follow-up strings. Installed Reversa skill content is predominantly Portuguese. |
| Test runner and test patterns are accurately documented. | **Verified** | Tests import `node:test` and `node:assert/strict`; use `mkdtempSync`, `withTempDir`, and `createHarness`; no Jest/Mocha/Vitest references found. |
| Focused command `node --test test/isolation.test.js` targets a valid native-test file and does not require a separate framework. | **Verified** | `test/isolation.test.js` exists and uses `node:test`; `package.json` requires a compatible Node version. It was not executed because the task prohibited running test suites unless explicitly authorized. |
| A fresh checkout needs skill preparation before packaged skills can load. | **Verified** | `packaged-skills/` is gitignored and `package.json:pi.skills` points to it; `npm test` and `prepack` generate it. |
| `typebox` is imported but is not a direct dependency; it is supplied through the Pi peer ecosystem in the current lock graph. | **Verified** | Imports in `extensions/reversa.js` and `extensions/lib/guarded-tools.js`; absent from direct `package.json:dependencies`; `package-lock.json` shows Pi ecosystem packages depending on `typebox@1.1.38`. |
| `IDEATION_UI_UX.md` is analytical rather than runtime policy. | **Verified** | File is explicitly an analysis report; no package entry, script, extension registration, or published-file entry references it. |
| `.atl/`, `node_modules/`, `*.tgz`, and `packaged-skills/` are gitignored. | **Verified** | `.gitignore`. |
| Unsafe output folders reject self/traversal, absolute paths, control characters, and `.reversa` prefixes. | **Verified** | `extensions/lib/reversa-state.js:isSafeOutputFolder`; exhaustive cases in `test/orchestrator.test.js`. |
| Maintainer TUI skills and `skills-lock.json` are orthogonal to package publication. | **Verified** | `skills-lock.json` lists only TUI skills; `package.json:files` excludes both `.agents/` and `skills-lock.json`. |
| No secrets or credential material appears in AGENTS.md. | **Verified** | Static secret-pattern review found no API keys, tokens, passwords, private-key blocks, or credential values. |
| Guidance is repository-specific and operational rather than excessive generic advice. | **Verified** | Sections consistently cite actual paths, package scripts, sandbox constraints, test contracts, and publication behavior. |
| Phrase “raw per-stage stage output” is grammatically duplicated. | **Weakened — informational/editorial** | `AGENTS.md`, runtime-control-path entry. Meaning remains clear and repository evidence supports the underlying claim. |
| Material factual contradictions or unsupported operational claims. | **Verified: none found** | Cross-check across `package.json`, `package-lock.json`, `README.md`, `.gitignore`, scripts, extension sources, tests, and pipeline declarations. |

## 2. Corrections needed

No factual correction is required.

Optional editorial cleanup:

- Replace:
  > `.reversa/runs/<runId>/` — raw per-stage stage output

- With:
  > `.reversa/runs/<runId>/` — raw output for each stage run

This does not affect technical accuracy or publication readiness.

## 3. Publication readiness

**PASS**

`AGENTS.md` is technically consistent with the inspected repository, correctly distinguishes generated and runtime-only paths, documents supported commands, matches package/runtime constraints, contains no secrets, and remains operationally useful. No blocker or material correction was found.

### Verification boundaries

- Read-only static inspection only.
- No tests, builds, package preparation, installation, or commands that could mutate the checkout were run.
- Git staging status was not checked because no exact git command was authorized.
- The generated `packaged-skills/` directory was absent, as expected; its generation contract was verified from configuration and source rather than executed.