import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodeIntelTool } from '../extensions/lib/code-intel-tool.js';
import { parseVendorPins, smokeTestDocs } from '../extensions/lib/docs-assets.js';
import { SUBAGENT_TOOLS } from '../extensions/lib/subagent.js';
import { expandStages } from '../extensions/lib/orchestrator.js';
import { PIPELINES } from '../extensions/lib/pipelines.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-reversa-cbm-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SUBAGENT_TOOLS includes curated code intelligence tool', () => {
  assert.ok(SUBAGENT_TOOLS.includes('reversa_code_intel'));
  assert.ok(!SUBAGENT_TOOLS.includes('bash'));
});

test('discovery pipeline fans writer by units and includes writer-globals', () => {
  const writer = PIPELINES.discovery.stages.find((stage) => stage.id === 'writer');
  const globals = PIPELINES.discovery.stages.find((stage) => stage.id === 'writer-globals');
  assert.equal(writer.fanOut, 'units');
  assert.ok(globals);
  const expanded = expandStages([writer], [], ['auth', 'billing']);
  assert.deepEqual(expanded.map((run) => run.key), ['writer:auth', 'writer:billing']);
});

test('migrate pipeline declares two-phase designer and screen translator', () => {
  const ids = PIPELINES.migrate.stages.map((stage) => stage.id);
  assert.ok(ids.includes('designer-topology'));
  assert.ok(ids.includes('designer-architecture'));
  assert.ok(ids.includes('screen-translator-mode'));
  assert.ok(ids.includes('screen-translator-generation'));
});

test('docs pipeline has controller config/vendor/smoke stages', () => {
  const ids = PIPELINES.docs.stages.map((stage) => stage.id);
  assert.deepEqual(ids.slice(0, 2), ['docs-config', 'docs-vendor']);
  assert.ok(ids.includes('docs-smoke'));
});

test('createCodeIntelTool returns structured fallback when session unavailable', async () => {
  const tool = createCodeIntelTool({
    getSession: async () => ({ available: false, reason: 'disabled in test' }),
  });
  const result = await tool.execute('1', { action: 'status' }, undefined, undefined, { cwd: process.cwd() });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.available, false);
  assert.match(payload.reason, /disabled/);
});

test('parseVendorPins reads lib files and fallbacks', () => {
  const parsed = parseVendorPins(`
libs:
  d3:
    files:
      - url: "https://example.com/d3.min.js"
        local: "assets/vendor/d3.v7.min.js"
        fallbacks:
          - "https://cdn.example.com/d3.min.js"
`);
  assert.equal(parsed.libs.length, 1);
  assert.equal(parsed.libs[0].files[0].local, 'assets/vendor/d3.v7.min.js');
  assert.equal(parsed.libs[0].files[0].fallbacks.length, 1);
});

test('smokeTestDocs flags missing assets and external CDN', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'index.html'), `<html><script src="https://cdn.example.com/x.js"></script><script src="assets/vendor/missing.js"></script></html>`);
    const result = await smokeTestDocs({ docsRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.kind === 'cdn'));
    assert.ok(result.errors.some((error) => error.kind === 'asset-missing'));
  });
});
