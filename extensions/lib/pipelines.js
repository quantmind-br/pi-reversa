/**
 * Declarative pipeline tables.
 *
 * Only the three non-destructive pipelines are automatable: `forward` and
 * `new` end in `reversa-coding`, which writes real project source, and the
 * sandbox in `guarded-tools.js` exists precisely to forbid that.
 *
 * Stage shape:
 *   id       stable key used in `.reversa/state.json` → `completed`
 *   skill    packaged skill alias, or null for a reference-driven stage
 *   label    human label shown in progress updates
 *   fanOut   "modules" expands to one run per Scout module; null runs once
 *   task     stage-specific instruction appended to the skill body
 */

/** @typedef {{ id: string, skill: string | null, label: string, fanOut: "modules" | null, optional: boolean, task: string, reference?: string, requires?: string }} Stage */

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
        task: "Execute o mapeamento de superfície completo do projeto e gere `.reversa/context/surface.json` com o campo `modules` preenchido.",
      },
      {
        id: "archaeologist",
        skill: "reversa-archaeologist",
        label: "Archaeologist",
        fanOut: "modules",
        optional: false,
        task: "Execute a escavação de código.",
      },
      {
        id: "detective",
        skill: "reversa-detective",
        label: "Detective",
        fanOut: null,
        optional: false,
        task: "Execute a investigação de regras de negócio e histórico.",
      },
      {
        id: "architect",
        skill: "reversa-architect",
        label: "Architect",
        fanOut: null,
        optional: false,
        task: "Execute a reconstrução arquitetural.",
      },
      {
        id: "writer",
        skill: "reversa-writer",
        label: "Writer",
        fanOut: null,
        optional: false,
        task: "Gere as especificações SDD finais.",
      },
      {
        id: "reviewer",
        skill: "reversa-reviewer",
        label: "Reviewer",
        fanOut: null,
        optional: true,
        task: "Revise as specs geradas e registre os vereditos.",
      },
      {
        id: "regression-check",
        skill: null,
        label: "Regression check",
        fanOut: null,
        optional: true,
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
        task: "Recomende o paradigma e a stack alvo da migração.",
      },
      {
        id: "curator",
        skill: "reversa-curator",
        label: "Curator",
        fanOut: null,
        optional: false,
        task: "Cure o material do legado relevante para a migração.",
      },
      {
        id: "strategist",
        skill: "reversa-strategist",
        label: "Strategist",
        fanOut: null,
        optional: false,
        task: "Defina a estratégia e as ondas de migração.",
      },
      {
        id: "designer",
        skill: "reversa-designer",
        label: "Designer",
        fanOut: null,
        optional: false,
        task: "Projete a arquitetura alvo.",
      },
      {
        id: "screen-translator",
        skill: "reversa-screen-translator",
        label: "Screen Translator",
        fanOut: null,
        optional: false,
        task: "Traduza as telas do legado para a stack alvo.",
      },
      {
        id: "inspector",
        skill: "reversa-inspector",
        label: "Inspector",
        fanOut: null,
        optional: true,
        task: "Inspecione os artefatos de migração e gere o handoff.",
      },
    ],
  },
  docs: {
    label: "Time Reversa Docs",
    stages: [
      {
        id: "docs-mapper",
        skill: "reversa-docs-mapper",
        label: "Docs Mapper",
        fanOut: null,
        optional: false,
        task: "Monte a estrutura espacial do mini-site.",
      },
      {
        id: "docs-analyst",
        skill: "reversa-docs-analyst",
        label: "Docs Analyst",
        fanOut: null,
        optional: false,
        task: "Produza os dados quantitativos do mini-site.",
      },
      {
        id: "docs-storyteller",
        skill: "reversa-docs-storyteller",
        label: "Docs Storyteller",
        fanOut: null,
        optional: false,
        task: "Produza a narrativa e o onboarding.",
      },
      {
        id: "docs-publisher",
        skill: "reversa-docs-publisher",
        label: "Docs Publisher",
        fanOut: null,
        optional: false,
        task: "Integre e publique o mini-site final.",
      },
    ],
  },
};

/** Pipeline ids exposed to the LLM. */
export const PIPELINE_IDS = Object.keys(PIPELINES);
