import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createGitReadTool,
  createGuardedFileTools,
  createSandboxGuard,
  rejectGitArgs,
  WriteOutsideSandboxError,
} from '../extensions/lib/guarded-tools.js';
import {
  buildStageTask,
  expandStages,
  PIPELINE_EXTRA_ROOTS,
  runPipeline,
  sandboxRoots,
} from '../extensions/lib/orchestrator.js';
import { PIPELINES } from '../extensions/lib/pipelines.js';
import {
  isSafeOutputFolder,
  listScoutModules,
  outputFolder,
  readSpecsSection,
  writeSpecsSection,
  writeState,
} from '../extensions/lib/reversa-state.js';
import { runSubagent, SUBAGENT_TOOLS } from '../extensions/lib/subagent.js';
import { buildLauncherPrompt, parsePipelineArg } from '../extensions/lib/interview.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-orch-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sandbox guard accepts allowed roots and rejects traversal', async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    const guard = createSandboxGuard(dir, [join(dir, '.reversa')]);

    assert.equal(guard(join(dir, '.reversa', 'a.md')), join(dir, '.reversa', 'a.md'));
    assert.throws(() => guard(join(dir, 'src', 'a.js')), WriteOutsideSandboxError);
    assert.throws(() => guard(join(dir, '.reversa', '..', 'src', 'a.js')), WriteOutsideSandboxError);
  });
});

test('sandbox guard rejects a root that is a symlink out of the project', async () => {
  await withTempDir((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'reversa-escape-'));
    try {
      symlinkSync(outside, join(dir, '.reversa'), 'dir');
      const guard = createSandboxGuard(dir, [join(dir, '.reversa')]);

      // Lexically inside the allowed root, but fs would follow the link out.
      assert.throws(() => guard(join(dir, '.reversa', 'state.json')), WriteOutsideSandboxError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('guarded write tool refuses to write outside the sandbox', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    const [write] = createGuardedFileTools(dir, [join(dir, '.reversa')]);
    assert.equal(write.name, 'write');

    await write.execute('1', { path: '.reversa/ok.md', content: 'hello' }, undefined, undefined, {});
    assert.equal(readFileSync(join(dir, '.reversa', 'ok.md'), 'utf8'), 'hello');

    await assert.rejects(
      () => write.execute('2', { path: 'src/evil.js', content: 'boom' }, undefined, undefined, {}),
      /refusing to write outside allowed roots/,
    );
  });
});

test('guarded tools shadow the builtin write and edit names', async () => {
  await withTempDir((dir) => {
    const names = createGuardedFileTools(dir, [join(dir, '.reversa')]).map((tool) => tool.name);
    assert.deepEqual(names, ['write', 'edit']);
  });
});

test('reversa_git allows read-only forms and rejects mutations', () => {
  assert.equal(rejectGitArgs(['log', '--oneline', '-n', '5']), null);
  assert.equal(rejectGitArgs(['blame', 'src/index.js']), null);
  assert.equal(rejectGitArgs(['remote', 'show', 'origin']), null);
  assert.equal(rejectGitArgs(['config', '--get', 'user.name']), null);
  assert.equal(rejectGitArgs(['tag', '--list']), null);
  assert.equal(rejectGitArgs(['branch', '--all']), null);

  assert.match(rejectGitArgs(['push']), /subcommand not allowed: push/);
  assert.match(rejectGitArgs(['log', '--output', '/tmp/x']), /argument not allowed/);
  // Mutating forms of otherwise-allowed subcommands.
  assert.match(rejectGitArgs(['branch', 'new-branch']), /does not accept the positional argument/);
  assert.match(rejectGitArgs(['branch', '-d', 'old']), /does not accept -d/);
  assert.match(rejectGitArgs(['tag', 'v1.0.0']), /does not accept the positional argument/);
  assert.match(rejectGitArgs(['remote', 'add', 'evil', 'git@x:y']), /does not accept the subcommand add/);
  assert.match(rejectGitArgs(['config', 'user.name', 'mallory']), /requires an explicit read flag/);
  assert.match(rejectGitArgs(['config', '--get', 'a', '--unset']), /does not accept --unset/);
});

test('reversa_git rejection surfaces as a thrown tool error', async () => {
  const tool = createGitReadTool(process.cwd());
  await assert.rejects(
    () => tool.execute('1', { args: ['push'] }, undefined, undefined, {}),
    /subcommand not allowed: push/,
  );
});

test('reversa_git runs an allowed command', async () => {
  const tool = createGitReadTool(process.cwd());
  const result = await tool.execute('1', { args: ['rev-parse', '--is-inside-work-tree'] }, undefined, undefined, {});
  assert.match(result.content[0].text, /true/);
});

test('listScoutModules reads the three tolerated shapes', () => {
  assert.deepEqual(listScoutModules({ modules: ['auth', 'orders'] }), ['auth', 'orders']);
  assert.deepEqual(
    listScoutModules({ organization_suggestion: { modules: [{ name: 'billing' }] } }),
    ['billing'],
  );
  assert.deepEqual(listScoutModules({ map: { modules: [{ path: 'src/users' }] } }), ['src/users']);
  assert.deepEqual(listScoutModules({}), []);
  assert.deepEqual(listScoutModules(null), []);
});

test('writeSpecsSection creates, appends, and never overwrites a decision', async () => {
  await withTempDir((dir) => {
    assert.equal(writeSpecsSection(dir, { granularity: 'module' }).written, true);
    assert.equal(readSpecsSection(dir).granularity, 'module');

    const second = writeSpecsSection(dir, { granularity: 'feature' });
    assert.equal(second.written, false);
    assert.match(second.reason, /already decided: module/);
    assert.equal(readSpecsSection(dir).granularity, 'module');
  });
});

test('writeSpecsSection preserves unrelated sections', async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    writeFileSync(join(dir, '.reversa', 'config.toml'), '[project]\nname = "demo"\n');

    writeSpecsSection(dir, { granularity: 'hybrid', customFolders: ['a', 'b'] });
    const raw = readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8');

    assert.match(raw, /\[project\]\nname = "demo"/);
    assert.match(raw, /\[specs\]\ngranularity = "hybrid"/);
    assert.deepEqual(readSpecsSection(dir).custom_folders, ['a', 'b']);
  });
});

