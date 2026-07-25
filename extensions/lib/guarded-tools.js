import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Thrown when a subagent tries to mutate a path outside the Reversa sandbox. */
export class WriteOutsideSandboxError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "WriteOutsideSandboxError";
  }
}

/**
 * Lexical containment: is `target` at or below `root`?
 *
 * @param {string} root absolute
 * @param {string} target absolute
 */
function contains(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a path through symlinks as far as it exists on disk, keeping the
 * not-yet-created tail verbatim. Returns `null` when an existing component
 * cannot be resolved (for example a dangling symlink), which callers must
 * treat as a sandbox violation.
 *
 * @param {string} inputPath
 * @returns {string | null}
 */
export function canonicalize(inputPath) {
  let current = resolve(inputPath);
  /** @type {string[]} */
  const tail = [];

  for (;;) {
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats) {
      let real;
      try {
        real = realpathSync(current);
      } catch {
        return null;
      }
      return tail.length ? join(real, ...tail) : real;
    }

    const parent = dirname(current);
    if (parent === current) return tail.length ? join(current, ...tail) : current;
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * Build the mutation guard shared by the `write` and `edit` overrides.
 *
 * Two independent gates, both mandatory:
 *   1. lexical — the resolved path must sit under one of `allowedRoots`;
 *      this rejects `../` traversal.
 *   2. canonical — the symlink-resolved path must sit under the canonical
 *      form of the same root, where canonical roots are derived from
 *      `realpath(cwd)` plus the root's lexical offset. This rejects a root
 *      (or any ancestor) that is itself a symlink pointing out of the project,
 *      which the lexical gate alone cannot see.
 *
 * @param {string} cwd
 * @param {string[]} allowedRoots absolute paths, normally inside `cwd`
 * @returns {(absolutePath: string) => string} resolved path, or throws
 */
export function createSandboxGuard(cwd, allowedRoots) {
  const baseCwd = resolve(cwd);
  const canonicalCwd = canonicalize(baseCwd) ?? baseCwd;
  const roots = allowedRoots.map((root) => resolve(baseCwd, root));
  const canonicalRoots = roots.map((root) =>
    contains(baseCwd, root) ? join(canonicalCwd, relative(baseCwd, root)) : (canonicalize(root) ?? root),
  );

  return (absolutePath) => {
    const target = resolve(absolutePath);

    if (!roots.some((root) => contains(root, target))) {
      throw new WriteOutsideSandboxError(
        `Reversa sandbox: refusing to write outside allowed roots: ${absolutePath}`,
      );
    }

    const canonicalTarget = canonicalize(target);
    if (canonicalTarget === null || !canonicalRoots.some((root) => contains(root, canonicalTarget))) {
      throw new WriteOutsideSandboxError(
        `Reversa sandbox: refusing to write through a symlink that escapes the allowed roots: ${absolutePath}`,
      );
    }

    return target;
  };
}

/**
 * `write` and `edit` tool definitions restricted to the Reversa sandbox.
 * The names deliberately shadow the builtins so `customTools` replaces them.
 *
 * The thrown `WriteOutsideSandboxError` cannot reach the orchestrator: the
 * agent loop catches every tool exception and turns it into an error tool
 * result (pi-agent-core/dist/agent-loop.js:468-474). So each violation is also
 * recorded out-of-band on `.violations`, which the orchestrator inspects after
 * the child session settles. Throwing still matters — it stops the write and
 * tells the model why.
 *
 * @param {string} cwd
 * @param {string[]} allowedRoots
 * @returns {import("@earendil-works/pi-coding-agent").ToolDefinition[] & { violations: WriteOutsideSandboxError[] }}
 */
export function createGuardedFileTools(cwd, allowedRoots) {
  const rawGuard = createSandboxGuard(cwd, allowedRoots);
  /** @type {WriteOutsideSandboxError[]} */
  const violations = [];

  /** @param {string} absolutePath */
  const guard = (absolutePath) => {
    try {
      return rawGuard(absolutePath);
    } catch (error) {
      if (error instanceof WriteOutsideSandboxError) violations.push(error);
      throw error;
    }
  };

  /** @param {string} absolutePath @param {string} content */
  const guardedWriteFile = async (absolutePath, content) => {
    await writeFile(guard(absolutePath), content, "utf8");
  };

  /** @param {string} dir */
  const guardedMkdir = async (dir) => {
    await mkdir(guard(dir), { recursive: true });
  };

  const tools = [
    createWriteToolDefinition(cwd, {
      operations: { writeFile: guardedWriteFile, mkdir: guardedMkdir },
    }),
    createEditToolDefinition(cwd, {
      operations: {
        readFile: (absolutePath) => readFile(absolutePath),
        writeFile: guardedWriteFile,
        access: (absolutePath) => access(absolutePath),
      },
    }),
  ];

  return Object.assign(tools, { violations });
}

/** git subcommands a Reversa subagent may run. Read-only archaeology only. */
export const GIT_READ_SUBCOMMANDS = [
  "log",
  "show",
  "diff",
  "blame",
  "ls-files",
  "rev-parse",
  "shortlog",
  "describe",
  "status",
  "tag",
  "branch",
  "remote",
  "config",
];

const GIT_FORBIDDEN_ARGS = new Set(["--output", "-o", "--exec", ">", ">>"]);
const GIT_MAX_OUTPUT = 200_000;

/**
 * Extra per-subcommand policies.
 *
 * Four allowlisted subcommands are read-only only in *some* forms: `git branch
 * foo`, `git tag v1`, `git remote add …` and `git config key value` all mutate
 * `.git`, which sits outside the sandbox roots and so would bypass the write
 * guard entirely. Each policy returns a rejection reason or null.
 *
 * @type {Record<string, (rest: string[]) => string | null>}
 */
const GIT_SUBCOMMAND_POLICIES = {
  branch: (rest) => {
    const mutating = new Set([
      "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy",
      "-f", "--force", "--edit-description", "--set-upstream", "--set-upstream-to",
      "-u", "--unset-upstream", "-t", "--track", "--no-track",
    ]);
    for (const arg of rest) {
      if (mutating.has(arg) || arg.startsWith("--set-upstream-to=") || arg.startsWith("--track=")) {
        return `reversa_git: read-only git branch does not accept ${arg}`;
      }
      if (!arg.startsWith("-")) {
        return `reversa_git: read-only git branch does not accept the positional argument ${arg}`;
      }
    }
    return null;
  },
  tag: (rest) => {
    const readOnlyFlags = new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "-i", "--ignore-case"]);
    let listing = false;
    for (const arg of rest) {
      const flag = arg.split("=")[0];
      if (readOnlyFlags.has(flag)) {
        if (flag === "-l" || flag === "--list") listing = true;
        continue;
      }
      if (arg.startsWith("-")) return `reversa_git: read-only git tag does not accept ${arg}`;
      // Positional patterns are only safe in explicit list mode.
      if (!listing) return `reversa_git: read-only git tag does not accept the positional argument ${arg}`;
    }
    return null;
  },
  remote: (rest) => {
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    if (positional.length === 0) return null;
    const [verb] = positional;
    if (verb !== "show" && verb !== "get-url") {
      return `reversa_git: read-only git remote does not accept the subcommand ${verb}`;
    }
    return null;
  },
  config: (rest) => {
    const readOnly = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"];
    if (!rest.some((arg) => readOnly.includes(arg.split("=")[0]))) {
      return "reversa_git: git config requires an explicit read flag (--get, --get-all, --get-regexp, --list)";
    }
    const mutating = new Set(["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"]);
    for (const arg of rest) {
      if (mutating.has(arg)) return `reversa_git: read-only git config does not accept ${arg}`;
    }
    return null;
  },
};

