import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { containsPath, createSandboxGuard, WriteOutsideSandboxError } from "./guarded-tools.js";
import { PIPELINES } from "./pipelines.js";
import { acquireExclusiveLock, automationLockPath } from "./locks.js";
import {
  atomicWrite,
  DEFAULT_OUTPUT_FOLDER,
  isSafeOutputFolder,
  listArchaeologistModules,
  listScoutModules,
  normalizeSurfaceLocation,
  readOrganizationSuggestion,
  readState,
  readSurface,
  resolveProjectLayout,
  setActiveSpecSource,
  validateSurface,
  writeSpecsSection,
  writeState,
} from "./reversa-state.js";
import {
  DEFAULT_SPECS_ROOT,
  getPipelineWriteRoots,
  listRegressionWatchPaths,
} from "reversa/paths/layout.js";
import {
  createCodeIntelSession,
  ensureIndexedAndMaterialized,
  statusSnapshot,
  writeSessionEvents,
} from "./code-intelligence/index.js";
import { buildSkillBlock, stripFrontmatter } from "./skill-block.js";
import { runSubagent as defaultRunSubagent } from "./subagent.js";
import { ensureDocsVendors, smokeTestDocs } from "./docs-assets.js";

/** Parallel Archaeologists / Writers. Modules/units write disjoint files. */
export const DEFAULT_FANOUT_CONCURRENCY = 3;

const REPORT_LIMIT = 12_000;

/**
 * Minimum gap between two shard activity events. Lifecycle transitions
 * (`running`, `done`, `failed`) are always emitted; only the per-tool-call
 * heartbeat is rate-limited, because a busy child repaints the TUI otherwise.
 */
const ACTIVITY_THROTTLE_MS = 1_000;

/** Migrate stages whose unattended gate must be auto-approved before running. */
const MIGRATE_AUTO_GATES = {
  "designer-architecture": "topology",
  "screen-translator-generation": "screen",
};

/**
 * @deprecated Pipeline roots now come from resolveProjectLayout + getPipelineWriteRoots.
 * Kept as an empty map for older tests that still import the symbol.
 */
export const PIPELINE_EXTRA_ROOTS = {};

/**
 * Sandbox roots subagents of `pipeline` may write to.
 *
 * @param {string} cwd
 * @param {string | Record<string, any>} folderOrState
 * @param {string} [pipeline]
 * @param {Record<string, any>} [state]
 * @returns {string[]}
 */
export function sandboxRoots(cwd, folderOrState, pipeline = "discovery", state) {
  const base = resolve(cwd);
  const sourceState =
    state && typeof state === "object"
      ? state
      : folderOrState && typeof folderOrState === "object"
        ? folderOrState
        : { output_folder: folderOrState };

  const layout = resolveProjectLayout(sourceState, cwd);
  if (typeof folderOrState === "string" && !isSafeOutputFolder(folderOrState)) {
    layout.folders.discovery = DEFAULT_OUTPUT_FOLDER;
    layout.output_folder = DEFAULT_OUTPUT_FOLDER;
  } else if (typeof folderOrState === "string" && isSafeOutputFolder(folderOrState) && !sourceState.folders) {
    if (pipeline === "discovery") layout.folders.discovery = folderOrState.trim();
  }

  /** @type {string[]} */
  let names = getPipelineWriteRoots(
    {
      ...layout,
      folders: layout.folders,
      output_folder: layout.output_folder,
      forward_folder: layout.forward_folder,
    },
    pipeline === "migrate" ? "migration" : pipeline,
  );

  // Closed extra roots for Screen Translator / design-system tokens.
  // Kept local to pi-reversa so we do not depend on upstream layout patches.
  if (pipeline === "migrate" || pipeline === "migration") {
    const migration = String(layout.folders.migration ?? ".specs/migration").replace(/\\/g, "/").replace(/\/$/, "");
    const discovery = String(layout.folders.discovery ?? ".specs/discovery").replace(/\\/g, "/").replace(/\/$/, "");
    const screens = migration.endsWith("/migration")
      ? `${migration.slice(0, -"/migration".length)}/screens`
      : migration === "migration"
        ? "screens"
        : ".specs/screens";
    const designSystem = discovery.includes("/") ? `${discovery}/design-system` : ".specs/design-system";
    names.push(screens, designSystem);
  }

  if (pipeline === "regression-check") {
    names = names.filter((name) => name !== layout.forward_folder);
    names.push(...listRegressionWatchPaths(cwd, layout.forward_folder));
  }

  return [...new Set(names)].map((name) => join(base, name));
}

/**
 * @param {string} cwd
 * @param {Record<string, any>} [state]
 */
export function hasRegressionWatch(cwd, state = {}) {
  const layout = resolveProjectLayout(state, cwd);
  return listRegressionWatchPaths(cwd, layout.forward_folder).length > 0;
}

/**
 * Folder names the Writer fans out over.
 *
 * Order: explicit `custom_folders`, the Scout's suggested features, the
 * Scout's `modules`, then the Archaeologist's `.reversa/context/modules.json`.
 * The last one only matters when the Scout emitted an off-contract surface —
 * the Writer always runs after the Archaeologist, so the file is available and
 * is structured module identity, not heuristic evidence.
 *
 * @param {string} cwd
 * @param {Record<string, any>} state
 * @returns {string[]}
 */
export function listWriterUnits(cwd, state = {}) {
  const surface = readSurface(cwd) ?? {};
  const specs = readSpecsChoice(cwd, state);
  if (specs.granularity === "custom" && Array.isArray(specs.custom_folders) && specs.custom_folders.length > 0) {
    return specs.custom_folders.map(slug).filter(Boolean);
  }
  const features = readOrganizationSuggestion(surface)?.features ?? [];
  if (Array.isArray(features) && features.length > 0) {
    return features.map((entry) => (typeof entry === "string" ? entry : entry?.name)).map(slug).filter(Boolean);
  }
  const scouted = listScoutModules(surface).map(slug).filter(Boolean);
  if (scouted.length > 0) return scouted;
  return listArchaeologistModules(cwd).map(slug).filter(Boolean);
}

/**
 * @param {string} cwd
 * @param {Record<string, any>} state
 */
