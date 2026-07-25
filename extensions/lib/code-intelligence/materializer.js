import { mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const CONTEXT_DIR = ['.reversa', 'context', 'codebase-memory'];
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function contextRoot(projectRoot) {
  return join(resolve(projectRoot), ...CONTEXT_DIR);
}

/**
 * @param {string} destination
 * @param {string} content
 */
function atomicWrite(destination, content) {
  mkdirSync(dirname(destination), { recursive: true });
  const tmp = `${destination}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, destination);
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {{ json: string, truncated: boolean, bytes: number }}
 */
export function serializeLimited(value, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  let json = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return { json, truncated: false, bytes: Buffer.byteLength(json, 'utf8') };
  }

  const compact = {
    truncated: true,
    reason: `payload exceeded ${maxBytes} bytes`,
    summary: summarizeForMaterialization(value),
  };
  json = `${JSON.stringify(compact, null, 2)}\n`;
  return { json, truncated: true, bytes: Buffer.byteLength(json, 'utf8') };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function summarizeForMaterialization(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 20),
    };
  }
  /** @type {Record<string, any>} */
  const summary = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      summary[key] = { type: 'array', length: entry.length, sample: entry.slice(0, 10) };
    } else if (entry && typeof entry === 'object') {
      summary[key] = { type: 'object', keys: Object.keys(entry).slice(0, 30) };
    } else {
      summary[key] = entry;
    }
  }
  return summary;
}

/**
 * Write the standard materialization bundle.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {Record<string, any>} options.manifest
 * @param {unknown} [options.architecture]
 * @param {unknown} [options.schemaSummary]
 * @param {unknown} [options.coverage]
 * @param {Record<string, unknown>} [options.modules]
 * @param {number} [options.maxFileBytes]
 * @param {number} [options.maxTotalBytes]
 * @returns {{ root: string, files: string[], warnings: string[] }}
 */
export function materializeContextBundle(options) {
  const root = contextRoot(options.projectRoot);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const warnings = [];
  let total = 0;

  mkdirSync(root, { recursive: true });

  /**
   * @param {string} relativePath
   * @param {unknown} value
   */
  const writeJson = (relativePath, value) => {
    const absolute = join(root, relativePath);
    const serialized = serializeLimited(value, maxFileBytes);
    if (total + serialized.bytes > maxTotalBytes) {
      warnings.push(`skipped ${relativePath}: total materialization budget exceeded`);
      return;
    }
    atomicWrite(absolute, serialized.json);
    files.push(relativePath);
    total += serialized.bytes;
    if (serialized.truncated) warnings.push(`truncated ${relativePath}`);
  };

  writeJson('manifest.json', options.manifest);
  if (options.architecture !== undefined) writeJson('architecture.json', options.architecture);
  if (options.schemaSummary !== undefined) writeJson('schema-summary.json', options.schemaSummary);
  if (options.coverage !== undefined) {
    writeJson(
      options.coverage && typeof options.coverage === 'object' && options.coverage.unavailable
        ? 'coverage-unavailable.json'
        : 'coverage.json',
      options.coverage,
    );
  }

  if (options.modules && typeof options.modules === 'object') {
    mkdirSync(join(root, 'modules'), { recursive: true });
    for (const [slug, payload] of Object.entries(options.modules)) {
      const safe = slug.replace(/[^A-Za-z0-9._-]+/g, '_');
      writeJson(join('modules', `${safe}.json`), payload);
    }
  }

  return { root, files, warnings };
}

/**
 * Remove materialization directory if present.
 *
 * @param {string} projectRoot
 */
export function clearMaterializedContext(projectRoot) {
  const root = contextRoot(projectRoot);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

/**
 * Hash small metadata for logs without storing full payloads.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
