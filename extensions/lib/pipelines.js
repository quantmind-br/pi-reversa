/**
 * Declarative pipeline tables.
 *
 * Only the three non-destructive pipelines are automatable: `forward` and
 * `new` end in `reversa-coding`, which writes real project source, and the
 * sandbox in `guarded-tools.js` exists precisely to forbid that.
 *
 * Stage shape:
 *   id           stable key used in `.reversa/state.json` → `completed`
 *   skill        packaged skill alias, or null for a reference/controller stage
 *   label        human label shown in progress updates
 *   fanOut       "modules" | "units" | null
 *   optional     stage may fail without aborting at itself; it does NOT make the
 *                failure acceptable to mandatory consumers downstream
 *   task         stage-specific instruction appended to the skill body
 *   dependsOn    stage ids that must have succeeded before this stage runs
 *   failPipeline `false` suppresses only the immediate abort at that stage
 *   kind         "agent" (default) | "controller"
 *   handler      controller handler name when kind === "controller"
 *   args         optional skill args for unattended modes
 *   outputs      declared artifacts; supports {{output_folder}} and {{item}}
 *   condition    surface.automation_signals flag that must be detected to run
 *   role         "review" when the stage reviews/audits produced artifacts; null otherwise
 */

/**
 * @typedef {{
 *   id: string,
 *   skill: string | null,
 *   label: string,
 *   fanOut: "modules" | "units" | null,
 *   optional: boolean,
 *   task: string,
 *   reference?: string,
 *   requires?: string,
 *   dependsOn?: string[],
 *   failPipeline?: boolean,
 *   kind?: "agent" | "controller",
 *   handler?: string,
 *   args?: string,
 *   phase?: string,
 *   role?: "review",
 *   outputs?: string[],
 *   condition?: string,
 * }} Stage
 */

import { loadDiscoveryWorkflow } from "./workflow-adapter.js";