function readSpecsChoice(cwd, state) {
  try {
    const configPath = join(resolve(cwd), ".reversa", "config.toml");
    if (!existsSync(configPath)) {
      return {
        granularity: state.specs_choice ?? "module",
        custom_folders: state.custom_folders ?? [],
      };
    }
    const raw = readFileSync(configPath, "utf8");
    let granularity = state.specs_choice ?? "";
    /** @type {string[]} */
    let custom = Array.isArray(state.custom_folders) ? state.custom_folders : [];
    let inSpecs = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inSpecs = trimmed === "[specs]";
        continue;
      }
      if (!inSpecs || !trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (!match) continue;
      if (match[1] === "granularity") granularity = match[2].trim().replace(/^["']|["']$/g, "");
      if (match[1] === "custom_folders") {
        custom = [...match[2].matchAll(/"([^"]*)"|'([^']*)'/g)].map((entry) => entry[1] ?? entry[2]).filter(Boolean);
      }
    }
    return { granularity: granularity || "module", custom_folders: custom };
  } catch {
    return { granularity: state.specs_choice ?? "module", custom_folders: state.custom_folders ?? [] };
  }
}

/**
 * @param {unknown} value
 */
function slug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {import("./pipelines.js").Stage[]} stages
 * @param {string[]} modules
 * @param {string[]} units
 */
export function expandStages(stages, modules, units = []) {
  const expanded = [];
  for (const stage of stages) {
    if (stage.fanOut === "modules" && modules.length > 0) {
      for (const module of modules) expanded.push({ stage, module, unit: null, key: `${stage.id}:${module}` });
    } else if (stage.fanOut === "units" && units.length > 0) {
      for (const unit of units) expanded.push({ stage, module: null, unit, key: `${stage.id}:${unit}` });
    } else {
      expanded.push({ stage, module: null, unit: null, key: stage.id });
    }
  }
  return expanded;
}

/**
 * @param {object} input
 * @returns {string}
 */
export function buildStageTask({
  stage,
  module,
  unit,
  skillEntry,
  state,
  folder,
  writableRoots,
  skillsDir,
  codeIntelAvailable = false,
}) {
  const sections = [];

  if (stage.skill && skillEntry) {
    const body = stripFrontmatter(readFileSync(skillEntry.path, "utf8"));
    sections.push(buildSkillBlock(stage.skill, skillEntry.path, skillEntry.baseDir, body));
  }

  if (stage.reference && skillsDir) {
    sections.push(
      `Leia e siga integralmente o documento de referência: ${join(skillsDir, stage.reference)}`,
    );
  }

  const codeIntelLines = codeIntelAvailable
    ? [
        "- A ferramenta `reversa_code_intel` está disponível. Use-a para descoberta estrutural (architecture/symbols/traces).",
        "- Trate resultados do grafo como descoberta. Confirme claims materiais com `read` no source atual.",
        "- Claims negativas exigem fallback textual quando a cobertura for parcial/ausente.",
      ]
    : [
        "- `reversa_code_intel` pode estar indisponível; use read/grep/find/ls e confirme tudo no source.",
      ];

  const specsRoot = String(state.specs_root ?? DEFAULT_SPECS_ROOT);

  sections.push(
    [
      "## Contexto da execução autônoma",
      `- Projeto: ${state.project ?? "(não informado)"}   Usuário: ${state.user_name ?? "(não informado)"}`,
      `- Idioma do chat: ${state.chat_language ?? "pt-BR"}   Idioma das specs: ${state.doc_language ?? "pt-BR"}`,
      `- Nível de documentação: ${state.doc_level ?? "essencial"}`,
      `- Pasta de saída: ${folder}`,
      `- answer_mode = file: NUNCA pergunte nada. Toda dúvida vai para ${folder}/questions.md com contexto e marcador 🔴 LACUNA na spec correspondente.`,
      "- Você não tem `bash`. Para histórico de git use a ferramenta `reversa_git`.",
      ...codeIntelLines,
      `- Escreva APENAS em ${(writableRoots ?? [".reversa", folder]).map((root) => (root.endsWith(".md") ? root : `${root}/`)).join(", ")}. Escritas fora disso falham por design.`,
      ...(folder !== specsRoot
        ? [
            `- Caminhos legados: o corpo do skill cita \`${specsRoot}/<resto>\`. Reescreva cada um para \`${folder}/<resto>\` antes de escrever. Exceção: \`surface.json\` é sempre \`.reversa/context/surface.json\`, nunca dentro de \`${folder}\`.`,
          ]
        : []),
      "- Não peça CONTINUAR, não ofereça /clear, não sugira próximos passos interativos.",
      "- Ao terminar, responda com um resumo de no máximo 20 linhas: artefatos criados, contagens 🟢/🟡/🔴, e avisos.",
    ].join("\n"),
  );

  const scopeLine = module
    ? `\nAnalise exclusivamente o módulo \`${module}\`.`
    : unit
      ? `\nGere exclusivamente a unit \`${unit}\`${stage.args ? ` (args: ${stage.args})` : ""}.`
      : stage.args
        ? `\nArgs: ${stage.args}`
        : "";
  sections.push(`## Tarefa\n${stage.task}${scopeLine}`);

  return sections.join("\n\n");
}

/**
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @param {() => boolean} [shouldStop] polled before each launch; stops new launches
 */
async function withConcurrency(tasks, limit, shouldStop = () => false) {
  const results = new Array(tasks.length).fill(undefined);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} answers
 */
export function mergeAnswers(state, answers) {
  const merged = { ...state };
  for (const [key, value] of Object.entries(answers)) {
    if (value === undefined || value === null || value === "") continue;
    merged[key] = value;
  }
  merged.answer_mode = "file";
  return merged;
}

/**
 * @param {Set<string>} succeededStageIds
 * @param {import("./pipelines.js").Stage} stage
 * @param {Array<{ id: string, status: string }>} stageResults
 */
function dependenciesSatisfied(succeededStageIds, stage, stageResults) {
  const dependsOn = stage.dependsOn ?? [];
  if (dependsOn.length === 0) return { ok: true };
  for (const dep of dependsOn) {
    if (succeededStageIds.has(dep)) continue;
    const failedDep = stageResults.find((entry) => entry.id === dep || entry.id.startsWith(`${dep}:`));
    if (failedDep && failedDep.status === "failed") {
      return { ok: false, reason: `dependência falhou: ${dep}` };
    }
    // If dependency was skipped optionally, allow optional dependents; otherwise block.
    if (failedDep && failedDep.status === "skipped") {
      return { ok: false, reason: `dependência ausente/skipped: ${dep}` };
    }
    return { ok: false, reason: `dependência não concluída: ${dep}` };
  }
  return { ok: true };
}

/**
 * Is a conditional stage enabled by the Scout's surface signals?
 *
 * The schema is `automation_signals.<flag>.detected`
 * (`reversa-scout/references/surface-schema.md:41`), but the Scout skill body
 * describes the flags in prose ("`design`: true quando…"), so real runs also
 * emit `{present: true, evidence: [...]}` or a plain boolean. All three are
 * accepted; a top-level `capabilities` map keeps hand-written surfaces working.
 * No signal at all → the stage is skipped.
 *
 * @param {string | undefined} condition
 * @param {Record<string, any> | null | undefined} surface
 */
function conditionMet(condition, surface) {
  if (!condition) return true;
  const signal = surface?.automation_signals?.[condition];
  if (signal === true || signal?.detected === true || signal?.present === true) return true;
  if (surface?.capabilities?.[condition] === true) return true;
  // Older/looser Scout output puts the flags at the top level of the surface.
  return surface?.[condition] === true;
}

/**
 * Expand a stage's declared output contract into project-relative paths.
 *
 * A fan-out stage that collapsed to a single item-less run has no `{{item}}`
 * to substitute; templating it to `""` would fabricate a path with an empty
 * segment (`.specs/discovery//requirements.md`) that can never exist. Such
 * templates are dropped, exactly like any other unresolved placeholder.
 *
 * @param {import("./pipelines.js").Stage} stage
 * @param {{ folder: string, item?: string | null }} context
 * @returns {string[]}
 */
export function resolveStageOutputs(stage, { folder, item }) {
  if (!Array.isArray(stage.outputs) || stage.outputs.length === 0) return [];
  const hasItem = typeof item === "string" && item.trim().length > 0;
  return stage.outputs
    .filter((template) => hasItem || !template.includes("{{item}}"))
    .map((template) =>
      template.replaceAll("{{output_folder}}", folder).replaceAll("{{item}}", item ?? ""),
    )
    .filter((path) => !path.includes("{{"));
}

/**
 * @param {string} cwd
 * @param {string[]} outputs
 * @returns {string[]} outputs missing, empty, or escaping the project
 */
function missingStageOutputs(cwd, outputs) {
  const base = resolve(cwd);
  return outputs.filter((relPath) => {
    const abs = resolve(base, relPath);
    if (!containsPath(base, abs)) return true;
    try {
      return statSync(abs).size === 0;
    } catch {
      return true;
    }
  });
}

/**
 * Execute a whole Reversa pipeline under the per-project automation lock.
 *
 * Only one unattended run may touch `.reversa/` at a time: concurrent runs
 * would interleave `state.completed` writes and corrupt resume semantics.
 *
 * @param {object} options
 */
export async function runPipeline(options) {
  const { cwd, pipeline } = options;
  const lockPath = automationLockPath(cwd);
  /** @type {(() => void) | undefined} */
  let releaseLock;
  try {
    releaseLock = acquireExclusiveLock(lockPath, {
      staleMs: 6 * 60 * 60 * 1000,
      label: "reversa automation",
      containRoot: cwd,
    });
  } catch (error) {
    // A symlinked `.reversa` would otherwise place the lock file outside the
    // project before any pipeline sandbox validation ran.
    if (error instanceof WriteOutsideSandboxError) {
      return {
        stages: [],
        warnings: [`Execução interrompida por violação de sandbox: ${error.message}`],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        aborted: true,
        status: "blocked",
        runDir: null,
        report: `# Reversa — pipeline \`${pipeline}\`\n\n❌ Sandbox violada antes de iniciar: ${error.message}`,
      };
    }
    if (error?.code !== "lock_busy") throw error;
    return {
      stages: [],
      warnings: [`Outra execução Reversa está ativa neste projeto: ${lockPath}`],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      aborted: true,
      status: "blocked",
      runDir: null,
      report: `# Reversa — pipeline \`${pipeline}\`\n\n❌ Lock ocupado. Aguarde a execução em andamento ou remova \`.reversa/automation.lock\` se ela morreu.`,
    };
  }

  try {
    return await runPipelineLocked(options);
  } finally {
    releaseLock?.();
  }
}

/**
 * @param {object} options
 */
async function runPipelineLocked({
  cwd,
  pipeline,
  answers,
  skillIndex,
  model,
  thinkingLevel,
  concurrency = DEFAULT_FANOUT_CONCURRENCY,
  resume = false,
  skillsDir,
  signal,
  onProgress,
  runSubagent = defaultRunSubagent,
  stageModels = {},
  stageModelLabels = {},
  stageModelWarnings = [],
}) {
  const definition = PIPELINES[pipeline];
  if (!definition) throw new Error(`unknown pipeline: ${pipeline}`);
  const startedAt = new Date().toISOString();

  /** @type {string[]} */
  const warnings = [...stageModelWarnings];
  /** @type {any[]} */
  const stages = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let aborted = false;
  let sandboxViolation = null;
  /** @type {string} */
  let status = "completed";

  let state = mergeAnswers(readState(cwd), answers);
  state.phase = state.phase ?? "reconhecimento";

  if (state.output_folder !== undefined && !isSafeOutputFolder(state.output_folder)) {
    warnings.push(
      `output_folder inválido em .reversa/state.json (${JSON.stringify(state.output_folder)}); usando \`${DEFAULT_OUTPUT_FOLDER}\`.`,
    );
    delete state.output_folder;
  }

  const layout = resolveProjectLayout(state, cwd);
  warnings.push(...layout.warnings);
  state.layout_mode = layout.layout_mode;
  state.specs_root = layout.specs_root;
  state.folders = layout.folders;
  state.forward_folder = layout.forward_folder;

  if (pipeline === "discovery") {
    setActiveSpecSource(state, "discovery");
  } else {
    state.output_folder = layout.output_folder;
    state.active_spec_source = layout.active_spec_source;
  }

  const folder =
    pipeline === "docs"
      ? state.folders.docs
      : pipeline === "migrate"
        ? state.folders.migration
        : state.output_folder;

  const roots = sandboxRoots(cwd, state, pipeline, state);
  const rootNames = roots.map((root) => relative(resolve(cwd), root) || ".");
  const guard = createSandboxGuard(cwd, roots);
  const recoverSurface = () => {
    const recovery = normalizeSurfaceLocation(cwd, folder, guard);
    if (recovery.recovered) {
      warnings.push(
        `surface.json encontrado em \`${recovery.from}\`; cópia canônica atualizada em \`.reversa/context/surface.json\`.`,
      );
    }
  };

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(resolve(cwd), ".reversa", "runs", runId);

  try {
    mkdirSync(guard(runDir), { recursive: true });
    writeState(cwd, state, guard);
    recoverSurface();
  } catch (error) {
    if (!(error instanceof WriteOutsideSandboxError)) throw error;
    return {
      stages: [],
      warnings: [`Execução interrompida por violação de sandbox: ${error.message}`],
      usage,
      cost,
      aborted: true,
      status: "blocked",
      runDir,
      report: `# Reversa — pipeline \`${pipeline}\`\n\n❌ Sandbox violada antes de iniciar: ${error.message}`,
    };
  }

  // Controller-owned code intelligence preflight/materialization.
  /** @type {any} */
  let codeIntel = null;
  try {
    codeIntel = await createCodeIntelSession({ projectRoot: cwd, signal });
    if (codeIntel.available) {
      codeIntel = await ensureIndexedAndMaterialized(codeIntel, { signal });
    } else {
      warnings.push(`code intelligence unavailable: ${codeIntel.reason ?? "unknown"}`);
    }
    writeSessionEvents(runDir, codeIntel, guard);
  } catch (error) {
    // Degraded code intelligence is tolerable; escaping the project is not.
    if (error instanceof WriteOutsideSandboxError) {
      return {
        stages: [],
        warnings: [...warnings, `Execução interrompida por violação de sandbox: ${error.message}`],
        usage,
        cost,
        aborted: true,
        status: "blocked",
        runDir,
        report: `# Reversa — pipeline \`${pipeline}\`\n\n❌ Sandbox violada antes de iniciar: ${error.message}`,
      };
    }
    warnings.push(`code intelligence preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const completed = new Set(Array.isArray(state.completed) ? state.completed : []);
  /** @type {Set<string>} */
  const succeededStageIds = new Set(
    [...completed].filter((key) => !String(key).includes(":")),
  );

  const plannedStages = definition.stages;
  let index = 0;
  const total = plannedStages.length;

  for (const stage of plannedStages) {
    index += 1;
    if (signal?.aborted) {
      aborted = true;
      status = "aborted";
      break;
    }

    const dependency = dependenciesSatisfied(succeededStageIds, stage, stages);
    if (!dependency.ok) {
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "skipped",
        reason: dependency.reason,
      });
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      if (stage.failPipeline !== false && !stage.optional) {
        status = "failed";
        aborted = true;
        warnings.push(`${stage.label} bloqueada: ${dependency.reason}`);
        break;
      }
      status = status === "completed" ? "completed_with_gaps" : status;
      continue;
    }

    if (stage.requires === "regression-watch" && !hasRegressionWatch(cwd, state)) {
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "skipped",
        reason: `nenhum ${state.forward_folder}/*/regression-watch.md`,
      });
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    if (stage.condition && !conditionMet(stage.condition, readSurface(cwd))) {
      const reason = `condição \`${stage.condition}\` não sinalizada em surface.automation_signals`;
      stages.push({ id: stage.id, label: stage.label, status: "skipped", reason });
      warnings.push(`${stage.label}: estágio de enriquecimento pulado — ${reason}`);
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    if (stage.skill && !skillIndex.has(stage.skill)) {
      const missing = `skill \`${stage.skill}\` não está instalada`;
      if (stage.failPipeline !== false && !stage.optional) {
        stages.push({ id: stage.id, label: stage.label, status: "failed", reason: missing });
        warnings.push(`${stage.label} falhou: ${missing}`);
        onProgress?.({ stage: stage.label, index, total, status: "failed" });
        status = "failed";
        aborted = true;
        break;
      }
      stages.push({ id: stage.id, label: stage.label, status: "skipped", reason: missing });
      warnings.push(`Etapa ${stage.label} pulada: ${missing}`);
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    if (stage.kind === "controller") {
      onProgress?.({ stage: stage.label, index, total, status: "start", runs: 1 });
      try {
        const controllerResult = await runControllerStage({
          stage,
          cwd,
          folder,
          skillsDir,
          guard,
          runDir,
          state,
        });
        stages.push({
          id: stage.id,
          label: stage.label,
          status: controllerResult.ok ? "done" : "failed",
          reason: controllerResult.reason,
        });
        if (controllerResult.ok) {
          completed.add(stage.id);
          succeededStageIds.add(stage.id);
        } else {
          warnings.push(`${stage.label}: ${controllerResult.reason}`);
          if (stage.failPipeline !== false && !stage.optional) {
            status = "failed";
            aborted = true;
            break;
          }
          status = status === "completed" ? "completed_with_gaps" : status;
        }
        state.completed = [...completed];
        state.phase = stage.id;
        writeState(cwd, state, guard);
        onProgress?.({
          stage: stage.label,
          index,
          total,
          status: controllerResult.ok ? "done" : "failed",
        });
      } catch (error) {
        // A sandbox violation is never an ordinary stage failure: it stops the
        // run as `blocked`, exactly like the agent path, regardless of
        // `optional` / `failPipeline`.
        if (error instanceof WriteOutsideSandboxError) {
          sandboxViolation = error;
          stages.push({
            id: stage.id,
            label: stage.label,
            status: "failed",
            reason: `sandbox: ${error.message}`,
          });
          warnings.push(`Execução interrompida por violação de sandbox: ${error.message}`);
          onProgress?.({ stage: stage.label, index, total, status: "failed" });
          status = "blocked";
          aborted = true;
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        stages.push({ id: stage.id, label: stage.label, status: "failed", reason });
        warnings.push(`${stage.label} falhou: ${reason}`);
        onProgress?.({ stage: stage.label, index, total, status: "failed" });
        if (stage.failPipeline !== false && !stage.optional) {
          status = "failed";
          aborted = true;
          break;
        }
        status = status === "completed" ? "completed_with_gaps" : status;
      }
      continue;
    }

    // Auto-approve migrate phase gates before architecture/generation stages.
    if (pipeline === "migrate" && MIGRATE_AUTO_GATES[stage.id]) {
      try {
        autoApproveMigrationPhase(cwd, folder, MIGRATE_AUTO_GATES[stage.id], warnings, guard);
      } catch (error) {
        if (error instanceof WriteOutsideSandboxError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`${stage.label}: auto-aprovação de fase falhou: ${reason}`);
        stages.push({ id: stage.id, label: stage.label, status: "failed", reason });
        onProgress?.({ stage: stage.label, index, total, status: "failed" });
        if (stage.failPipeline !== false && !stage.optional) {
          status = "failed";
          aborted = true;
          break;
        }
        status = status === "completed" ? "completed_with_gaps" : status;
        continue;
      }
    }

    const modules = stage.fanOut === "modules" ? listScoutModules(readSurface(cwd)) : [];
    const units = stage.fanOut === "units" ? listWriterUnits(cwd, state) : [];
    if (stage.fanOut === "modules" && modules.length === 0) {
      warnings.push(
        `${stage.label}: nenhum módulo em .reversa/context/surface.json nem em ${folder}/surface.json; executando uma única vez.`,
      );
    }
    if (stage.fanOut === "units" && units.length === 0) {
      warnings.push(
        `${stage.label}: nenhuma unit em .reversa/context/surface.json nem em .reversa/context/modules.json; executando uma única vez, sem validação de outputs por unit.`,
      );
    }

    const runs = expandStages([stage], modules, units);
    const pending = runs.filter((run) => !(resume && completed.has(run.key)));
    for (const run of runs) {
      if (pending.includes(run)) continue;
      stages.push({ id: run.key, label: stage.label, status: "skipped", reason: "já concluída (resume)", resumed: true });
    }
    if (pending.length === 0) {
      succeededStageIds.add(stage.id);
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    /** Settled shards in this stage; drives the aggregate `runsDone/runs` counter. */
    let doneRuns = 0;
    const runsTotal = pending.length;

    /**
     * Single emission point for every shard-level event, so the payload shape
     * cannot drift between the lifecycle and activity paths. `stage` stays the
     * human label for backwards compatibility; `stageId`/`runKey`/`item` are
     * the machine-readable identity a renderer needs to keep one row per shard.
     */
    const emitRun = (label, run, status, extra) => {
      onProgress?.({
        stage: label,
        stageId: stage.id,
        runKey: run.key,
        item: run.module ?? run.unit ?? null,
        index,
        total,
        runs: runsTotal,
        runsDone: doneRuns,
        status,
        ...extra,
      });
    };

    onProgress?.({
      stage: stage.label,
      stageId: stage.id,
      index,
      total,
      status: "start",
      runs: runsTotal,
      runsDone: 0,
      model: stageModelLabels[stage.id] ?? null,
    });

    let fanOutStopped = false;

    /**
     * One shard: everything between launch and a settled result. Kept as a
     * nested function so the wrapper below owns emission and the closure state
     * (`sandboxViolation`, `warnings`, `usage`, …) stays shared as before.
     */
    const executeRun = async (run, label, onEvent) => {
      const stageModel = stageModels[stage.id] ?? model;
      const stagePipeline = stage.requires === "regression-watch" ? "regression-check" : pipeline;
      const stageRoots = stagePipeline === pipeline ? roots : sandboxRoots(cwd, state, stagePipeline, state);
      const stageRootNames = stageRoots.map((root) => relative(resolve(cwd), root) || ".");
      const task = buildStageTask({
        stage,
        module: run.module,
        unit: run.unit,
        skillEntry: stage.skill ? skillIndex.get(stage.skill) : undefined,
        state,
        folder,
        writableRoots: stageRootNames,
        skillsDir,
        codeIntelAvailable: Boolean(codeIntel?.available),
      });

      try {
        const result = await runSubagent({
          cwd,
          agent: stage.skill ?? stage.id,
          stageId: stage.id,
          runKey: run.key,
          task,
          model: stageModel,
          thinkingLevel,
          allowedRoots: stageRoots,
          signal,
          onEvent,
          codeIntelSession: codeIntel,
        });

        writeFileSync(
          guard(join(runDir, `${run.key.replace(/[/:]/g, "_")}.md`)),
          `# ${label}\n\n${result.text}\n`,
          "utf8",
        );

        usage.input += result.usage?.input ?? 0;
        usage.output += result.usage?.output ?? 0;
        usage.cacheRead += result.usage?.cacheRead ?? 0;
        usage.cacheWrite += result.usage?.cacheWrite ?? 0;
        usage.total += result.usage?.total ?? 0;
        cost += result.cost ?? 0;

        if (result.violations?.length) {
          sandboxViolation = result.violations[0];
          fanOutStopped = true;
          return {
            id: run.key,
            label,
            status: "failed",
            reason: `sandbox: ${result.violations[0].message}`,
          };
        }

        if (result.stopReason === "error") {
          warnings.push(`${label} terminou com erro: ${result.errorMessage ?? "desconhecido"}`);
          return { id: run.key, label, status: "failed", reason: result.errorMessage ?? "erro" };
        }
        if (result.stopReason === "aborted") {
          aborted = true;
          fanOutStopped = true;
          return { id: run.key, label, status: "failed", reason: "abortado" };
        }

        const expected = resolveStageOutputs(stage, { folder, item: run.module ?? run.unit });
        const missing = missingStageOutputs(cwd, expected);
        if (missing.length > 0) {
          warnings.push(`${label}: outputs ausentes — ${missing.join(", ")}`);
          return {
            id: run.key,
            label,
            status: "failed",
            reason: `outputs ausentes: ${missing.join(", ")}`,
            outputsMissing: missing,
          };
        }

        completed.add(run.key);
        return { id: run.key, label, status: "done", tokens: result.usage?.total ?? 0 };
      } catch (error) {
        if (error instanceof WriteOutsideSandboxError) {
          sandboxViolation = error;
          fanOutStopped = true;
          return { id: run.key, label, status: "failed", reason: `sandbox: ${error.message}` };
        }
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`${label} falhou: ${reason}`);
        return { id: run.key, label, status: "failed", reason };
      }
    };

    /** Module/unit-qualified label; identical for launched and cancelled shards. */
    const runLabel = (run) =>
      run.module
        ? `${stage.label} — ${run.module}`
        : run.unit
          ? `${stage.label} — ${run.unit}`
          : stage.label;

    const tasks = pending.map((run) => async () => {
      const label = runLabel(run);

      // `running` fires when the worker actually picks the shard up, not when
      // the stage started: with concurrency < runs, the difference is the whole
      // point of the counter.
      emitRun(label, run, "running", { toolCalls: 0 });

      let toolCalls = 0;
      let lastTool = null;
      let liveTokens = 0;
      let lastActivityAt = 0;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let trailing = null;

      const paint = () => {
        lastActivityAt = Date.now();
        emitRun(label, run, "running", { tool: lastTool, toolCalls, tokens: liveTokens });
      };

      /**
       * Leading-edge emit plus a trailing timer for whatever the throttle
       * swallowed. The trailing edge is what makes the count *live*: without it
       * a burst of events inside one window would only reach the TUI after the
       * child returned, which is no longer progress reporting.
       */
      const beat = () => {
        const waited = Date.now() - lastActivityAt;
        if (waited >= ACTIVITY_THROTTLE_MS) {
          if (trailing) {
            clearTimeout(trailing);
            trailing = null;
          }
          paint();
          return;
        }
        if (trailing) return;
        trailing = setTimeout(() => {
          trailing = null;
          paint();
        }, ACTIVITY_THROTTLE_MS - waited);
        // A pending repaint must never keep the process alive on its own.
        trailing.unref?.();
      };

      const onEvent = (event) => {
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          lastTool = event.name ?? lastTool;
        } else if (event.type === "message_end") {
          // A message with no numeric usage carries no new information.
          if (!event.tokens) return;
          liveTokens += event.tokens;
        } else {
          return;
        }
        // Lifecycle transitions are never throttled; only this heartbeat is.
        beat();
      };

      const result = await executeRun(run, label, onEvent);
      // Land any still-scheduled repaint before the terminal event, so the last
      // `running` reflects the real accumulated state and no timer fires after
      // the shard has already settled.
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
        paint();
      }
      doneRuns += 1;
      emitRun(label, run, result.status, {
        tokens: result.tokens ?? liveTokens,
        toolCalls,
        lastTool,
      });
      return result;
    });

    const rawResults = await withConcurrency(
      tasks,
      stage.fanOut ? concurrency : 1,
      () => fanOutStopped,
    );
    const stageResults = rawResults.map(
      (result, position) =>
        result ?? {
          id: pending[position].key,
          label: runLabel(pending[position]),
          status: "skipped",
          reason: "cancelado antes do launch",
        },
    );
    stages.push(...stageResults);

    const anyFailed = stageResults.some((result) => result.status === "failed");
    const allSucceeded = stageResults.every((result) => result.status === "done");
    if (allSucceeded) succeededStageIds.add(stage.id);

    state.completed = [...completed];
    state.phase = stage.id;
    try {
      writeState(cwd, state, guard);
    } catch (error) {
      if (!(error instanceof WriteOutsideSandboxError)) throw error;
      sandboxViolation = error;
    }

    // Launched shards already reported themselves as they settled; only the
    // ones cancelled before launch are still unannounced. They count as
    // settled too, otherwise an early stop freezes the counter mid-way.
    for (let position = 0; position < rawResults.length; position += 1) {
      if (rawResults[position] !== undefined) continue;
      const run = pending[position];
      doneRuns += 1;
      emitRun(runLabel(run), run, "skipped", {});
    }

    if (sandboxViolation) {
      warnings.push(`Execução interrompida por violação de sandbox: ${sandboxViolation.message}`);
      status = "blocked";
      aborted = true;
      break;
    }
    if (signal?.aborted || aborted) {
      aborted = true;
      status = "aborted";
      break;
    }

    if (anyFailed && stage.failPipeline !== false && !stage.optional) {
      status = "failed";
      aborted = true;
      warnings.push(`${stage.label}: falha obrigatória interrompeu o pipeline`);
      break;
    }
    if (anyFailed) {
      status = status === "completed" ? "completed_with_gaps" : status;
    }

    // Specs organization after Scout.
    if (pipeline === "discovery" && stage.id === "scout") {
      recoverSurface();

      // An off-contract surface degrades every downstream consumer (fan-out,
      // conditional stages, granularity). Say so once, explicitly, instead of
      // leaving three unrelated "não sinalizada" warnings as the only trace.
      for (const problem of validateSurface(readSurface(cwd))) {
        warnings.push(`Scout: surface.json fora do contrato — ${problem}.`);
      }

      const choice = answers.specs_choice ?? "auto";
      let granularity = choice;
      if (choice === "auto") {
        granularity = readOrganizationSuggestion(readSurface(cwd))?.granularity;
        if (!granularity) {
          granularity = "module";
          warnings.push(
            `Scout não produziu organization_suggestion (checados .reversa/context/surface.json e ${folder}/surface.json); organização das specs definida como \`module\`.`,
          );
        }
      }
      try {
        const outcome = writeSpecsSection(
          cwd,
          { granularity, customFolders: answers.custom_folders },
          guard,
        );
        if (!outcome.written && !outcome.reason.startsWith("already decided")) {
          warnings.push(`Organização das specs não persistida: ${outcome.reason}`);
        }
      } catch (error) {
        if (!(error instanceof WriteOutsideSandboxError)) throw error;
        warnings.push(`Execução interrompida por violação de sandbox: ${error.message}`);
        aborted = true;
        status = "blocked";
        break;
      }

      // Refresh code-intel module materialization after Scout.
      if (codeIntel?.available) {
        try {
          const modulesAfterScout = listScoutModules(readSurface(cwd));
          codeIntel = await ensureIndexedAndMaterialized(codeIntel, {
            signal,
            modules: modulesAfterScout,
          });
          writeSessionEvents(runDir, codeIntel, guard);
        } catch (error) {
          if (error instanceof WriteOutsideSandboxError) {
            sandboxViolation = error;
            warnings.push(`Execução interrompida por violação de sandbox: ${error.message}`);
            status = "blocked";
            aborted = true;
            break;
          }
          warnings.push(`code intelligence module materialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  if (aborted && status === "completed") status = "aborted";
  let report = buildReport({
    pipeline,
    definition,
    stages,
    warnings,
    usage,
    cost,
    runDir,
    folder,
    aborted,
    status,
    codeIntel: codeIntel ? statusSnapshot(codeIntel) : null,
    stageModelLabels,
  });

  try {
    atomicWrite(
      join(runDir, "run.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          pipeline,
          run_id: runId,
          status,
          aborted,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          folder,
          models: stageModelLabels,
          stages: stages.map((stage) => ({
            id: stage.id,
            status: stage.status,
            reason: stage.reason,
            outputs_missing: stage.outputsMissing ?? [],
          })),
          warnings,
          usage,
          cost,
        },
        null,
        2,
      )}\n`,
      guard,
    );
  } catch (error) {
    if (!(error instanceof WriteOutsideSandboxError)) {
      warnings.push(`run.json não persistido: ${error instanceof Error ? error.message : String(error)}`);
    } else {
      // Reachable when `.reversa/runs` is swapped for an external symlink after
      // the stages finish. The contract is a `blocked` result, never a rejected
      // promise, so callers still get the report and the released lock.
      warnings.push(`Execução interrompida por violação de sandbox: ${error.message}`);
      status = "blocked";
      aborted = true;
      report = buildReport({
        pipeline,
        definition,
        stages,
        warnings,
        usage,
        cost,
        runDir,
        folder,
        aborted,
        status,
        codeIntel: codeIntel ? statusSnapshot(codeIntel) : null,
        stageModelLabels,
      });
    }
  }

  return {
    stages,
    warnings,
    usage,
    cost,
    aborted,
    status,
    runDir,
    codeIntel: codeIntel ? statusSnapshot(codeIntel) : null,
    report: report.length > REPORT_LIMIT ? `${report.slice(0, REPORT_LIMIT)}\n… [relatório truncado]` : report,
  };
}

/**
 * @param {object} input
 */
async function runControllerStage({ stage, cwd, folder, skillsDir, guard, runDir, state = {} }) {
  if (stage.handler === "preflight") {
    try {
      const evidenceRoot = join(resolve(cwd), folder, ".evidence");
      mkdirSync(guard(evidenceRoot), { recursive: true });
      const entries = readdirSync(resolve(cwd), { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules" && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "dir" : "file" }));
      atomicWrite(
        join(evidenceRoot, "source-snapshot.json"),
        `${JSON.stringify({ generated_at: new Date().toISOString(), project_root_entries: entries }, null, 2)}\n`,
        guard,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof WriteOutsideSandboxError) throw error;
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  if (stage.handler === "quality-gate") return runQualityGate({ cwd, folder, guard });

  if (stage.handler === "migrate-preflight") return runMigratePreflight({ cwd, folder, guard, state });

  if (stage.handler === "migrate-finalize") return runMigrateFinalize({ cwd, folder, guard });

  if (stage.handler === "docs-config") return runDocsConfig({ cwd, folder, guard, state });

  if (stage.handler === "docs-vendor") {
    const docsRoot = join(resolve(cwd), folder);
    mkdirSync(guard(docsRoot), { recursive: true });
    const pinsPath = skillsDir
      ? join(skillsDir, "reversa-docs-publisher", "references", "vendor-pins.yaml")
      : null;
    if (!pinsPath || !existsSync(pinsPath)) {
      return { ok: false, reason: "vendor-pins.yaml não encontrado nas packaged skills" };
    }
    const result = await ensureDocsVendors({ docsRoot, pinsPath });
    writeFileSync(
      guard(join(runDir, "docs-vendor.json")),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    try {
      const statePath = join(docsRoot, ".state.json");
      /** @type {Record<string, any>} */
      let docsState = {};
      if (existsSync(statePath)) {
        try { docsState = JSON.parse(readFileSync(statePath, "utf8")); } catch { docsState = {}; }
      }
      docsState.vendorMissing = result.missing;
      docsState.cdnFallbackUsed = result.usedFallback.length > 0;
      docsState.cdnFallbackDetails = result.usedFallback;
      writeFileSync(guard(statePath), `${JSON.stringify(docsState, null, 2)}\n`, "utf8");
    } catch (error) {
      // Telemetry is best-effort, but a sandbox violation is never non-fatal.
      if (error instanceof WriteOutsideSandboxError) throw error;
    }
    if (result.missing.length > 0) {
      return {
        ok: true,
        reason: `vendor parcial; missing=${result.missing.join(",")}`,
      };
    }
    return { ok: true };
  }

  if (stage.handler === "docs-smoke") {
    const docsRoot = join(resolve(cwd), folder);
    const result = await smokeTestDocs({ docsRoot });
    writeFileSync(
      guard(join(runDir, "docs-smoke.json")),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    // Persist smoke markers beside docs when possible.
    try {
      const statePath = join(docsRoot, ".state.json");
      /** @type {Record<string, any>} */
      let docsState = {};
      if (existsSync(statePath)) {
        try { docsState = JSON.parse(readFileSync(statePath, "utf8")); } catch { docsState = {}; }
      }
      docsState.smokeTestFailed = !result.ok;
      docsState.smokeTestErrors = result.errors;
      writeFileSync(guard(statePath), `${JSON.stringify(docsState, null, 2)}\n`, "utf8");
    } catch (error) {
      // Telemetry is best-effort, but a sandbox violation is never non-fatal.
      if (error instanceof WriteOutsideSandboxError) throw error;
    }
    if (!result.ok) {
      return {
        ok: false,
        reason: `smoke falhou com ${result.errors.length} erro(s)`,
      };
    }
    return { ok: true };
  }

  return { ok: false, reason: `handler desconhecido: ${stage.handler}` };
}

/** Review layers the adjudication must cover, in upstream order. */
const REVIEW_LAYER_FILES = [
  "evidence-initial.jsonl",
  "structural-findings.jsonl",
  "adversarial-findings.jsonl",
  "coverage-findings.jsonl",
  "domain-findings.jsonl",
  "consistency-findings.jsonl",
  "evidence-final.jsonl",
];

/**
 * @param {string} path
 * @returns {string[]} non-empty lines, or [] when unreadable
 */
function readJsonlLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Only a complete, fully adjudicated review set authorizes `verified`.
 *
 * @param {{ cwd: string, folder: string, guard: (p: string) => string }} input
 */
function runQualityGate({ cwd, folder, guard }) {
  const reviewRoot = join(resolve(cwd), folder, "review");
  /** @type {string[]} */
  const layersPresent = [];
  /** @type {string[]} */
  const layersMissing = [];
  /** @type {string[]} */
  const findingIds = [];
  let findingsTotal = 0;
  let unreadableFindings = 0;

  for (const file of REVIEW_LAYER_FILES) {
    const lines = readJsonlLines(join(reviewRoot, file));
    if (lines.length === 0) {
      layersMissing.push(file);
      continue;
    }
    layersPresent.push(file);
    // Every review layer carries findings: the Evidence Auditor emits FND-EV-*
    // records with ids into evidence-{initial,final}.jsonl
    // (`reversa-evidence-auditor/SKILL.md:61`), exactly like the reviewers.
    findingsTotal += lines.length;
    for (const line of lines) {
      try {
        const id = JSON.parse(line)?.id;
        if (id === undefined || id === null) unreadableFindings += 1;
        else findingIds.push(String(id));
      } catch {
        unreadableFindings += 1;
      }
    }
  }

  const resolvedIds = new Set();
  for (const line of readJsonlLines(join(reviewRoot, "resolution.jsonl"))) {
    try {
      const id = JSON.parse(line)?.id;
      if (id !== undefined && id !== null) resolvedIds.add(String(id));
    } catch {
      // an unparseable resolution resolves nothing
    }
  }

  const unresolvedTotal =
    findingIds.filter((id) => !resolvedIds.has(id)).length + unreadableFindings;

  try {
    atomicWrite(
      join(resolve(cwd), folder, ".evidence", "coverage.json"),
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          layers_present: layersPresent,
          layers_missing: layersMissing,
          findings_total: findingsTotal,
          unresolved_total: unresolvedTotal,
        },
        null,
        2,
      )}\n`,
      guard,
    );
  } catch (error) {
    if (error instanceof WriteOutsideSandboxError) throw error;
    return { ok: false, reason: `coverage.json não persistido: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (layersMissing.length > 0) {
    return { ok: false, reason: `quality gate incompleto: camadas ausentes — ${layersMissing.join(", ")}` };
  }
  if (unresolvedTotal > 0) {
    return { ok: false, reason: `quality gate reprovado: ${unresolvedTotal} findings unresolved` };
  }
  return { ok: true };
}

/**
 * Build the migration brief the Paradigm Advisor / Curator / Strategist expect.
 *
 * @param {{ cwd: string, folder: string, guard: (p: string) => string, state: Record<string, any> }} input
 */
function runMigratePreflight({ cwd, folder, guard, state }) {
  const layout = resolveProjectLayout(state, cwd);
  const discoveryFolder = layout.folders.discovery;
  const discoveryRoot = join(resolve(cwd), discoveryFolder);
  let discoveryEntries = [];
  try {
    discoveryEntries = readdirSync(discoveryRoot);
  } catch {
    discoveryEntries = [];
  }
  if (discoveryEntries.length === 0) {
    return { ok: false, reason: "Discovery ausente: rode o pipeline discovery antes de migrate" };
  }

  const targetStack = String(state.target_stack ?? "").trim();
  if (!targetStack) {
    return { ok: false, reason: "target_stack não informado na entrevista" };
  }

  const migrationRoot = join(resolve(cwd), folder);
  try {
    mkdirSync(guard(migrationRoot), { recursive: true });
    atomicWrite(
      join(migrationRoot, "migration_brief.md"),
      [
        "# Briefing de migração",
        "",
        "## Stack alvo",
        targetStack,
        "",
        "## Escopo",
        String(state.migration_scope ?? "total"),
        "",
        "## Estratégia de cutover",
        String(state.cutover_strategy ?? "strangler"),
        "",
        "## Restrições",
        String(state.constraints ?? "").trim() || "Nenhuma restrição registrada.",
        "",
        "## Fonte",
        `Artefatos de discovery em \`${discoveryFolder}/\`.`,
        "",
      ].join("\n"),
      guard,
    );
  } catch (error) {
    if (error instanceof WriteOutsideSandboxError) throw error;
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

/**
 * Consolidate ambiguities and emit the coding handoff.
 *
 * Pending deviations do not block: in unattended mode `auto-defaults.md` is the
 * authority, so the handoff records them instead of failing.
 *
 * @param {{ cwd: string, folder: string, guard: (p: string) => string }} input
 */
function runMigrateFinalize({ cwd, folder, guard }) {
  const migrationRoot = join(resolve(cwd), folder);
  /** @type {string[]} */
  const pending = [];
  /** @type {string[]} */
  const humanDecided = [];
  /** @type {string[]} */
  const deferredToCoding = [];

  const ambiguityPath = join(migrationRoot, "ambiguity_log.md");
  if (existsSync(ambiguityPath)) {
    for (const line of readFileSync(ambiguityPath, "utf8").split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry.startsWith("-")) continue;
      if (entry.includes("[auto-decidido]")) pending.push(entry);
      else if (/\[codifica(ç|c)ão\]/i.test(entry)) deferredToCoding.push(entry);
      else humanDecided.push(entry);
    }
  }

  /** @type {string[]} */
  let artifacts = [];
  try {
    artifacts = readdirSync(migrationRoot).filter((name) => !name.startsWith("."));
  } catch {
    artifacts = [];
  }
  const mustRead = ["paradigm_decision.md", "topology_decision.md"].filter((name) =>
    artifacts.includes(name),
  );
  const rest = artifacts.filter((name) => !mustRead.includes(name));

  try {
    mkdirSync(guard(migrationRoot), { recursive: true });
    atomicWrite(
      ambiguityPath,
      [
        "# Ambiguity log",
        "",
        "## PENDENTES",
        ...(pending.length > 0 ? pending : ["- (nenhuma)"]),
        "",
        "## RESOLVIDOS COM DECISÃO HUMANA",
        ...(humanDecided.length > 0 ? humanDecided : ["- (nenhuma)"]),
        "",
        "## REFERIDOS À CODIFICAÇÃO",
        ...(deferredToCoding.length > 0 ? deferredToCoding : ["- (nenhuma)"]),
        "",
      ].join("\n"),
      guard,
    );
    atomicWrite(
      join(migrationRoot, "handoff.md"),
      [
        "# Handoff de migração",
        "",
        "## Leitura obrigatória primeiro",
        ...(mustRead.length > 0 ? mustRead.map((name) => `- \`${name}\``) : ["- (nenhum)"]),
        "",
        "## Demais artefatos",
        ...(rest.length > 0 ? rest.map((name) => `- \`${name}\``) : ["- (nenhum)"]),
        "",
        "## Itens auto-decididos",
        ...(pending.length > 0 ? pending : ["- (nenhum)"]),
        "",
        "## Próximos passos para a codificação",
        "1. Leia as decisões obrigatórias acima antes de escrever qualquer código.",
        "2. Revise os itens auto-decididos e confirme ou corrija cada um.",
        "3. Siga as ondas de `migration_strategy.md`, validando `risk_register.md` a cada onda.",
        "",
      ].join("\n"),
      guard,
    );
  } catch (error) {
    if (error instanceof WriteOutsideSandboxError) throw error;
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (pending.length > 0) {
    return { ok: true, reason: `handoff gerado com ${pending.length} pendência(s)` };
  }
  return { ok: true };
}

/**
 * Materialize `<docs>/.config.json` from the interview answers.
 *
 * Idempotent: a valid existing config is preserved across reruns.
 *
 * @param {{ cwd: string, folder: string, guard: (p: string) => string, state: Record<string, any> }} input
 */
function runDocsConfig({ cwd, folder, guard, state }) {
  const base = resolve(cwd);
  const docsRoot = join(base, folder);
  const configPath = join(docsRoot, ".config.json");

  if (existsSync(configPath)) {
    try {
      if (JSON.parse(readFileSync(configPath, "utf8"))?.schemaVersion === 1) {
        return { ok: true, reason: "config existente preservada" };
      }
    } catch {
      // malformed config is rewritten below
    }
  }

  const soulPath = join(base, ".reversa", "soul.md");
  const hasSoul = existsSync(soulPath);
  const projectName = String(state.project ?? "").trim() || basename(base);
  const seedSource = hasSoul ? readFileSync(soulPath, "utf8") : projectName;
  const layout = resolveProjectLayout(state, cwd);
  const discoveryRoot = join(base, layout.folders.discovery);
  /** @type {string[]} */
  let sddSpecs = [];
  try {
    sddSpecs = readdirSync(discoveryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    sddSpecs = [];
  }

  try {
    mkdirSync(guard(docsRoot), { recursive: true });
    atomicWrite(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          projectName,
          interview: {
            reader_profile: state.reader_profile ?? "novo_dev",
            docs_depth: state.docs_depth ?? "full",
            visual_style: state.visual_style ?? "sober",
          },
          seed: {
            hash: `sha256:${createHash("sha256").update(seedSource).digest("hex")}`,
            source: hasSoul ? "soul.md" : "project_name",
          },
          knowledgeSources: {
            soul: hasSoul,
            chronicle: existsSync(join(base, ".reversa", "chronicle.md")),
            topology: existsSync(join(discoveryRoot, "architecture.md")),
            sourceCode: true,
            sddSpecs,
          },
        },
        null,
        2,
      )}\n`,
      guard,
    );
  } catch (error) {
    if (error instanceof WriteOutsideSandboxError) throw error;
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

/**
 * Auto-approve migrate phase recommendations for unattended runs.
 *
 * @param {string} cwd
 * @param {string} folder
 * @param {"topology" | "screen"} kind
 * @param {string[]} warnings
 * @param {(absolutePath: string) => string} guard
 */
function autoApproveMigrationPhase(cwd, folder, kind, warnings, guard) {
  const migrationRoot = join(resolve(cwd), folder);
  // Must precede every read and write below: appendAmbiguity() writes into this
  // directory, and a project without a migration folder would throw there.
  mkdirSync(guard(migrationRoot), { recursive: true });
  const statePath = join(migrationRoot, ".state.json");
  /** @type {Record<string, any>} */
  let migrationState = {
    schemaVersion: 2,
    completedAgents: [],
    pendingAgents: [],
    currentAgent: {
      agent: null,
      phase: null,
      status: null,
      topologyApproved: false,
      screenModeApproved: false,
    },
    auto: true,
  };
  if (existsSync(statePath)) {
    try {
      migrationState = {
        ...migrationState,
        ...JSON.parse(readFileSync(statePath, "utf8")),
      };
    } catch {
      // keep defaults
    }
  }
  migrationState.currentAgent = {
    ...(migrationState.currentAgent ?? {}),
    status: "running",
  };

  if (kind === "topology") {
    migrationState.currentAgent.agent = "designer";
    migrationState.currentAgent.phase = "architecture";
    migrationState.currentAgent.topologyApproved = true;
    warnings.push("migrate unattended: topology recommendation auto-approved (topologyApproved=true)");
    appendAmbiguity(migrationRoot, "Designer topology auto-approved recommended option", guard);
  } else {
    migrationState.currentAgent.agent = "screen_translator";
    migrationState.currentAgent.phase = "generation";
    migrationState.currentAgent.screenModeApproved = true;
    warnings.push("migrate unattended: screen mode recommendation auto-approved (screenModeApproved=true)");
    appendAmbiguity(migrationRoot, "Screen Translator mode auto-approved recommended option", guard);
  }

  writeFileSync(guard(statePath), `${JSON.stringify(migrationState, null, 2)}\n`, "utf8");
}

/**
 * @param {string} migrationRoot
 * @param {string} line
 * @param {(absolutePath: string) => string} guard
 */
function appendAmbiguity(migrationRoot, line, guard) {
  const path = join(migrationRoot, "ambiguity_log.md");
  const stamp = new Date().toISOString();
  const entry = `\n- [auto-decidido] ${stamp} — ${line}\n`;
  if (existsSync(path)) {
    writeFileSync(guard(path), `${readFileSync(path, "utf8").replace(/\s*$/, "")}${entry}`, "utf8");
  } else {
    writeFileSync(guard(path), `# Ambiguity log\n${entry}`, "utf8");
  }
}

/**
 * @param {object} input
 * @returns {string}
 */
function buildReport({
  pipeline,
  definition,
  stages,
  warnings,
  usage,
  cost,
  runDir,
  folder,
  aborted,
  status,
  codeIntel,
  stageModelLabels = {},
}) {
  const icon = { done: "✅", skipped: "⏭", failed: "❌" };
  const lines = [
    `# Reversa — pipeline \`${pipeline}\` (${definition.label})`,
    "",
    aborted ? `**Execução interrompida (${status}).**` : `**Execução concluída (${status}).**`,
    "",
    "## Etapas",
  ];

  for (const stage of stages) {
    const suffix = stage.reason ? ` — ${stage.reason}` : "";
    lines.push(`- ${icon[stage.status] ?? "•"} ${stage.label}${suffix}`);
  }

  const counts = stages.reduce((acc, stage) => {
    acc[stage.status] = (acc[stage.status] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
  lines.push("", `Totais: ✅ ${counts.done ?? 0} · ⏭ ${counts.skipped ?? 0} · ❌ ${counts.failed ?? 0}`);

  const resumedLabels = [...new Set(stages.filter((stage) => stage.resumed).map((stage) => stage.label))];
  if (resumedLabels.length) {
    lines.push(
      "",
      `⚠️ Não executadas nesta sessão (vindas de \`state.completed\`): ${resumedLabels.join(", ")}.`,
    );
  }

  lines.push(
    "",
    "## Artefatos",
    `- Specs e documentos em \`${folder}/\``,
    `- Saída bruta por etapa em \`${runDir}\``,
  );

  const modelEntries = Object.entries(stageModelLabels);
  if (modelEntries.length > 0) {
    lines.push(
      "",
      "## Modelos por etapa",
      ...modelEntries.map(([id, ref]) => `- \`${id}\`: \`${ref}\``),
    );
  }

  if (codeIntel) {
    lines.push(
      "",
      "## Code intelligence",
      `- available: ${codeIntel.available}`,
      `- project: ${codeIntel.project ?? "n/a"}`,
      `- binary: ${codeIntel.binary_version ?? "n/a"}`,
      `- actions: ${(codeIntel.curated_actions ?? []).join(", ") || "none"}`,
    );
  }

  if (warnings.length) {
    lines.push("", "## Avisos");
    for (const warning of warnings) lines.push(`- ⚠️ ${warning}`);
  }

  if (status === "blocked") {
    lines.push(
      "",
      "## Como retomar",
      "- A etapa bloqueada NÃO foi marcada como concluída em `.reversa/state.json`.",
      "- Corrija o caminho de escrita e chame `reversa_orchestrate` de novo com `resume: true`.",
      "- NÃO edite `.reversa/state.json` à mão: o schema v3 exige `folders`, `output_folder`, `specs_root`, `layout_mode`, `forward_folder` e `active_spec_source` consistentes; uma edição parcial corrompe o layout.",
    );
  }

  lines.push(
    "",
    "## Consumo",
    `- Tokens: ${usage.total} (entrada ${usage.input}, saída ${usage.output}, cache ${usage.cacheRead}/${usage.cacheWrite})`,
    `- Custo estimado: US$ ${cost.toFixed(4)}`,
  );

  return lines.join("\n");
}
