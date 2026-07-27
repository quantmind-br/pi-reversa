import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readStageModels } from '../extensions/lib/stage-models.js';


async function loadModule() {
  return import(`${new URL('../extensions/reversa.js', import.meta.url).href}?test=${Date.now()}-${Math.random()}`);
}

async function loadExtension() {
  const module = await loadModule();
  return module.default;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'reversa', 'bin', 'reversa.js'), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function createHarness(commands, options = {}) {
  const handlers = new Map();
  const registered = new Map();
  const tools = new Map();
  const sent = [];
  const hostTools = options.hostTools ?? [];

  const pi = {
    getCommands: () => [
      ...commands,
      ...[...registered.entries()].map(([name, value]) => ({
        name,
        description: value.description,
        source: 'extension',
        sourceInfo: { path: '<test>', source: 'test', scope: 'temporary', origin: 'top-level' },
      })),
    ],
    registerCommand: (name, options) => registered.set(name, options),
    registerTool: (tool) => tools.set(tool.name, tool),
    getAllTools: () => [...hostTools.map((name) => ({ name })), ...[...tools.keys()].map((name) => ({ name }))],
    getThinkingLevel: () => 'medium',
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (content, options) => sent.push({ content, options }),
  };

  return { pi, handlers, registered, tools, sent };
}


function skillCommand(name, filePath, description = `${name} description`) {
  return {
    name: `skill:${name}`,
    description,
    source: 'skill',
    sourceInfo: {
      path: filePath,
      baseDir: filePath.slice(0, filePath.lastIndexOf('/')),
      source: 'project',
      scope: 'project',
      origin: 'top-level',
    },
  };
}

/** Package-owned commands that are not skill aliases, hence outside alias assertions. */
const NON_ALIAS_COMMANDS = new Set(['reversa-cbm', 'reversa-models']);

const registeredAliases = (harness) =>
  [...harness.registered.keys()].filter((name) => !NON_ALIAS_COMMANDS.has(name));

