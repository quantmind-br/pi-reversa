import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


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

    assert.deepEqual([...harness.registered.keys()], ['reversa', 'reversa-forward', 'reversa-auto']);
    assert.equal(harness.registered.get('reversa').description, 'Main orchestrator');
    assert.equal(harness.registered.get('reversa-forward').description, 'Forward orchestrator');
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

test('dependency contract regression: bundled CLI rejects unsupported run command', async () => {
  const result = await runCli(['run']);

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Comando desconhecido: "run"/);
});

test('reports missing skill files', async () => {
  const missing = join(tmpdir(), `missing-${Date.now()}`, 'SKILL.md');
  const harness = createHarness([
    skillCommand('reversa', missing),
  ]);
  const extension = await loadExtension();
  extension(harness.pi);

  await harness.handlers.get('session_start')({ reason: 'startup' }, {});

  assert.deepEqual([...harness.registered.keys()], ['reversa', 'reversa-auto']);

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

  assert.deepEqual([...harness.registered.keys()], ['reversa', 'reversa-auto']);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][1], 'warning');
  assert.equal(
    notifications[0][0],
    'Reversa alias /reversa-forward was not registered because another extension already provides it (existing). Use /skill:reversa-forward if Skill commands are enabled (default); otherwise enable "Skill commands" in /settings.',
  );
});

test('registers reversa_orchestrate at load, before any session_start', async () => {
  const harness = createHarness([]);
  const extension = await loadExtension();
  extension(harness.pi);

  const tool = harness.tools.get('reversa_orchestrate');
  assert.ok(tool, 'tool must exist before session_start runs');
  assert.equal(harness.registered.size, 0, 'no commands are registered before session_start');

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
  assert.deepEqual([...harness.tools.keys()], ['reversa_orchestrate']);
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
  assert.match(notifications[0][0], /Pipeline desconhecido/);
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

  assert.match(result.content[0].text, /nenhum modelo está selecionado/);
  assert.deepEqual(result.details.stages, []);
});
