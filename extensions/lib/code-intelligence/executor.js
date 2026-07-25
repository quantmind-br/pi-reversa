import { spawn } from 'node:child_process';
import { CodeIntelligenceError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_STDOUT_BYTES = 512 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * @typedef {object} CliExecOptions
 * @property {string} binaryPath
 * @property {string[]} args
 * @property {unknown} [input]
 * @property {number} [timeoutMs]
 * @property {number} [maxStdoutBytes]
 * @property {number} [maxStderrBytes]
 * @property {AbortSignal} [signal]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 */

/**
 * @param {Buffer[]} chunks
 * @returns {number}
 */
function totalBytes(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

/**
 * Execute one codebase-memory CLI invocation without shell.
 *
 * Prefers JSON over stdin when `input` is provided.
 *
 * @param {CliExecOptions} options
 * @returns {Promise<any>}
 */
export async function execCodebaseMemoryCli(options) {
  const {
    binaryPath,
    args,
    input,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    signal,
    env,
    cwd,
  } = options;

  if (signal?.aborted) {
    throw new CodeIntelligenceError('aborted', 'codebase-memory call aborted before start');
  }

  return await new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;

    const child = spawn(binaryPath, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 250).unref?.();
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      if (totalBytes(stdoutChunks) > maxStdoutBytes) {
        outputLimitExceeded = true;
        killChild();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      if (totalBytes(stderrChunks) > maxStderrBytes) {
        // keep last window only
        const joined = Buffer.concat(stderrChunks);
        stderrChunks.length = 0;
        stderrChunks.push(joined.subarray(joined.length - maxStderrBytes));
      }
    });

    child.on('error', (error) => {
      finish(new CodeIntelligenceError('unavailable', `failed to spawn codebase-memory: ${error.message}`));
    });

    child.on('close', (code, killSignal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (aborted || signal?.aborted) {
        finish(new CodeIntelligenceError('aborted', 'codebase-memory call aborted', { stderr }));
        return;
      }
      if (timedOut) {
        finish(new CodeIntelligenceError('timeout', `codebase-memory timed out after ${timeoutMs}ms`, { stderr }));
        return;
      }
      if (outputLimitExceeded) {
        finish(new CodeIntelligenceError('output_limit', `codebase-memory stdout exceeded ${maxStdoutBytes} bytes`, {
          stderr,
        }));
        return;
      }
      if (code !== 0) {
        finish(new CodeIntelligenceError('cli_error', `codebase-memory exited with code ${code ?? 'null'}${killSignal ? ` signal ${killSignal}` : ''}`, {
          code,
          signal: killSignal,
          stderr,
          stdout: stdout.slice(0, 4_000),
        }));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        finish(new CodeIntelligenceError('cli_error', 'codebase-memory returned empty stdout', { stderr }));
        return;
      }

      // CLI may emit log lines before JSON. Prefer the last JSON object/array.
      let jsonText = trimmed;
      const firstBrace = trimmed.indexOf('{');
      const firstBracket = trimmed.indexOf('[');
      const startCandidates = [firstBrace, firstBracket].filter((index) => index >= 0);
      if (startCandidates.length > 0) {
        const start = Math.min(...startCandidates);
        jsonText = trimmed.slice(start);
      }

      try {
        finish(null, JSON.parse(jsonText));
      } catch (error) {
        finish(new CodeIntelligenceError('cli_error', 'codebase-memory returned non-JSON stdout', {
          stderr,
          stdout: trimmed.slice(0, 4_000),
          parseError: error instanceof Error ? error.message : String(error),
        }));
      }
    });

    if (input !== undefined) {
      const payload = typeof input === 'string' ? input : `${JSON.stringify(input)}\n`;
      child.stdin.write(payload);
    }
    child.stdin.end();
  });
}

/**
 * Build CLI args for a tool invocation.
 *
 * @param {string} tool
 * @param {Record<string, any>} [params]
 * @returns {string[]}
 */
export function buildCliArgs(tool, params = {}) {
  // Prefer stdin JSON for complex objects; keep flags for simple overrides when needed.
  return ['cli', tool];
}