test('registers only Reversa skill aliases with descriptions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const reversa = join(dir, 'reversa.md');
    const forward = join(dir, 'forward.md');
    const unrelated = join(dir, 'other.md');
    writeFileSync(reversa, '---\nname: reversa\n---\nMain body');
    writeFileSync(forward, '---\nname: reversa-forward\n---\nForward body');
    writeFileSync(unrelated, 'Other body');

    const harness = createHarness([
      skillCommand('reversa', reversa, 'Main orchestrator'),
      skillCommand('reversa-forward', forward, 'Forward orchestrator'),
      skillCommand('other', unrelated),
    ]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    assert.deepEqual(registeredAliases(harness), ['reversa', 'reversa-auto', 'reversa-forward']);
    assert.equal(harness.registered.get('reversa').description, 'Analyze a legacy system end to end');
    assert.equal(harness.registered.get('reversa-forward').description, 'Evolve a feature over the legacy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expands skill body, strips frontmatter, and appends arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '---\r\nname: reversa-new\r\ndescription: test\r\n---\r\n# Reversa New\r\n\r\nDo the work.');
    const harness = createHarness([skillCommand('reversa-new', skill)]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const ctx = { isIdle: () => true, hasUI: false, ui: {} };
    await harness.registered.get('reversa-new').handler('expresso Minha ideia', ctx);

    assert.equal(harness.sent.length, 1);
    assert.match(harness.sent[0].content, /^<skill name="reversa-new"/);
    assert.match(harness.sent[0].content, /# Reversa New/);
    assert.doesNotMatch(harness.sent[0].content, /description: test/);
    assert.match(harness.sent[0].content, /\n\nexpresso Minha ideia$/);
    assert.equal(harness.sent[0].options, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queues a follow-up when Pi is busy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '# Reversa');
    const harness = createHarness([skillCommand('reversa', skill)]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const notifications = [];
    const ctx = {
      isIdle: () => false,
      hasUI: true,
      ui: { notify: (...args) => notifications.push(args) },
    };
    await harness.registered.get('reversa').handler('', ctx);

    assert.deepEqual(harness.sent[0].options, { deliverAs: 'followUp' });
    assert.deepEqual(notifications[0], ['/reversa queued as a follow-up', 'info']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exposes autonomous execution through the real Reversa skill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const autonomous = join(dir, 'SKILL.md');
    writeFileSync(autonomous, '---\nname: reversa-autonomous\n---\n# Autonomous workflow');
    const harness = createHarness([skillCommand('reversa-autonomous', autonomous)]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    assert.equal(harness.registered.has('reversa-run'), false);
    assert.equal(harness.registered.has('reversa-run-status'), false);
    assert.equal(harness.registered.has('reversa-autonomous'), true);

    await harness.registered.get('reversa-autonomous').handler('', {
      isIdle: () => true,
      hasUI: false,
      ui: {},
    });
    assert.match(harness.sent[0].content, /^<skill name="reversa-autonomous"/);
    assert.match(harness.sent[0].content, /# Autonomous workflow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dependency contract regression: bundled CLI exposes transactional run command', async () => {
  const result = await runCli(['run']);

  // `run` is a supported command; without an install it fails on preconditions, not parsing.
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(`${result.stderr}\n${result.stdout}`, /Reversa is not installed|npx reversa install/i);
});

test('reports missing skill files', async () => {
  const missing = join(tmpdir(), `missing-${Date.now()}`, 'SKILL.md');
  const harness = createHarness([
    skillCommand('reversa', missing),
  ]);
  const extension = await loadExtension();
  extension(harness.pi);

  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  assert.deepEqual(registeredAliases(harness), ['reversa', 'reversa-auto']);

  const notifications = [];
  await harness.registered.get('reversa').handler('', {
    isIdle: () => true,
    hasUI: true,
    ui: { notify: (...args) => notifications.push(args) },
  });
  assert.equal(harness.sent.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][0], /Could not activate \/reversa/);
  assert.equal(notifications[0][1], 'error');
});

test('warns once for foreign alias conflicts and stays silent for own reloads', async () => {
  const missing = join(tmpdir(), `missing-${Date.now()}`, 'SKILL.md');
  const harness = createHarness([
    skillCommand('reversa', missing),
    {
      name: 'reversa-forward',
      description: 'Existing extension',
      source: 'extension',
      sourceInfo: { path: '<existing>', source: 'existing', scope: 'project', origin: 'top-level' },
    },
    skillCommand('reversa-forward', missing),
  ]);
  const extension = await loadExtension();
  extension(harness.pi);

  const notifications = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (...args) => notifications.push(args) },
  };

  await harness.handlers.get('session_start')({ reason: 'startup' }, ctx);
  await harness.handlers.get('session_start')({ reason: 'reload' }, ctx);

  assert.deepEqual(registeredAliases(harness), ['reversa', 'reversa-auto']);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][1], 'warning');
  assert.equal(
    notifications[0][0],
    'Reversa: 1 command was not registered because another extension already provides it: reversa-forward (existing). Use /skill:<name>, or enable "Skill commands" in /settings.',
  );
});

test('registers reversa_orchestrate at load, before any session_start', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);

  const tool = harness.tools.get('reversa_orchestrate');
  assert.ok(tool, 'tool must exist before session_start runs');
  // No command registers at factory time; /reversa-cbm now registers in session_start.
  assert.deepEqual(
    [...harness.registered.keys()].filter((name) => !['reversa-cbm'].includes(name)),
    [],
    'skill aliases must not register before session_start',
  );

  const keys = Object.keys(tool.parameters.properties);
  for (const key of ['pipeline', 'doc_level', 'specs_choice', 'user_name', 'project']) {
    assert.ok(keys.includes(key), `missing parameter: ${key}`);
  }
  assert.equal(tool.executionMode, 'sequential');
  assert.match(tool.description, /never asks anything/);
});

test('isolation: no Reversa tool shadows a host delegation mechanism', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);
  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  for (const forbidden of ['subagent', 'subagent_wait', 'agent', 'delegate', 'task', 'run']) {
    assert.equal(harness.tools.has(forbidden), false, `must not register a tool named ${forbidden}`);
  }
  assert.deepEqual([...harness.tools.keys()].sort(), ['reversa_code_intel', 'reversa_orchestrate']);
});

test('/reversa-auto prompts for ask_user_question when the tool is present', async () => {
  const harness = createHarness([], { hostTools: ['ask_user_question'] });
  const extension = await loadExtension();
  extension(harness.pi);
  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  await harness.registered.get('reversa-auto').handler('', {
    isIdle: () => true,
    hasUI: false,
    ui: {},
    cwd: process.cwd(),
  });

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].content, /ask_user_question/);
  assert.match(harness.sent[0].content, /pipeline: "discovery"/);
  assert.match(harness.sent[0].content, /Não use a ferramenta `subagent`/);
});

