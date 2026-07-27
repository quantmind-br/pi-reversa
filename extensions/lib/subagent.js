import { createGitReadTool, createGuardedFileTools } from "./guarded-tools.js";
import { createCodeIntelTool } from "./code-intel-tool.js";

/**
 * Tools a Reversa subagent may use.
 *
 * `bash` is absent by design: arbitrary shell cannot be sandboxed, so git
 * archaeology goes through `reversa_git` instead. No host delegation tool
 * (`subagent`, `subagent_wait`, …) appears here, and `noExtensions` below means
 * none can be loaded either.
 *
 * `reversa_code_intel` is package-owned and optional at runtime: if the binary
 * / index is unavailable the tool itself returns a structured fallback.
 */
export const SUBAGENT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "reversa_git",
  "reversa_code_intel",
];

/**
 * Lazily import the Pi SDK. Inside Pi, the extension loader aliases this
 * specifier to the running instance; outside Pi (tests) callers inject their
 * own `deps`, so the import never happens.
 */
async function loadSdk() {
  return import("@earendil-works/pi-coding-agent");
}

/**
 * Run one Reversa pipeline stage in an isolated in-process child session.
 *
 * Isolation contract (never configurable):
 *   - `noExtensions: true` — the child cannot load pi-reversa (no recursion)
 *     nor any host extension, so host delegation tools do not exist there.
 *   - `SessionManager.inMemory` — the child never touches ~/.pi/agent/sessions.
 *   - guarded `write`/`edit` override the builtins through `customTools`.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.task full prompt for the child session
 * @param {any} [options.model]
 * @param {string} [options.thinkingLevel]
 * @param {string[]} options.allowedRoots
 * @param {AbortSignal} [options.signal]
 * @param {(event: { type: string, name?: string, tokens?: number }) => void} [options.onEvent]
 * @param {any} [options.codeIntelSession]
 * @param {string} [options.stageId] pipeline stage id; identity seam for tests
 * @param {string} [options.runKey] fan-out run key (`stage:item`) when sharded
 * @param {object} [deps] injection seam for tests
 * @returns {Promise<{ text: string, stopReason: string, errorMessage?: string, usage: any, cost: number, messageCount: number, violations?: any[] }>}
 */
export async function runSubagent(
  { cwd, task, model, thinkingLevel, allowedRoots, signal, onEvent, codeIntelSession },
  deps = {},
) {
  const sdk = deps.sdk ?? (await loadSdk());
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir } = sdk;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: false,
  });
  await loader.reload();

  const fileTools = createGuardedFileTools(cwd, allowedRoots);
  const codeIntelTool = createCodeIntelTool({
    getSession: async () => codeIntelSession ?? null,
  });

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: SUBAGENT_TOOLS,
    customTools: [...fileTools, createGitReadTool(cwd), codeIntelTool],
  });

  const onAbort = () => void session.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const unsubscribe = onEvent
    ? session.subscribe((event) => {
        if (event.type === "tool_execution_start") onEvent({ type: event.type, name: event.toolName });
        // Same field `summarize` totals below, so live and final counts agree.
        else if (event.type === "message_end") {
          onEvent({ type: event.type, tokens: event.message?.usage?.totalTokens ?? 0 });
        }
      })
    : undefined;

  try {
    await session.prompt(task, { expandPromptTemplates: false });
    // The agent loop swallows the thrown WriteOutsideSandboxError, so read the
    // violations the guard recorded out-of-band instead.
    return { ...summarize(session.messages), violations: [...fileTools.violations] };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe?.();
    session.dispose();
  }
}

/**
 * Collapse a finished child session into the orchestrator's stage result.
 *
 * @param {any[]} messages
 */
function summarize(messages) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;

  for (const message of messages) {
    if (message?.role !== "assistant" || !message.usage) continue;
    usage.input += message.usage.input ?? 0;
    usage.output += message.usage.output ?? 0;
    usage.cacheRead += message.usage.cacheRead ?? 0;
    usage.cacheWrite += message.usage.cacheWrite ?? 0;
    usage.total += message.usage.totalTokens ?? 0;
    cost += message.usage.cost?.total ?? 0;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;

    const text = (message.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    return {
      text,
      stopReason: message.stopReason ?? "stop",
      errorMessage: message.errorMessage,
      usage,
      cost,
      messageCount: messages.length,
    };
  }

  return { text: "", stopReason: "error", errorMessage: "no assistant message", usage, cost, messageCount: messages.length };
}