test('sandbox roots are pipeline-aware', () => {
  const discovery = sandboxRoots('/p', '.specs/discovery', 'discovery').map((root) => root.replace('/p/', ''));
  assert.deepEqual(discovery, ['.reversa', '.specs/discovery']);

  const docs = sandboxRoots('/p', { folders: {
    discovery: '.specs/discovery', migration: '.specs/migration', forward: '.specs/forward',
    docs: '.specs/docs', new: '.specs/new', bugs: '.specs/bugs', refactor: '.specs/refactor',
  }}, 'docs').map((root) => root.replace('/p/', ''));
  assert.deepEqual(docs, ['.reversa', '.specs/docs']);
  assert.equal(PIPELINE_EXTRA_ROOTS.discovery, undefined);
});

test('docs stages may write .specs/docs but not project source', async () => {
  await withTempDir(async (dir) => {
    const roots = sandboxRoots(dir, {
      folders: {
        discovery: '.specs/discovery', migration: '.specs/migration', forward: '.specs/forward',
        docs: '.specs/docs', new: '.specs/new', bugs: '.specs/bugs', refactor: '.specs/refactor',
      },
    }, 'docs');
    const [write] = createGuardedFileTools(dir, roots);

    await write.execute('1', { path: '.specs/docs/index.html', content: '<html>' }, undefined, undefined, {});
    assert.equal(readFileSync(join(dir, '.specs', 'docs', 'index.html'), 'utf8'), '<html>');

    await assert.rejects(
      () => write.execute('2', { path: 'src/app.js', content: 'x' }, undefined, undefined, {}),
      WriteOutsideSandboxError,
    );
  });
});

test('expandStages fans out per module and falls back to a single run', () => {
  const stage = PIPELINES.discovery.stages.find((entry) => entry.id === 'archaeologist');
  assert.deepEqual(
    expandStages([stage], ['auth', 'orders']).map((run) => run.key),
    ['archaeologist:auth', 'archaeologist:orders'],
  );
  assert.deepEqual(expandStages([stage], []).map((run) => run.key), ['archaeologist']);
});