test('/reversa-auto falls back to a numbered menu without ask_user_question', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);
  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  await harness.registered.get('reversa-auto').handler('', {
    isIdle: () => true,
    hasUI: false,
    ui: {},
    cwd: process.cwd(),
  });

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].content, /menu numerado/);
});

test('/reversa-auto accepts a pipeline argument and rejects unknown ones', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);
  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  const ctx = { isIdle: () => true, hasUI: false, ui: {}, cwd: process.cwd() };
  await harness.registered.get('reversa-auto').handler('docs', ctx);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].content, /pipeline: "docs"/);

  const notifications = [];
  await harness.registered.get('reversa-auto').handler('nope', {
    ...ctx,
    hasUI: true,
    ui: { notify: (...args) => notifications.push(args) },
  });
  assert.equal(harness.sent.length, 1, 'unknown pipeline must not send a prompt');
  assert.equal(notifications[0][1], 'error');
  assert.match(notifications[0][0], /Unknown pipeline/);
});

test('reversa_orchestrate reports cleanly when no model is selected', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);

  const tool = harness.tools.get('reversa_orchestrate');
  const result = await tool.execute(
    '1',
    { pipeline: 'discovery', user_name: 'Ana', project: 'demo', chat_language: 'pt-BR', doc_language: 'pt-BR', doc_level: 'essencial', specs_choice: 'auto' },
    undefined,
    undefined,
    { cwd: process.cwd(), model: undefined },
  );

  assert.match(result.content[0].text, /no model is selected/);
  assert.deepEqual(result.details.stages, []);
});

