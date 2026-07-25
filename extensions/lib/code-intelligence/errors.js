/**
 * Structured errors for the code-intelligence adapter.
 */
export class CodeIntelligenceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, any>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CodeIntelligenceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {unknown} error
 * @returns {error is CodeIntelligenceError}
 */
export function isCodeIntelligenceError(error) {
  return error instanceof CodeIntelligenceError;
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string, details?: Record<string, any> }}
 */
export function serializeCodeIntelligenceError(error) {
  if (isCodeIntelligenceError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: 'internal', message: error.message };
  }
  return { code: 'internal', message: String(error) };
}
