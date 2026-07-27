import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { buildLauncherPrompt, parsePipelineArg } from "./lib/interview.js";
import { DEFAULT_FANOUT_CONCURRENCY, runPipeline } from "./lib/orchestrator.js";
import { PIPELINE_IDS, PIPELINES } from "./lib/pipelines.js";
import { readSpecsSection, readState } from "./lib/reversa-state.js";
import {
  countStageOverrides,
  formatModelRef,
  readStageModels,
  resolveStageModels,
  writeStageModels,
} from "./lib/stage-models.js";
import { buildSkillBlock, stripFrontmatter } from "./lib/skill-block.js";
import { createCodeIntelTool } from "./lib/code-intel-tool.js";
import { createCodeIntelSession, ensureIndexedAndMaterialized, statusSnapshot } from "./lib/code-intelligence/index.js";

const AUTO_COMMAND = "reversa-auto";
const CBM_COMMAND = "reversa-cbm";
const MODELS_COMMAND = "reversa-models";

/**
 * Palette order is the only ordering lever Pi exposes: `RegisteredCommand`
 * carries no category or priority field, and the interactive palette lists
 * extension commands in registration order. Declare that order here instead of
 * inheriting `pi.getCommands()` order.
 */
const COMMAND_ORDER = [
  "reversa",
  AUTO_COMMAND,
  "reversa-autonomous",
  "reversa-forward",
  "reversa-migrate",
  "reversa-docs",
  "reversa-new",
  "reversa-debugger",
];

/**
 * Skill aliases registered by default: the seven skills whose frontmatter
 * declares `metadata.role: orchestrator`. Every other Reversa skill stays
 * reachable through `/skill:<name>`, and `REVERSA_ALIASES=all` re-exposes them
 * all as native aliases.
 */
const ENTRY_POINT_ALIASES = new Set(COMMAND_ORDER.filter((name) => name !== AUTO_COMMAND));

/**
 * Palette copy owned by this package, one entry per name in
 * `ENTRY_POINT_ALIASES`. Upstream skill descriptions run 103–905
 * characters and Pi shows roughly 40, so the pass-through text never carries
 * the action. These replace it for the alias only; the `/skill:` command and
 * model-side skill activation keep the upstream description untouched.
 */
const ALIAS_DESCRIPTIONS = {
  "reversa": "Analyze a legacy system end to end",
  "reversa-autonomous": "Unattended legacy discovery run",
  "reversa-forward": "Evolve a feature over the legacy",
  "reversa-migrate": "Plan and spec a legacy migration",
  "reversa-docs": "Build the HTML docs mini-site",
  "reversa-new": "Spec a greenfield project",
  "reversa-debugger": "Log, triage and track bugs",
};

/**
 * One warning for every conflicting command instead of one paragraph each.
 *
 * @param {{ name: string, source: string }[]} conflicts
 * @returns {string}
 */
const conflictWarning = (conflicts) => {
  const list = conflicts.map(({ name, source }) => `${name} (${source})`).join(", ");
  const one = conflicts.length === 1;
  return `Reversa: ${conflicts.length} ${one ? "command was" : "commands were"} not registered because another extension already provides ${one ? "it" : "them"}: ${list}. Use /skill:<name>, or enable "Skill commands" in /settings.`;
};

/**
 * One progress line. Fan-out stages report per shard, so the line carries the
 * settled/total counter for the stage plus whatever the shard is doing right
 * now; sequential stages keep the original `[i/total] label: status` shape.
 *
 * @param {{ stage: string, index: number, total: number, status: string,
 *   runs?: number, runsDone?: number, tokens?: number, tool?: string,
 *   lastTool?: string|null, toolCalls?: number, model?: string|null }} update
 * @returns {string}
 */
const formatTokens = (tokens) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(tokens);

