export {
  DEFAULT_CODE_INTELLIGENCE_CONFIG,
  codeIntelligenceConfigTomlBlock,
  parseCodeIntelligenceSection,
  readCodeIntelligenceConfigFile,
  resolveCodeIntelligenceConfig,
} from './config.js';

export {
  detectPlatformSupport,
  packageRootDir,
  probeBinaryVersion,
  resolveCodebaseMemoryBinary,
} from './binary.js';

export {
  CURATED_ACTIONS,
  UPSTREAM_TOOLS,
  probeCapabilities,
  upstreamToolForAction,
} from './capabilities.js';

export {
  CodeIntelligenceError,
  isCodeIntelligenceError,
  serializeCodeIntelligenceError,
} from './errors.js';

export {
  buildCliArgs,
  execCodebaseMemoryCli,
} from './executor.js';

export {
  captureIgnoreConfigHashes,
  captureWorktreeFingerprint,
  fingerprintsMatch,
  inventorySignature,
} from './freshness.js';

export {
  CONTEXT_DIR,
  clearMaterializedContext,
  contextRoot,
  hashValue,
  materializeContextBundle,
  serializeLimited,
} from './materializer.js';

export {
  canonicalizeRoot,
  deriveProjectName,
  listProjects,
  resolveBoundProject,
} from './project.js';

export {
  buildCbmEnv,
  cacheDirFor,
  createCodeIntelSession,
  ensureIndexedAndMaterialized,
  queryCodeIntel,
  readAttestation,
  statusSnapshot,
  writeSessionEvents,
} from './controller.js';
