import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { buildLauncherPrompt, parsePipelineArg } from "./lib/interview.js";
import { DEFAULT_FANOUT_CONCURRENCY, runPipeline } from "./lib/orchestrator.js";
import { PIPELINE_IDS } from "./lib/pipelines.js";
import { readSpecsSection, readState } from "./lib/reversa-state.js";
import { buildSkillBlock, stripFrontmatter } from "./lib/skill-block.js";

const AUTO_COMMAND = "reversa-auto";

/**
 * Pi extension that exposes project-installed Reversa skills as native slash
 * commands, plus an autonomous orchestrator that runs a whole Reversa pipeline
 * end to end inside a single tool call.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export function createReversaPiExtension() {
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
                text: "reversa_orchestrate: nenhum modelo está selecionado nesta sessão. Escolha um modelo e chame novamente.",
              },
            ],
            details: { stages: [], warnings: ["no model selected"] },
          };
        }

        const { pipeline, resume, ...answers } = params;

        const result = await runPipeline({
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
          onProgress: (update) => {
            const suffix = update.tokens ? ` (${update.tokens} tokens)` : "";
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `[${update.index}/${update.total}] ${update.stage}: ${update.status}${suffix}`,
                },
              ],
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
          },
        };
      },
    });

    const registerAutoCommand = (ctx, extensionCommands) => {
      if (registeredAliases.has(AUTO_COMMAND)) return;

      const conflict = extensionCommands.get(AUTO_COMMAND);
      if (conflict) {
        if (!warnedAliases.has(AUTO_COMMAND)) {
          const sourceLabel = conflict.sourceInfo.source || conflict.sourceInfo.path;
          reportWarning(
            ctx,
            `Reversa command /${AUTO_COMMAND} was not registered because another extension already provides it (${sourceLabel}).`,
          );
          warnedAliases.add(AUTO_COMMAND);
        }
        return;
      }

      pi.registerCommand(AUTO_COMMAND, {
        description: "Executa o pipeline Reversa de ponta a ponta com subagentes, sem paradas.",
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

    const registerAliases = (ctx) => {
      const commands = pi.getCommands();
      const extensionCommands = new Map(
        commands
          .filter((command) => command.source === "extension")
          .map((command) => [command.name, command]),
      );

      for (const command of commands) {
        if (command.source !== "skill") continue;
        if (command.name !== "skill:reversa" && !command.name.startsWith("skill:reversa-")) continue;

        const alias = command.name.slice("skill:".length);
        const skillPath = command.sourceInfo.path;
        const baseDir = command.sourceInfo.baseDir ?? dirname(skillPath);

        // The index feeds the orchestrator and is rebuilt on every reload,
        // independent of whether the alias itself could be registered.
        skillIndex.set(alias, { path: skillPath, baseDir, description: command.description });
        if (alias === "reversa") skillsDir = dirname(baseDir);

        if (registeredAliases.has(alias)) continue;

        const conflict = extensionCommands.get(alias);
        if (conflict) {
          if (!warnedAliases.has(alias)) {
            const sourceLabel = conflict.sourceInfo.source || conflict.sourceInfo.path;
            reportWarning(
              ctx,
              `Reversa alias /${alias} was not registered because another extension already provides it (${sourceLabel}). Use /skill:${alias} if Skill commands are enabled (default); otherwise enable "Skill commands" in /settings.`,
            );
            warnedAliases.add(alias);
          }
          continue;
        }

        const skillName = alias;

        pi.registerCommand(alias, {
          description: command.description ?? `Activate the ${skillName} Reversa skill`,
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
      }

      registerAutoCommand(ctx, extensionCommands);
    };

    pi.on("session_start", async (_event, ctx) => {
      registerAliases(ctx);
    });
  };
}

export default createReversaPiExtension();
