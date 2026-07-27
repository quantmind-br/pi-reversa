import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalize, containsPath, WriteOutsideSandboxError } from './guarded-tools.js';

/**
 * Simple exclusive lock backed by O_EXCL, with stale-lock recovery.
 *
 * When `containRoot` is given, the lock path must resolve inside it *through
 * symlinks*. Without that check a symlinked `.reversa` would place the lock
 * outside the project before any pipeline sandbox validation runs.
 *
 * @param {string} lockPath
 * @param {{ staleMs?: number, label?: string, containRoot?: string }} [options]
 * @returns {() => void} release
 */
export function acquireExclusiveLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? 30 * 60 * 1000;

  // Validate BEFORE mkdir: creating the parent chain first would already
  // materialize directories outside the project under a symlinked `.reversa`.
  if (options.containRoot) {
    const root = canonicalize(resolve(options.containRoot));
    const target = canonicalize(lockPath);
    if (root === null || target === null || !containsPath(root, target)) {
      throw new WriteOutsideSandboxError(
        `Reversa sandbox: refusing to create the ${options.label ?? 'reversa'} lock outside the project: ${lockPath}`,
      );
    }
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > staleMs) rmSync(lockPath, { force: true });
    } catch {
      // ignore
    }
  }

  let fd;
  try {
    fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    }));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        // ignore
      }
      const err = new Error(`${options.label ?? 'reversa'} lock busy: ${lockPath}`);
      // @ts-ignore
      err.code = 'lock_busy';
      // @ts-ignore
      err.owner = owner;
      throw err;
    }
    throw error;
  }

  return () => {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(lockPath, { force: true });
  };
}

/**
 * Lock guarding a whole unattended pipeline run for a project.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function automationLockPath(projectRoot) {
  return join(resolve(projectRoot), '.reversa', 'automation.lock');
}
