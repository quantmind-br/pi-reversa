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
import { dirname, join } from 'node:path';

/**
 * Simple exclusive lock for index/refresh operations.
 *
 * @param {string} lockPath
 * @param {{ staleMs?: number }} [options]
 * @returns {() => void}
 */
export function acquireExclusiveLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? 30 * 60 * 1000;
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
      const err = new Error(`codebase-memory index lock busy: ${lockPath}`);
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
 * @param {string} projectRoot
 * @returns {string}
 */
export function indexLockPath(projectRoot) {
  return join(projectRoot, '.reversa', 'cache', 'codebase-memory', 'index.lock');
}
