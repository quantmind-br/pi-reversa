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
 *   optional     optional stages may fail without failing the whole pipeline
 *   task         stage-specific instruction appended to the skill body
 *   dependsOn    stage ids that must have succeeded before this stage runs
 *   failPipeline if true, a failed stage aborts remaining dependent work
 *   kind         "agent" (default) | "controller"
 *   handler      controller handler name when kind === "controller"
 *   args         optional skill args for unattended modes
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
 * }} Stage
 */

/** @type {Record<string, { label: string, stages: Stage[] }>} */
export const PIPELINES = {
  discovery: {
    label: "Time de Descoberta",
    stages: [
      {
        id: "scout",
        skill: "reversa-scout",
        label: "Scout",
        fanOut: null,
        optional: false,
        failPipeline: true,
        task: "Execute o mapeamento de superfície completo do projeto e gere `.reversa/context/surface.json` com o campo `modules` preenchido.",
      },
      {
        id: "archaeologist",
        skill: "reversa-archaeologist",
        label: "Archaeologist",
        fanOut: "modules",
        optional: false,
        dependsOn: ["scout"],
        failPipeline: true,
        task: "Execute a escavação de código.",
      },
      {
        id: "detective",
        skill: "reversa-detective",
        label: "Detective",
        fanOut: null,
        optional: false,
        dependsOn: ["archaeologist"],
        failPipeline: true,
        task: "Execute a investigação de regras de negócio e histórico.",
      },
      {
        id: "architect",
        skill: "reversa-architect",
        label: "Architect",
        fanOut: null,
        optional: false,
        dependsOn: ["detective"],
        failPipeline: true,
        task: "Execute a reconstrução arquitetural.",
      },
      {
        id: "writer",
        skill: "reversa-writer",
        label: "Writer",
        fanOut: "units",
        optional: false,
        dependsOn: ["architect"],
        failPipeline: true,
        args: "--unattended",
        task: "Gere as especificações SDD da unit solicitada em modo unattended.",
      },
      {
        id: "writer-globals",
        skill: "reversa-writer",
        label: "Writer globals",
        fanOut: null,
        optional: false,
        dependsOn: ["writer"],
        failPipeline: true,
        args: "--globals --unattended",
        task: "Gere os artefatos globais de rastreabilidade (globals) em modo unattended.",
      },
      {
        id: "reviewer",
        skill: "reversa-reviewer",
        label: "Reviewer",
        fanOut: null,
        optional: true,
        dependsOn: ["writer-globals"],
        failPipeline: false,
        task: "Revise as specs geradas e registre os vereditos.",
      },
      {
        id: "regression-check",
        skill: null,
        label: "Regression check",
        fanOut: null,
        optional: true,
        dependsOn: ["reviewer"],
        failPipeline: false,
        reference: "reversa/references/step-04-regression-check.md",
        requires: "regression-watch",
        task: "Execute a verificação de regressão semântica seguindo integralmente o documento de referência indicado acima.",
      },
    ],
  },
  migrate: {
    label: "Time de Migração",
    stages: [
      {
        id: "paradigm-advisor",
        skill: "reversa-paradigm-advisor",
        label: "Paradigm Advisor",
        fanOut: null,
        optional: false,
        failPipeline: true,
        task: "Recomende o paradigma e a stack alvo da migração. Em modo unattended, registre a recomendação e continue sem pausa.",
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
      },
      {
        id: "inspector",
        skill: "reversa-inspector",
        label: "Inspector",
        fanOut: null,
        optional: true,
        dependsOn: ["screen-translator-generation"],
        failPipeline: false,
        task: "Inspecione os artefatos de migração e gere o handoff.",
      },
    ],
  },
  docs: {
    label: "Time Reversa Docs",
    stages: [
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
