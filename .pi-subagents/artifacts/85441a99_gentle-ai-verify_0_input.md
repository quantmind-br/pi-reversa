# Task for gentle-ai-verify

Read-only technical verification of /home/diogo/dev/pi-reversa/AGENTS.md against the repository at /home/diogo/dev/pi-reversa.

## Skills to load before work
None required.

## Scope
Verify the newly written root AGENTS.md. Rules:
- FORBIDDEN: edits, commits, nested delegation
- Do NOT run full builds or full test suites
- Use static evidence and safe probes only

## Checks required
1. Every referenced path in AGENTS.md exists (or is correctly described as generated/runtime-only).
2. Every documented command is supported by package.json scripts, README, or other repo evidence.
3. Runtime/package-manager claims agree across package.json, package-lock.json, engines, lockfiles.
4. No contradictions, unsupported claims, excessive generic advice, or secrets.
5. Document is titled "# Repository Guidelines" and stays operationally useful.

## Method
- Read AGENTS.md fully
- Cross-check package.json, README.md, .gitignore, scripts/prepare-skills.js, extensions layout, test layout, pipelines PIPELINE_IDS
- For each claim, mark Verified / Weakened / Falsified with evidence path

## Required output format
1. FINDING rows: claim | tag | evidence
2. List of corrections needed (if any) with exact suggested replacement text
3. Overall pass/fail for publication readiness

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