/** @type {Record<string, { label: string, stages: Stage[] }>} */
export const PIPELINES = {
  discovery: loadDiscoveryWorkflow(),
  migrate: {
    label: "Time de Migração",
    stages: [
      {
        id: "migrate-preflight",
        skill: null,
        label: "Migrate preflight",
        fanOut: null,
        optional: false,
        failPipeline: true,
        kind: "controller",
        handler: "migrate-preflight",
        outputs: ["{{output_folder}}/migration_brief.md"],
        task: "Controller-owned migration brief from discovery output and interview answers.",
      },
      {
        id: "paradigm-advisor",
        skill: "reversa-paradigm-advisor",
        label: "Paradigm Advisor",
        fanOut: null,
        optional: false,
        failPipeline: true,
        task: "Recomende o paradigma e a stack alvo da migração. Em modo unattended, registre a recomendação e continue sem pausa.",
        outputs: ["{{output_folder}}/paradigm_decision.md"],
      },
      {
        id: "curator",
        skill: "reversa-curator",
        label: "Curator",
        fanOut: null,
        optional: false,
        dependsOn: ["paradigm-advisor"],
        failPipeline: true,
        task: "Cure o material do legado relevante para a migração. Aplique defaults de --auto para itens pendentes e registre auto-decididos.",
        outputs: ["{{output_folder}}/target_business_rules.md"],
      },
      {
        id: "strategist",
        skill: "reversa-strategist",
        label: "Strategist",
        fanOut: null,
        optional: false,
        dependsOn: ["curator"],
        failPipeline: true,
        task: "Defina a estratégia e as ondas de migração. Adote a estratégia recomendada em modo unattended.",
        outputs: [
          "{{output_folder}}/migration_strategy.md",
          "{{output_folder}}/risk_register.md",
        ],
      },
      {
        id: "designer-topology",
        skill: "reversa-designer",
        label: "Designer topology",
        fanOut: null,
        optional: false,
        dependsOn: ["strategist"],
        failPipeline: true,
        phase: "topology",
        task: "Execute somente a Fase 1 (topology). Produza topology_decision.md com recomendação explícita. Não rode a Fase 2.",
        outputs: ["{{output_folder}}/topology_decision.md"],
      },
      {
        id: "designer-architecture",
        skill: "reversa-designer",
        label: "Designer architecture",
        fanOut: null,
        optional: false,
        dependsOn: ["designer-topology"],
        failPipeline: true,
        phase: "architecture",
        task: "Execute a Fase 2 (architecture) assumindo topologyApproved=true. Produza target_architecture/domain/data e data_migration_plan.",
        outputs: ["{{output_folder}}/target_architecture.md"],
      },
      {
        id: "screen-translator-mode",
        skill: "reversa-screen-translator",
        label: "Screen Translator mode",
        fanOut: null,
        optional: false,
        dependsOn: ["designer-architecture"],
        failPipeline: true,
        phase: "mode",
        task: "Execute somente a Fase 1 (mode). Produza screen_modernization_decision.md com modo recomendado. Não rode a Fase 2.",
        outputs: ["{{output_folder}}/screen_modernization_decision.md"],
      },
      {
        id: "screen-translator-generation",
        skill: "reversa-screen-translator",
        label: "Screen Translator generation",
        fanOut: null,
        optional: false,
        dependsOn: ["screen-translator-mode"],
        failPipeline: true,
        phase: "generation",
        task: "Execute a Fase 2 (generation) assumindo screenModeApproved=true. Gere target_screens, deviations e inventory/golden quando aplicável.",
        outputs: ["{{output_folder}}/target_screens.md"],
      },
      {
        id: "inspector",
        skill: "reversa-inspector",
        label: "Inspector",
        fanOut: null,
        optional: true,
        dependsOn: ["screen-translator-generation"],
        failPipeline: false,
        role: "review",
        task: "Inspecione os artefatos de migração e gere o handoff.",
      },
      {
        id: "migrate-finalize",
        skill: null,
        label: "Migrate finalize",
        fanOut: null,
        optional: false,
        failPipeline: false,
        kind: "controller",
        handler: "migrate-finalize",
        outputs: ["{{output_folder}}/handoff.md"],
        task: "Controller-owned migration handoff and ambiguity consolidation.",
      },
    ],
  },
  docs: {
    label: "Time Reversa Docs",
    stages: [
      {
        id: "docs-config",
        skill: null,
        label: "Docs config",
        fanOut: null,
        optional: false,
        failPipeline: true,
        kind: "controller",
        handler: "docs-config",
        outputs: ["{{output_folder}}/.config.json"],
        task: "Controller-owned docs configuration derived from the interview answers.",
      },
      {
        id: "docs-vendor",
        skill: null,
        label: "Docs vendor preflight",
        fanOut: null,
        optional: false,
        failPipeline: false,
        kind: "controller",
        handler: "docs-vendor",
        task: "Controller-owned vendor download for offline docs assets.",
      },
      {
        id: "docs-mapper",
        skill: "reversa-docs-mapper",
        label: "Docs Mapper",
        fanOut: null,
        optional: false,
        dependsOn: ["docs-vendor"],
        failPipeline: true,
        task: "Monte a estrutura espacial do mini-site.",
        outputs: [
          "{{output_folder}}/arquitetura.html",
          "{{output_folder}}/modulos.html",
        ],
      },
      {
        id: "docs-analyst",
        skill: "reversa-docs-analyst",
        label: "Docs Analyst",
        fanOut: null,
        optional: false,
        dependsOn: ["docs-mapper"],
        failPipeline: true,
        task: "Produza os dados quantitativos do mini-site.",
      },
      {
        id: "docs-storyteller",
        skill: "reversa-docs-storyteller",
        label: "Docs Storyteller",
        fanOut: null,
        optional: false,
        dependsOn: ["docs-analyst"],
        failPipeline: true,
        task: "Produza a narrativa e o onboarding.",
      },
      {
        id: "docs-publisher",
        skill: "reversa-docs-publisher",
        label: "Docs Publisher",
        fanOut: null,
        optional: false,
        dependsOn: ["docs-storyteller"],
        failPipeline: true,
        task: "Integre e publique o mini-site final. Não baixe vendor nem rode smoke HTTP; o controlador faz isso.",
        outputs: ["{{output_folder}}/index.html"],
      },
      {
        id: "docs-smoke",
        skill: null,
        label: "Docs smoke",
        fanOut: null,
        optional: false,
        dependsOn: ["docs-publisher"],
        failPipeline: false,
        kind: "controller",
        handler: "docs-smoke",
        task: "Controller-owned smoke validation for generated docs.",
      },
    ],
  },
};

/** Pipeline ids exposed to the LLM. */
export const PIPELINE_IDS = Object.keys(PIPELINES);

/**
 * A stage whose job is to review/audit artifacts produced upstream.
 *
 * @param {Stage} stage
 * @returns {boolean}
 */
export const isReviewStage = (stage) => stage?.role === "review";

/**
 * Agent review stages of a pipeline, in declaration order. Controller stages
 * never run a model, so they can never belong to the group.
 *
 * @param {string} pipeline
 * @returns {Stage[]}
 */
export const reviewStages = (pipeline) =>
  (PIPELINES[pipeline]?.stages ?? []).filter(
    (stage) => (stage.kind ?? "agent") !== "controller" && isReviewStage(stage),
  );
