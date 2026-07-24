import { readFileSync } from "node:fs";
import { dirname } from "node:path";



/**
 * Pi extension that exposes project-installed Reversa skills as native slash
 * commands.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export function createReversaPiExtension() {
  return function reversaPiExtension(pi) {
  /** @type {Set<string>} */
  const registeredAliases = new Set();
  /** @type {Set<string>} */
  const warnedAliases = new Set();

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

  const stripFrontmatter = (content) => {
    if (!content.startsWith("---")) return content.trim();
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return (match ? content.slice(match[0].length) : content).trim();
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

      const skillPath = command.sourceInfo.path;
      const skillName = alias;
      const baseDir = command.sourceInfo.baseDir ?? dirname(skillPath);

      pi.registerCommand(alias, {
        description: command.description ?? `Activate the ${skillName} Reversa skill`,
        handler: async (args, ctx) => {
          try {
            const content = readFileSync(skillPath, "utf8");
            const body = stripFrontmatter(content);
            const skillBlock = `<skill name="${skillName}" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
            const prompt = args.trim() ? `${skillBlock}\n\n${args.trim()}` : skillBlock;

            if (ctx.isIdle()) {
              pi.sendUserMessage(prompt);
            } else {
              pi.sendUserMessage(prompt, { deliverAs: "followUp" });
              if (ctx.hasUI) ctx.ui.notify(`/${alias} queued as a follow-up`, "info");
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            reportError(ctx, `Could not activate /${alias}: ${reason}`);
          }
        },
      });

      registeredAliases.add(alias);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    registerAliases(ctx);
  });
  };
}

export default createReversaPiExtension();
