/**
 * Per-stage model configuration, persisted in `.reversa/config.toml`.
 *
 * `readSpecsSection` / `writeSpecsSection` in `reversa-state.js` cannot be
 * reused: they only know `[specs]` and the writer is write-once by design
 * (a granularity decision is final). Model choices must stay re-editable, so
 * the `[models]` block gets its own reader/writer. Only `atomicWrite` is
 * shared.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PIPELINE_IDS, PIPELINES } from "./pipelines.js";
import { atomicWrite } from "./reversa-state.js";

const CONFIG_PATH = [".reversa", "config.toml"];

/**
 * @typedef {{ default: string | null, pipelines: Record<string, Record<string, string>> }} StageModelConfig
 */

/**
 * Shape reference for an absent config. Never mutate; callers get fresh copies.
 *
 * `pipelines` and every per-pipeline table are null-prototype maps: a config
 * section is attacker-controlled data used as an object key, and an inherited
 * name (`__proto__`, `constructor`, `toString`) would otherwise turn a lookup
 * or an assignment into a global mutation.
 */
export const EMPTY_STAGE_MODELS = Object.freeze({ default: null, pipelines: Object.freeze(Object.create(null)) });

/** @returns {StageModelConfig} */
const emptyConfig = () => ({ default: null, pipelines: Object.create(null) });

/** @param {string} cwd */
const configPathIn = (cwd) => join(resolve(cwd), ...CONFIG_PATH);

/**
 * Format a model as the `<provider>/<modelId>` reference stored in TOML.
 *
 * @param {{ provider: string, id: string }} model
 * @returns {string}
 */
export function formatModelRef(model) {
  return `${model.provider}/${model.id}`;
}

/**
 * Parse a `<provider>/<modelId>` reference. Splits on the **first** slash only:
 * OpenRouter ids embed slashes (`openrouter/openai/gpt-5`).
 *
 * @param {unknown} ref
 * @returns {{ provider: string, id: string } | null}
 */
export function parseModelRef(ref) {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  const index = trimmed.indexOf("/");
  if (index <= 0 || index === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, index), id: trimmed.slice(index + 1) };
}

/**
 * Is `key` a valid TOML bare key? `writeStageModels` serializes section names
 * and stage keys unescaped, so anything outside this charset could inject a new
 * table header. Inherited names are rejected too: harmless against the
 * null-prototype maps here, but a caller-supplied config may be a plain object.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * Own-property read. Never `map[key]`: `key` is config data, and a plain-object
 * config would resolve `toString` / `constructor` off the prototype chain.
 *
 * @param {Record<string, any> | null | undefined} map
 * @param {string} key
 * @returns {any}
 */
function ownValue(map, key) {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * Read `[models]` and `[models.<pipeline>]` from `.reversa/config.toml`.
 * Missing or unreadable file yields an empty config.
 *
 * @param {string} cwd
 * @returns {StageModelConfig}
 */
export function readStageModels(cwd) {
  let raw;
  try {
    raw = readFileSync(configPathIn(cwd), "utf8");
  } catch {
    return emptyConfig();
  }

  const config = emptyConfig();
  /** @type {string | null} */
  let pipeline = null;
  let inModels = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      const section = trimmed.match(/^\[(.+)\]$/)?.[1]?.trim();
      if (section === "models") {
        inModels = true;
        pipeline = null;
      } else if (section?.startsWith("models.")) {
        inModels = true;
        pipeline = section.slice("models.".length).trim();
      } else {
        inModels = false;
        pipeline = null;
      }
      continue;
    }
    if (!inModels || !trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (!parseModelRef(value)) continue;

    if (pipeline === null) {
      if (key === "default") config.default = value;
      continue;
    }
    if (!isSafeKey(pipeline) || !isSafeKey(key)) continue;
    (config.pipelines[pipeline] ??= Object.create(null))[key] = value;
  }

  return config;
}

/**
 * Serialize the models block. Empty config serializes to `""`.
 *
 * @param {StageModelConfig} config
 * @returns {string}
 */
