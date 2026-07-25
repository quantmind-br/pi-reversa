import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveCodebaseMemoryBinary } from './binary.js';
import { probeCapabilities, upstreamToolForAction } from './capabilities.js';
import { resolveCodeIntelligenceConfig } from './config.js';
import { execCodebaseMemoryCli } from './executor.js';
import { CodeIntelligenceError, serializeCodeIntelligenceError } from './errors.js';
import {
  captureIgnoreConfigHashes,
  captureWorktreeFingerprint,
  fingerprintsMatch,
} from './freshness.js';
import { acquireExclusiveLock, indexLockPath } from './locks.js';
import { hashValue, materializeContextBundle } from './materializer.js';
import { canonicalizeRoot, deriveProjectName, resolveBoundProject } from './project.js';

/**
 * @typedef {object} CodeIntelSession
 * @property {boolean} available
 * @property {string} [reason]
 * @property {import('./config.js').CodeIntelligenceConfig} config
 * @property {string} projectRoot
 * @property {string} canonicalRoot
 * @property {string} cacheDir
 * @property {import('./binary.js').BinaryResolution | null} binary
 * @property {import('./capabilities.js').CapabilityReport | null} capabilities
 * @property {import('./project.js').ResolvedProject | null} project
 * @property {import('./freshness.js').WorktreeFingerprint | null} fingerprint
 * @property {Record<string, any> | null} manifest
 * @property {string[]} warnings
 * @property {any[]} events
 */

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function cacheDirFor(projectRoot) {
  return join(resolve(projectRoot), '.reversa', 'cache', 'codebase-memory');
}

/**
 * @param {string} projectRoot
 * @returns {Record<string, string | undefined>}
 */
export function buildCbmEnv(projectRoot) {
  const cacheDir = cacheDirFor(projectRoot);
  mkdirSync(cacheDir, { recursive: true });
  return {
    CBM_CACHE_DIR: cacheDir,
    CBM_ALLOWED_ROOT: canonicalizeRoot(projectRoot),
  };
}

/**
 * @param {string} destination
 * @param {unknown} value
 */
