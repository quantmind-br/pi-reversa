import { spawnSync } from 'node:child_process';
import { CodeIntelligenceError } from './errors.js';

/** Actions exposed by the curated Reversa tool surface. */
export const CURATED_ACTIONS = Object.freeze([
  'architecture',
  'search_symbols',
  'search_code',
  'trace_calls',
  'trace_data_flow',
  'snippet',
  'change_impact',
  'status',
]);

/** Upstream tools that may exist depending on binary version. */
export const UPSTREAM_TOOLS = Object.freeze([
  'index_repository',
  'list_projects',
  'index_status',
  'search_graph',
  'search_code',
  'trace_path',
  'get_code_snippet',
  'get_architecture',
  'get_graph_schema',
  'detect_changes',
  'query_graph',
  'check_index_coverage',
  'delete_project',
  'manage_adr',
  'ingest_traces',
]);

/**
 * @typedef {object} CapabilityReport
 * @property {string} version
 * @property {string} binaryPath
 * @property {string[]} availableTools
 * @property {string[]} missingTools
 * @property {string[]} curatedActions
 * @property {string[]} unavailableActions
 * @property {boolean} hasCoverageCheck
 * @property {boolean} hasDetectChanges
 * @property {boolean} hasGraphSchema
 * @property {Record<string, any>} details
 */

/**
 * Probe which tools exist by invoking `--help` per candidate.
 *
 * @param {object} options
 * @param {string} options.binaryPath
 * @param {string} options.version
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<CapabilityReport>}
 */
export async function probeCapabilities(options) {
  const { binaryPath, version, signal } = options;
  if (signal?.aborted) {
    throw new CodeIntelligenceError('aborted', 'capability probe aborted');
  }

  /** @type {string[]} */
  const availableTools = [];
  /** @type {string[]} */
  const missingTools = [];
  /** @type {Record<string, string>} */
  const probeErrors = {};

  for (const tool of UPSTREAM_TOOLS) {
    if (signal?.aborted) {
      throw new CodeIntelligenceError('aborted', 'capability probe aborted');
    }
    const result = spawnSync(binaryPath, ['cli', tool, '--help'], {
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
    });
    const blob = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`.toLowerCase();
    if (result.error && result.error.code === 'ENOENT') {
      throw new CodeIntelligenceError('unavailable', `binary missing during capability probe: ${binaryPath}`);
    }
    if (
      blob.includes('unknown tool')
      || blob.includes('unrecognized')
      || (result.status !== 0 && blob.includes('error: unknown'))
    ) {
      missingTools.push(tool);
      probeErrors[tool] = (result.stderr || result.stdout || result.error?.message || 'unknown tool').trim();
      continue;
    }
    if (blob.includes('usage:') || blob.includes('flags:') || result.status === 0) {
      availableTools.push(tool);
      continue;
    }
    // Conservative fallback: non-zero without usage text => missing.
    missingTools.push(tool);
    probeErrors[tool] = (result.stderr || result.stdout || 'probe failed').trim();
  }

  // Ensure core tools from --help of the binary itself are considered when help probing is noisy.
  if (availableTools.length === 0) {
    const top = spawnSync(binaryPath, ['--help'], {
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
    });
    const help = `${top.stdout ?? ''}\n${top.stderr ?? ''}`.toLowerCase();
    for (const tool of UPSTREAM_TOOLS) {
      if (help.includes(tool.toLowerCase()) || help.includes(tool.replaceAll('_', ' '))) {
        availableTools.push(tool);
      }
    }
  }

  const available = new Set(availableTools);
  const curatedActions = CURATED_ACTIONS.filter((action) => actionSupported(action, available));
  const unavailableActions = CURATED_ACTIONS.filter((action) => !actionSupported(action, available));

  return {
    version,
    binaryPath,
    availableTools: [...available],
    missingTools: missingTools.filter((tool) => !available.has(tool)),
    curatedActions,
    unavailableActions,
    hasCoverageCheck: available.has('check_index_coverage'),
    hasDetectChanges: available.has('detect_changes'),
    hasGraphSchema: available.has('get_graph_schema'),
    details: {
      probeErrors,
      note: 'Security allowlists are enforced by Reversa, not by upstream tool profiles.',
    },
  };
}

/**
 * @param {string} action
 * @param {Set<string>} available
 */
function actionSupported(action, available) {
  switch (action) {
    case 'architecture':
      return available.has('get_architecture');
    case 'search_symbols':
      return available.has('search_graph');
    case 'search_code':
      return available.has('search_code');
    case 'trace_calls':
    case 'trace_data_flow':
      return available.has('trace_path');
    case 'snippet':
      return available.has('get_code_snippet');
    case 'change_impact':
      return available.has('detect_changes');
    case 'status':
      return available.has('index_status') || available.has('list_projects');
    default:
      return false;
  }
}

/**
 * Map curated action names to upstream tool names.
 *
 * @param {string} action
 * @returns {string}
 */
export function upstreamToolForAction(action) {
  switch (action) {
    case 'architecture':
      return 'get_architecture';
    case 'search_symbols':
      return 'search_graph';
    case 'search_code':
      return 'search_code';
    case 'trace_calls':
    case 'trace_data_flow':
      return 'trace_path';
    case 'snippet':
      return 'get_code_snippet';
    case 'change_impact':
      return 'detect_changes';
    case 'status':
      return 'index_status';
    default:
      throw new CodeIntelligenceError('unsupported', `unknown curated action: ${action}`);
  }
}
