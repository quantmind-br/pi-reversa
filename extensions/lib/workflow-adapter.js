import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Path of the discovery workflow materialized by `scripts/prepare-skills.js`.
 *
 * The upstream `reversa` package keeps `templates/workflow.json` outside its
 * `exports` map, so it cannot be imported; `prepare-skills` copies it here.
 */
const WORKFLOW_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "generated",
  "reversa-workflow-discovery.json",
);

/**
 * @param {string} id
 * @returns {string} human label derived from the task id
 */
function labelFor(id) {
  return String(id)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Convert one upstream workflow task into a pi-reversa stage.
 *
 * The upstream workflow is a flat ordered list: it declares no dependency
 * graph, so none is invented here. Order plus the scheduler's abort rule
 * carries the sequencing.
 *
 * @param {Record<string, any>} task
 * @returns {import("./pipelines.js").Stage}
 */
export function adaptWorkflowTask(task) {
  const id = String(task.id);
  const isController = task.kind === "internal";

  /** @type {import("./pipelines.js").Stage} */
  const stage = {
    id,
    skill: isController ? null : (task.skill ?? null),
    label: labelFor(id),
    fanOut: task.expand === "modules" ? "modules" : task.expand === "units" ? "units" : null,
    optional: false,
    failPipeline: true,
    task: isController
      ? `Controller \`${task.handler}\`.`
      : `Execute a etapa \`${id}\` do workflow Reversa conforme o corpo do skill.`,
  };

  if (isController) {
    stage.kind = "controller";
    stage.handler = task.handler;
  }

  if (task.condition) {
    stage.condition = task.condition;
    stage.optional = true;
    stage.failPipeline = false;
  }

  if (id === "regression-check") {
    stage.optional = true;
    stage.failPipeline = false;
    stage.requires = "regression-watch";
  }
  if (Array.isArray(task.outputs)) stage.outputs = [...task.outputs];
  if (task.args) stage.args = task.args;

  return stage;
}

/**
 * Load the discovery pipeline definition from the materialized workflow.
 *
 * @returns {{ label: string, stages: import("./pipelines.js").Stage[] }}
 */
export function loadDiscoveryWorkflow() {
  if (!existsSync(WORKFLOW_PATH)) {
    throw new Error("workflow discovery não materializado; rode npm run prepare-skills");
  }
  const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"));
  if (workflow.schema_version !== 1) {
    throw new Error(`workflow discovery com schema_version inesperado: ${workflow.schema_version}`);
  }
  if (workflow.id !== "discovery") {
    throw new Error(`workflow materializado não é discovery: ${workflow.id}`);
  }
  return {
    label: "Time de Descoberta",
    stages: workflow.tasks.map(adaptWorkflowTask),
  };
}
