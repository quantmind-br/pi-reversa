import { join } from 'node:path';

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function indexLockPath(projectRoot) {
  return join(projectRoot, '.reversa', 'cache', 'codebase-memory', 'index.lock');
}
