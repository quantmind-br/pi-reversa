import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execCodebaseMemoryCli } from './executor.js';
import { CodeIntelligenceError } from './errors.js';

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function canonicalizeRoot(projectRoot) {
  const absolute = resolve(projectRoot);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * @param {string} rootPath
 * @returns {string}
 */
function canonicalizeMaybe(rootPath) {
  try {
    return realpathSync(resolve(rootPath));
  } catch {
    return resolve(rootPath);
  }
}

/**
 * @typedef {object} ResolvedProject
 * @property {string} name
 * @property {string} root_path
 * @property {string} canonical_root
 * @property {Record<string, any>} raw
 */

/**
 * List projects using controller-only access.
 *
 * @param {object} options
 * @param {string} options.binaryPath
 * @param {Record<string, string | undefined>} [options.env]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any[]>}
 */
export async function listProjects(options) {
  const result = await execCodebaseMemoryCli({
    binaryPath: options.binaryPath,
    args: ['cli', 'list_projects'],
    input: {},
    timeoutMs: 10_000,
    env: options.env,
    signal: options.signal,
  });
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.projects)) return result.projects;
  return [];
}

/**
 * Resolve the exact project bound to a cwd.
 *
 * @param {object} options
 * @param {string} options.binaryPath
 * @param {string} options.projectRoot
 * @param {Record<string, string | undefined>} [options.env]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.preferredName]
 * @returns {Promise<ResolvedProject | null>}
 */
export async function resolveBoundProject(options) {
  const canonicalRoot = canonicalizeRoot(options.projectRoot);
  const projects = await listProjects(options);
  const matches = projects
    .map((project) => {
      const root = project?.root_path ?? project?.rootPath ?? project?.path;
      if (!root || typeof root !== 'string') return null;
      const candidateRoot = canonicalizeMaybe(root);
      if (candidateRoot !== canonicalRoot) return null;
      const name = project?.name ?? project?.project;
      if (!name || typeof name !== 'string') return null;
      return {
        name,
        root_path: root,
        canonical_root: candidateRoot,
        raw: project,
      };
    })
    .filter(Boolean);

  if (matches.length === 0) return null;

  if (options.preferredName) {
    const preferred = matches.find((entry) => entry.name === options.preferredName);
    if (preferred) return preferred;
  }

  if (matches.length > 1) {
    throw new CodeIntelligenceError(
      'scope_mismatch',
      `multiple codebase-memory projects map to ${canonicalRoot}; configure an explicit project name`,
      {
        canonicalRoot,
        candidates: matches.map((entry) => entry.name),
      },
    );
  }

  return matches[0];
}

/**
 * Suggest a stable project name derived from the absolute root.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function deriveProjectName(projectRoot) {
  const canonical = canonicalizeRoot(projectRoot)
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return canonical || 'project';
}
