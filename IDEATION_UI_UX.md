# UI/UX Improvements Analysis Report

## Executive Summary

`pi-reversa` is a **Pi Coding Agent extension package**, not a web, desktop, or TUI application. It ships no renderable interface of its own. Its entire user-facing surface is:

1. **64 `/reversa-*` slash commands** registered into Pi's command palette at `session_start` (`extensions/reversa.js:42-98`), each carrying a description sourced from a packaged `SKILL.md` frontmatter (`packaged-skills/*/SKILL.md`).
2. **Three notification strings** emitted through Pi's `ctx.ui.notify(...)` — one `error`, one `warning`, one `info` (`extensions/reversa.js:19-33, 61-64, 87, 91`).
3. **The injected `<skill>` prompt block** sent via `pi.sendUserMessage` when a command runs (`extensions/reversa.js:80-86`).

All three surfaces are delivered to or through **Pi's own chat UI**, which is external to this repository and could not be launched or attached in this environment. There is no browser target, no Electron/Tauri window, and no TUI process this package owns. Consequently **every finding below is `[CODE-ONLY]`**: grounded in current source, with no claim about how Pi renders any of them, and confidence lowered accordingly. No screenshots, accessibility snapshots, or pane captures were produced because there was no owned interface to capture — none are cited.

Findings are deliberately scoped to **surfaces this repo fully controls**: command naming/descriptions, alias-conflict copy, and activation-failure copy. Two candidate issues that would depend on unobserved Pi rendering/injection behavior — whether idle activation gives the user visible acknowledgement, and whether the injected `<skill>` block appears as a wall of text in the transcript — are **not** reported as findings; they are documented as unverified limitations, because this repository provides no evidence of how Pi renders or delivers a `sendUserMessage`.

The material, grounded issues are: (1) a **flat, undifferentiated palette of 64 look-alike commands** with no grouping or entry-point tiering; (2) **long, action-burying command descriptions** (median 308 chars, 55 of 64 over 250, action verb behind team/phase framing); (3) a **mixed-language experience** — 64/64 skill descriptions in Portuguese while the extension's own operator copy is English; and (4) an **alias-conflict warning that is dense and stacks per conflicting alias**.

## Visual Inspection Log

**UI Type:** mixed (host-rendered command palette + notifications; no self-owned UI)
**Environment:** local (static source only; no running app)
**Browser/App/Terminal Tooling:** none applicable — the host UI (Pi Coding Agent chat) is not present in this environment and was not launched
**Launch Command:** none — package is a library/extension loaded by Pi (`pi install pi-reversa`); it exposes no runnable UI process
**User Role / Data Fixture:** N/A
**Screens/Journeys Inspected:** 0 rendered / 3 code-level surfaces analyzed
**Viewports/Sizes Tested:** N/A (no rendered target)

| Screen / Journey | Screenshot/Capture | Accessibility Snapshot | States Captured | Viewports/Sizes | Notes |
|---|---|---|---|---|---|
| Command palette (`/reversa*`) | N/A — host UI unavailable | N/A | N/A | N/A | 64 commands registered; descriptions from `SKILL.md` frontmatter |
| Notifications (error/warning/info) | N/A — host UI unavailable | N/A | error, warning, info (code paths only) | N/A | `ctx.ui.notify`; console fallback when `!ctx.hasUI` |
| Command activation | N/A — host UI unavailable | N/A | idle send, busy follow-up, failure (code paths only) | N/A | Rendering/injection behavior is Pi's — not inspectable here |

## Visual Inspection Limitations

Runtime inspection was **impossible** for the entire target. Details:

- **Target:** Pi Coding Agent chat UI (palette + notifications + transcript).
  **Attempts:** Enumerated the repo for any self-hosted web/desktop/TUI entry point (`package.json` scripts, `extensions/`, `scripts/`); the package declares only `prepare-skills`/`test`/`prepack` and a `pi.extensions` hook — no server, window, or terminal app. No `agent-browser`/tmux target exists because the host UI is not part of this checkout and cannot be installed/run here.
  **Failure reason:** The rendering surface belongs to the external Pi host, which is not available in this environment.
  **Affected findings:** UIUX-001 … UIUX-004 are all `[CODE-ONLY]` with lowered confidence. No claim is made about how Pi truncates descriptions or styles notifications; where palette truncation is referenced it is marked `[INFERENCE]`.

### Unverified — deliberately excluded from findings

The following would require observing Pi's rendering/injection behavior, which this repo does not evidence. They are recorded so a future run inside a live Pi can confirm or dismiss them; **no finding claims a user-facing outcome for either:**

- **Idle-activation acknowledgement.** On the idle path, `extensions/reversa.js:83-84` calls `pi.sendUserMessage(prompt)` with no extension-emitted `notify`, whereas the busy path adds `"/${alias} queued as a follow-up"` (`:87`). Whether the idle send is itself sufficient visible feedback depends on how Pi renders a user message — unobserved. Not a finding.
- **Injected `<skill>` block visibility.** `extensions/reversa.js:78-84` sends the frontmatter-stripped skill body wrapped in `<skill>…</skill>` as the message. Whether Pi shows this in the transcript or handles it as hidden/context injection is unknown from this repo. Not a finding.

## Issues Found

### High Priority

#### UIUX-001: Flat palette of 64 look-alike `/reversa-*` commands with no grouping or tiering

**Category:** structural
**Priority Rationale:** Affects the very first interaction of every user, on every session; discoverability of the correct command among 64 near-identical entries is the primary friction point of the whole package. High impact × high frequency × entry-point criticality. Confidence lowered because palette rendering/filtering is Pi's, not observed.
**Confidence:** medium `[CODE-ONLY]`

**Evidence:**
- Code: `extensions/reversa.js:50-97` — every `skill:reversa*` command is registered flat, with no category, ordering, or "entry-point vs sub-agent" distinction.
- Measurement: 64 registered commands sharing the `reversa` / `reversa-` prefix (enumerated from `packaged-skills/*/SKILL.md`). Several are documented as internal steps normally invoked by an orchestrator, e.g. `reversa-curator` ("geralmente invocado por /reversa-migrate", `packaged-skills/reversa-curator/SKILL.md:3`) and `reversa-designer` ("normalmente via /reversa-migrate", `packaged-skills/reversa-designer/SKILL.md:3`), yet they sit at the same level as top-level entry points like `reversa`, `reversa-forward`, `reversa-new`.

**Affected User Journey / Screens:**
- Command discovery: user types `/reversa` and must choose among 64 entries.

**Affected Code:**
- `extensions/reversa.js` (registration loop, lines 50-97)

**Current State:**
All matching skills register as sibling commands with equal prominence. Frequently-used entry points (`reversa`, `reversa-autonomous`, `reversa-forward`) are indistinguishable in the registration from rarely-typed sub-steps meant to be orchestrated automatically.

**Proposed Change:**
Tier the palette by prominence. Define a small curated set of top-level entry-point aliases (e.g. `reversa`, `reversa-forward`, `reversa-autonomous`, `reversa-new`, `reversa-migrate`, `reversa-debugger`) and prefix the description of orchestrator-invoked sub-agents with a consistent tag such as `[etapa]` / `[sub-agente]` so palette scanning groups them. Reuse the existing `reversa-` prefix and only adjust the description lead and, if Pi exposes it, command ordering/category metadata — do not introduce a second naming scheme.

**User Benefit:**
Cuts scan time to the ~6 commands a user actually starts from, and steers users away from invoking internal sub-steps out of sequence.

**Risks / Trade-offs:**
Requires deciding the entry-point set (a product decision). Description/tag edits belong upstream in the `reversa` dependency (copied by `scripts/prepare-skills.js`), not hand-edited in generated `packaged-skills/`.