function atomicWriteJson(destination, value) {
  mkdirSync(dirname(destination), { recursive: true });
  const tmp = `${destination}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, destination);
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function attestationPath(projectRoot) {
  return join(cacheDirFor(projectRoot), 'attestation.json');
}

/**
 * @param {string} projectRoot
 * @returns {Record<string, any> | null}
 */
export function readAttestation(projectRoot) {
  try {
    return JSON.parse(readFileSync(attestationPath(projectRoot), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Create a session-scoped controller state without indexing yet.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {Partial<import('./config.js').CodeIntelligenceConfig>} [options.config]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<CodeIntelSession>}
 */
export async function createCodeIntelSession(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const config = resolveCodeIntelligenceConfig(projectRoot, options.config);
  /** @type {CodeIntelSession} */
  const session = {
    available: false,
    config,
    projectRoot,
    canonicalRoot: canonicalizeRoot(projectRoot),
    cacheDir: cacheDirFor(projectRoot),
    binary: null,
    capabilities: null,
    project: null,
    fingerprint: null,
    manifest: null,
    warnings: [],
    events: [],
  };

  if (!config.enabled) {
    session.reason = 'code intelligence disabled by configuration';
    return session;
  }

  try {
    session.binary = resolveCodebaseMemoryBinary({
      projectRoot,
      bin: config.bin,
    });
    session.capabilities = await probeCapabilities({
      binaryPath: session.binary.path,
      version: session.binary.version,
      signal: options.signal,
    });
    if (session.capabilities.curatedActions.length === 0) {
      throw new CodeIntelligenceError('unsupported', 'no curated codebase-memory actions available on this binary', {
        version: session.binary.version,
        availableTools: session.capabilities.availableTools,
      });
    }
    session.available = true;
    pushEvent(session, 'preflight_ok', {
      version: session.binary.version,
      actions: session.capabilities.curatedActions,
    });
  } catch (error) {
    session.available = false;
    session.reason = error instanceof Error ? error.message : String(error);
    session.warnings.push(session.reason);
    pushEvent(session, 'preflight_failed', serializeCodeIntelligenceError(error));
  }

  return session;
}

/**
 * Ensure an index exists and is fresh, then materialize context.
 *
 * @param {CodeIntelSession} session
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.forceRefresh]
 * @param {string[]} [options.modules]
 * @returns {Promise<CodeIntelSession>}
 */
export async function ensureIndexedAndMaterialized(session, options = {}) {
  if (!session.available || !session.binary || !session.capabilities) return session;

  const env = buildCbmEnv(session.projectRoot);
  const fingerprint = captureWorktreeFingerprint(session.projectRoot);
  session.fingerprint = fingerprint;

  let project = null;
  try {
    project = await resolveBoundProject({
      binaryPath: session.binary.path,
      projectRoot: session.projectRoot,
      env,
      signal: options.signal,
    });
  } catch (error) {
    session.available = false;
    session.reason = error instanceof Error ? error.message : String(error);
    session.warnings.push(session.reason);
    pushEvent(session, 'project_resolve_failed', serializeCodeIntelligenceError(error));
    return session;
  }

  const attestation = readAttestation(session.projectRoot);
  const fresh = project
    && attestation
    && attestation.project_name === project.name
    && fingerprintsMatch(attestation.fingerprint, fingerprint)
    && attestation.binary_version === session.binary.version
    && !options.forceRefresh;

  if (!fresh) {
    if (!session.config.auto_index && !options.forceRefresh) {
      if (!project) {
        session.available = false;
        session.reason = 'no bound codebase-memory index found and auto_index is disabled';
        session.warnings.push(session.reason);
        return session;
      }
      if (session.config.strict_freshness) {
        session.available = false;
        session.reason = 'codebase-memory index is stale and auto_index is disabled';
        session.warnings.push(session.reason);
        pushEvent(session, 'stale_index', { project: project.name });
        return session;
      }
      session.warnings.push('using stale codebase-memory index because auto_index is disabled');
    } else {
      try {
        project = await indexRepository(session, {
          env,
          signal: options.signal,
          existing: project,
        });
      } catch (error) {
        session.available = false;
        session.reason = error instanceof Error ? error.message : String(error);
        session.warnings.push(session.reason);
        pushEvent(session, 'index_failed', serializeCodeIntelligenceError(error));
        return session;
      }
    }
  }

  session.project = project;

  /** @type {Record<string, any>} */
  const manifest = {
    available: true,
    provider: 'codebase-memory',
    binary: {
      path: session.binary.path,
      version: session.binary.version,
      source: session.binary.source,
    },
    project: {
      name: project?.name ?? null,
      root_path: project?.root_path ?? session.canonicalRoot,
      canonical_root: session.canonicalRoot,
    },
    capabilities: {
      curatedActions: session.capabilities.curatedActions,
      availableTools: session.capabilities.availableTools,
      hasCoverageCheck: session.capabilities.hasCoverageCheck,
      hasDetectChanges: session.capabilities.hasDetectChanges,
    },
    fingerprint,
    ignore_hashes: captureIgnoreConfigHashes(session.projectRoot),
    cache_dir: session.cacheDir,
    generated_at: new Date().toISOString(),
    evidence_policy: {
      graph_is_discovery_only: true,
      require_source_confirmation: true,
      negative_claims_require_fallback: true,
    },
  };

  let architecture;
  let schemaSummary;
  let coverage;

  try {
    if (project && session.capabilities.curatedActions.includes('architecture')) {
      architecture = await execCodebaseMemoryCli({
        binaryPath: session.binary.path,
        args: ['cli', 'get_architecture'],
        input: {
          project: project.name,
          aspects: ['overview'],
        },
        timeoutMs: 60_000,
        env,
        signal: options.signal,
      });
    }
  } catch (error) {
    session.warnings.push(`architecture materialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (project && session.capabilities.hasGraphSchema) {
      schemaSummary = await execCodebaseMemoryCli({
        binaryPath: session.binary.path,
        args: ['cli', 'get_graph_schema'],
        input: { project: project.name },
        timeoutMs: 15_000,
        env,
        signal: options.signal,
      });
    }
  } catch {
    // optional
  }

  if (session.capabilities.hasCoverageCheck && project) {
    try {
      coverage = await execCodebaseMemoryCli({
        binaryPath: session.binary.path,
        args: ['cli', 'check_index_coverage'],
        input: { project: project.name },
        timeoutMs: 30_000,
        env,
        signal: options.signal,
      });
    } catch (error) {
      coverage = {
        unavailable: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    coverage = {
      unavailable: true,
      reason: 'check_index_coverage not available on this binary',
    };
  }

  /** @type {Record<string, unknown>} */
  const modules = {};
  for (const moduleName of options.modules ?? []) {
    modules[moduleName] = {
      module: moduleName,
      note: 'Use reversa_code_intel with file/module scoped queries for deep analysis.',
    };
  }

  const materialization = materializeContextBundle({
    projectRoot: session.projectRoot,
    manifest,
    architecture,
    schemaSummary,
    coverage,
    modules,
  });
  manifest.materialization = materialization;
  session.manifest = manifest;
  pushEvent(session, 'materialized', {
    files: materialization.files,
    warnings: materialization.warnings,
  });

  return session;
}

/**
 * @param {CodeIntelSession} session
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env
 * @param {AbortSignal} [options.signal]
 * @param {import('./project.js').ResolvedProject | null} [options.existing]
 */
async function indexRepository(session, options) {
  if (!session.binary) {
    throw new CodeIntelligenceError('unavailable', 'binary not resolved');
  }

  const release = acquireExclusiveLock(indexLockPath(session.projectRoot));
  const started = Date.now();
  try {
    const name = options.existing?.name ?? deriveProjectName(session.projectRoot);
    const result = await execCodebaseMemoryCli({
      binaryPath: session.binary.path,
      args: ['cli', 'index_repository'],
      input: {
        repo_path: session.canonicalRoot,
        mode: session.config.index_mode,
        name,
        persistence: false,
      },
      timeoutMs: 10 * 60 * 1000,
      maxStdoutBytes: 1024 * 1024,
      env: options.env,
      signal: options.signal,
    });

    const fingerprint = captureWorktreeFingerprint(session.projectRoot);
    session.fingerprint = fingerprint;

    const project = await resolveBoundProject({
      binaryPath: session.binary.path,
      projectRoot: session.projectRoot,
      env: options.env,
      signal: options.signal,
      preferredName: result?.project ?? name,
    });
    if (!project) {
      throw new CodeIntelligenceError('scope_mismatch', 'index completed but project could not be bound to cwd', {
        result,
        name,
      });
    }

    atomicWriteJson(attestationPath(session.projectRoot), {
      project_name: project.name,
      root_path: project.root_path,
      canonical_root: session.canonicalRoot,
      binary_version: session.binary.version,
      index_mode: session.config.index_mode,
      fingerprint,
      ignore_hashes: captureIgnoreConfigHashes(session.projectRoot),
      indexed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      result_status: result?.status ?? null,
    });

    pushEvent(session, 'indexed', {
      project: project.name,
      duration_ms: Date.now() - started,
      mode: session.config.index_mode,
    });

    return project;
  } finally {
    release();
  }
}

/**
 * Execute one curated query against the bound project.
 *
 * @param {CodeIntelSession} session
 * @param {object} request
 * @param {string} request.action
 * @param {Record<string, any>} [request.params]
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<any>}
 */
export async function queryCodeIntel(session, request) {
  if (!session.available || !session.binary || !session.capabilities || !session.project) {
    throw new CodeIntelligenceError('unavailable', session.reason ?? 'code intelligence unavailable');
  }
  if (!session.capabilities.curatedActions.includes(request.action) && request.action !== 'status') {
    throw new CodeIntelligenceError('unsupported', `action not available: ${request.action}`, {
      action: request.action,
      curatedActions: session.capabilities.curatedActions,
    });
  }

  // Freshness gate for strict mode.
  if (session.config.strict_freshness && session.fingerprint) {
    const current = captureWorktreeFingerprint(session.projectRoot);
    if (!fingerprintsMatch(session.fingerprint, current)) {
      if (session.config.auto_index) {
        await ensureIndexedAndMaterialized(session, {
          signal: request.signal,
          forceRefresh: true,
        });
      } else {
        throw new CodeIntelligenceError('stale', 'worktree changed since codebase-memory snapshot was captured');
      }
    }
  }

  const env = buildCbmEnv(session.projectRoot);
  const tool = upstreamToolForAction(request.action);
  const input = buildUpstreamInput(session, request.action, request.params ?? {});
  const started = Date.now();

  try {
    const result = await execCodebaseMemoryCli({
      binaryPath: session.binary.path,
      args: ['cli', tool],
      input,
      timeoutMs: timeoutForAction(request.action),
      env,
      signal: request.signal,
    });
    pushEvent(session, 'query_ok', {
      action: request.action,
      duration_ms: Date.now() - started,
      params_hash: hashValue(sanitizeParams(request.params ?? {})),
    });
    return {
      action: request.action,
      project: session.project.name,
      result,
      evidence_policy: session.manifest?.evidence_policy ?? {
        graph_is_discovery_only: true,
        require_source_confirmation: true,
      },
    };
  } catch (error) {
    pushEvent(session, 'query_failed', {
      action: request.action,
      duration_ms: Date.now() - started,
      error: serializeCodeIntelligenceError(error),
    });
    throw error;
  }
}

/**
 * @param {CodeIntelSession} session
 * @param {string} action
 * @param {Record<string, any>} params
 */
function buildUpstreamInput(session, action, params) {
  const project = session.project?.name;
  if (!project) throw new CodeIntelligenceError('unavailable', 'project not bound');

  // Strip forbidden keys even if a caller tries to inject them.
  const {
    project: _project,
    repo_path: _repoPath,
    cache_dir: _cacheDir,
    ...safe
  } = params;

  switch (action) {
    case 'architecture':
      return {
        project,
        path: safe.path,
        aspects: Array.isArray(safe.aspects) ? safe.aspects.slice(0, 8) : ['overview'],
      };
    case 'search_symbols':
      return {
        project,
        query: safe.query,
        name_pattern: safe.name_pattern,
        label: safe.label,
        file_pattern: safe.file_pattern,
        limit: clampInt(safe.limit, 1, 50, 20),
        offset: clampInt(safe.offset, 0, 10_000, 0),
      };
    case 'search_code':
      return {
        project,
        query: safe.query ?? safe.pattern,
        file_pattern: safe.file_pattern,
        limit: clampInt(safe.limit, 1, 20, 10),
      };
    case 'trace_calls':
      return {
        project,
        function_name: safe.function_name ?? safe.symbol,
        direction: safe.direction ?? 'both',
        depth: clampInt(safe.depth, 1, 5, 3),
        mode: 'calls',
        include_tests: Boolean(safe.include_tests),
      };
    case 'trace_data_flow':
      return {
        project,
        function_name: safe.function_name ?? safe.symbol,
        direction: safe.direction ?? 'both',
        depth: clampInt(safe.depth, 1, 5, 3),
        mode: 'data_flow',
        parameter_name: safe.parameter_name,
        include_tests: Boolean(safe.include_tests),
      };
    case 'snippet':
      return {
        project,
        qualified_name: safe.qualified_name,
        include_neighbors: safe.include_neighbors !== false,
      };
    case 'change_impact':
      return {
        project,
        // detect_changes uses git state; keep params minimal.
      };
    case 'status':
      return { project };
    default:
      throw new CodeIntelligenceError('unsupported', `unknown action ${action}`);
  }
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

/**
 * @param {string} action
 */
function timeoutForAction(action) {
  switch (action) {
    case 'architecture':
      return 60_000;
    case 'trace_calls':
    case 'trace_data_flow':
      return 30_000;
    case 'change_impact':
      return 30_000;
    default:
      return 15_000;
  }
}

/**
 * @param {Record<string, any>} params
 */
function sanitizeParams(params) {
  const clone = { ...params };
  delete clone.project;
  delete clone.repo_path;
  delete clone.cache_dir;
  return clone;
}

/**
 * @param {CodeIntelSession} session
 * @param {string} type
 * @param {Record<string, any>} [payload]
 */
function pushEvent(session, type, payload = {}) {
  session.events.push({
    type,
    at: new Date().toISOString(),
    ...payload,
  });
}

/**
 * Persist run events for observability.
 *
 * @param {string} runDir
 * @param {CodeIntelSession} session
 */
export function writeSessionEvents(runDir, session) {
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
  const target = join(runDir, 'cbm-events.jsonl');
  const lines = session.events.map((event) => JSON.stringify(event));
  writeFileSync(target, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

/**
 * Host-friendly status snapshot.
 *
 * @param {CodeIntelSession} session
 */
export function statusSnapshot(session) {
  return {
    available: Boolean(session?.available),
    reason: session?.reason ?? null,
    enabled: session?.config?.enabled ?? false,
    auto_index: session?.config?.auto_index ?? false,
    provider: session?.config?.provider ?? 'codebase-memory',
    binary_version: session?.binary?.version ?? null,
    project: session?.project?.name ?? null,
    canonical_root: session?.canonicalRoot ?? null,
    curated_actions: session?.capabilities?.curatedActions ?? [],
    warnings: session?.warnings ?? [],
    fingerprint: session?.fingerprint ?? null,
  };
}
