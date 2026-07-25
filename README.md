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
- Reversa skills copied into `packaged-skills/` from the installed `reversa` dependency during tests and packaging. The Reversa CLI is installation/maintenance-only; this plugin does not invoke a nonexistent `reversa run` command.

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