**Verdict:** Requires design decision on the entry-point set and whether Pi exposes command grouping/ordering metadata.
**Estimated Effort:** medium

---

#### UIUX-002: Long, action-burying command descriptions

**Category:** usability
**Priority Rationale:** Every command carries an oversized description; the meaningful "what does this do" is often buried behind team/phase framing, degrading scanability across all 64 entries. High frequency, moderate per-item impact. Confidence lowered because Pi's truncation width is unobserved.
**Confidence:** medium `[CODE-ONLY]`

**Evidence:**
- Measurement (computed from `packaged-skills/*/SKILL.md` frontmatter): description length min/median/max = **103 / 308 / 408** characters; **63 of 64** exceed 160 chars; **55 of 64** exceed 250 chars.
- Code: `extensions/reversa.js:74-75` passes `command.description` straight through to `pi.registerCommand` with no shortening.
- Examples of buried intent: `reversa-designer` opens with "Quarto agente do Time de Migração, em duas fases…" (`packaged-skills/reversa-designer/SKILL.md:3`); `reversa-curator` opens with "Segundo agente do Time de Migração…" (`packaged-skills/reversa-curator/SKILL.md:3`) — the role number and team name lead, not the action.

**Affected User Journey / Screens:**
- Command discovery / palette autocomplete.

**Affected Code:**
- `extensions/reversa.js:74-75`; upstream `packaged-skills/*/SKILL.md` descriptions.

**Current State:**
Descriptions embed activation phrases, team/phase lineage, and trigger synonyms in a single long string. `[INFERENCE: if Pi truncates to a single line]`, a palette row shows mostly framing before the action verb.

**Proposed Change:**
Front-load a ≤160-char action-first summary. Move activation synonyms and phase/team lineage to the body of `SKILL.md` (they serve model matching, not the palette). Lead with the verb: e.g. `reversa-curator` → "Decide o que migra, descarta ou precisa de decisão humana; gera target_business_rules.md e discard_log.md." Apply upstream in `reversa` so `prepare-skills.js` copies the improved text; do not edit generated `packaged-skills/`.

**User Benefit:**
The first glance answers "what does this do," reducing wrong-command activations.

**Risks / Trade-offs:**
Trigger synonyms currently in the description aid model matching for natural-language requests; relocate them to the body rather than delete them so activation coverage is preserved.

**Verdict:** Implement after confirming triggers are preserved in the skill body.
**Estimated Effort:** medium

---

### Medium Priority

#### UIUX-003: Mixed-language UX — Portuguese command descriptions, English operator copy

**Category:** usability
**Priority Rationale:** Inconsistent language across one product surface; hits any user at the exact moments the extension speaks for itself (queueing, conflicts, errors). Moderate frequency, clear coherence/trust impact.
**Confidence:** high `[CODE-ONLY]`

**Evidence:**
- Measurement: **64 of 64** skill descriptions are Portuguese (`packaged-skills/*/SKILL.md` frontmatter).
- Code (English operator copy): `extensions/reversa.js:87` `"/${alias} queued as a follow-up"`; `:91` `"Could not activate /${alias}: ${reason}"`; `:61-64` the conflict warning, verified verbatim in `test/extension.test.js:235-238`: "Reversa alias /reversa-forward was not registered because another extension already provides it (existing). Use /skill:reversa-forward if Skill commands are enabled (default); otherwise enable \"Skill commands\" in /settings."

**Affected User Journey / Screens:**
- Follow-up queueing, activation failure, alias-conflict warning.

**Affected Code:**
- `extensions/reversa.js:61-64, 87, 91`

**Current State:**
A Portuguese-first product emits its own status/error/warning messages in English, including references to Pi UI labels ("Skill commands", "/settings") that may themselves be localized differently.

