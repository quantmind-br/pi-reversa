import { createRequire } from 'node:module';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CodeIntelligenceError } from './errors.js';

const SUPPORTED_PLATFORMS = new Set(['linux']);
const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);

/**
 * @typedef {object} BinaryResolution
 * @property {string} path
 * @property {string} version
 * @property {'linux'} platform
 * @property {'x64' | 'arm64'} arch
 * @property {string} source
 */

/**
 * @returns {{ platform: string, arch: string, supported: boolean, reason?: string }}
 */
export function detectPlatformSupport() {
  const platform = process.platform;
  const arch = process.arch;
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return {
      platform,
      arch,
      supported: false,
      reason: `codebase-memory support is Linux-first; platform ${platform} is not supported yet`,
    };
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    return {
      platform,
      arch,
      supported: false,
      reason: `architecture ${arch} is not supported for codebase-memory on Linux`,
    };
  }
  return { platform, arch, supported: true };
}

/**
 * Prefer the native payload binary over npm launcher shims when present.
 *
 * @param {string} candidate
 * @returns {string}
 */
function preferNativeBinary(candidate) {
  try {
    const resolved = realpathSync(candidate);
    const dir = dirname(resolved);
    const payload = join(dir, 'codebase-memory-mcp');
    if (existsSync(payload) && statSync(payload).isFile()) return payload;
    return resolved;
  } catch {
    return candidate;
  }
}

/**
 * @param {string} projectRoot
 * @param {string | null | undefined} configuredBin
 * @returns {string[]}
 */
function candidatePaths(projectRoot, configuredBin) {
  /** @type {string[]} */
  const candidates = [];
  if (configuredBin) candidates.push(configuredBin);
  if (process.env.REVERSA_CBM_BIN) candidates.push(process.env.REVERSA_CBM_BIN);

  const requireFromProject = createRequire(join(projectRoot, 'package.json'));
  const requireFromHere = createRequire(import.meta.url);

  for (const requireFn of [requireFromProject, requireFromHere]) {
    try {
      const pkgJson = requireFn.resolve('codebase-memory-mcp/package.json');
      const root = dirname(pkgJson);
      candidates.push(join(root, 'bin', 'codebase-memory-mcp'));
      candidates.push(join(root, 'bin.js'));
    } catch {
      // package not installed in this resolution root
    }
  }

  // Common local installs used in development/machines that already have CBM.
  candidates.push('/usr/local/bin/codebase-memory-mcp');

  const which = spawnSync('which', ['codebase-memory-mcp'], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  if (which.status === 0 && which.stdout.trim()) {
    candidates.push(which.stdout.trim());
  }

  return [...new Set(candidates.filter(Boolean))];
}

/**
 * @param {string} binaryPath
 * @returns {string}
 */
export function probeBinaryVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new CodeIntelligenceError('unavailable', `failed to execute codebase-memory binary: ${result.error.message}`, {
      path: binaryPath,
    });
  }
  if (result.status !== 0) {
    throw new CodeIntelligenceError('unavailable', `codebase-memory --version exited ${result.status}`, {
      path: binaryPath,
      stderr: result.stderr?.trim() || undefined,
    });
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const match = text.match(/codebase-memory-mcp\s+(\S+)/i) ?? text.match(/(\d+\.\d+\.\d+[^\s]*)/);
  return match?.[1] ?? text.split(/\s+/)[0] ?? 'unknown';
}

/**
 * Resolve a usable codebase-memory binary.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {string | null} [options.bin]
 * @returns {BinaryResolution}
 */
export function resolveCodebaseMemoryBinary(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const support = detectPlatformSupport();
  if (!support.supported) {
    throw new CodeIntelligenceError('unsupported', support.reason ?? 'platform unsupported', support);
  }

  const candidates = candidatePaths(projectRoot, options.bin);
  /** @type {string[]} */
  const errors = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      errors.push(`${candidate}: missing`);
      continue;
    }
    const binaryPath = preferNativeBinary(candidate);
    try {
      const version = probeBinaryVersion(binaryPath);
      return {
        path: binaryPath,
        version,
        platform: /** @type {'linux'} */ (support.platform),
        arch: /** @type {'x64' | 'arm64'} */ (support.arch),
        source: candidate === binaryPath ? 'direct' : 'package-payload',
      };
    } catch (error) {
      errors.push(`${binaryPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new CodeIntelligenceError(
    'unavailable',
    'codebase-memory-mcp binary not found or not executable',
    { candidates, errors },
  );
}

/**
 * Absolute directory of this package, useful for locating packaged assets.
 *
 * @returns {string}
 */
export function packageRootDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '../../..');
}