function serializeStageModels(config) {
  const lines = [];
  if (config.default) lines.push("[models]", `default = ${JSON.stringify(config.default)}`);

  const declared = Object.keys(config.pipelines).filter(isSafeKey);
  const names = [
    ...PIPELINE_IDS.filter((id) => declared.includes(id)),
    ...declared.filter((id) => !PIPELINE_IDS.includes(id)),
  ];

  for (const pipeline of names) {
    const entries = ownValue(config.pipelines, pipeline);
    const keys = Object.keys(entries ?? {}).filter(isSafeKey);
    if (keys.length === 0) continue;

    const stageOrder = (PIPELINES[pipeline]?.stages ?? []).map((stage) => stage.id);
    const ordered = [
      ...(keys.includes("default") ? ["default"] : []),
      ...stageOrder.filter((id) => keys.includes(id)),
      ...keys.filter((key) => key !== "default" && !stageOrder.includes(key)),
    ];

    if (lines.length) lines.push("");
    lines.push(`[models.${pipeline}]`);
    for (const key of ordered) lines.push(`${key} = ${JSON.stringify(ownValue(entries, key))}`);
  }

  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Rewrite only the `[models]` / `[models.<pipeline>]` tables of
 * `.reversa/config.toml`, keeping every other section verbatim. Comments that
 * lived inside the models block are dropped: the block is UI-owned.
 *
 * @param {string} cwd
 * @param {StageModelConfig} config
 * @param {(absolutePath: string) => string} [guard]
 * @returns {void}
 */
export function writeStageModels(cwd, config, guard) {
  const path = configPathIn(cwd);
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = "";
  }

  const kept = [];
  let dropping = false;
  for (const line of current.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      const section = trimmed.match(/^\[(.+)\]$/)?.[1]?.trim();
      dropping = section === "models" || Boolean(section?.startsWith("models."));
    }
    if (!dropping) kept.push(line);
  }

  const preserved = kept.join("\n").replace(/\s*$/, "");
  const block = serializeStageModels(config);

  let next;
  if (!block) next = preserved ? `${preserved}\n` : "";
  else if (!preserved) next = block;
  else next = `${preserved}\n\n${block}`;

  atomicWrite(path, next, guard);
}

/**
 * Resolve one model per agent stage, applying the precedence
 * stage → pipeline default → global default → session model.
 *
 * Controller stages never run a model and are excluded. An unresolvable
 * reference degrades to the session model with a warning; it never fails.
 *
 * @param {object} input
 * @param {StageModelConfig} input.config
 * @param {string} input.pipeline
 * @param {import("./pipelines.js").Stage[]} input.stages
 * @param {{ find(provider: string, modelId: string): any } | null | undefined} input.registry
 * @returns {{ models: Record<string, any>, labels: Record<string, string>, warnings: string[] }}
 */
export function resolveStageModels({ config, pipeline, stages, registry }) {
  /** @type {Record<string, any>} */
  const models = {};
  /** @type {Record<string, string>} */
  const labels = {};
  /** @type {string[]} */
  const warnings = [];

  const perPipeline = ownValue(config?.pipelines, pipeline) ?? {};
  const globalDefault = config?.default ?? null;
  const hasEntries = Boolean(globalDefault) || Object.keys(perPipeline).length > 0;
  if (!hasEntries) return { models, labels, warnings };

  if (!registry) {
    warnings.push("registry de modelos indisponível; configuração `[models]` ignorada nesta execução.");
    return { models, labels, warnings };
  }

  const agentStages = (stages ?? []).filter((stage) => (stage.kind ?? "agent") !== "controller");
  const knownIds = new Set(agentStages.map((stage) => stage.id));

  for (const key of Object.keys(perPipeline)) {
    if (key === "default" || knownIds.has(key)) continue;
    warnings.push(`etapa \`${key}\` não existe no pipeline \`${pipeline}\`; entrada de modelo ignorada.`);
  }

  for (const stage of agentStages) {
    const ref = ownValue(perPipeline, stage.id) ?? ownValue(perPipeline, "default") ?? globalDefault;
    if (!ref) continue;

    const parsed = parseModelRef(ref);
    const model = parsed ? registry.find(parsed.provider, parsed.id) : undefined;
    if (!model) {
      warnings.push(`modelo \`${ref}\` não encontrado no registry; etapa \`${stage.id}\` usa o modelo da sessão.`);
      continue;
    }

    models[stage.id] = model;
    labels[stage.id] = ref;
  }

  return { models, labels, warnings };
}

/**
 * Count stage-level overrides for a pipeline, excluding the `default` key.
 *
 * @param {StageModelConfig} config
 * @param {string} pipeline
 * @returns {number}
 */
export function countStageOverrides(config, pipeline) {
  const entries = ownValue(config?.pipelines, pipeline);
  if (!entries) return 0;
  return Object.keys(entries).filter((key) => key !== "default").length;
}
