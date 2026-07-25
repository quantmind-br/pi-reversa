import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createSandboxGuard, WriteOutsideSandboxError } from "./guarded-tools.js";
import { PIPELINES } from "./pipelines.js";
import {
  DEFAULT_OUTPUT_FOLDER,
  isSafeOutputFolder,
  listScoutModules,
  outputFolder,
  readState,
  readSurface,
  writeSpecsSection,
  writeState,
} from "./reversa-state.js";
import { buildSkillBlock, stripFrontmatter } from "./skill-block.js";
import { runSubagent as defaultRunSubagent } from "./subagent.js";

/** Parallel Archaeologists. Modules write disjoint files, so this is safe. */
export const DEFAULT_FANOUT_CONCURRENCY = 3;

const REPORT_LIMIT = 12_000;

/**
 * Extra write roots a specific pipeline needs beyond the shared ones.
 *
 * `docs` renders a self-contained mini-site into `_reversa_docs/`
 * (packaged-skills/reversa-docs/SKILL.md), which is outside the discovery
 * output folder. Listed explicitly so the sandbox stays closed: no pipeline
 * gains access to arbitrary project paths.
 */
export const PIPELINE_EXTRA_ROOTS = { docs: ["_reversa_docs"] };

/**
 * Sandbox roots subagents of `pipeline` may write to, mirroring the Reversa
 * absolute rule (packaged-skills/reversa/SKILL.md, "Regra absoluta").
 *
 * `folder` originates in `.reversa/state.json` and is untrusted: `"."` would
 * make the entire project writable and `"../x"` would leave it. Unsafe values
 * are replaced by the default here as well as in `outputFolder()`, so a direct
 * caller cannot widen the sandbox by accident.
 *
 * @param {string} cwd
 * @param {string} folder output_folder from state.json
 * @param {string} [pipeline]
 * @returns {string[]} absolute paths
 */
export function sandboxRoots(cwd, folder, pipeline) {
  const base = resolve(cwd);
  const safeFolder = isSafeOutputFolder(folder) ? folder.trim() : DEFAULT_OUTPUT_FOLDER;
  const names = [".reversa", safeFolder, "_reversa_forward", ...(PIPELINE_EXTRA_ROOTS[pipeline] ?? [])];
  return [...new Set(names)].map((name) => join(base, name));
}

/**
 * Does the project have at least one forward-cycle regression watch file?
 *
 * @param {string} cwd
 */
