import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_SPECS_ROOT,
  defaultWorkflowFolders,
  isSafeRelativeFolder,
  resolveLayout,
  setActiveSpecSource as setLayoutActiveSpecSource,
} from "reversa/paths/layout.js";

const STATE_PATH = [".reversa", "state.json"];
const SURFACE_PATH = [".reversa", "context", "surface.json"];
const MODULES_PATH = [".reversa", "context", "modules.json"];
const CONFIG_PATH = [".reversa", "config.toml"];

/** @deprecated Prefer DEFAULT_DISCOVERY_FOLDER / resolveProjectLayout(). */
export const DEFAULT_OUTPUT_FOLDER = defaultWorkflowFolders(DEFAULT_SPECS_ROOT).discovery;
export const DEFAULT_DISCOVERY_FOLDER = DEFAULT_OUTPUT_FOLDER;
export const DEFAULT_FORWARD_FOLDER = defaultWorkflowFolders(DEFAULT_SPECS_ROOT).forward;
export const DEFAULT_DOCS_FOLDER = defaultWorkflowFolders(DEFAULT_SPECS_ROOT).docs;
export const DEFAULT_MIGRATION_FOLDER = defaultWorkflowFolders(DEFAULT_SPECS_ROOT).migration;

/** Valid `[specs] granularity` values, per step-03-specs-organization.md. */
export const SPEC_GRANULARITIES = ["module", "use-case", "endpoint", "hybrid", "feature", "custom"];

/** Identity guard: used when a caller writes outside an orchestrated run. */
const noGuard = (absolutePath) => absolutePath;

/**
 * Write a file atomically, creating parent directories as needed.
 *
 * @param {string} destination absolute path
 * @param {string} content
 * @param {(absolutePath: string) => string} [guard]
 */
