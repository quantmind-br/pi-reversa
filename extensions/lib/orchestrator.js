import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createSandboxGuard, WriteOutsideSandboxError } from "./guarded-tools.js";
import { PIPELINES } from "./pipelines.js";
import {
  DEFAULT_OUTPUT_FOLDER,
  isSafeOutputFolder,
  listScoutModules,
  readState,
  readSurface,
  resolveProjectLayout,
  setActiveSpecSource,
  writeSpecsSection,
  writeState,
} from "./reversa-state.js";
import {
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
  const features = surface.organization_suggestion?.features ?? [];
  if (Array.isArray(features) && features.length > 0) {
    return features.map((entry) => (typeof entry === "string" ? entry : entry?.name)).map(slug).filter(Boolean);
  }
  return listScoutModules(surface).map(slug).filter(Boolean);
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
 */
async function withConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
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
 * Execute a whole Reversa pipeline.
 *
 * @param {object} options
 */
export async function runPipeline({
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
}) {
  const definition = PIPELINES[pipeline];
  if (!definition) throw new Error(`unknown pipeline: ${pipeline}`);

  /** @type {string[]} */
  const warnings = [];
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

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(resolve(cwd), ".reversa", "runs", runId);

  try {
    mkdirSync(guard(runDir), { recursive: true });
    writeState(cwd, state, guard);
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
    writeSessionEvents(runDir, codeIntel);
  } catch (error) {
    warnings.push(`code intelligence preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const completed = new Set(Array.isArray(state.completed) ? state.completed : []);
  /** @type {Set<string>} */
  const succeededStageIds = new Set(
    [...completed].map((key) => String(key).split(":")[0]),
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
        });
        stages.push({
          id: stage.id,
          label: stage.label,
          status: controllerResult.ok ? "done" : stage.optional || stage.failPipeline === false ? "failed" : "failed",
          reason: controllerResult.ok ? undefined : controllerResult.reason,
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
        const reason = error instanceof Error ? error.message : String(error);
        stages.push({ id: stage.id, label: stage.label, status: "failed", reason });
        warnings.push(`${stage.label} falhou: ${reason}`);
        if (stage.failPipeline !== false && !stage.optional) {
          status = "failed";
          aborted = true;
          break;
        }
        status = status === "completed" ? "completed_with_gaps" : status;
      }
      continue;
    }

    if (stage.skill && !skillIndex.has(stage.skill)) {
      warnings.push(`Etapa ${stage.label} pulada: skill \`${stage.skill}\` não está instalada.`);
      stages.push({ id: stage.id, label: stage.label, status: "skipped", reason: "skill ausente" });
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
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

    // Auto-approve migrate phase gates before architecture/generation stages.
    if (pipeline === "migrate" && stage.id === "designer-architecture") {
      autoApproveMigrationPhase(cwd, folder, "topology", warnings, guard);
    }
    if (pipeline === "migrate" && stage.id === "screen-translator-generation") {
      autoApproveMigrationPhase(cwd, folder, "screen", warnings, guard);
    }

    const modules = stage.fanOut === "modules" ? listScoutModules(readSurface(cwd)) : [];
    const units = stage.fanOut === "units" ? listWriterUnits(cwd, state) : [];
    if (stage.fanOut === "modules" && modules.length === 0) {
      warnings.push(
        `${stage.label}: nenhum módulo encontrado em .reversa/context/surface.json; executando uma única vez.`,
      );
    }
    if (stage.fanOut === "units" && units.length === 0) {
      warnings.push(
        `${stage.label}: nenhuma unit encontrada; executando uma única vez com fallback module.`,
      );
    }

    const runs = expandStages([stage], modules, units);
    const pending = runs.filter((run) => !(resume && completed.has(run.key)));
    for (const run of runs) {
      if (pending.includes(run)) continue;
      stages.push({ id: run.key, label: stage.label, status: "skipped", reason: "já concluída (resume)" });
      succeededStageIds.add(stage.id);
    }
    if (pending.length === 0) {
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    onProgress?.({ stage: stage.label, index, total, status: "start", runs: pending.length });

    const tasks = pending.map((run) => async () => {
      const label = run.module
        ? `${stage.label} — ${run.module}`
        : run.unit
          ? `${stage.label} — ${run.unit}`
          : stage.label;
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
          task,
          model,
          thinkingLevel,
          allowedRoots: stageRoots,
          signal,
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
          return { id: run.key, label, status: "failed", reason: "abortado" };
        }

        completed.add(run.key);
        return { id: run.key, label, status: "done", tokens: result.usage?.total ?? 0 };
      } catch (error) {
        if (error instanceof WriteOutsideSandboxError) {
          sandboxViolation = error;
          return { id: run.key, label, status: "failed", reason: `sandbox: ${error.message}` };
        }
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`${label} falhou: ${reason}`);
        return { id: run.key, label, status: "failed", reason };
      }
    });

    const stageResults = await withConcurrency(tasks, stage.fanOut ? concurrency : 1);
    stages.push(...stageResults);

    const anyFailed = stageResults.some((result) => result.status === "failed");
    const anyDone = stageResults.some((result) => result.status === "done");
    if (anyDone) succeededStageIds.add(stage.id);

    state.completed = [...completed];
    state.phase = stage.id;
    try {
      writeState(cwd, state, guard);
    } catch (error) {
      if (!(error instanceof WriteOutsideSandboxError)) throw error;
      sandboxViolation = error;
    }

    for (const result of stageResults) {
      onProgress?.({ stage: result.label, index, total, status: result.status, tokens: result.tokens });
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
      const choice = answers.specs_choice ?? "auto";
      let granularity = choice;
      if (choice === "auto") {
        granularity = readSurface(cwd)?.organization_suggestion?.granularity;
        if (!granularity) {
          granularity = "module";
          warnings.push(
            "Scout não produziu organization_suggestion; organização das specs definida como `module`.",
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
          writeSessionEvents(runDir, codeIntel);
        } catch (error) {
          warnings.push(`code intelligence module materialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  if (aborted && status === "completed") status = "aborted";
  const report = buildReport({
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
  });

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
async function runControllerStage({ stage, cwd, folder, skillsDir, guard, runDir }) {
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
    } catch {
      // non-fatal
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

  mkdirSync(guard(migrationRoot), { recursive: true });
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
  lines.push(
    "",
    `Totais: ✅ ${counts.done ?? 0} · ⏭ ${counts.skipped ?? 0} · ❌ ${counts.failed ?? 0}`,
    "",
    "## Artefatos",
    `- Specs e documentos em \`${folder}/\``,
    `- Saída bruta por etapa em \`${runDir}\``,
  );

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

  lines.push(
    "",
    "## Consumo",
    `- Tokens: ${usage.total} (entrada ${usage.input}, saída ${usage.output}, cache ${usage.cacheRead}/${usage.cacheWrite})`,
    `- Custo estimado: US$ ${cost.toFixed(4)}`,
  );

  return lines.join("\n");
}
