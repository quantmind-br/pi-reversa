import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const STATE_PATH = [".reversa", "state.json"];
const SURFACE_PATH = [".reversa", "context", "surface.json"];
const CONFIG_PATH = [".reversa", "config.toml"];

export const DEFAULT_OUTPUT_FOLDER = "_reversa_sdd";

/** Valid `[specs] granularity` values, per step-03-specs-organization.md. */
export const SPEC_GRANULARITIES = ["module", "use-case", "endpoint", "hybrid", "feature", "custom"];

/** Identity guard: used when a caller writes outside an orchestrated run. */
const noGuard = (absolutePath) => absolutePath;

/**
 * Write a file atomically, creating parent directories as needed.
 *
 * Every mutating path — the temp file, its parent directory, and the final
 * destination — passes through `guard`. The orchestrator supplies the same
 * sandbox guard the child `write`/`edit` tools use, so a symlinked `.reversa`
 * is rejected here too, before Scout ever runs.
 *
 * @param {string} destination absolute path
 * @param {string} content
 * @param {(absolutePath: string) => string} [guard]
 */
function atomicWrite(destination, content, guard = noGuard) {
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
 * Read `.reversa/state.json`. Missing or corrupt files yield `{}` — the
 * orchestrator must never fail to start because of a stale state file.
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
 * @param {(absolutePath: string) => string} [guard] sandbox guard
 */
export function writeState(cwd, state, guard) {
  atomicWrite(pathIn(cwd, STATE_PATH), `${JSON.stringify(state, null, 2)}\n`, guard);
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
 * Extract module names from a Scout `surface.json`.
 *
 * The canonical schema (reversa-scout/references/surface-schema.md) puts a
 * plain string array at `surface.modules`; the two fallbacks tolerate older or
 * nested shapes rather than silently degrading the Archaeologist fan-out.
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
 * Read the `[specs]` section of `.reversa/config.toml`.
 *
 * Deliberately a line scanner, not a TOML round-trip: the orchestrator must
 * never rewrite sections it does not own.
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
 * Persist the specs organization decision. Idempotent: an already-decided
 * `granularity` is immutable (step-03 treats the decision as final), and other
 * sections are never rewritten.
 *
 * @param {string} cwd
 * @param {{ granularity: string, customFolders?: string[] }} decision
 * @param {(absolutePath: string) => string} [guard] sandbox guard
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
 * Is `folder` usable as a Reversa output directory?
 *
 * `output_folder` comes from `.reversa/state.json`, which is untrusted input,
 * and it is fed straight into `sandboxRoots()`. A value like `"."` would make
 * the whole project writable and `"../outside"` would escape it entirely —
 * neither of which the write guard can catch, because by then they are
 * legitimate roots. So reject anything that is not a plain project-relative
 * subdirectory before it ever reaches the sandbox.
 *
 * @param {unknown} folder
 * @returns {boolean}
 */
export function isSafeOutputFolder(folder) {
  if (typeof folder !== "string") return false;
  const value = folder.trim();
  if (!value) return false;

  // Absolute (POSIX or Windows-style) or UNC.
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("\\")) return false;
  // NUL and other control characters.
  if (/[\0-\x1f]/.test(value)) return false;

  const segments = value.split(/[/\\]/).filter((segment) => segment !== "");
  if (segments.length === 0) return false;
  // "." and ".." in any position: no self-reference, no traversal.
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  // Never let the output folder alias Reversa's own control directory.
  if (segments[0] === ".reversa") return false;

  return true;
}

/**
 * Resolve the output folder, falling back to the default whenever the
 * persisted value is missing or unsafe.
 *
 * @param {Record<string, any>} state
 * @returns {string}
 */
export function outputFolder(state) {
  const folder = state?.output_folder;
  return isSafeOutputFolder(folder) ? folder.trim() : DEFAULT_OUTPUT_FOLDER;
}