**Proposed Change:**
Localize the three notification strings to match the skills' language (Portuguese), e.g. `"/${alias} enfileirado como follow-up"`, `"Não foi possível ativar /${alias}: ${reason}"`. Keep literal Pi commands (`/settings`, `/skill:${alias}`) as-is but translate the surrounding sentence. If the package intends to support both languages, drive copy from a single language setting rather than hard-coding one.

**User Benefit:**
A single coherent language removes the jarring context switch and keeps guidance readable for the target audience.

**Risks / Trade-offs:**
Two tests assert the exact English strings (`test/extension.test.js:144, 235-238`); update them alongside the copy.

**Verdict:** Implement now.
**Estimated Effort:** small

---

### Low Priority

#### UIUX-004: Alias-conflict warning is dense and can stack per conflicting alias

**Category:** interaction
**Priority Rationale:** Rare (only on foreign-extension conflicts) but the message is long and repeats once per conflicting alias, surfacing at `session_start` when the user is not acting on it. Low frequency, low-moderate impact.
**Confidence:** high `[CODE-ONLY]`

**Evidence:**
- Code: `extensions/reversa.js:57-68` warns once per alias (`warnedAliases` guard, `:59, 65`), emitted from the `session_start` handler (`:100-102`). Exact ~230-char text verified in `test/extension.test.js:235-238`.

**Affected User Journey / Screens:**
- Session start when another extension already provides a `reversa-*` name.

**Affected Code:**
- `extensions/reversa.js:57-68`

**Current State:**
Each conflicting alias yields its own long warning at startup. Multiple conflicts produce multiple stacked long warnings, unprompted.

**Proposed Change:**
Coalesce conflicts into a single summary warning listing the affected aliases plus the one-time remediation ("use `/skill:<name>` or enable Skill commands in /settings"), rather than one paragraph per alias.

**User Benefit:**
A single, scannable startup warning instead of a stack of near-duplicate paragraphs.

**Risks / Trade-offs:**
Aggregation changes timing (one message after the loop vs. inline); the `warnedAliases` de-dup logic must move to the aggregation step. Update `test/extension.test.js:208-239` accordingly.

**Verdict:** Implement now.
**Estimated Effort:** small

## Structural Recommendations

The one genuinely structural item is **UIUX-001** (palette tiering). It touches: the registration loop in `extensions/reversa.js` (entry-point set, optional ordering/category metadata) and description leads across upstream `reversa` skills. Migration sequence: (1) decide the top-level entry-point set with the maintainer; (2) apply description-lead tagging upstream in `reversa` so `scripts/prepare-skills.js` propagates it; (3) if Pi exposes command grouping/ordering, pass it in `pi.registerCommand`. Rollback is trivial (revert to flat registration; descriptions are cosmetic). Breakage risk is limited to the copy-asserting tests (`test/extension.test.js:144, 235-238`) and user muscle-memory — command names themselves are unchanged, only prominence and description leads. No other structural change is justified; the extension's control flow is small and sound.

## Summary

| Category | Count |
|---|---|
| Usability | 2 |
| Accessibility | 0 |
| Performance Perception | 0 |
| Visual Polish | 0 |
| Interaction | 1 |
| State Handling | 0 |
| Structural | 1 |

**Total Screens/Journeys Inspected:** 0 rendered (3 code-level surfaces analyzed)
**Total Components Analyzed:** 1 extension module + 64 packaged skill descriptions
**Total Issues Found:** 4
**Findings with Visual Evidence:** 0 / 4 (no renderable interface available)
**Code-Only Findings:** 4
**Uninspected Targets/Screens/States:** All rendered states — the host Pi Coding Agent UI is external to this repository and could not be launched or attached (see Visual Inspection Limitations, including two unverified candidates excluded from findings).

> **Accessibility not assessed:** contrast, target size, focus order, keyboard flow, and reduced motion are all properties of Pi's rendering, which was not available. No accessibility claim is made. If you can run this package inside Pi, re-run this audit against the live palette/notifications to upgrade every `[CODE-ONLY]` finding with rendered evidence and to confirm or dismiss the two unverified candidates.