const formatProgress = (update) => {
  const parts = [];
  if (update.runs > 1) parts.push(`${update.runsDone ?? 0}/${update.runs} runs`);
  if (update.model) parts.push(update.model);
  // `tool` is the live heartbeat; `lastTool` is what a settled shard ended on.
  const tool = update.tool ?? update.lastTool;
  if (tool) parts.push(update.toolCalls > 1 ? `${tool} +${update.toolCalls - 1}` : tool);
  else if (update.toolCalls) parts.push(`${update.toolCalls} tools`);
  if (update.tokens) parts.push(`${formatTokens(update.tokens)} tokens`);
  const suffix = parts.length ? ` (${parts.join(", ")})` : "";
  return `[${update.index}/${update.total}] ${update.stage}: ${update.status}${suffix}`;
};

/**
 * Pi extension that exposes project-installed Reversa skills as native slash
 * commands, plus an autonomous orchestrator that runs a whole Reversa pipeline
 * end to end inside a single tool call.
 *
 * @param {object} [deps] injection seam for tests
 * @param {typeof runPipeline} [deps.runPipeline] pipeline driver; defaults to the real one
 * @returns {(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void}
 */
export function createReversaPiExtension(deps = {}) {
  const drivePipeline = deps.runPipeline ?? runPipeline;
  return function reversaPiExtension(pi) {
    /** @type {Set<string>} */
    const registeredAliases = new Set();
    /** @type {Set<string>} */
    const warnedAliases = new Set();
    /** @type {Map<string, { path: string, baseDir: string, description?: string }>} */
    const skillIndex = new Map();
    /** Directory holding the packaged Reversa skills, for reference-driven stages. */
    let skillsDir;

    const reportError = (ctx, message) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
        return;
      }
      console.error(`[Reversa] ${message}`);
    };

    const reportWarning = (ctx, message) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
        return;
      }
      console.warn(`[Reversa] ${message}`);
    };

    /**
     * @param {{ name: string, source: string }[]} conflicts
     * @param {string} name
     * @param {any} conflict a RegisteredCommand from another extension
     */
    const collectConflict = (conflicts, name, conflict) => {
      if (warnedAliases.has(name)) return;
      warnedAliases.add(name);
      conflicts.push({ name, source: conflict.sourceInfo.source || conflict.sourceInfo.path });
    };

    // Host-facing curated code intelligence (same tool surface as children).
    /** @type {any} */
    let hostCodeIntelSession = null;
    pi.registerTool(createCodeIntelTool({
      getSession: async () => hostCodeIntelSession,
      setSession: (session) => { hostCodeIntelSession = session; },
    }));

    // Registered at factory time, not in session_start: the tool must exist
    // from the very first turn, before any command runs.
    pi.registerTool({
      name: "reversa_orchestrate",
      label: "Reversa Orchestrator",
      description: [
        "Runs a whole Reversa pipeline end to end with isolated subagents, without stopping.",
        "Call this exactly once, after collecting every answer with ask_user_question.",
        "It blocks until every stage finished; it never asks anything and never returns control mid-pipeline.",
        "Do not call any Reversa skill command yourself while this is running.",
      ].join("\n"),
      parameters: Type.Object({
        pipeline: Type.Union(
          PIPELINE_IDS.map((id) => Type.Literal(id)),
          { description: "Which Reversa pipeline to run end to end." },
        ),
        user_name: Type.String({ description: "How to address the user." }),
        project: Type.String({ description: "Project name." }),
        chat_language: Type.String({ description: "Language for chat output, e.g. 'pt-BR'." }),
        doc_language: Type.String({ description: "Language for generated specs, e.g. 'pt-BR'." }),
        doc_level: Type.Union([
          Type.Literal("essencial"),
          Type.Literal("completo"),
          Type.Literal("detalhado"),
        ]),
        specs_choice: Type.Union([
          Type.Literal("auto"),
          Type.Literal("module"),
          Type.Literal("use-case"),
          Type.Literal("endpoint"),
          Type.Literal("hybrid"),
          Type.Literal("feature"),
          Type.Literal("custom"),
        ]),
        custom_folders: Type.Optional(Type.Array(Type.String())),
        resume: Type.Optional(
          Type.Boolean({ description: "Skip stages already marked completed in .reversa/state.json." }),
        ),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        if (!ctx.model) {
          return {
            content: [
              {
                type: "text",
                text: "reversa_orchestrate: no model is selected in this session. Pick a model and call again.",
              },
            ],
            details: { stages: [], warnings: ["no model selected"] },
          };
        }

        const { pipeline, resume, ...answers } = params;

        const resolved = resolveStageModels({
          config: readStageModels(ctx.cwd),
          pipeline,
          stages: PIPELINES[pipeline].stages,
          registry: ctx.modelRegistry ?? null,
        });

        const result = await drivePipeline({
          cwd: ctx.cwd,
          pipeline,
          answers,
          skillIndex,
          skillsDir,
          model: ctx.model,
          thinkingLevel: pi.getThinkingLevel(),
          concurrency: DEFAULT_FANOUT_CONCURRENCY,
          resume: resume ?? false,
          signal,
          stageModels: resolved.models,
          stageModelLabels: resolved.labels,
          stageModelWarnings: resolved.warnings,
          onProgress: (update) => {
            onUpdate?.({
              content: [{ type: "text", text: formatProgress(update) }],
              details: update,
            });
          },
        });

        return {
          content: [{ type: "text", text: result.report }],
          details: {
            stages: result.stages,
            warnings: result.warnings,
            usage: result.usage,
            runDir: result.runDir,
            status: result.status,
            codeIntel: result.codeIntel,
          },
        };
      },
    });

    const registerAutoCommand = (ctx, extensionCommands, conflicts) => {
      if (registeredAliases.has(AUTO_COMMAND)) return;

      const conflict = extensionCommands.get(AUTO_COMMAND);
      if (conflict) {
        collectConflict(conflicts, AUTO_COMMAND, conflict);
        return;
      }

      pi.registerCommand(AUTO_COMMAND, {
        description: "Run a full Reversa pipeline unattended",
        getArgumentCompletions: (argumentPrefix) => {
          const value = argumentPrefix.trim().toLowerCase();
          const matches = PIPELINE_IDS.filter((id) => id.startsWith(value));
          return matches.length
            ? matches.map((id) => ({ value: id, label: id, description: PIPELINES[id].label }))
            : null;
        },
        handler: async (args, commandCtx) => {
          const parsed = parsePipelineArg(args ?? "");
          if ("error" in parsed) {
            reportError(commandCtx, parsed.error);
            return;
          }

          const askToolAvailable = pi.getAllTools().some((tool) => tool.name === "ask_user_question");
          const cwd = commandCtx.cwd ?? process.cwd();
          const prompt = buildLauncherPrompt({
            askToolAvailable,
            pipeline: parsed.pipeline,
            state: readState(cwd),
            specs: readSpecsSection(cwd),
          });

          if (commandCtx.isIdle()) {
            pi.sendUserMessage(prompt);
          } else {
            pi.sendUserMessage(prompt, { deliverAs: "followUp" });
            if (commandCtx.hasUI) commandCtx.ui.notify(`/${AUTO_COMMAND} queued as a follow-up`, "info");
          }
        },
      });

      registeredAliases.add(AUTO_COMMAND);
    };

    const registerCbmCommand = (ctx, extensionCommands, conflicts) => {
      // Must precede the conflict check: on a reload Pi already reports this
      // package's own command with `source: "extension"`.
      if (registeredAliases.has(CBM_COMMAND)) return;

      const conflict = extensionCommands.get(CBM_COMMAND);
      if (conflict) {
        collectConflict(conflicts, CBM_COMMAND, conflict);
        return;
      }

      pi.registerCommand(CBM_COMMAND, {
        description: "Code intelligence status/refresh/enable/disable",
        handler: async (args, commandCtx) => {
          const cwd = commandCtx.cwd ?? process.cwd();
          const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
          const action = (parts[0] || "status").toLowerCase();
          if (action === "disable") {
            process.env.REVERSA_CBM_ENABLED = "false";
            hostCodeIntelSession = null;
            if (commandCtx.hasUI) commandCtx.ui.notify("code intelligence disabled for this process", "info");
            else console.log("[Reversa] code intelligence disabled for this process");
            return;
          }
          if (action === "enable") {
            process.env.REVERSA_CBM_ENABLED = "true";
          }
          try {
            let session = await createCodeIntelSession({ projectRoot: cwd });
            if ((action === "refresh" || action === "enable" || action === "status") && session.available) {
              session = await ensureIndexedAndMaterialized(session, { forceRefresh: action === "refresh" });
            }
            hostCodeIntelSession = session;
            const snapshot = statusSnapshot(session);
            // Never write to stdout while a UI is attached: it tears the frame.
            if (commandCtx.hasUI) {
              const detail = snapshot.available ? "" : ` — ${snapshot.reason ?? "unknown reason"}`;
              commandCtx.ui.notify(`cbm ${action}: available=${snapshot.available}${detail}`, snapshot.available ? "info" : "warning");
            } else {
              console.log(JSON.stringify(snapshot, null, 2));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (commandCtx.hasUI) commandCtx.ui.notify(`cbm failed: ${message}`, "error");
            else console.error(`[Reversa] cbm failed: ${message}`);
          }
        },
      });

      registeredAliases.add(CBM_COMMAND);
    };

    /**
     * Model picker dialog. `ui.select` returns the chosen *string*, so every
     * option is mapped back to its action instead of being re-parsed.
     *
     * @param {any} commandCtx
     * @param {any[]} available
     * @param {string} scopeLabel
     * @returns {Promise<{ cancelled: true } | { cancelled?: false, ref: string | null }>}
     */
    const pickStageModel = async (commandCtx, available, scopeLabel) => {
      const inherit = "Inherit (clear)";
      const options = [inherit];
      /** @type {Map<string, any>} */
      const byLabel = new Map();
      for (const model of available) {
        const label = `${formatModelRef(model)} — ${model.name ?? model.id}`;
        options.push(label);
        byLabel.set(label, model);
      }

      const choice = await commandCtx.ui.select(`Model for ${scopeLabel}`, options);
      if (choice === undefined) return { cancelled: true };
      if (choice === inherit) return { ref: null };
      const model = byLabel.get(choice);
      return model ? { ref: formatModelRef(model) } : { cancelled: true };
    };

    /**
     * @param {import("./lib/stage-models.js").StageModelConfig} config
     * @param {string} pipeline
     * @param {string} key stage id, or `default` for the pipeline default
     * @param {string | null} ref
     */
    const setStageModelEntry = (config, pipeline, key, ref) => {
      const table = config.pipelines[pipeline] ?? {};
      if (ref === null) delete table[key];
      else table[key] = ref;
      if (Object.keys(table).length === 0) delete config.pipelines[pipeline];
      else config.pipelines[pipeline] = table;
    };

    /**
     * Three-level picker: pipeline → stage → model. Every change is persisted
     * immediately, so an ESC out of the loop never loses an earlier choice.
     *
     * @param {string} cwd
     * @param {import("./lib/stage-models.js").StageModelConfig} config
     * @param {any} commandCtx
     * @param {(message: string, level?: string) => void} report
     */
    const runModelsPicker = async (cwd, config, commandCtx, report) => {
      const available = commandCtx.modelRegistry ? commandCtx.modelRegistry.getAvailable() : [];
      if (available.length === 0) {
        commandCtx.ui.notify("no models available; configure a provider first", "warning");
        return;
      }

      /** @type {string | null} */
      let pipeline = null;

      for (;;) {
        if (pipeline === null) {
          /** @type {Map<string, { kind: "global" } | { kind: "pipeline", id: string }>} */
          const actions = new Map();
          const globalLabel = `Global default — ${config.default ?? "session model"}`;
          actions.set(globalLabel, { kind: "global" });
          const options = [globalLabel];
          for (const id of PIPELINE_IDS) {
            const label = `${id} — ${countStageOverrides(config, id)} stage override(s)`;
            actions.set(label, { kind: "pipeline", id });
            options.push(label);
          }
          options.push("Clear all", "Close");

          const choice = await commandCtx.ui.select("Reversa models", options);
          if (choice === undefined || choice === "Close") return;
          if (choice === "Clear all") {
            config.default = null;
            config.pipelines = {};
            writeStageModels(cwd, config);
            report("per-stage models cleared");
            continue;
          }

          const action = actions.get(choice);
          if (!action) continue;
          if (action.kind === "pipeline") {
            pipeline = action.id;
            continue;
          }

          const picked = await pickStageModel(commandCtx, available, "global default");
          if (picked.cancelled) continue;
          config.default = picked.ref;
          writeStageModels(cwd, config);
          report(`global default: ${picked.ref ?? "session model"}`);
          continue;
        }

        const table = config.pipelines[pipeline] ?? {};
        /** @type {Map<string, string>} */
        const actions = new Map();
        const defaultLabel = `Pipeline default — ${table.default ?? "inherit"}`;
        actions.set(defaultLabel, "default");
        const options = ["← Back", defaultLabel];
        // Keyed on `stage.id`, not `stage.skill`: discovery reuses one skill
        // across several stages, and each must stay independently configurable.
        for (const stage of PIPELINES[pipeline].stages) {
          if ((stage.kind ?? "agent") !== "agent") continue;
          const label = `${stage.id} — ${stage.label} — ${table[stage.id] ?? "inherit"}`;
          actions.set(label, stage.id);
          options.push(label);
        }

        const choice = await commandCtx.ui.select(`Reversa models — ${pipeline}`, options);
        if (choice === undefined || choice === "← Back") {
          pipeline = null;
          continue;
        }

        const key = actions.get(choice);
        if (!key) continue;
        const picked = await pickStageModel(commandCtx, available, `${pipeline}/${key}`);
        if (picked.cancelled) continue;
        setStageModelEntry(config, pipeline, key, picked.ref);
        writeStageModels(cwd, config);
        report(`${pipeline}/${key}: ${picked.ref ?? "inherit"}`);
      }
    };

    const registerModelsCommand = (ctx, extensionCommands, conflicts) => {
      if (registeredAliases.has(MODELS_COMMAND)) return;

      const conflict = extensionCommands.get(MODELS_COMMAND);
      if (conflict) {
        collectConflict(conflicts, MODELS_COMMAND, conflict);
        return;
      }

      pi.registerCommand(MODELS_COMMAND, {
        description: "Pick a model per pipeline stage",
        handler: async (args, commandCtx) => {
          const cwd = commandCtx.cwd ?? process.cwd();
          const action = String(args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
          // Never write to stdout while a UI is attached: it tears the frame.
          const report = (message, level = "info") => {
            if (commandCtx.hasUI) commandCtx.ui.notify(message, level);
            else console.log(`[Reversa] ${message}`);
          };

          try {
            if (action === "reset") {
              writeStageModels(cwd, { default: null, pipelines: {} });
              report("per-stage models cleared");
              return;
            }

            const config = readStageModels(cwd);
            if (action === "show" || !commandCtx.hasUI) {
              if (!commandCtx.hasUI) {
                console.log(JSON.stringify(config, null, 2));
                return;
              }
              const overrides = PIPELINE_IDS.reduce((sum, id) => sum + countStageOverrides(config, id), 0);
              report(`per-stage models: ${overrides} override(s), global default ${config.default ?? "session model"}`);
              return;
            }

            await runModelsPicker(cwd, config, commandCtx, report);
          } catch (error) {
            reportError(commandCtx, `models failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });

      registeredAliases.add(MODELS_COMMAND);
    };

    /**
     * @param {any} ctx
     * @param {string} alias
     * @param {{ skillPath: string, baseDir: string, description?: string }} skill
     * @param {Map<string, any>} extensionCommands
     * @param {{ name: string, source: string }[]} conflicts
     */
    const registerSkillAlias = (ctx, alias, skill, extensionCommands, conflicts) => {
      // Must precede the conflict check: on a reload Pi already reports this
      // package's own alias with `source: "extension"`.
      if (registeredAliases.has(alias)) return;

      const conflict = extensionCommands.get(alias);
      if (conflict) {
        collectConflict(conflicts, alias, conflict);
        return;
      }

      const { skillPath, baseDir } = skill;
      const skillName = alias;

      pi.registerCommand(alias, {
        description: ALIAS_DESCRIPTIONS[alias] ?? skill.description ?? `Activate the ${skillName} Reversa skill`,
        handler: async (args, commandCtx) => {
          try {
            const content = readFileSync(skillPath, "utf8");
            const skillBlock = buildSkillBlock(skillName, skillPath, baseDir, stripFrontmatter(content));
            const prompt = args.trim() ? `${skillBlock}\n\n${args.trim()}` : skillBlock;

            if (commandCtx.isIdle()) {
              pi.sendUserMessage(prompt);
            } else {
              pi.sendUserMessage(prompt, { deliverAs: "followUp" });
              if (commandCtx.hasUI) commandCtx.ui.notify(`/${alias} queued as a follow-up`, "info");
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            reportError(commandCtx, `Could not activate /${alias}: ${reason}`);
          }
        },
      });

      registeredAliases.add(alias);
    };

    const registerAliases = (ctx) => {
      const commands = pi.getCommands();
      const extensionCommands = new Map(
        commands
          .filter((command) => command.source === "extension")
          .map((command) => [command.name, command]),
      );

      /** @type {Map<string, { skillPath: string, baseDir: string, description?: string }>} */
      const skillCommands = new Map();

      // Scan every Reversa skill: the index feeds the orchestrator and is
      // rebuilt on every reload, independent of which aliases get registered.
      for (const command of commands) {
        if (command.source !== "skill") continue;
        if (command.name !== "skill:reversa" && !command.name.startsWith("skill:reversa-")) continue;

        const alias = command.name.slice("skill:".length);
        const skillPath = command.sourceInfo.path;
        const baseDir = command.sourceInfo.baseDir ?? dirname(skillPath);

        skillIndex.set(alias, { path: skillPath, baseDir, description: command.description });
        if (alias === "reversa") skillsDir = dirname(baseDir);
        skillCommands.set(alias, { skillPath, baseDir, description: command.description });
      }

      const exposeAll = String(process.env.REVERSA_ALIASES ?? "").trim().toLowerCase() === "all";
      const order = [...COMMAND_ORDER];
      if (exposeAll) {
        for (const alias of skillCommands.keys()) {
          if (!order.includes(alias)) order.push(alias);
        }
      }

      /** @type {{ name: string, source: string }[]} */
      const conflicts = [];

      for (const name of order) {
        if (name === AUTO_COMMAND) {
          registerAutoCommand(ctx, extensionCommands, conflicts);
          continue;
        }
        const skill = skillCommands.get(name);
        if (!skill) continue;
        registerSkillAlias(ctx, name, skill, extensionCommands, conflicts);
      }

      registerCbmCommand(ctx, extensionCommands, conflicts);
      registerModelsCommand(ctx, extensionCommands, conflicts);

      if (conflicts.length > 0) reportWarning(ctx, conflictWarning(conflicts));
    };

    pi.on("session_start", async (_event, ctx) => {
      registerAliases(ctx);
    });
  };
}

export default createReversaPiExtension();
