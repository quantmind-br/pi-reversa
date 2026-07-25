import { Type } from "typebox";
import {
  CURATED_ACTIONS,
  createCodeIntelSession,
  ensureIndexedAndMaterialized,
  queryCodeIntel,
  statusSnapshot,
} from "./code-intelligence/index.js";

/**
 * Shared curated code-intelligence tool factory for host session and children.
 *
 * @param {object} [options]
 * @param {() => Promise<import('./code-intelligence/index.js').CodeIntelSession | null> | import('./code-intelligence/index.js').CodeIntelSession | null} [options.getSession]
 * @param {(session: any) => void} [options.setSession]
 * @returns {any}
 */
export function createCodeIntelTool(options = {}) {
  /** @type {any} */
  let localSession = null;
  /** @type {Promise<any> | null} */
  let boot = null;

  async function resolveSession(cwd, signal) {
    if (options.getSession) {
      const provided = await options.getSession();
      if (provided) return provided;
    }
    if (localSession?.available && localSession.project) return localSession;
    if (!boot) {
      boot = (async () => {
        const created = await createCodeIntelSession({ projectRoot: cwd, signal });
        if (!created.available) return created;
        return ensureIndexedAndMaterialized(created, { signal });
      })();
    }
    localSession = await boot;
    options.setSession?.(localSession);
    return localSession;
  }

  return {
    name: "reversa_code_intel",
    label: "Reversa Code Intelligence",
    description: [
      "Curated structural code intelligence bound to the current project.",
      "Actions: architecture, search_symbols, search_code, trace_calls, trace_data_flow, snippet, change_impact, status.",
      "Do not pass project/repo paths. Treat results as discovery and confirm material claims with read on current source.",
    ].join(" "),
    promptSnippet: "Project-bound code graph queries for architecture, symbols, traces and snippets",
    promptGuidelines: [
      "Use reversa_code_intel for structural discovery before broad grep when available.",
      "Confirm reversa_code_intel findings by reading the current source before writing locators or evidence.",
      "For negative claims, fall back to read/grep/find when coverage is unavailable or partial.",
    ],
    parameters: Type.Object({
      action: Type.Union(CURATED_ACTIONS.map((action) => Type.Literal(action))),
      query: Type.Optional(Type.String()),
      name_pattern: Type.Optional(Type.String()),
      function_name: Type.Optional(Type.String()),
      symbol: Type.Optional(Type.String()),
      qualified_name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      file_pattern: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      direction: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      include_tests: Type.Optional(Type.Boolean()),
      parameter_name: Type.Optional(Type.String()),
      include_neighbors: Type.Optional(Type.Boolean()),
      aspects: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const session = await resolveSession(ctx.cwd, signal);
      if (!session?.available) {
        let status = null;
        try {
          status = session?.config ? statusSnapshot(session) : {
            available: false,
            reason: session?.reason ?? "code intelligence unavailable",
          };
        } catch {
          status = {
            available: false,
            reason: session?.reason ?? "code intelligence unavailable",
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              available: false,
              reason: session?.reason ?? "code intelligence unavailable",
              status,
              fallback: "Use read/grep/find/ls.",
            }, null, 2),
          }],
          details: { available: false },
        };
      }

      const { action, ...rest } = params;
      try {
        const result = await queryCodeIntel(session, {
          action,
          params: rest,
          signal,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { available: true, action, project: result.project },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              available: false,
              action,
              error: message,
              fallback: "Use read/grep/find/ls and confirm against current source.",
            }, null, 2),
          }],
          details: { available: false, action, error: message },
        };
      }
    },
  };
}
