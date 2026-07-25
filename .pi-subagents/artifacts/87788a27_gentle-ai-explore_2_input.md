# Task for gentle-ai-explore

Read-only exploration of repository root /home/diogo/dev/pi-reversa.

## Skills to load before work
None required.

## Assigned scope: CONVENTIONS
Discover naming, formatting, error handling, async/state patterns, generated vs vendor boundaries, docs conventions from representative source and tests.

Focus on:
- extensions/**/*.js style (ESM, exports, error handling)
- test/** patterns and fixtures
- packaged-skills SKILL.md conventions (frontmatter, language)
- .agents/skills local skills if any
- generated boundaries: packaged-skills vs source skills symlink
- any human policy files (nested AGENTS.md outside node_modules, CONTRIBUTING, etc.)
- IDEATION_UI_UX.md relevance (note only if operational)

## Rules
- FORBIDDEN: edits, commits, nested delegation, unsupported claims
- Prefer structural listing + targeted reads of 5-15 representative files
- Base every finding on observed evidence with paths

## Required handoff format
1. Findings (bullets)
2. Supporting paths
3. Exact commands run and source of each claim
4. Conflicts / uncertainties
5. Recommended AGENTS.md clauses for conventions and agent operating notes

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```