export function atomicWrite(destination, content, guard = noGuard) {
  const target = guard(destination);
  mkdirSync(guard(dirname(target)), { recursive: true });
  const tmp = guard(`${target}.${process.pid}.tmp`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

/** @param {string} cwd @param {string[]} parts */
function pathIn(cwd, parts) {
  return join(resolve(cwd), ...parts);
}

/**
 * Resolve layout for a project state, detecting on-disk legacy trees when needed.
 *
 * @param {Record<string, any>} [state]
 * @param {string} [cwd]
 */
export function resolveProjectLayout(state = {}, cwd) {
  return resolveLayout(state, cwd ? { projectRoot: cwd } : {});
}

/**
 * Read `.reversa/state.json`. Missing or corrupt files yield `{}`.
 *
 * @param {string} cwd
 * @returns {Record<string, any>}
 */
export function readState(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(pathIn(cwd, STATE_PATH), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} cwd
 * @param {Record<string, any>} state
 * @param {(absolutePath: string) => string} [guard]
 */
export function writeState(cwd, state, guard) {
  const layout = resolveProjectLayout(state, cwd);
  const next = {
    ...state,
    schema_version: Math.max(Number(state.schema_version) || 0, 3),
    layout_mode: layout.layout_mode,
    specs_root: layout.specs_root,
    folders: layout.folders,
    active_spec_source: layout.active_spec_source,
    output_folder: layout.output_folder,
    forward_folder: layout.forward_folder,
  };
  atomicWrite(pathIn(cwd, STATE_PATH), `${JSON.stringify(next, null, 2)}\n`, guard);
}

/**
 * @param {string} cwd
 * @returns {Record<string, any> | null}
 */
export function readSurface(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(pathIn(cwd, SURFACE_PATH), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Os corpos dos skills citam caminhos `.specs/`, então o Scout costuma gravar
 * `surface.json` na pasta de saída da pipeline em vez do canônico
 * `.reversa/context/surface.json`, que o orquestrador e nove skills Reversa leem.
 * Atualiza a cópia canônica a partir da deslocada quando a canônica está
 * ausente, corrompida ou mais antiga.
 *
 * @param {string} cwd
 * @param {string} folder pasta de saída da pipeline, relativa a cwd
 * @param {(absolutePath: string) => string} [guard]
 * @returns {{ recovered: boolean, from?: string }}
 */
export function normalizeSurfaceLocation(cwd, folder, guard) {
  if (typeof folder !== "string" || !isSafeOutputFolder(folder)) return { recovered: false };

  const canonical = pathIn(cwd, SURFACE_PATH);
  const stray = join(resolve(cwd), folder, "surface.json");
  if (stray === canonical) return { recovered: false };

  let strayRaw;
  try {
    strayRaw = readFileSync(stray, "utf8");
    const parsed = JSON.parse(strayRaw);
    if (!parsed || typeof parsed !== "object") return { recovered: false };
  } catch {
    return { recovered: false };
  }

  if (readSurface(cwd) !== null) {
    const canonicalTime = statSync(canonical, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const strayTime = statSync(stray, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (strayTime <= canonicalTime) return { recovered: false };
  }

  atomicWrite(canonical, strayRaw, guard);
  return { recovered: true, from: `${folder}/surface.json` };
}

/**
 * Read the Scout's `organization_suggestion`, tolerating the flat shape.
 *
 * The schema nests `granularity`/`rationale`/`signals`/`features` under
 * `organization_suggestion` (`reversa-scout/references/surface-schema.md:50`),
 * but the skill body describes those fields inline, so real Scout runs also
 * emit them at the top level of `surface.json`. Both are accepted; the nested
 * form wins when present.
 *
 * @param {Record<string, any> | null | undefined} surface
 * @returns {Record<string, any> | null}
 */
export function readOrganizationSuggestion(surface) {
  if (!surface || typeof surface !== "object") return null;

  const nested = surface.organization_suggestion;
  if (nested && typeof nested === "object" && SPEC_GRANULARITIES.includes(nested.granularity)) {
    return nested;
  }
  if (SPEC_GRANULARITIES.includes(surface.granularity)) {
    return {
      granularity: surface.granularity,
      rationale: surface.rationale,
      signals: Array.isArray(surface.signals) ? surface.signals : [],
      features: Array.isArray(surface.features) ? surface.features : [],
    };
  }
  return nested && typeof nested === "object" ? nested : null;
}

/**
 * Report how a `surface.json` deviates from the Scout contract.
 *
 * Deviations are never fatal — the orchestrator degrades around them — but a
 * silent degradation is what turns one off-contract field into a pipeline that
 * skips half its stages for no stated reason.
 *
 * @param {Record<string, any> | null | undefined} surface
 * @returns {string[]} human-readable deviations, empty when on contract
 */
export function validateSurface(surface) {
  if (!surface || typeof surface !== "object") return ["surface.json ausente ou ilegível"];

  /** @type {string[]} */
  const problems = [];
  if (listScoutModules(surface).length === 0) {
    problems.push("campo obrigatório `modules` ausente ou vazio");
  }
  if (!readOrganizationSuggestion(surface)) {
    problems.push("campo obrigatório `organization_suggestion` ausente ou com `granularity` inválida");
  } else if (!surface.organization_suggestion) {
    problems.push("`organization_suggestion` emitido como campos soltos na raiz; lido mesmo assim");
  }

  const signals = surface.automation_signals;
  if (signals && typeof signals === "object") {
    for (const [flag, value] of Object.entries(signals)) {
      if (value && typeof value === "object" && !("detected" in value) && "present" in value) {
        problems.push(`automation_signals.${flag} usa \`present\` em vez de \`detected\`; lido mesmo assim`);
      }
    }
  }
  return problems;
}

/**
 * Extract module names from a Scout `surface.json`.
 *
 * @param {Record<string, any> | null | undefined} surface
 * @returns {string[]}
 */
export function listScoutModules(surface) {
  if (!surface || typeof surface !== "object") return [];

  const candidates = [surface.modules, surface.organization_suggestion?.modules, surface.map?.modules];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;

    const names = candidate
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          const name = entry.name ?? entry.id ?? entry.path;
          return typeof name === "string" ? name.trim() : "";
        }
        return "";
      })
      .filter((name) => name.length > 0);

    if (names.length > 0) return names;
  }

  return [];
}

/**
 * Module names from the Archaeologist's `.reversa/context/modules.json`.
 *
 * A structured, contract-declared source (`reversa-archaeologist/references/
 * modules-schema.md`), so it is a sound fallback for a `surface.json` that
 * omitted `modules`. Only stages that run after the Archaeologist may use it.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function listArchaeologistModules(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(pathIn(cwd, MODULES_PATH), "utf8"));
    return listScoutModules(parsed);
  } catch {
    return [];
  }
}

/**
 * Read the `[specs]` section of `.reversa/config.toml`.
 *
 * @param {string} cwd
 * @returns {{ granularity?: string, custom_folders?: string[] }}
 */
export function readSpecsSection(cwd) {
  let raw;
  try {
    raw = readFileSync(pathIn(cwd, CONFIG_PATH), "utf8");
  } catch {
    return {};
  }

  /** @type {{ granularity?: string, custom_folders?: string[] }} */
  const section = {};
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
    const [, key, rawValue] = match;

    if (key === "granularity") {
      section.granularity = rawValue.trim().replace(/^["']|["']$/g, "");
    } else if (key === "custom_folders") {
      section.custom_folders = [...rawValue.matchAll(/"([^"]*)"|'([^']*)'/g)]
        .map((entry) => entry[1] ?? entry[2])
        .filter((entry) => entry && entry.length > 0);
    }
  }

  return section;
}

/**
 * Persist the specs organization decision.
 *
 * @param {string} cwd
 * @param {{ granularity: string, customFolders?: string[] }} decision
 * @param {(absolutePath: string) => string} [guard]
 * @returns {{ written: boolean, reason: string }}
 */
export function writeSpecsSection(cwd, { granularity, customFolders }, guard) {
  if (!SPEC_GRANULARITIES.includes(granularity)) {
    return { written: false, reason: `invalid granularity: ${granularity}` };
  }

  const configPath = pathIn(cwd, CONFIG_PATH);
  const existing = readSpecsSection(cwd);
  if (existing.granularity && SPEC_GRANULARITIES.includes(existing.granularity)) {
    return { written: false, reason: `already decided: ${existing.granularity}` };
  }

  const lines = [`[specs]`, `granularity = "${granularity}"`];
  if (customFolders?.length) {
    lines.push(`custom_folders = [${customFolders.map((folder) => JSON.stringify(folder)).join(", ")}]`);
  }
  const block = `${lines.join("\n")}\n`;

  if (!existsSync(configPath)) {
    atomicWrite(configPath, block, guard);
    return { written: true, reason: "created config.toml" };
  }

  const current = readFileSync(configPath, "utf8");
  const hasSection = current.split(/\r?\n/).some((line) => line.trim() === "[specs]");
  const appended = hasSection
    ? `${current.replace(/\s*$/, "")}\ngranularity = "${granularity}"\n`
    : `${current.replace(/\s*$/, "")}\n\n${block}`;

  atomicWrite(configPath, appended, guard);
  return { written: true, reason: hasSection ? "filled empty [specs]" : "appended [specs]" };
}

/**
 * Is `folder` usable as a Reversa artifact directory?
 *
 * @param {unknown} folder
 * @returns {boolean}
 */
export function isSafeOutputFolder(folder) {
  return isSafeRelativeFolder(folder);
}

/**
 * Resolve the primary output folder for a pipeline/state.
 *
 * For discovery this is folders.discovery; callers that need the full map
 * should use resolveProjectLayout().
 *
 * @param {Record<string, any>} state
 * @param {string} [cwd]
 * @returns {string}
 */
export function outputFolder(state, cwd) {
  return resolveProjectLayout(state, cwd).output_folder;
}

/**
 * @param {Record<string, any>} state
 * @param {string} [cwd]
 */
export function forwardFolder(state, cwd) {
  return resolveProjectLayout(state, cwd).forward_folder;
}

/**
 * @param {Record<string, any>} state
 * @param {'discovery' | 'new' | null} source
 */
export function setActiveSpecSource(state, source) {
  return setLayoutActiveSpecSource(state, source);
}