test('buildStageTask states the autonomous contract and the real write roots', () => {
  const stage = PIPELINES.docs.stages[0];
  const task = buildStageTask({
    stage,
    module: null,
    skillEntry: undefined,
    state: { project: 'demo', user_name: 'Ana' },
    folder: '.specs/discovery',
    writableRoots: ['.reversa', '.specs/docs'],
  });

  assert.match(task, /answer_mode = file/);
  assert.match(task, /Você não tem `bash`/);
  assert.match(task, /\.specs\/docs\//);
  assert.match(task, /Não peça CONTINUAR/);
});

test('regression-check stage points at a reference file that really exists', () => {
  // skillsDir is derived as dirname(baseDir) of the `reversa` skill, i.e. the
  // packaged-skills root. A one-level error would silently hand the stage a
  // bad path with no skill body, so assert against the real tree.
  const skillPath = join(process.cwd(), 'packaged-skills', 'reversa', 'SKILL.md');
  const baseDir = dirname(skillPath);
  const skillsDir = dirname(baseDir);
  assert.equal(skillsDir, join(process.cwd(), 'packaged-skills'));

  const stage = PIPELINES.discovery.stages.find((entry) => entry.id === 'regression-check');
  assert.equal(stage.skill, null);
  const referencePath = join(skillsDir, stage.reference);

  assert.ok(existsSync(referencePath), `missing reference file: ${referencePath}`);

  const task = buildStageTask({
    stage,
    module: null,
    skillEntry: undefined,
    state: {},
    folder: '.specs/discovery',
    skillsDir,
  });
  assert.ok(task.includes(referencePath), 'task must name the resolved reference path');
});

function fakeResult(overrides = {}) {
  return {
    text: 'done',
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    cost: 0,
    messageCount: 2,
    ...overrides,
  };
}

function discoverySkillIndex(dir) {
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, '---\nname: x\n---\nBody');
  return new Map(
    PIPELINES.discovery.stages
      .filter((stage) => stage.skill)
      .map((stage) => [stage.skill, { path: skillPath, baseDir: dir }]),
  );
}

test('runPipeline runs discovery in order, fans out, and survives a failing stage', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['auth', 'orders', 'billing'], organization_suggestion: { granularity: 'module' } }),
    );

    const calls = [];
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: { user_name: 'Ana', project: 'demo', specs_choice: 'auto' },
      skillIndex: discoverySkillIndex(dir),
      runSubagent: async ({ task }) => {
        const label = task.match(/## Tarefa\n(.*)/)?.[1] ?? '';
        calls.push(label);
        if (label.startsWith('Execute a investigação')) throw new Error('detective exploded');
        return fakeResult();
      },
    });

    const done = result.stages.filter((stage) => stage.status === 'done').map((stage) => stage.id);
    assert.deepEqual(done.slice(0, 4), ['scout', 'archaeologist:auth', 'archaeologist:orders', 'archaeologist:billing']);
    // The pipeline continued past the failure instead of stopping.
    assert.ok(done.includes('writer'), 'writer must still run after detective failed');
    assert.ok(result.warnings.some((warning) => /detective exploded/.test(warning)));
    assert.equal(result.aborted, false);
    assert.match(result.report, /Totais: ✅/);

    // Specs organization persisted after Scout, before Archaeologist.
    assert.equal(readSpecsSection(dir).granularity, 'module');
    assert.ok(calls[0].startsWith('Execute o mapeamento'));
  });
});

test('runPipeline resumes by skipping stage keys already in state.completed', async () => {
  await withTempDir(async (dir) => {
    writeState(dir, { completed: ['reconhecimento', 'scout'], output_folder: '.specs/discovery' });

    const ran = [];
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      resume: true,
      skillIndex: discoverySkillIndex(dir),
      runSubagent: async ({ task }) => {
        ran.push(task.match(/## Tarefa\n(.*)/)?.[1] ?? '');
        return fakeResult();
      },
    });

    assert.ok(!ran.some((task) => task.startsWith('Execute o mapeamento')), 'scout must be skipped on resume');
    assert.ok(result.stages.some((stage) => stage.id === 'scout' && stage.status === 'skipped'));

    // Pre-existing phase entries survive alongside appended stage keys.
    const state = JSON.parse(readFileSync(join(dir, '.reversa', 'state.json'), 'utf8'));
    assert.ok(state.completed.includes('reconhecimento'));
    assert.ok(state.completed.includes('scout'));
  });
});

test('runPipeline skips stages whose skill is not installed', async () => {
  await withTempDir(async (dir) => {
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: new Map(),
      runSubagent: async () => fakeResult(),
    });

    assert.ok(result.stages.every((stage) => stage.status === 'skipped'));
    assert.ok(result.warnings.some((warning) => /não está instalada/.test(warning)));
  });
});