test('registers only entry-point aliases, leaving support skills to /skill:', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '# Reversa');
    const harness = createHarness([
      skillCommand('reversa', skill),
      skillCommand('reversa-writer', skill),
      skillCommand('reversa-curator', skill),
    ]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    assert.equal(harness.registered.has('reversa'), true);
    assert.equal(harness.registered.has('reversa-writer'), false);
    assert.equal(harness.registered.has('reversa-curator'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REVERSA_ALIASES=all restores every skill alias with its upstream description', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  const previous = process.env.REVERSA_ALIASES;
  try {
    process.env.REVERSA_ALIASES = 'all';
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '# Reversa');
    const harness = createHarness([
      skillCommand('reversa', skill),
      skillCommand('reversa-writer', skill),
    ]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    assert.equal(harness.registered.has('reversa-writer'), true);
    // No package-owned override exists for a non-entry-point alias, so the
    // upstream description flows through unchanged.
    assert.equal(harness.registered.get('reversa-writer').description, 'reversa-writer description');
  } finally {
    if (previous === undefined) delete process.env.REVERSA_ALIASES;
    else process.env.REVERSA_ALIASES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every entry-point alias carries package-owned copy within the visible budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '# Reversa');
    const entryPoints = [
      'reversa',
      'reversa-autonomous',
      'reversa-forward',
      'reversa-migrate',
      'reversa-docs',
      'reversa-new',
      'reversa-debugger',
    ];
    const harness = createHarness(entryPoints.map((name) => skillCommand(name, skill)));
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    for (const name of entryPoints) {
      const command = harness.registered.get(name);
      assert.ok(command, `${name} must be registered`);
      assert.ok(command.description.length > 0, `${name} description must not be empty`);
      assert.notEqual(command.description, `${name} description`, `${name} must not pass through the upstream description`);
      assert.ok(command.description.length <= 40, `${name} description exceeds the visible budget: ${command.description.length}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/reversa-auto completes the pipeline enum', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);
  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  const complete = harness.registered.get('reversa-auto').getArgumentCompletions;
  assert.deepEqual(complete('').map((item) => item.value), ['discovery', 'migrate', 'docs']);
  assert.deepEqual(complete('').map((item) => item.description), ['Time de Descoberta', 'Time de Migração', 'Time Reversa Docs']);
  assert.deepEqual(complete('d').map((item) => item.value), ['discovery', 'docs']);
  assert.equal(complete('zz'), null);
});

test('/reversa-cbm never writes to stdout while a UI is attached', async () => {
  const previous = process.env.REVERSA_CBM_ENABLED;
  const originalLog = console.log;
  const logged = [];
  try {
    process.env.REVERSA_CBM_ENABLED = 'false';
    console.log = (...args) => logged.push(args);

    const harness = createHarness([]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const notifications = [];
    await harness.registered.get('reversa-cbm').handler('status', {
      cwd: process.cwd(),
      hasUI: true,
      ui: { notify: (...args) => notifications.push(args) },
    });

    assert.equal(logged.length, 0, 'stdout writes tear the TUI frame');
    assert.deepEqual(notifications, [
      ['cbm status: available=false — code intelligence disabled by configuration', 'warning'],
    ]);

    await harness.registered.get('reversa-cbm').handler('status', {
      cwd: process.cwd(),
      hasUI: false,
      ui: {},
    });

    assert.equal(logged.length, 1, 'headless mode keeps the JSON payload');
    assert.equal(JSON.parse(logged[0][0]).available, false);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.REVERSA_CBM_ENABLED;
    else process.env.REVERSA_CBM_ENABLED = previous;
  }
});

test('aggregates every alias conflict into a single warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-ext-'));
  try {
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '# Reversa');
    const foreign = (name) => ({
      name,
      description: 'Existing extension',
      source: 'extension',
      sourceInfo: { path: '<existing>', source: 'existing', scope: 'project', origin: 'top-level' },
    });
    const harness = createHarness([
      foreign('reversa-forward'),
      foreign('reversa-auto'),
      skillCommand('reversa', skill),
      skillCommand('reversa-forward', skill),
    ]);
    const extension = await loadExtension();
    extension(harness.pi);

    const notifications = [];
    const ctx = { hasUI: true, ui: { notify: (...args) => notifications.push(args) } };

    await harness.handlers.get('session_start')({ reason: 'startup' }, ctx);

    assert.equal(notifications.length, 1, 'one aggregate warning, not one per conflict');
    assert.equal(notifications[0][1], 'warning');
    assert.match(notifications[0][0], /2 commands were not registered/);
    assert.match(notifications[0][0], /reversa-auto \(existing\)/);
    assert.match(notifications[0][0], /reversa-forward \(existing\)/);

    await harness.handlers.get('session_start')({ reason: 'reload' }, ctx);
    assert.equal(notifications.length, 1, 'a reload must not re-report a known conflict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reversa_orchestrate renders shard progress through onUpdate', async () => {
  // Drives the real tool with an injected pipeline, so the assertions cover the
  // presentation the TUI actually receives — not a re-implementation of it.
  const { createReversaPiExtension } = await loadModule();
  /** @type {any[]} */
  const emitted = [];
  const extension = createReversaPiExtension({
    runPipeline: async ({ onProgress }) => {
      // One fan-out stage, three shards, mirroring the orchestrator's payload.
      const base = { stageId: 'arch', index: 2, total: 5, runs: 3 };
      onProgress({ ...base, stage: 'Archaeologist', status: 'start', runsDone: 0 });
      onProgress({ ...base, stage: 'Archaeologist — auth', runKey: 'arch:auth', item: 'auth', status: 'running', runsDone: 0, toolCalls: 0 });
      onProgress({ ...base, stage: 'Archaeologist — auth', runKey: 'arch:auth', item: 'auth', status: 'running', runsDone: 0, tool: 'grep', toolCalls: 4, tokens: 2100 });
      onProgress({ ...base, stage: 'Archaeologist — auth', runKey: 'arch:auth', item: 'auth', status: 'done', runsDone: 1, tokens: 1200, toolCalls: 7, lastTool: 'read' });
      onProgress({ ...base, stage: 'Archaeologist — orders', runKey: 'arch:orders', item: 'orders', status: 'failed', runsDone: 2, toolCalls: 1, lastTool: 'write' });
      // Sequential stage: no runs counter, original shape preserved.
      onProgress({ stage: 'Curator', stageId: 'curator', index: 3, total: 5, status: 'done', runs: 1, runsDone: 1, tokens: 40 });
      return { report: 'ok', stages: [], warnings: [], usage: {}, runDir: null, status: 'completed', codeIntel: null };
    },
  });

  const harness = createHarness([]);
  extension(harness.pi);
  const tool = harness.tools.get('reversa_orchestrate');
  const result = await tool.execute(
    '1',
    { pipeline: 'discovery', user_name: 'Ana', project: 'demo', chat_language: 'pt-BR', doc_language: 'pt-BR', doc_level: 'essencial', specs_choice: 'auto' },
    undefined,
    (update) => emitted.push(update),
    { cwd: process.cwd(), model: { id: 'test' } },
  );

  assert.equal(result.content[0].text, 'ok');
  assert.deepEqual(emitted.map((update) => update.content[0].text), [
    '[2/5] Archaeologist: start (0/3 runs)',
    '[2/5] Archaeologist — auth: running (0/3 runs)',
    '[2/5] Archaeologist — auth: running (0/3 runs, grep +3, 2.1k tokens)',
    '[2/5] Archaeologist — auth: done (1/3 runs, read +6, 1.2k tokens)',
    '[2/5] Archaeologist — orders: failed (2/3 runs, write)',
    '[3/5] Curator: done (40 tokens)',
  ]);

  // The machine-readable identity must survive alongside the rendered text.
  const shard = emitted[3].details;
  assert.equal(shard.runKey, 'arch:auth');
  assert.equal(shard.item, 'auth');
  assert.equal(shard.stageId, 'arch');
});

/**
 * `ui.select` answers come from a scripted queue: each entry is asserted to be
 * an actual option of the dialog it answers, so a renamed label fails loudly
 * instead of silently selecting nothing.
 */
function scriptedUI(answers) {
  const seen = [];
  const notifications = [];
  return {
    seen,
    notifications,
    ui: {
      notify: (...args) => notifications.push(args),
      select: async (title, options) => {
        seen.push({ title, options });
        const answer = answers.shift();
        if (answer === undefined) return undefined;
        assert.ok(options.includes(answer), `"${answer}" is not an option of "${title}": ${options.join(' | ')}`);
        return answer;
      },
    },
  };
}

test('/reversa-models persists a stage override picked through the UI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-models-'));
  try {
    const harness = createHarness([]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const command = harness.registered.get('reversa-models');
    assert.ok(command, '/reversa-models must be registered');
    assert.ok(command.description.length <= 40, 'command copy must fit the visible budget');

    const scripted = scriptedUI([
      'discovery — 0 stage override(s)',
      'review-structural — Review Structural — inherit',
      'anthropic/opus — Opus',
      '← Back',
      'Close',
    ]);

    await command.handler('', {
      cwd: dir,
      hasUI: true,
      ui: scripted.ui,
      modelRegistry: {
        getAvailable: () => [{ provider: 'anthropic', id: 'opus', name: 'Opus' }],
        find: (provider, id) => ({ provider, id, name: 'Opus' }),
      },
    });

    const config = readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8');
    assert.match(config, /\[models\.discovery\]/);
    assert.match(config, /review-structural = "anthropic\/opus"/);

    // Level 2 must key on stage ids, so the two writer stages stay distinct.
    const stageDialog = scripted.seen[1];
    assert.equal(stageDialog.title, 'Reversa models — discovery');
    assert.ok(stageDialog.options.some((option) => option.startsWith('writer — ')));
    assert.ok(stageDialog.options.some((option) => option.startsWith('writer-globals — ')));
    assert.ok(!stageDialog.options.some((option) => option.startsWith('preflight — ')), 'controller stages are not pickable');

    // Level 2 is re-rendered with the new value, then level 1 reflects the count.
    assert.ok(scripted.seen[3].options.includes('review-structural — Review Structural — anthropic/opus'));
    assert.ok(scripted.seen[4].options.includes('discovery — 1 stage override(s)'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/reversa-models show is headless-safe and reset clears the config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-models-'));
  const originalLog = console.log;
  const logged = [];
  try {
    console.log = (...args) => logged.push(args);

    const harness = createHarness([]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});
    const command = harness.registered.get('reversa-models');

    const notifications = [];
    const uiCtx = {
      cwd: dir,
      hasUI: true,
      ui: {
        notify: (...args) => notifications.push(args),
        select: async () => { throw new Error('show must not open a dialog'); },
      },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
    };

    mkdirSync(join(dir, '.reversa'), { recursive: true });
    await command.handler('show', uiCtx);
    assert.equal(logged.length, 0, 'stdout writes tear the TUI frame');
    assert.deepEqual(notifications, [['per-stage models: 0 override(s), global default session model', 'info']]);

    // Headless: any invocation renders JSON instead of opening a picker.
    await command.handler('', { cwd: dir, hasUI: false, ui: {} });
    assert.equal(logged.length, 1);
    assert.deepEqual(JSON.parse(logged[0][0]), { default: null, review: null, pipelines: {} });

    writeFileSync(join(dir, '.reversa', 'config.toml'), '[specs]\ngranularity = "module"\n\n[models]\ndefault = "a/x"\n');
    await command.handler('reset', uiCtx);
    assert.equal(readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8'), '[specs]\ngranularity = "module"\n');
    assert.deepEqual(notifications[1], ['per-stage models cleared', 'info']);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/reversa-models sets one model for every review stage of a pipeline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-models-'));
  try {
    const harness = createHarness([]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const command = harness.registered.get('reversa-models');
    const scripted = scriptedUI([
      'discovery — 0 stage override(s)',
      'Review stages (9) — inherit',
      'anthropic/opus — Opus',
      '← Back',
      'Close',
    ]);

    await command.handler('', {
      cwd: dir,
      hasUI: true,
      ui: scripted.ui,
      modelRegistry: {
        getAvailable: () => [{ provider: 'anthropic', id: 'opus', name: 'Opus' }],
        find: (provider, id) => ({ provider, id, name: 'Opus' }),
      },
    });

    const config = readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8');
    assert.match(config, /\[models\.discovery\]\nreview = "anthropic\/opus"/);

    // The group is one pick, but every review stage must read as covered by it
    // while the producing stages stay untouched.
    assert.ok(scripted.seen[3].options.includes('review-structural — Review Structural — review: anthropic/opus'));
    assert.ok(scripted.seen[3].options.includes('scout — Scout — inherit'));
    assert.ok(scripted.seen[4].options.includes('discovery — 0 stage override(s), review anthropic/opus'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the docs pipeline offers no review group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-models-'));
  try {
    const harness = createHarness([]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const command = harness.registered.get('reversa-models');
    const scripted = scriptedUI(['docs — 0 stage override(s)', '← Back', 'Close']);

    await command.handler('', {
      cwd: dir,
      hasUI: true,
      ui: scripted.ui,
      modelRegistry: {
        getAvailable: () => [{ provider: 'anthropic', id: 'opus', name: 'Opus' }],
        find: (provider, id) => ({ provider, id, name: 'Opus' }),
      },
    });

    assert.equal(scripted.seen[1].title, 'Reversa models — docs');
    assert.ok(
      !scripted.seen[1].options.some((option) => option.startsWith('Review stages (')),
      'docs has no reviewing stage, so the group must stay hidden',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/reversa-models sets a global review default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-pi-models-'));
  try {
    const harness = createHarness([]);
    const extension = await loadExtension();
    extension(harness.pi);
    await harness.handlers.get('session_start')({ reason: 'startup' }, {});

    const command = harness.registered.get('reversa-models');
    const scripted = scriptedUI([
      'Review stages default — global default',
      'anthropic/opus — Opus',
      'Close',
    ]);
    const ctx = {
      cwd: dir,
      hasUI: true,
      ui: scripted.ui,
      modelRegistry: {
        getAvailable: () => [{ provider: 'anthropic', id: 'opus', name: 'Opus' }],
        find: (provider, id) => ({ provider, id, name: 'Opus' }),
      },
    };

    await command.handler('', ctx);
    assert.match(readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8'), /\[models\]\nreview = "anthropic\/opus"/);

    await command.handler('reset', ctx);
    assert.deepEqual(
      JSON.parse(JSON.stringify(readStageModels(dir))),
      { default: null, review: null, pipelines: {} },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/reversa-models yields to a foreign command and reports the conflict once', async () => {
  const harness = createHarness([
    {
      name: 'reversa-models',
      description: 'Existing extension',
      source: 'extension',
      sourceInfo: { path: '<existing>', source: 'existing', scope: 'project', origin: 'top-level' },
    },
  ]);
  const extension = await loadExtension();
  extension(harness.pi);

  const notifications = [];
  const ctx = { hasUI: true, ui: { notify: (...args) => notifications.push(args) } };

  await harness.handlers.get('session_start')({ reason: 'startup' }, ctx);
  assert.equal(harness.registered.has('reversa-models'), false, 'must not clobber another extension');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][0], /reversa-models \(existing\)/);

  // A reload re-runs registration; the conflict must not be re-reported.
  await harness.handlers.get('session_start')({ reason: 'reload' }, ctx);
  assert.equal(notifications.length, 1, 'a known conflict is warned about exactly once');
});