/**
 * @param {string[]} args
 * @returns {string | null} rejection reason, or null when allowed
 */
export function rejectGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return "reversa_git: no subcommand given";

  const [subcommand, ...rest] = args;
  if (!GIT_READ_SUBCOMMANDS.includes(subcommand)) {
    return `reversa_git: subcommand not allowed: ${subcommand}`;
  }

  for (const arg of rest) {
    if (GIT_FORBIDDEN_ARGS.has(arg) || arg.startsWith("--upload-pack") || arg.startsWith("--receive-pack")) {
      return `reversa_git: argument not allowed: ${arg}`;
    }
  }

  return GIT_SUBCOMMAND_POLICIES[subcommand]?.(rest) ?? null;
}

/**
 * Read-only git tool. Exists because subagents run without `bash`, and the
 * Detective stage needs commit archaeology.
 *
 * @param {string} cwd
 * @returns {import("@earendil-works/pi-coding-agent").ToolDefinition}
 */
export function createGitReadTool(cwd) {
  return {
    name: "reversa_git",
    label: "Reversa Git (read-only)",
    description:
      "Run a read-only git command in the project. Only history/inspection subcommands are allowed; there is no shell.",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: 'git subcommand and arguments, e.g. ["log","--oneline","-n","50"]',
      }),
    }),
    async execute(_toolCallId, params, signal) {
      // The runtime turns a thrown error into an error tool result
      // (pi-agent-core/dist/agent-loop.js:468-474); there is no isError field
      // on AgentToolResult.
      const rejection = rejectGitArgs(params.args);
      if (rejection) {
        throw new Error(`${rejection}. Allowed subcommands: ${GIT_READ_SUBCOMMANDS.join(", ")}`);
      }

      const output = await new Promise((resolvePromise, rejectPromise) => {
        execFile(
          "git",
          params.args,
          { cwd, signal, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error && !stdout) {
              rejectPromise(new Error(`reversa_git failed: ${stderr || error.message}`));
              return;
            }
            resolvePromise(stdout || stderr || "(no output)");
          },
        );
      });

      const text = output.length > GIT_MAX_OUTPUT ? `${output.slice(0, GIT_MAX_OUTPUT)}\n… [truncated]` : output;

      return { content: [{ type: "text", text }], details: { args: params.args } };
    },
  };
}
