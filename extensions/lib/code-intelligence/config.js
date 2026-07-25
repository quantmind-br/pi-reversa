import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {'moderate' | 'fast' | 'full'} IndexMode */

/**
 * @typedef {object} CodeIntelligenceConfig
 * @property {boolean} enabled
 * @property {string} provider
 * @property {IndexMode} index_mode
 * @property {boolean} auto_index
 * @property {boolean} strict_freshness
 * @property {boolean} query_tool
 * @property {string | null} bin
 */

export const DEFAULT_CODE_INTELLIGENCE_CONFIG = Object.freeze({
  enabled: true,
  provider: 'codebase-memory',
  index_mode: /** @type {IndexMode} */ ('moderate'),
  auto_index: true,
  strict_freshness: true,
  query_tool: true,
  bin: null,
});

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * @param {string} value
 * @returns {boolean | undefined}
 */
function parseBool(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * @param {string} value
 * @returns {IndexMode | undefined}
 */
function parseIndexMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'moderate' || normalized === 'fast' || normalized === 'full') return normalized;
  return undefined;
}

/**
 * Parse a TOML-ish `[code_intelligence]` section without pulling a full TOML parser.
 *
 * @param {string} raw
 * @returns {Partial<CodeIntelligenceConfig>}
 */
export function parseCodeIntelligenceSection(raw) {
  /** @type {Partial<CodeIntelligenceConfig>} */
  const section = {};
  let inSection = false;

  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      inSection = trimmed === '[code_intelligence]';
      continue;
    }
    if (!inSection) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, '');

    if (key === 'enabled') {
      const parsed = parseBool(value);
      if (parsed !== undefined) section.enabled = parsed;
    } else if (key === 'provider') {
      section.provider = value;
    } else if (key === 'index_mode') {
      const parsed = parseIndexMode(value);
      if (parsed) section.index_mode = parsed;
    } else if (key === 'auto_index') {
      const parsed = parseBool(value);
      if (parsed !== undefined) section.auto_index = parsed;
    } else if (key === 'strict_freshness') {
      const parsed = parseBool(value);
      if (parsed !== undefined) section.strict_freshness = parsed;
    } else if (key === 'query_tool') {
      const parsed = parseBool(value);
      if (parsed !== undefined) section.query_tool = parsed;
    } else if (key === 'bin') {
      section.bin = value || null;
    }
  }

  return section;
}

/**
 * @param {string} projectRoot
 * @returns {Partial<CodeIntelligenceConfig>}
 */
export function readCodeIntelligenceConfigFile(projectRoot) {
  const configPath = join(projectRoot, '.reversa', 'config.toml');
  if (!existsSync(configPath)) return {};
  try {
    return parseCodeIntelligenceSection(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Resolve effective code-intelligence configuration with env overrides.
 *
 * @param {string} projectRoot
 * @param {Partial<CodeIntelligenceConfig>} [overrides]
 * @returns {CodeIntelligenceConfig}
 */
export function resolveCodeIntelligenceConfig(projectRoot, overrides = {}) {
  const fileConfig = readCodeIntelligenceConfigFile(projectRoot);
  const envEnabled = parseBool(process.env.REVERSA_CBM_ENABLED ?? '');
  const envAutoIndex = parseBool(process.env.REVERSA_CBM_AUTO_INDEX ?? '');
  const envStrict = parseBool(process.env.REVERSA_CBM_STRICT_FRESHNESS ?? '');
  const envQueryTool = parseBool(process.env.REVERSA_CBM_QUERY_TOOL ?? '');
  const envMode = parseIndexMode(process.env.REVERSA_CBM_INDEX_MODE ?? '');
  const envBin = process.env.REVERSA_CBM_BIN?.trim() || null;

  return {
    ...DEFAULT_CODE_INTELLIGENCE_CONFIG,
    ...fileConfig,
    ...overrides,
    ...(envEnabled === undefined ? {} : { enabled: envEnabled }),
    ...(envAutoIndex === undefined ? {} : { auto_index: envAutoIndex }),
    ...(envStrict === undefined ? {} : { strict_freshness: envStrict }),
    ...(envQueryTool === undefined ? {} : { query_tool: envQueryTool }),
    ...(envMode ? { index_mode: envMode } : {}),
    ...(envBin ? { bin: envBin } : {}),
  };
}

/**
 * TOML block used by install templates / documentation.
 *
 * @returns {string}
 */
export function codeIntelligenceConfigTomlBlock() {
  return [
    '[code_intelligence]',
    'enabled = true',
    'provider = "codebase-memory"',
    'index_mode = "moderate"',
    'auto_index = true',
    'strict_freshness = true',
    'query_tool = true',
    '',
  ].join('\n');
}