test('runPipeline aborts before Scout when .reversa escapes the project', async () => {
  await withTempDir(async (dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'reversa-escape-'));
    try {
      symlinkSync(outside, join(dir, '.reversa'), 'dir');

      let launched = false;
      const result = await runPipeline({
        cwd: dir,
        pipeline: 'discovery',
        answers: {},
        skillIndex: discoverySkillIndex(dir),
        runSubagent: async () => {
          launched = true;
          return fakeResult();
        },
      });

      assert.equal(launched, false, 'no subagent may launch after a sandbox violation');
      assert.equal(result.aborted, true);
      assert.ok(result.warnings.some((warning) => /sandbox/i.test(warning)));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('runPipeline skips the regression check without a regression-watch file', async () => {
  await withTempDir(async (dir) => {
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: discoverySkillIndex(dir),
      runSubagent: async () => fakeResult(),
    });

    const regression = result.stages.find((stage) => stage.id === 'regression-check');
    assert.equal(regression.status, 'skipped');
    assert.match(regression.reason, /regression-watch/);
  });
});

test('runSubagent isolates the child session from the host agent', async () => {
  let loaderOptions;
  let sessionOptions;

  const sdk = {
    getAgentDir: () => '/tmp/agent-dir',
    SettingsManager: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options) {
        loaderOptions = options;
      }
      async reload() {}
    },
    createAgentSession: async (options) => {
      sessionOptions = options;
      return {
        session: {
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.1 } } },
          ],
          async prompt() {},
          subscribe: () => () => {},
          dispose() {},
          async abort() {},
        },
      };
    },
  };

  const result = await runSubagent(
    { cwd: '/tmp/project', task: 'do it', allowedRoots: ['/tmp/project/.reversa'] },
    { sdk },
  );

  assert.equal(loaderOptions.noExtensions, true, 'child must never load extensions');
  assert.equal(loaderOptions.noSkills, true);

  for (const forbidden of ['subagent', 'subagent_wait', 'bash', 'agent', 'delegate', 'task']) {
    assert.ok(!sessionOptions.tools.includes(forbidden), `child tool allowlist must exclude ${forbidden}`);
  }
  assert.deepEqual(sessionOptions.tools, SUBAGENT_TOOLS);
  assert.ok(sessionOptions.customTools.some((tool) => tool.name === 'write'));
  assert.ok(sessionOptions.customTools.some((tool) => tool.name === 'reversa_git'));

  assert.equal(result.text, 'ok');
  assert.equal(result.usage.total, 3);
});

test('launcher prompt adapts to ask_user_question availability', () => {
  const withTool = buildLauncherPrompt({ askToolAvailable: true, pipeline: 'discovery' });
  assert.match(withTool, /ask_user_question/);
  assert.match(withTool, /não se misturam com os do agente hospedeiro/);
  assert.match(withTool, /Não use a ferramenta `subagent`/);

  const withoutTool = buildLauncherPrompt({ askToolAvailable: false, pipeline: 'discovery' });
  assert.match(withoutTool, /menu numerado/);
});

test('launcher prompt only asks for what is missing', () => {
  const prompt = buildLauncherPrompt({
    askToolAvailable: true,
    pipeline: 'discovery',
    state: { user_name: 'Ana', chat_language: 'pt-BR', doc_language: 'pt-BR', project: 'demo' },
    specs: { granularity: 'module' },
  });

  assert.match(prompt, /Já preenchido \(não perguntar\): user_name, chat_language, doc_language, project, specs_choice/);
  assert.match(prompt, /Ainda falta: doc_level/);
});

test('parsePipelineArg defaults to discovery and rejects unknown values', () => {
  assert.deepEqual(parsePipelineArg(''), { pipeline: 'discovery' });
  assert.deepEqual(parsePipelineArg(' docs '), { pipeline: 'docs' });
  assert.deepEqual(parsePipelineArg('migrate'), { pipeline: 'migrate' });
  assert.match(parsePipelineArg('nope').error, /Pipeline desconhecido/);
  // Destructive pipelines stay out of reach.
  assert.ok(parsePipelineArg('forward').error);
  assert.ok(parsePipelineArg('new').error);
});

test('guard records violations out-of-band because the agent loop swallows the throw', async () => {
  await withTempDir(async (dir) => {
    const tools = createGuardedFileTools(dir, [join(dir, '.reversa')]);
    const [write] = tools;
    assert.deepEqual(tools.violations, []);

    // Replicate exactly what pi-agent-core/dist/agent-loop.js does: catch the
    // tool exception and convert it to an error result. The orchestrator
    // therefore never sees the error, and must rely on `.violations`.
    let escaped = false;
    try {
      await write.execute('1', { path: 'src/evil.js', content: 'x' }, undefined, undefined, {});
    } catch {
      escaped = true;
    }

    assert.equal(escaped, true, 'the tool still throws so the model learns why');
    assert.equal(tools.violations.length, 1, 'the violation must also be recorded out-of-band');
    assert.ok(tools.violations[0] instanceof WriteOutsideSandboxError);
  });
});

