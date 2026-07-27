import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reversaRoot = dirname(require.resolve("reversa/package.json"));
const source = join(reversaRoot, "agents");
const target = join(projectRoot, "packaged-skills");

if (!existsSync(source)) throw new Error(`Missing Reversa skills at ${source}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, dereference: true });

// The canonical discovery workflow lives outside reversa's `exports` map, so it
// is materialized here instead of imported. `extensions/` ships in `files`.
const workflowSrc = join(reversaRoot, "templates", "workflow.json");
const workflowDst = join(projectRoot, "extensions", "generated", "reversa-workflow-discovery.json");
if (!existsSync(workflowSrc)) throw new Error(`Missing Reversa workflow at ${workflowSrc}`);
mkdirSync(dirname(workflowDst), { recursive: true });
cpSync(workflowSrc, workflowDst);