export function hasRegressionWatch(cwd) {
  try {
    const forwardDir = join(resolve(cwd), "_reversa_forward");
    return readdirSync(forwardDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      try {
        readFileSync(join(forwardDir, entry.name, "regression-watch.md"), "utf8");
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Expand the declared stages into concrete runs, applying fan-out.
 *
 * @param {import("./pipelines.js").Stage[]} stages
 * @param {string[]} modules
 * @returns {{ stage: import("./pipelines.js").Stage, module: string | null, key: string }[]}
 */
export function expandStages(stages, modules) {
  const expanded = [];
  for (const stage of stages) {
    if (stage.fanOut === "modules" && modules.length > 0) {
      for (const module of modules) expanded.push({ stage, module, key: `${stage.id}:${module}` });
    } else {
      expanded.push({ stage, module: null, key: stage.id });
    }
  }
  return expanded;
}

/**
 * Build the full prompt for one stage. Pure string assembly — no model call.
 *
 * @param {object} input
 * @param {import("./pipelines.js").Stage} input.stage
 * @param {string | null} input.module
 * @param {Record<string, any>} input.state
 * @param {string} input.folder
 * @param {string[]} [input.writableRoots] root names advertised to the subagent
 * @param {string} [input.skillsDir]
 * @returns {string}
 */
export function buildStageTask({ stage, module, skillEntry, state, folder, writableRoots, skillsDir }) {
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

  sections.push(
    [
      "## Contexto da execução autônoma",
      `- Projeto: ${state.project ?? "(não informado)"}   Usuário: ${state.user_name ?? "(não informado)"}`,
      `- Idioma do chat: ${state.chat_language ?? "pt-BR"}   Idioma das specs: ${state.doc_language ?? "pt-BR"}`,
      `- Nível de documentação: ${state.doc_level ?? "essencial"}`,
      `- Pasta de saída: ${folder}`,
      `- answer_mode = file: NUNCA pergunte nada. Toda dúvida vai para ${folder}/questions.md com contexto e marcador 🔴 LACUNA na spec correspondente.`,
      "- Você não tem `bash`. Para histórico de git use a ferramenta `reversa_git`.",
      `- Escreva APENAS em ${(writableRoots ?? [".reversa", folder, "_reversa_forward"]).map((root) => `${root}/`).join(", ")} — e em _reversa_forward/ apenas a seção de histórico de <feature>/regression-watch.md. Escritas fora disso falham por design.`,
      "- Não peça CONTINUAR, não ofereça /clear, não sugira próximos passos interativos.",
      "- Ao terminar, responda com um resumo de no máximo 20 linhas: artefatos criados, contagens 🟢/🟡/🔴, e avisos.",
    ].join("\n"),
  );

  const moduleLine = module ? `\nAnalise exclusivamente o módulo \`${module}\`.` : "";
  sections.push(`## Tarefa\n${stage.task}${moduleLine}`);

  return sections.join("\n\n");
}

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
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
 * Merge interview answers into the persisted state without clobbering values
 * the user already has on disk, unless the answer is explicit.
 *
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
 * Execute a whole Reversa pipeline. Never asks the user anything: the only
 * events that stop the loop are an abort and a sandbox violation.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.pipeline
 * @param {Record<string, any>} options.answers
 * @param {Map<string, { path: string, baseDir: string, description?: string }>} options.skillIndex
 * @param {any} [options.model]
 * @param {string} [options.thinkingLevel]
 * @param {number} [options.concurrency]
 * @param {boolean} [options.resume]
 * @param {string} [options.skillsDir]
 * @param {AbortSignal} [options.signal]
 * @param {(update: any) => void} [options.onProgress]
 * @param {typeof defaultRunSubagent} [options.runSubagent]
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

  let state = mergeAnswers(readState(cwd), answers);
  state.phase = state.phase ?? "reconhecimento";
  if (state.output_folder !== undefined && !isSafeOutputFolder(state.output_folder)) {
    warnings.push(
      `output_folder inválido em .reversa/state.json (${JSON.stringify(state.output_folder)}); usando \`${DEFAULT_OUTPUT_FOLDER}\`.`,
    );
    state.output_folder = DEFAULT_OUTPUT_FOLDER;
  }
  const folder = outputFolder(state);
  const roots = sandboxRoots(cwd, folder, pipeline);
  const rootNames = roots.map((root) => relative(resolve(cwd), root) || ".");

  // The orchestrator's own writes go through the same guard as the child
  // write/edit tools. This runs before Scout, so a symlinked `.reversa`
  // raises WriteOutsideSandboxError here rather than escaping the project.
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
      runDir,
      report: `# Reversa — pipeline \`${pipeline}\`\n\n❌ Sandbox violada antes de iniciar: ${error.message}`,
    };
  }

  /** Track resume ledger in `state.completed`, alongside existing phase entries. */
  const completed = new Set(Array.isArray(state.completed) ? state.completed : []);

  const plannedStages = definition.stages;
  let index = 0;
  const total = plannedStages.length;

  for (const stage of plannedStages) {
    index += 1;
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    if (stage.skill && !skillIndex.has(stage.skill)) {
      warnings.push(`Etapa ${stage.label} pulada: skill \`${stage.skill}\` não está instalada.`);
      stages.push({ id: stage.id, label: stage.label, status: "skipped", reason: "skill ausente" });
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    if (stage.requires === "regression-watch" && !hasRegressionWatch(cwd)) {
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "skipped",
        reason: "nenhum _reversa_forward/*/regression-watch.md",
      });
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    const modules = stage.fanOut === "modules" ? listScoutModules(readSurface(cwd)) : [];
    if (stage.fanOut === "modules" && modules.length === 0) {
      warnings.push(
        `${stage.label}: nenhum módulo encontrado em .reversa/context/surface.json; executando uma única vez.`,
      );
    }

    const runs = expandStages([stage], modules);
    const pending = runs.filter((run) => !(resume && completed.has(run.key)));
    for (const run of runs) {
      if (pending.includes(run)) continue;
      stages.push({ id: run.key, label: stage.label, status: "skipped", reason: "já concluída (resume)" });
    }
    if (pending.length === 0) {
      onProgress?.({ stage: stage.label, index, total, status: "skipped" });
      continue;
    }

    onProgress?.({ stage: stage.label, index, total, status: "start", runs: pending.length });

    const tasks = pending.map((run) => async () => {
      const label = run.module ? `${stage.label} — ${run.module}` : stage.label;
      const task = buildStageTask({
        stage,
        module: run.module,
        skillEntry: stage.skill ? skillIndex.get(stage.skill) : undefined,
        state,
        folder,
        writableRoots: rootNames,
        skillsDir,
      });

      try {
        const result = await runSubagent({
          cwd,
          agent: stage.skill ?? stage.id,
          task,
          model,
          thinkingLevel,
          allowedRoots: roots,
          signal,
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

        // A child's WriteOutsideSandboxError never propagates (the agent loop
        // converts it to an error tool result), so check the guard's ledger.
        // A sandbox violation is one of only two events that stop the loop.
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
      break;
    }
    if (signal?.aborted || aborted) {
      aborted = true;
      break;
    }

    // Specs organization must be persisted after Scout and before any
    // Archaeologist (packaged-skills/reversa/SKILL.md, "Ação especial após o Scout").
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
        break;
      }
    }
  }

  const report = buildReport({ pipeline, definition, stages, warnings, usage, cost, runDir, folder, aborted });

  return {
    stages,
    warnings,
    usage,
    cost,
    aborted,
    runDir,
    report: report.length > REPORT_LIMIT ? `${report.slice(0, REPORT_LIMIT)}\n… [relatório truncado]` : report,
  };
}

/**
 * @param {object} input
 * @returns {string}
 */
function buildReport({ pipeline, definition, stages, warnings, usage, cost, runDir, folder, aborted }) {
  const icon = { done: "✅", skipped: "⏭", failed: "❌" };
  const lines = [
    `# Reversa — pipeline \`${pipeline}\` (${definition.label})`,
    "",
    aborted ? "**Execução interrompida antes do fim.**" : "**Execução concluída.**",
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
    `## Artefatos`,
    `- Specs e documentos em \`${folder}/\``,
    `- Saída bruta por etapa em \`${runDir}\``,
  );

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
