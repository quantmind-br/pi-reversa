# pi-reversa

Pi Coding Agent integration for the [Reversa](https://www.npmjs.com/package/reversa) reverse-engineering framework.

## Install

```bash
pi install pi-reversa
```

For development from this checkout:

```bash
pi install /path/to/pi-reversa
```

The package loads:

- `extensions/reversa.js`: native aliases for the packaged `/reversa-*` skills, including `/reversa-autonomous` for unattended discovery.
- `/reversa-auto`: runs a whole Reversa pipeline end to end with isolated subagents, without stopping. Takes an optional pipeline argument — `/reversa-auto` (discovery, the default), `/reversa-auto migrate`, `/reversa-auto docs`. It collects every decision in a single interview up front, then hands off to the orchestrator.
- `reversa_orchestrate`: the tool behind `/reversa-auto`. The entire pipeline runs inside one tool call, which is what guarantees it never stops to ask mid-run. Each stage runs in an isolated in-process child session with no extensions, no `bash`, and `write`/`edit` restricted to `.reversa/` and the pipeline's `.specs/<workflow>/` folder (defaults: discovery → `.specs/discovery`, migrate → `.specs/migration`, docs → `.specs/docs`). Git archaeology goes through a read-only `reversa_git` tool. Raw per-stage output lands in `.reversa/runs/<runId>/`.
- `/reversa-models`: pick a different model per pipeline stage — e.g. a stronger model for the review stages and a cheaper one for the `archaeologist` / `writer` fan-out. A three-level picker (pipeline → stage → model) writes the choice to `[models]` / `[models.<pipeline>]` in `.reversa/config.toml`; `show` prints the current config and `reset` clears it. Besides `default`, both levels accept a reserved `review` key that retargets every reviewing/auditing stage in one pick (9 in `discovery`, `inspector` in `migrate`, none in `docs`), so the picker offers it as a single "Review stages" entry. Resolution per stage is stage id → pipeline `review` → pipeline `default` → global `review` → global `default` → the session model, with the `review` tiers applying only to stages tagged as review; an unresolvable reference degrades to the session model with a warning instead of failing the run. Thinking level stays global.
- Reversa skills copied into `packaged-skills/` from the installed `reversa` dependency during tests and packaging. There are two unattended discovery paths: `/reversa-auto` (this package's `reversa_orchestrate`) and the transactional runner `npx reversa run --workflow=discovery --unattended --engine=pi` from the `reversa` dependency. The runner is the more complete unattended discovery path.

The destructive pipelines (`forward`, `new`) are deliberately not automatable: they end in `reversa-coding`, which writes real project source.

### Recommended companion

`/reversa-auto` conducts its interview with the `ask_user_question` tool when available:

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

Without it the launcher falls back to a numbered menu in the chat, answered in a single consolidated reply.

### Subagent isolation

Reversa's subagents are internal to this package and do not mix with the host agent's subagent mechanism (for example `pi-subagents`). Namespaces, discovery, execution and artifacts are disjoint: this package registers only `reversa_orchestrate` and `reversa_git`, never reads host agent definitions, and runs every child session with `noExtensions`, so host delegation tools do not exist inside a Reversa subagent. `pi-subagents` is not a dependency; the pipeline behaves identically with it uninstalled.

After changing the extension or skills, run `/reload` in Pi.


## Code intelligence (codebase-memory)

This integration is self-contained in `pi-reversa` (`extensions/lib/code-intelligence`). It does not require a patched `reversa` package beyond the normal dependency.

`pi-reversa` depends on `codebase-memory-mcp` and exposes a curated tool:

- host + child tool: `reversa_code_intel`
- command: `/reversa-cbm status|refresh|enable|disable`
- default: enabled with auto-index on first use
- Linux x64/arm64 first; other platforms fall back to textual tools
- results are discovery aids; confirm material claims by reading current source

Cache and attestation live under `.reversa/cache/codebase-memory/` and materialization under `.reversa/context/codebase-memory/`.