test('runPipeline stops the loop when a child reports a sandbox violation', async () => {
  await withTempDir(async (dir) => {
    const attempted = [];

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: discoverySkillIndex(dir),
      // Simulate a child whose write was blocked: the agent loop absorbed the
      // exception, so the stage "succeeds" but carries a violation.
      runSubagent: async ({ task, allowedRoots }) => {
        attempted.push(task.match(/## Tarefa\n(.*)/)?.[1] ?? '');
        if (attempted.length === 1) {
          return fakeResult({
            violations: [new WriteOutsideSandboxError(`refusing to write outside allowed roots: ${join(dir, 'src/x.js')}`)],
          });
        }
        return fakeResult();
      },
    });

    assert.equal(attempted.length, 1, 'the loop must stop after the first sandbox violation');
    const failed = result.stages.find((stage) => stage.status === 'failed');
    assert.match(failed.reason, /sandbox/);
    assert.ok(result.warnings.some((warning) => /violação de sandbox/.test(warning)));
  });
});

test('isSafeOutputFolder rejects everything that would widen the sandbox', () => {
  // Safe: plain project-relative subdirectories.
  for (const folder of ['.specs/discovery', 'docs/specs', 'out_dir', '.specs/discovery/', '.specs']) {
    assert.equal(isSafeOutputFolder(folder), true, `${folder} should be accepted`);
  }

  // Unsafe: self-reference, traversal, absolute, control dir, junk.
  for (const folder of [
    '.', './', '..', '../outside', 'a/../..', 'a/./b', '.reversa', '.reversa/x',
    '/etc', '/tmp/evil', 'C:\\temp', '\\\\server\\share', '', '   ',
    null, undefined, 42, {}, ['.specs/discovery'], 'bad\0name',
  ]) {
    assert.equal(isSafeOutputFolder(folder), false, `${JSON.stringify(folder)} should be rejected`);
  }
});

test('outputFolder falls back to the default for unsafe persisted values', () => {
  assert.equal(outputFolder({ output_folder: '_custom' }), '_custom');
  assert.equal(outputFolder({ output_folder: '.' }), '.specs/discovery');
  assert.equal(outputFolder({ output_folder: '../outside' }), '.specs/discovery');
  assert.equal(outputFolder({ output_folder: 'src/..' }), '.specs/discovery');
  assert.equal(outputFolder({}), '.specs/discovery');
});

test('sandboxRoots never widens past the project for a hostile output_folder', () => {
  // "." would otherwise make the whole project writable; ".." would leave it.
  for (const hostile of ['.', '..', '../outside', '/etc', 'src/../..']) {
    const roots = sandboxRoots('/p', hostile, 'discovery');
    assert.ok(!roots.includes('/p'), `${hostile} must not make the project root writable`);
    for (const root of roots) {
      assert.ok(root.startsWith('/p/'), `${hostile} produced an escaping root: ${root}`);
    }
    assert.ok(roots.includes('/p/.specs/discovery'), 'must fall back to the default output folder');
  }
});

test('a hostile output_folder cannot make project source writable', async () => {
  await withTempDir(async (dir) => {
    // Simulate a poisoned state file claiming the whole project as output.
    writeState(dir, { output_folder: '.' });

    const roots = sandboxRoots(dir, outputFolder({ output_folder: '.' }), 'discovery');
    const [write] = createGuardedFileTools(dir, roots);

    await assert.rejects(
      () => write.execute('1', { path: 'index.js', content: 'pwned' }, undefined, undefined, {}),
      WriteOutsideSandboxError,
    );
  });
});

test('runPipeline warns when it rejects a persisted output_folder', async () => {
  await withTempDir(async (dir) => {
    // Write a poisoned state file directly: writeState() sanitizes paths.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    writeFileSync(join(dir, '.reversa', 'state.json'), JSON.stringify({ output_folder: '../outside' }, null, 2));

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: new Map(),
      runSubagent: async () => fakeResult(),
    });

    assert.ok(
      result.warnings.some((warning) => /output_folder inválido/.test(warning)),
      'the rejection must be reported, not silent',
    );
  });
});
