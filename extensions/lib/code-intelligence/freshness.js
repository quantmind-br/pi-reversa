import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @typedef {object} WorktreeFingerprint
 * @property {boolean} is_git
 * @property {string | null} head
 * @property {string} dirty_signature
 * @property {string[]} dirty_paths
 * @property {string} inventory_signature
 * @property {string} captured_at
 */

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.reversa',
  '.specs',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.pi',
  '.atl',
  'packaged-skills',
]);

/**
 * @param {string} projectRoot
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string }}
 */
function git(projectRoot, args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

/**
 * Lightweight inventory hash for non-git projects or supplemental freshness.
 *
 * @param {string} projectRoot
 * @param {number} [maxFiles]
 * @returns {string}
 */
export function inventorySignature(projectRoot, maxFiles = 5_000) {
  const root = resolve(projectRoot);
  /** @type {string[]} */
  const entries = [];

  /**
   * @param {string} dir
   */
  function walk(dir) {
    if (entries.length >= maxFiles) return;
    let listing = [];
    try {
      listing = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing) {
      if (entries.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.cbmignore') {
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory() && IGNORED_DIR_NAMES.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = statSync(absolute);
        entries.push(`${rel}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
      } catch {
        // ignore unreadable
      }
    }
  }

  walk(root);
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/**
 * Capture a freshness fingerprint for the current worktree.
 *
 * @param {string} projectRoot
 * @returns {WorktreeFingerprint}
 */
export function captureWorktreeFingerprint(projectRoot) {
  const captured_at = new Date().toISOString();
  const inv = inventorySignature(projectRoot);
  const headResult = git(projectRoot, ['rev-parse', 'HEAD']);
  if (!headResult.ok) {
    return {
      is_git: false,
      head: null,
      dirty_signature: inv,
      dirty_paths: [],
      inventory_signature: inv,
      captured_at,
    };
  }

  const status = git(projectRoot, ['status', '--porcelain=v1', '-uall']);
  const dirtyPaths = status.ok
    ? status.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
    : [];

  const dirtyMaterial = [
    headResult.stdout.trim(),
    status.stdout,
    inv,
  ].join('\n');

  return {
    is_git: true,
    head: headResult.stdout.trim() || null,
    dirty_signature: createHash('sha256').update(dirtyMaterial).digest('hex'),
    dirty_paths: dirtyPaths,
    inventory_signature: inv,
    captured_at,
  };
}

/**
 * @param {WorktreeFingerprint | null | undefined} left
 * @param {WorktreeFingerprint | null | undefined} right
 * @returns {boolean}
 */
export function fingerprintsMatch(left, right) {
  if (!left || !right) return false;
  if (left.is_git !== right.is_git) return false;
  if (left.is_git) {
    return left.head === right.head && left.dirty_signature === right.dirty_signature;
  }
  return left.inventory_signature === right.inventory_signature;
}

/**
 * Collect ignore-related file hashes used in attestation.
 *
 * @param {string} projectRoot
 * @returns {Record<string, string>}
 */
export function captureIgnoreConfigHashes(projectRoot) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const rel of ['.gitignore', '.cbmignore', '.codebase-memory.json']) {
    const absolute = join(projectRoot, rel);
    if (!existsSync(absolute)) continue;
    try {
      hashes[rel] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    } catch {
      // ignore
    }
  }
  return hashes;
}
