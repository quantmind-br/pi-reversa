import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createGitReadTool,
  containsPath,
  createGuardedFileTools,
  createSandboxGuard,
  rejectGitArgs,
  WriteOutsideSandboxError,
} from '../extensions/lib/guarded-tools.js';
import {
  buildStageTask,
  expandStages,
  PIPELINE_EXTRA_ROOTS,
  resolveStageOutputs,
  runPipeline,
  sandboxRoots,
} from '../extensions/lib/orchestrator.js';
import { acquireExclusiveLock, automationLockPath } from '../extensions/lib/locks.js';
import { indexLockPath } from '../extensions/lib/code-intelligence/locks.js';
import { buildCbmEnv } from '../extensions/lib/code-intelligence/controller.js';
import { materializeContextBundle } from '../extensions/lib/code-intelligence/materializer.js';
import { adaptWorkflowTask } from '../extensions/lib/workflow-adapter.js';
import { smokeTestDocs } from '../extensions/lib/docs-assets.js';
import { PIPELINES } from '../extensions/lib/pipelines.js';
import {
  isSafeOutputFolder,
  listScoutModules,
  normalizeSurfaceLocation,
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

/**
 * Fan-out/stage fake that honours declared `outputs`: it creates every file the
 * stage promises, so tests exercise scheduling rather than the output contract.
 * Identify stages via `stageId`, never by parsing the prompt prose.
 */
function satisfyingSubagent(dir, { onStage } = {}) {
  return async ({ stageId, runKey }) => {
    const stage = PIPELINES.discovery.stages.find((entry) => entry.id === stageId);
    const item = runKey?.includes(':') ? runKey.slice(runKey.indexOf(':') + 1) : '';
    for (const template of stage?.outputs ?? []) {
      const relPath = template
        .replaceAll('{{output_folder}}', '.specs/discovery')
        .replaceAll('{{item}}', item);
      const absolute = join(dir, relPath);
      // Never clobber a real artifact (e.g. surface.json seeded by the test).
      if (existsSync(absolute)) continue;
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'x');
    }
    return onStage ? onStage({ stageId, runKey }) ?? fakeResult() : fakeResult();
  };
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
  assert.match(task, /Caminhos legados/);
  assert.match(task, /\.reversa\/context\/surface\.json/);

  // Legacy layout writes straight into `.specs`: rewriting `.specs/x` to
  // `.specs/x` is a tautology, so the instruction must not be emitted.
  const taskLegacy = buildStageTask({
    stage,
    module: null,
    skillEntry: undefined,
    state: { specs_root: '.specs' },
    folder: '.specs',
    writableRoots: ['.reversa', '.specs'],
  });
  assert.doesNotMatch(taskLegacy, /Caminhos legados/);
});

test('regression-check runs the reversa skill gated on regression-watch', () => {
  // The upstream workflow drives this stage through the `reversa` skill with
  // `--regression-only`, not through a reference document. Assert against the
  // real packaged tree so a bad alias cannot silently yield an empty body.
  const skillsDir = join(process.cwd(), 'packaged-skills');
  const stage = PIPELINES.discovery.stages.find((entry) => entry.id === 'regression-check');

  assert.equal(stage.skill, 'reversa');
  assert.equal(stage.requires, 'regression-watch');
  assert.equal(stage.optional, true);
  assert.equal(stage.failPipeline, false);
  assert.match(stage.args, /--regression-only/);

  const skillPath = join(skillsDir, stage.skill, 'SKILL.md');
  assert.ok(existsSync(skillPath), `missing packaged skill: ${skillPath}`);

  const task = buildStageTask({
    stage,
    module: null,
    skillEntry: { path: skillPath, baseDir: join(skillsDir, stage.skill) },
    state: {},
    folder: '.specs/discovery',
    skillsDir,
  });
  assert.ok(task.includes(stage.args), 'task must carry the regression-only args');
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

/**
 * Poll until `probe` returns something truthy. Used for genuinely asynchronous
 * contracts (a trailing repaint timer), never to paper over ordering bugs.
 *
 * @template T
 * @param {() => T} probe
 * @param {string} message
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor(probe, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

function migrateSkillIndex(dir) {
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, '---\nname: x\n---\nBody');
  return new Map(
    PIPELINES.migrate.stages
      .filter((stage) => stage.skill)
      .map((stage) => [stage.skill, { path: skillPath, baseDir: dir }]),
  );
}

/** Migrate counterpart of `satisfyingSubagent`: honours declared outputs. */
function satisfyingMigrateSubagent(dir, { onStage } = {}) {
  return async ({ stageId, runKey }) => {
    const stage = PIPELINES.migrate.stages.find((entry) => entry.id === stageId);
    for (const template of stage?.outputs ?? []) {
      const relPath = template.replaceAll('{{output_folder}}', '.specs/migration');
      if (relPath.includes('{{')) continue;
      const absolute = join(dir, relPath);
      if (existsSync(absolute)) continue;
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'x');
    }
    return onStage ? onStage({ stageId, runKey }) ?? fakeResult() : fakeResult();
  };
}

test('normalizeSurfaceLocation materializes the canonical surface.json copy', async () => {
  await withTempDir((dir) => {
    const stray = join(dir, '.specs', 'discovery', 'surface.json');
    const canonical = join(dir, '.reversa', 'context', 'surface.json');
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(stray, JSON.stringify({ modules: ['auth'] }));

    // Only the stray copy exists: materialize the canonical one.
    const first = normalizeSurfaceLocation(dir, '.specs/discovery');
    assert.equal(first.recovered, true);
    assert.equal(first.from, '.specs/discovery/surface.json');
    assert.deepEqual(JSON.parse(readFileSync(canonical, 'utf8')), { modules: ['auth'] });

    // Canonical strictly newer: keep it. Explicit mtimes, so the assertion does
    // not depend on filesystem timestamp resolution.
    writeFileSync(canonical, JSON.stringify({ modules: ['newer'] }));
    utimesSync(stray, 1000, 1000);
    utimesSync(canonical, 2000, 2000);
    assert.equal(normalizeSurfaceLocation(dir, '.specs/discovery').recovered, false);
    assert.deepEqual(JSON.parse(readFileSync(canonical, 'utf8')), { modules: ['newer'] });

    // Stray strictly newer: refresh the canonical.
    utimesSync(stray, 3000, 3000);
    assert.equal(normalizeSurfaceLocation(dir, '.specs/discovery').recovered, true);
    assert.deepEqual(JSON.parse(readFileSync(canonical, 'utf8')), { modules: ['auth'] });

    // A corrupt stray never overwrites a valid canonical, however new it is.
    writeFileSync(canonical, JSON.stringify({ modules: ['keep'] }));
    writeFileSync(stray, '{ not json');
    utimesSync(canonical, 4000, 4000);
    utimesSync(stray, 5000, 5000);
    assert.equal(normalizeSurfaceLocation(dir, '.specs/discovery').recovered, false);
    assert.deepEqual(JSON.parse(readFileSync(canonical, 'utf8')), { modules: ['keep'] });
  });
});

test('runPipeline runs discovery in order, fans out modules/units, and stops on required failure', async () => {
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
      runSubagent: satisfyingSubagent(dir, {
        onStage: ({ stageId }) => {
          calls.push(stageId);
          if (stageId === 'detective') throw new Error('detective exploded');
          return fakeResult();
        },
      }),
    });

    const done = result.stages.filter((stage) => stage.status === 'done').map((stage) => stage.id);
    assert.deepEqual(done.slice(0, 5), [
      'preflight',
      'scout',
      'archaeologist:auth',
      'archaeologist:orders',
      'archaeologist:billing',
    ]);
    // Required detective failure must block writer and mark pipeline failed.
    assert.ok(!done.some((id) => id === 'writer' || id.startsWith('writer:')), 'writer must not run after detective failed');
    assert.ok(result.warnings.some((warning) => /detective exploded/.test(warning)));
    assert.equal(result.aborted, true);
    assert.equal(result.status, 'failed');
    assert.match(result.report, /Totais: ✅/);

    // Specs organization persisted after Scout, before Archaeologist.
    assert.equal(readSpecsSection(dir).granularity, 'module');
    assert.equal(calls[0], 'scout', 'scout is the first agent stage; preflight is a controller');
  });
});

test('runPipeline honours stageModels per stage and reports them', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['auth'], organization_suggestion: { granularity: 'module' } }),
    );

    const SESSION = { provider: 'anthropic', id: 'sonnet' };
    const OPUS = { provider: 'anthropic', id: 'opus' };
    /** @type {{ stageId: string, model: any }[]} */
    const launches = [];
    /** @type {any[]} */
    const starts = [];

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: { specs_choice: 'auto' },
      skillIndex: discoverySkillIndex(dir),
      model: SESSION,
      stageModels: { 'review-structural': OPUS },
      stageModelLabels: { 'review-structural': 'anthropic/opus' },
      stageModelWarnings: ['modelo `ghost/x` não encontrado no registry; etapa `scout` usa o modelo da sessão.'],
      onProgress: (update) => {
        if (update.status === 'start') starts.push(update);
      },
      runSubagent: async (options) => {
        launches.push({ stageId: options.stageId, model: options.model });
        return satisfyingSubagent(dir)(options);
      },
    });

    const modelFor = (stageId) => launches.find((entry) => entry.stageId === stageId)?.model;
    assert.equal(modelFor('review-structural'), OPUS, 'the override wins for its stage');
    assert.equal(modelFor('scout'), SESSION, 'every other stage keeps the session model');
    assert.equal(modelFor('archaeologist'), SESSION);

    assert.match(result.report, /## Modelos por etapa/);
    assert.match(result.report, /- `review-structural`: `anthropic\/opus`/);
    assert.ok(
      result.warnings.some((warning) => /ghost\/x/.test(warning)),
      'resolution warnings surface in the run report',
    );

    const start = starts.find((update) => update.stageId === 'review-structural');
    assert.equal(start.model, 'anthropic/opus', 'the progress line carries the live model');
    assert.equal(starts.find((update) => update.stageId === 'scout').model, null);

    const runJson = JSON.parse(readFileSync(resolve(dir, result.runDir, 'run.json'), 'utf8'));
    assert.deepEqual(runJson.models, { 'review-structural': 'anthropic/opus' });
  });
});

test('runPipeline recupera surface.json deslocado e mantém o fan-out', async () => {
  await withTempDir(async (dir) => {
    // Contrast with the test above: the Scout wrote only the stray copy, which
    // is what the skill bodies' `.specs/` paths actually produce.
    mkdirSync(join(dir, '.specs', 'discovery'), { recursive: true });
    writeFileSync(
      join(dir, '.specs', 'discovery', 'surface.json'),
      JSON.stringify({
        modules: ['auth', 'orders', 'billing'],
        organization_suggestion: { granularity: 'endpoint' },
      }),
    );

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: { specs_choice: 'auto' },
      skillIndex: discoverySkillIndex(dir),
      runSubagent: satisfyingSubagent(dir),
    });

    assert.equal(readSpecsSection(dir).granularity, 'endpoint');
    const done = result.stages.filter((stage) => stage.status === 'done').map((stage) => stage.id);
    for (const key of ['archaeologist:auth', 'archaeologist:orders', 'archaeologist:billing']) {
      assert.ok(done.includes(key), `missing fan-out run: ${key}`);
    }
    assert.equal(existsSync(join(dir, '.reversa', 'context', 'surface.json')), true);
    assert.ok(result.warnings.some((warning) => /cópia canônica atualizada/.test(warning)));
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

    assert.match(result.report, /Não executadas nesta sessão/);
    assert.match(result.report, /Scout/);
  });
});

test('runPipeline fails and aborts when a required skill is not installed', async () => {
  await withTempDir(async (dir) => {
    let launched = false;
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: new Map(),
      runSubagent: async () => {
        launched = true;
        return fakeResult();
      },
    });

    assert.equal(launched, false, 'no subagent may run without its skill');
    assert.equal(result.status, 'failed');
    assert.equal(result.aborted, true);
    const failed = result.stages.find((stage) => stage.status === 'failed');
    assert.ok(failed, 'the first mandatory skill stage must fail');
    assert.match(failed.reason, /não está instalada/);
    assert.ok(result.warnings.some((warning) => /não está instalada/.test(warning)));
  });
});

test('runPipeline skips an optional stage whose skill is not installed', async () => {
  const stage = {
    id: 'optional-missing',
    skill: 'reversa-absent',
    label: 'Optional missing',
    fanOut: null,
    optional: true,
    failPipeline: false,
    task: 'Never runs.',
  };
  PIPELINES.__test_optional_skill = { label: 'Optional skill probe', stages: [stage] };
  try {
    await withTempDir(async (dir) => {
      const result = await runPipeline({
        cwd: dir,
        pipeline: '__test_optional_skill',
        answers: {},
        skillIndex: new Map(),
        runSubagent: async () => fakeResult(),
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(result.stages.map((entry) => entry.status), ['skipped']);
      assert.match(result.stages[0].reason, /não está instalada/);
    });
  } finally {
    delete PIPELINES.__test_optional_skill;
  }
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
      assert.equal(result.status, 'blocked');
      assert.ok(result.warnings.some((warning) => /sandbox/i.test(warning)));
      // NOTE: a post-hoc existsSync() here would be vacuous — the lock is
      // released in a `finally`. Containment is asserted directly in the
      // `acquireExclusiveLock` test below, which observes creation.
      assert.deepEqual(readdirSync(outside), [], 'nothing may be written outside the project');
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
      runSubagent: satisfyingSubagent(dir),
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
  assert.ok(sessionOptions.customTools.some((tool) => tool.name === 'reversa_code_intel'));

  assert.equal(result.text, 'ok');
  assert.equal(result.usage.total, 3);
});

test('runSubagent forwards tool names and message token usage to onEvent', async () => {
  /** @type {(event: any) => void} */
  let emit = () => {};
  const sdk = {
    getAgentDir: () => '/tmp/agent-dir',
    SettingsManager: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    createAgentSession: async () => ({
      session: {
        messages: [],
        async prompt() {
          // Session events fire while the child runs, i.e. inside `prompt`.
          emit({ type: 'tool_execution_start', toolName: 'grep' });
          emit({ type: 'message_end', message: { usage: { totalTokens: 800 } } });
          emit({ type: 'message_end', message: { usage: { totalTokens: 1300 } } });
          // Neither of these carries usable progress information.
          emit({ type: 'message_end', message: {} });
          emit({ type: 'message_update', message: { usage: { totalTokens: 99 } } });
        },
        subscribe: (handler) => {
          emit = handler;
          return () => { emit = () => {}; };
        },
        dispose() {},
        async abort() {},
      },
    }),
  };

  const events = [];
  await runSubagent(
    {
      cwd: '/tmp/project',
      task: 'do it',
      allowedRoots: ['/tmp/project/.reversa'],
      onEvent: (event) => events.push(event),
    },
    { sdk },
  );

  assert.deepEqual(events, [
    { type: 'tool_execution_start', name: 'grep' },
    { type: 'message_end', tokens: 800 },
    { type: 'message_end', tokens: 1300 },
    { type: 'message_end', tokens: 0 },
  ], 'tokens must reach the orchestrator; unrelated events must not');
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
  assert.match(parsePipelineArg('nope').error, /Unknown pipeline/);
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
    assert.match(result.report, /## Como retomar/);
    assert.match(result.report, /NÃO edite/);
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

// ---------------------------------------------------------------------------
// Pipeline hardening matrix
// ---------------------------------------------------------------------------

/** Register a synthetic pipeline for the duration of one test. */
async function withPipeline(id, definition, fn) {
  PIPELINES[id] = definition;
  try {
    return await fn();
  } finally {
    delete PIPELINES[id];
  }
}

function agentStage(overrides) {
  return {
    skill: null,
    label: overrides.id,
    fanOut: null,
    optional: false,
    failPipeline: true,
    task: `run ${overrides.id}`,
    ...overrides,
  };
}

test('1 — a controller whose dependency failed never runs', async () => {
  await withTempDir(async (dir) => {
    let controllerRan = false;
    await withPipeline(
      '__t_ctrl_dep',
      {
        label: 'controller dependency',
        stages: [
          agentStage({ id: 'publisher', skill: 'reversa-docs-publisher', label: 'Publisher' }),
          agentStage({
            id: 'smoke',
            label: 'Smoke',
            kind: 'controller',
            handler: 'docs-smoke',
            dependsOn: ['publisher'],
          }),
        ],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_ctrl_dep',
          answers: {},
          skillIndex: new Map([['reversa-docs-publisher', { path: skillPath, baseDir: dir }]]),
          runSubagent: async () => {
            controllerRan = true;
            throw new Error('publisher exploded');
          },
        });

        assert.equal(controllerRan, true, 'the agent stage did run');
        assert.equal(result.status, 'failed');
        assert.ok(
          !result.stages.some((stage) => stage.id === 'smoke' && stage.status === 'done'),
          'the controller must not execute behind a failed dependency',
        );
      },
    );
  });
});

test('3 — resume with one shard completed reruns only the missing shard', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['auth', 'orders'] }),
    );
    writeState(dir, { completed: ['archaeologist:auth'], output_folder: '.specs/discovery' });

    const ran = [];
    await withPipeline(
      '__t_resume',
      {
        label: 'resume shards',
        stages: [
          agentStage({ id: 'archaeologist', skill: 'a', label: 'Arch', fanOut: 'modules' }),
          agentStage({ id: 'after', skill: 'b', label: 'After', dependsOn: ['archaeologist'] }),
        ],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_resume',
          answers: {},
          resume: true,
          skillIndex: new Map([
            ['a', { path: skillPath, baseDir: dir }],
            ['b', { path: skillPath, baseDir: dir }],
          ]),
          runSubagent: async ({ runKey }) => {
            ran.push(runKey);
            return fakeResult();
          },
        });

        assert.deepEqual(ran, ['archaeologist:orders', 'after']);
        assert.equal(result.status, 'completed');
      },
    );
  });
});

test('4 — one failed shard blocks the mandatory consumer', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['auth', 'orders'] }),
    );

    await withPipeline(
      '__t_shard_fail',
      {
        label: 'shard failure',
        stages: [
          agentStage({ id: 'arch', skill: 'a', label: 'Arch', fanOut: 'modules', failPipeline: false }),
          agentStage({ id: 'after', skill: 'b', label: 'After', dependsOn: ['arch'] }),
        ],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        let afterRan = false;
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_shard_fail',
          answers: {},
          skillIndex: new Map([
            ['a', { path: skillPath, baseDir: dir }],
            ['b', { path: skillPath, baseDir: dir }],
          ]),
          runSubagent: async ({ stageId, runKey }) => {
            if (stageId === 'after') afterRan = true;
            if (runKey === 'arch:orders') throw new Error('shard exploded');
            return fakeResult();
          },
        });

        assert.equal(afterRan, false, 'a partially failed fan-out must not promote the stage');
        assert.equal(result.status, 'failed');
        const after = result.stages.find((stage) => stage.id === 'after');
        assert.equal(after.status, 'skipped');
        assert.match(after.reason, /depend/);
      },
    );
  });
});

test('5 — regression-check runs even though the reviewer stage did not succeed', async () => {
  await withTempDir(async (dir) => {
    const watchDir = join(dir, '.specs', 'forward', 'wave-1');
    mkdirSync(watchDir, { recursive: true });
    writeFileSync(join(watchDir, 'regression-watch.md'), '# watch');

    const regression = PIPELINES.discovery.stages.find((stage) => stage.id === 'regression-check');
    // 1.5: the trigger is position in the plan, not the Reviewer's success.
    assert.equal(regression.dependsOn, undefined);

    const ran = [];
    await withPipeline(
      '__t_regression',
      {
        label: 'regression without reviewer',
        stages: [
          agentStage({
            id: 'reviewer',
            skill: 'missing-reviewer',
            label: 'Reviewer',
            optional: true,
            failPipeline: false,
          }),
          { ...regression, skill: 'reversa' },
        ],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_regression',
          answers: {},
          skillIndex: new Map([['reversa', { path: skillPath, baseDir: dir }]]),
          runSubagent: async ({ stageId }) => {
            ran.push(stageId);
            return fakeResult();
          },
        });

        assert.deepEqual(ran, ['regression-check'], 'it must run without the Reviewer');
        const stage = result.stages.find((entry) => entry.id === 'regression-check');
        assert.equal(stage.status, 'done');
      },
    );
  });
});

test('6 — a sandbox violation stops the fan-out from launching more shards', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['m1', 'm2', 'm3', 'm4', 'm5'] }),
    );

    await withPipeline(
      '__t_failfast',
      {
        label: 'fan-out fail fast',
        stages: [agentStage({ id: 'arch', skill: 'a', label: 'Arch', fanOut: 'modules' })],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        let launches = 0;
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_failfast',
          answers: {},
          concurrency: 2,
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          runSubagent: async () => {
            launches += 1;
            return fakeResult({
              violations: [{ message: 'refusing to write outside allowed roots' }],
            });
          },
        });

        assert.ok(launches <= 2, `expected at most the 2 in-flight shards, got ${launches}`);
        assert.equal(result.status, 'blocked');
        assert.ok(
          result.stages.some((stage) => stage.reason === 'cancelado antes do launch'),
          'never-launched shards must be reported, not dropped',
        );
      },
    );
  });
});

test('7 — a concurrent run is blocked by the automation lock', async () => {
  await withTempDir(async (dir) => {
    const release = acquireExclusiveLock(automationLockPath(dir), { label: 'reversa automation' });
    try {
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

      assert.equal(launched, false, 'nothing may run while another pipeline holds the lock');
      assert.equal(result.status, 'blocked');
      assert.ok(result.warnings.some((warning) => /Outra execução Reversa/.test(warning)));
      assert.equal(existsSync(join(dir, '.reversa', 'state.json')), false, 'state must be untouched');
    } finally {
      release();
    }
  });
});

test('8 — a stale lock is recovered and the run proceeds', async () => {
  await withTempDir(async (dir) => {
    const lockPath = automationLockPath(dir);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
    const ancient = Date.now() / 1000 - 24 * 60 * 60;
    utimesSync(lockPath, ancient, ancient);

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: discoverySkillIndex(dir),
      runSubagent: satisfyingSubagent(dir),
    });

    assert.notEqual(result.status, 'blocked', 'a stale lock must not block a new run');
    assert.equal(existsSync(lockPath), false, 'the lock is released at the end');
  });
});

test('9 — a stage whose declared outputs are missing fails', async () => {
  await withTempDir(async (dir) => {
    await withPipeline(
      '__t_outputs',
      {
        label: 'output contract',
        stages: [
          agentStage({
            id: 'writes-nothing',
            skill: 'a',
            label: 'Writes nothing',
            outputs: ['{{output_folder}}/promised.md'],
          }),
        ],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_outputs',
          answers: {},
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          runSubagent: async () => fakeResult(),
        });

        assert.equal(result.status, 'failed');
        const stage = result.stages[0];
        assert.equal(stage.status, 'failed');
        assert.match(stage.reason, /outputs ausentes/);
        assert.deepEqual(stage.outputsMissing, ['.specs/discovery/promised.md']);
      },
    );
  });
});

test('10 — resolveStageOutputs expands output_folder and item', () => {
  const stage = {
    outputs: ['{{output_folder}}/a.md', '{{output_folder}}/{{item}}/b.md'],
  };
  assert.deepEqual(resolveStageOutputs(stage, { folder: '.specs/x', item: 'auth' }), [
    '.specs/x/a.md',
    '.specs/x/auth/b.md',
  ]);
  // An unresolved placeholder is dropped, never checked as a literal path.
  assert.deepEqual(resolveStageOutputs({ outputs: ['{{unknown}}/a.md'] }, { folder: 'f' }), []);
  assert.deepEqual(resolveStageOutputs({}, { folder: 'f' }), []);
});

test('10b — an item-less fan-out run never checks a path with an empty segment', () => {
  const stage = { outputs: ['{{output_folder}}/{{item}}/requirements.md'] };
  // Regression: a Writer that collapsed to a single item-less run used to be
  // validated against `.specs/discovery//requirements.md`, which cannot exist,
  // so a stage that produced every file it promised was reported as failed.
  assert.deepEqual(resolveStageOutputs(stage, { folder: '.specs/discovery', item: null }), []);
  assert.deepEqual(resolveStageOutputs(stage, { folder: '.specs/discovery', item: '' }), []);
  assert.deepEqual(resolveStageOutputs(stage, { folder: '.specs/discovery', item: '  ' }), []);
  // Non-item outputs of the same stage are still enforced.
  assert.deepEqual(
    resolveStageOutputs(
      { outputs: ['{{output_folder}}/{{item}}/a.md', '{{output_folder}}/global.md'] },
      { folder: '.specs/discovery', item: null },
    ),
    ['.specs/discovery/global.md'],
  );
});

test('10c — discovery survives the off-contract surface that failed the sm run', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    // Verbatim shape of the surface.json a real Scout run produced: the
    // organization suggestion inlined at the root instead of nested, no
    // `modules` key at all, and `present` where the schema says `detected`.
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({
        granularity: 'module',
        rationale: 'Top-level directories mirror domain namespaces.',
        signals: [{ type: 'domain_namespaces', evidence: ['internal/state/'] }],
        features: [],
        automation_signals: {
          database: false,
          design: { present: true, evidence: ['Lipgloss v2'] },
          screenshots: { present: true, evidence: ['.ideation/uiux-captures/a.txt'] },
        },
      }),
    );

    const ran = [];
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: { specs_choice: 'auto' },
      skillIndex: discoverySkillIndex(dir),
      runSubagent: satisfyingSubagent(dir, {
        onStage: ({ stageId, runKey }) => {
          ran.push(runKey);
          // The Archaeologist is the declared source of modules.json; a real
          // run writes it even when the Scout's surface omitted `modules`.
          // Written independently of the harness' own output materialization,
          // so this fixture never relies on that ordering.
          if (stageId === 'archaeologist') {
            mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
            writeFileSync(
              join(dir, '.reversa', 'context', 'modules.json'),
              JSON.stringify({
                modules: [
                  { name: 'state', path: 'internal/state' },
                  { name: 'engine', path: 'internal/engine' },
                ],
              }),
            );
          }
          return fakeResult();
        },
      }),
    });

    // `present` is honoured, so the enrichment stages are no longer skipped.
    assert.ok(ran.includes('design-system'), '`present: true` must enable the stage');
    assert.ok(ran.includes('visor'), '`present: true` must enable the stage');
    assert.ok(!ran.includes('data-master'), 'an explicit false still skips');

    // The Writer fans out over the Archaeologist's modules instead of
    // collapsing to one item-less run.
    assert.deepEqual(
      ran.filter((key) => key.startsWith('writer:')).sort(),
      ['writer:engine', 'writer:state'],
    );

    // The whole point: the Writer no longer aborts the run, so every stage
    // after it actually gets scheduled. (The quality gate still fails on this
    // harness because `satisfyingSubagent` writes `x`, not real JSONL findings
    // — that is test 13's contract, not this one's.)
    const writer = result.stages.filter((stage) => stage.id.startsWith('writer:'));
    assert.equal(writer.length, 2);
    assert.ok(writer.every((stage) => stage.status === 'done'), JSON.stringify(writer));
    assert.ok(ran.includes('adjudicate'), 'the pipeline must reach the stages after the Writer');
    assert.ok(
      !result.warnings.some((warning) => warning.includes('não produziu organization_suggestion')),
      'the flat organization suggestion must be read, not reported as absent',
    );
    assert.ok(
      result.warnings.some((warning) => warning.includes('fora do contrato')),
      'the deviations are tolerated but must still be reported',
    );
    assert.equal(readSpecsSection(dir).granularity, 'module');
  });
});

test('10d — an item-less Writer no longer aborts the pipeline', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    // Nothing anywhere declares units: no modules in the surface and no
    // modules.json from the Archaeologist.
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ organization_suggestion: { granularity: 'module' } }),
    );

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: { specs_choice: 'auto' },
      skillIndex: discoverySkillIndex(dir),
      runSubagent: satisfyingSubagent(dir),
    });

    const writer = result.stages.find((stage) => stage.id === 'writer');
    assert.equal(writer.status, 'done', JSON.stringify(writer));
    assert.ok(
      result.stages.some((stage) => stage.id === 'adjudicate'),
      'an item-less Writer must not abort the run',
    );
    assert.ok(
      result.warnings.some((warning) => warning.includes('sem validação de outputs por unit')),
      'the unvalidated fallback must be stated, not silent',
    );
  });
});

test('11 — adaptWorkflowTask maps internal, skill, expand, condition and outputs', () => {
  const controller = adaptWorkflowTask({ id: 'preflight', kind: 'internal', handler: 'preflight', outputs: ['o'] });
  assert.equal(controller.kind, 'controller');
  assert.equal(controller.handler, 'preflight');
  assert.equal(controller.skill, null);
  assert.equal(controller.label, 'Preflight');
  assert.deepEqual(controller.outputs, ['o']);

  const fanned = adaptWorkflowTask({ id: 'archaeologist', kind: 'skill', skill: 's', expand: 'modules' });
  assert.equal(fanned.fanOut, 'modules');
  assert.equal(fanned.skill, 's');
  assert.equal(fanned.optional, false);
  assert.equal(fanned.failPipeline, true);

  const units = adaptWorkflowTask({ id: 'writer', kind: 'skill', skill: 's', expand: 'units' });
  assert.equal(units.fanOut, 'units');

  const conditional = adaptWorkflowTask({ id: 'data-master', kind: 'skill', skill: 's', condition: 'database' });
  assert.equal(conditional.condition, 'database');
  assert.equal(conditional.optional, true);
  assert.equal(conditional.failPipeline, false);

  const regression = adaptWorkflowTask({ id: 'regression-check', kind: 'skill', skill: 'reversa', args: '--x' });
  assert.equal(regression.requires, 'regression-watch');
  assert.equal(regression.optional, true);
  assert.equal(regression.args, '--x');

  const multiword = adaptWorkflowTask({ id: 'review-structural', kind: 'skill', skill: 's' });
  assert.equal(multiword.label, 'Review Structural');
  // The upstream list is flat: inventing a dependency graph is forbidden.
  assert.equal(multiword.dependsOn, undefined);
});

test('12 — discovery comes from the generated workflow, preflight first, fan-out intact', async () => {
  const ids = PIPELINES.discovery.stages.map((stage) => stage.id);
  assert.equal(ids[0], 'preflight');
  assert.equal(ids.length, 20);
  assert.equal(ids.at(-1), 'quality-gate');
  assert.equal(PIPELINES.discovery.stages.find((s) => s.id === 'archaeologist').fanOut, 'modules');
  assert.equal(PIPELINES.discovery.stages.find((s) => s.id === 'writer').fanOut, 'units');

  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['auth'], organization_suggestion: { granularity: 'module' } }),
    );

    const ran = [];
    await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: discoverySkillIndex(dir),
      runSubagent: satisfyingSubagent(dir, {
        onStage: ({ stageId }) => {
          ran.push(stageId);
          return fakeResult();
        },
      }),
    });

    // Preflight is a controller, so the first *agent* stage is scout.
    assert.equal(ran[0], 'scout');
    assert.ok(
      existsSync(join(dir, '.specs', 'discovery', '.evidence', 'source-snapshot.json')),
      'the preflight controller must write its snapshot',
    );
  });
});

test('13 — quality-gate fails when a review layer is missing', async () => {
  await withTempDir(async (dir) => {
    const reviewDir = join(dir, '.specs', 'discovery', 'review');
    mkdirSync(reviewDir, { recursive: true });
    // Everything except consistency-findings.jsonl.
    for (const file of [
      'evidence-initial.jsonl',
      'structural-findings.jsonl',
      'adversarial-findings.jsonl',
      'coverage-findings.jsonl',
      'domain-findings.jsonl',
      'evidence-final.jsonl',
    ]) {
      writeFileSync(join(reviewDir, file), `${JSON.stringify({ id: file })}\n`);
    }

    await withPipeline(
      '__t_gate',
      {
        label: 'quality gate',
        stages: [agentStage({ id: 'quality-gate', label: 'Gate', kind: 'controller', handler: 'quality-gate' })],
      },
      async () => {
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_gate',
          answers: {},
          skillIndex: new Map(),
          runSubagent: async () => fakeResult(),
        });

        assert.equal(result.status, 'failed');
        assert.match(result.stages[0].reason, /camadas ausentes.*consistency-findings/s);
        const coverage = JSON.parse(
          readFileSync(join(dir, '.specs', 'discovery', '.evidence', 'coverage.json'), 'utf8'),
        );
        assert.deepEqual(coverage.layers_missing, ['consistency-findings.jsonl']);
        // All six present layers carry findings, evidence layers included:
        // the Evidence Auditor emits FND-EV-* records (SKILL.md:61).
        assert.equal(coverage.findings_total, 6);
      },
    );
  });
});

test('13b — quality-gate passes only when every finding is adjudicated', async () => {
  await withTempDir(async (dir) => {
    const reviewDir = join(dir, '.specs', 'discovery', 'review');
    mkdirSync(reviewDir, { recursive: true });
    const layers = [
      'evidence-initial.jsonl',
      'structural-findings.jsonl',
      'adversarial-findings.jsonl',
      'coverage-findings.jsonl',
      'domain-findings.jsonl',
      'consistency-findings.jsonl',
      'evidence-final.jsonl',
    ];
    for (const file of layers) writeFileSync(join(reviewDir, file), `${JSON.stringify({ id: file })}\n`);

    await withPipeline(
      '__t_gate2',
      {
        label: 'quality gate',
        stages: [agentStage({ id: 'quality-gate', label: 'Gate', kind: 'controller', handler: 'quality-gate' })],
      },
      async () => {
        const run = () =>
          runPipeline({
            cwd: dir,
            pipeline: '__t_gate2',
            answers: {},
            skillIndex: new Map(),
            runSubagent: async () => fakeResult(),
          });

        const unresolved = await run();
        assert.equal(unresolved.status, 'failed');
        assert.match(unresolved.stages[0].reason, /7 findings unresolved/);

        const findingsFiles = layers;
        writeFileSync(
          join(reviewDir, 'resolution.jsonl'),
          `${findingsFiles.map((file) => JSON.stringify({ id: file })).join('\n')}\n`,
        );
        const resolved = await run();
        assert.equal(resolved.stages[0].status, 'done');
      },
    );
  });
});

test('14 — a stage whose condition is not signalled is skipped with a reason', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({
        modules: ['auth'],
        automation_signals: { database: { detected: true }, design: { detected: false } },
      }),
    );

    const ran = [];
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'discovery',
      answers: {},
      skillIndex: discoverySkillIndex(dir),
      runSubagent: satisfyingSubagent(dir, {
        onStage: ({ stageId }) => {
          ran.push(stageId);
          return fakeResult();
        },
      }),
    });

    assert.ok(ran.includes('data-master'), 'a detected signal enables the stage');
    assert.ok(!ran.includes('design-system'), 'an explicit false must skip');
    assert.ok(!ran.includes('visor'), 'a missing signal must skip (conservative default)');

    const visor = result.stages.find((stage) => stage.id === 'visor');
    assert.equal(visor.status, 'skipped');
    assert.match(visor.reason, /screenshots/);
  });
});

test('15 — migrate-preflight fails before the Paradigm Advisor without discovery', async () => {
  await withTempDir(async (dir) => {
    let launched = false;
    const result = await runPipeline({
      cwd: dir,
      pipeline: 'migrate',
      answers: { target_stack: 'Node 22 + Fastify' },
      skillIndex: migrateSkillIndex(dir),
      runSubagent: async () => {
        launched = true;
        return fakeResult();
      },
    });

    assert.equal(launched, false, 'no migration agent may run without discovery');
    assert.equal(result.status, 'failed');
    assert.match(result.stages[0].reason, /Discovery ausente/);
  });
});

test('15b — migrate-preflight fails when the interview omitted target_stack', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.specs', 'discovery'), { recursive: true });
    writeFileSync(join(dir, '.specs', 'discovery', 'architecture.md'), '# arch');

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'migrate',
      answers: {},
      skillIndex: migrateSkillIndex(dir),
      runSubagent: async () => fakeResult(),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.stages[0].reason, /target_stack/);
  });
});

test('16 — migrate E2E writes the brief, auto-approves gates and emits the handoff', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.specs', 'discovery'), { recursive: true });
    writeFileSync(join(dir, '.specs', 'discovery', 'architecture.md'), '# arch');

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'migrate',
      answers: {
        target_stack: 'Node 22 + Fastify',
        migration_scope: 'incremental',
        cutover_strategy: 'strangler',
        constraints: 'sem downtime',
      },
      skillIndex: migrateSkillIndex(dir),
      runSubagent: satisfyingMigrateSubagent(dir),
    });

    const migration = join(dir, '.specs', 'migration');
    const brief = readFileSync(join(migration, 'migration_brief.md'), 'utf8');
    assert.match(brief, /Node 22 \+ Fastify/);
    assert.match(brief, /incremental/);
    assert.match(brief, /strangler/);
    assert.match(brief, /sem downtime/);

    const migrationState = JSON.parse(readFileSync(join(migration, '.state.json'), 'utf8'));
    assert.equal(migrationState.currentAgent.topologyApproved, true);
    assert.equal(migrationState.currentAgent.screenModeApproved, true);

    const handoff = readFileSync(join(migration, 'handoff.md'), 'utf8');
    assert.match(handoff, /paradigm_decision\.md/);
    assert.match(handoff, /topology_decision\.md/);

    const ambiguity = readFileSync(join(migration, 'ambiguity_log.md'), 'utf8');
    assert.match(ambiguity, /## PENDENTES/);
    assert.match(ambiguity, /## RESOLVIDOS COM DECISÃO HUMANA/);
    assert.match(ambiguity, /## REFERIDOS À CODIFICAÇÃO/);

    assert.notEqual(result.status, 'failed');
  });
});

test('17 — auto-approval does not throw when the migration folder does not exist', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.specs', 'discovery'), { recursive: true });
    writeFileSync(join(dir, '.specs', 'discovery', 'architecture.md'), '# arch');
    // The migration folder is deliberately absent: appendAmbiguity() used to
    // write into it before mkdir, throwing outside the stage error path.

    const result = await runPipeline({
      cwd: dir,
      pipeline: 'migrate',
      answers: { target_stack: 'Go 1.23' },
      skillIndex: migrateSkillIndex(dir),
      runSubagent: satisfyingMigrateSubagent(dir),
    });

    assert.ok(
      existsSync(join(dir, '.specs', 'migration', 'ambiguity_log.md')),
      'the ambiguity log must be created inside the migration folder',
    );
    assert.notEqual(result.status, 'failed');
  });
});

test('18 — docs-config writes a valid config and preserves an existing one', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    writeFileSync(join(dir, '.reversa', 'soul.md'), 'a alma do projeto');

    // The docs folder is only resolved for pipeline id `docs`, so swap the real
    // definition down to the single controller under test.
    const realDocs = PIPELINES.docs;
    PIPELINES.docs = {
      label: 'docs config',
      stages: [agentStage({ id: 'docs-config', label: 'Config', kind: 'controller', handler: 'docs-config' })],
    };
    try {
      {
        const run = (answers) =>
          runPipeline({
            cwd: dir,
            pipeline: 'docs',
            answers,
            skillIndex: new Map(),
            runSubagent: async () => fakeResult(),
          });

        const first = await run({ project: 'demo', reader_profile: 'auditor', docs_depth: 'overview' });
        assert.equal(first.stages[0].status, 'done');

        const configPath = join(dir, '.specs', 'docs', '.config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        assert.equal(config.schemaVersion, 1);
        assert.equal(config.projectName, 'demo');
        assert.equal(config.interview.reader_profile, 'auditor');
        assert.equal(config.interview.docs_depth, 'overview');
        assert.equal(config.interview.visual_style, 'sober', 'defaults fill the unanswered fields');
        assert.match(config.seed.hash, /^sha256:[a-f0-9]{64}$/);
        assert.equal(config.seed.source, 'soul.md');
        assert.equal(config.knowledgeSources.soul, true);
        assert.equal(config.knowledgeSources.sourceCode, true);

        const second = await run({ project: 'other', reader_profile: 'stakeholder' });
        assert.match(second.stages[0].reason, /config existente preservada/);
        assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), config, 'rerun must be idempotent');
      }
    } finally {
      PIPELINES.docs = realDocs;
    }
  });
});

test('19 — smokeTestDocs rejects a prefix sibling and percent-encoded traversal', async () => {
  await withTempDir(async (dir) => {
    const docs = join(dir, 'docs');
    const evil = join(dir, 'docs-evil');
    mkdirSync(docs, { recursive: true });
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'x.js'), 'boom');
    writeFileSync(
      join(docs, 'index.html'),
      '<html><body><script src="../docs-evil/x.js"></script></body></html>',
    );

    const result = await smokeTestDocs({ docsRoot: docs });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.kind === 'asset-escape'),
      'a sibling sharing the docs prefix must not pass containment',
    );

    // The HTTP handler decodes before resolving, so %2e%2e%2f normalizes to ../
    // and containment rejects it.
    const encoded = resolve(docs, `.${decodeURIComponent('/%2e%2e%2fdocs-evil/x.js')}`);
    assert.ok(!containsPath(docs, encoded), 'percent-encoded traversal must be rejected');
  });
});

test('20 — smokeTestDocs fails when no HTML page was generated', async () => {
  await withTempDir(async (dir) => {
    const docs = join(dir, 'docs');
    mkdirSync(docs, { recursive: true });

    const result = await smokeTestDocs({ docsRoot: docs });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.kind === 'no-pages'));
  });
});

test('21 — smokeTestDocs reports a broken href', async () => {
  await withTempDir(async (dir) => {
    const docs = join(dir, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(
      join(docs, 'index.html'),
      [
        '<html><body>',
        '<a href="missing.html">broken</a>',
        '<a href="index.html">fine</a>',
        '<a href="#anchor">anchor</a>',
        '<a href="https://example.com">external</a>',
        '<a href="mailto:a@b.c">mail</a>',
        '</body></html>',
      ].join('\n'),
    );

    const result = await smokeTestDocs({ docsRoot: docs });
    const broken = result.errors.filter((error) => error.kind === 'link-broken');
    assert.deepEqual(broken.map((error) => error.detail), ['missing.html']);
  });
});

test('22 — partial vendor surfaces its reason and persists telemetry', async () => {
  await withTempDir(async (dir) => {
    // A skills dir whose vendor-pins names a lib the (offline) fetch cannot get.
    const skillsDir = join(dir, 'skills');
    const refs = join(skillsDir, 'reversa-docs-publisher', 'references');
    mkdirSync(refs, { recursive: true });
    writeFileSync(
      join(refs, 'vendor-pins.yaml'),
      [
        'libs:',
        '  d3:',
        '    files:',
        '      - url: "https://127.0.0.1:1/d3.min.js"',
        '        local: "assets/vendor/d3.min.js"',
        '',
      ].join('\n'),
    );

    const realDocs = PIPELINES.docs;
    PIPELINES.docs = {
      label: 'docs vendor',
      stages: [
        agentStage({
          id: 'docs-vendor',
          label: 'Vendor',
          kind: 'controller',
          handler: 'docs-vendor',
          failPipeline: false,
        }),
      ],
    };
    try {
      const result = await runPipeline({
        cwd: dir,
        pipeline: 'docs',
        answers: {},
        skillsDir,
        skillIndex: new Map(),
        runSubagent: async () => fakeResult(),
      });

      const stage = result.stages[0];
      assert.equal(stage.status, 'done', 'partial vendor must not fail the stage');
      assert.match(stage.reason, /vendor parcial/, 'the reason must reach the report');
      assert.match(result.report, /vendor parcial/);

      const docsState = JSON.parse(readFileSync(join(dir, '.specs', 'docs', '.state.json'), 'utf8'));
      assert.deepEqual(docsState.vendorMissing, ['assets/vendor/d3.min.js']);
      assert.equal(docsState.cdnFallbackUsed, false);
      assert.deepEqual(docsState.cdnFallbackDetails, []);
    } finally {
      PIPELINES.docs = realDocs;
    }
  });
});

for (const handler of ['docs-vendor', 'docs-smoke']) {
  test(`23 — a ${handler} sandbox violation blocks the run even when optional`, async () => {
    await withTempDir(async (dir) => {
      // Lexical containment already rejects `../escaped`, so the real vector is a
      // symlinked docs folder: `.specs/docs` resolves outside the project and only
      // the guard's canonical (symlink-resolving) gate catches it. Both handlers
      // write through the guard — docs-vendor mkdirs the root, docs-smoke
      // persists `.state.json` telemetry — so the throw originates inside
      // runControllerStage either way.
      const outside = mkdtempSync(join(tmpdir(), 'reversa-escape-'));
      mkdirSync(join(dir, '.specs'), { recursive: true });
      symlinkSync(outside, join(dir, '.specs', 'docs'), 'dir');
      // docs-smoke reaches its telemetry write only after smoking a real page.
      writeFileSync(join(outside, 'index.html'), '<html><body>ok</body></html>');

      const realDocs = PIPELINES.docs;
      PIPELINES.docs = {
        label: 'docs sandbox',
        stages: [
          // Optional + failPipeline:false: an ordinary failure would be tolerated,
          // so only sandbox-specific handling can produce `blocked`.
          agentStage({
            id: handler,
            label: handler,
            kind: 'controller',
            handler,
            optional: true,
            failPipeline: false,
          }),
          agentStage({ id: 'after', skill: 'a', label: 'After' }),
        ],
      };
      try {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        let afterRan = false;
        const result = await runPipeline({
          cwd: dir,
          pipeline: 'docs',
          answers: {},
          skillsDir: join(dir, 'skills'),
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          runSubagent: async () => {
            afterRan = true;
            return fakeResult();
          },
        });

        assert.equal(result.status, 'blocked', 'a sandbox violation is never a tolerable failure');
        assert.equal(result.aborted, true);
        assert.equal(afterRan, false, 'the run must stop at the violating controller');
        assert.ok(result.warnings.some((warning) => /violação de sandbox/.test(warning)));
        assert.ok(
          result.stages.some((stage) => /sandbox:/.test(stage.reason ?? '')),
          'the violating controller must report the sandbox reason',
        );
        assert.equal(
          existsSync(join(outside, '.state.json')),
          false,
          'no telemetry may land outside the sandbox',
        );
      } finally {
        PIPELINES.docs = realDocs;
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
}

test('24 — acquireExclusiveLock refuses to create a lock outside the project', async () => {
  await withTempDir(async (dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'reversa-lock-escape-'));
    try {
      symlinkSync(outside, join(dir, '.reversa'), 'dir');

      // Both locks live under `.reversa/`, so a symlinked `.reversa` sends them
      // outside the project — and the automation lock is taken BEFORE any
      // pipeline sandbox validation, so only the lock's own gate can stop it.
      for (const lockPath of [automationLockPath(dir), indexLockPath(dir)]) {
        assert.throws(
          () => acquireExclusiveLock(lockPath, { label: 'reversa automation', containRoot: dir }),
          WriteOutsideSandboxError,
          `${lockPath} must be rejected`,
        );
      }

      // Rejection must happen before any mkdir: nothing may be materialized.
      assert.deepEqual(readdirSync(outside), [], 'no directory may be created outside');

      // A contained lock still works normally.
      rmSync(join(dir, '.reversa'));
      const release = acquireExclusiveLock(automationLockPath(dir), { containRoot: dir });
      assert.equal(existsSync(join(dir, '.reversa', 'automation.lock')), true);
      release();
      assert.equal(existsSync(join(dir, '.reversa', 'automation.lock')), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

for (const nested of ['cache', 'context', 'runs']) {
  test(`25 — a symlinked .reversa/${nested} blocks the run and writes nothing outside`, async () => {
    await withTempDir(async (dir) => {
      const outside = mkdtempSync(join(tmpdir(), 'reversa-nested-escape-'));
      try {
        // `.reversa` itself is a real directory here: the escape is one level
        // deeper, past the automation lock's containment check. Code intel
        // creates these paths before any stage runs, so an unguarded write
        // would land outside while the pipeline merely warned and continued.
        mkdirSync(join(dir, '.reversa'), { recursive: true });
        symlinkSync(outside, join(dir, '.reversa', nested), 'dir');

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

        assert.equal(result.status, 'blocked', 'a sandbox violation must stop the pipeline');
        assert.equal(result.aborted, true);
        assert.equal(launched, false, 'no stage may run after the violation');
        assert.ok(result.warnings.some((warning) => /violação de sandbox/.test(warning)));
        assert.deepEqual(
          readdirSync(outside),
          [],
          'the outside directory must remain completely unchanged',
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
}

test('26 — buildCbmEnv refuses a symlinked .reversa/cache before creating anything', async () => {
  await withTempDir(async (dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'reversa-cbm-escape-'));
    try {
      mkdirSync(join(dir, '.reversa'), { recursive: true });
      symlinkSync(outside, join(dir, '.reversa', 'cache'), 'dir');

      // Direct unit check: the pipeline-level test only reaches this code when
      // codebase-memory is installed, so assert the guard itself here.
      assert.throws(() => buildCbmEnv(dir), WriteOutsideSandboxError);
      assert.deepEqual(readdirSync(outside), [], 'rejection must precede any mkdir');

      // A contained cache dir still works.
      rmSync(join(dir, '.reversa', 'cache'));
      const env = buildCbmEnv(dir);
      assert.equal(existsSync(env.CBM_CACHE_DIR), true);
      assert.ok(containsPath(dir, env.CBM_CACHE_DIR));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('27 — materializeContextBundle refuses a symlinked .reversa/context', async () => {
  await withTempDir(async (dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'reversa-ctx-escape-'));
    try {
      mkdirSync(join(dir, '.reversa'), { recursive: true });
      symlinkSync(outside, join(dir, '.reversa', 'context'), 'dir');

      assert.throws(
        () => materializeContextBundle({ projectRoot: dir, architecture: { ok: true } }),
        WriteOutsideSandboxError,
      );
      assert.deepEqual(readdirSync(outside), [], 'rejection must precede any mkdir');

      rmSync(join(dir, '.reversa', 'context'));
      const bundle = materializeContextBundle({ projectRoot: dir, architecture: { ok: true } });
      assert.ok(containsPath(dir, bundle.root));
      assert.equal(existsSync(bundle.root), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('28 — a late .reversa/runs swap yields a blocked result, not a rejection', async () => {
  await withTempDir(async (dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'reversa-late-escape-'));
    try {
      const total = PIPELINES.discovery.stages.length;
      // The quality gate is the last stage and must pass, otherwise the run
      // ends `failed` before the final stage's progress event ever fires.
      // Present-but-empty layers satisfy presence with zero unresolved findings.
      const reviewDir = join(dir, '.specs', 'discovery', 'review');
      mkdirSync(reviewDir, { recursive: true });
      for (const file of [
        'evidence-initial.jsonl',
        'structural-findings.jsonl',
        'adversarial-findings.jsonl',
        'coverage-findings.jsonl',
        'domain-findings.jsonl',
        'consistency-findings.jsonl',
        'evidence-final.jsonl',
        'resolution.jsonl',
      ]) {
        writeFileSync(join(reviewDir, file), `${JSON.stringify({ id: file })}\n`);
      }
      writeFileSync(
        join(reviewDir, 'resolution.jsonl'),
        `${['evidence-initial.jsonl', 'structural-findings.jsonl', 'adversarial-findings.jsonl', 'coverage-findings.jsonl', 'domain-findings.jsonl', 'consistency-findings.jsonl', 'evidence-final.jsonl'].map((file) => JSON.stringify({ id: file })).join('\n')}\n`,
      );
      let stagesRun = 0;
      let swappedAt = null;
      // The swap must land AFTER the last stage finishes: any earlier and the
      // violation is caught by an ordinary stage write (scout.md), leaving the
      // final `run.json` catch — the path under test — unexercised.
      const result = await runPipeline({
        cwd: dir,
        pipeline: 'discovery',
        answers: {},
        skillIndex: discoverySkillIndex(dir),
        runSubagent: satisfyingSubagent(dir, {
          onStage: () => {
            stagesRun += 1;
            return fakeResult();
          },
        }),
        onProgress: (event) => {
          if (event.status !== 'done' || event.index !== event.total) return;
          const runsRoot = join(dir, '.reversa', 'runs');
          rmSync(runsRoot, { recursive: true, force: true });
          symlinkSync(outside, runsRoot, 'dir');
          swappedAt = event.index;
        },
      });

      assert.equal(swappedAt, total, 'the swap must fire on the final stage only');
      assert.ok(stagesRun > 0, 'the swap must happen after real work, not before');
      assert.ok(
        result.stages.every((stage) => stage.status !== 'failed'),
        'every stage must finish cleanly; the only violation is the run.json write',
      );
      assert.equal(result.status, 'blocked', 'a late violation must not surface as success');
      assert.equal(result.aborted, true);
      const sandboxWarnings = result.warnings.filter((warning) => /violação de sandbox/.test(warning));
      assert.equal(sandboxWarnings.length, 1, 'exactly one violation: the final run.json write');
      assert.match(sandboxWarnings[0], /run\.json/);
      assert.match(result.report, /sandbox/i, 'the report must reflect the blocked status');
      assert.deepEqual(readdirSync(outside), [], 'run.json must never land outside');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fan-out progress reporting
// ---------------------------------------------------------------------------

test('29 — each shard reports as it settles, not in a batch at the end of the stage', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['auth', 'orders', 'billing'] }),
    );
    await withPipeline(
      '__t_progress',
      {
        label: 'shard progress',
        stages: [agentStage({ id: 'arch', skill: 'a', label: 'Arch', fanOut: 'modules' })],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const events = [];
        // Concurrency 1 makes the interleaving deterministic: with batching at
        // the end, every `done` would land after the last shard's `running`.
        let running = 0;
        await runPipeline({
          cwd: dir,
          pipeline: '__t_progress',
          answers: {},
          concurrency: 1,
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          runSubagent: async () => {
            running += 1;
            return fakeResult();
          },
          onProgress: (event) => events.push({ ...event, observedRunning: running }),
        });

        const shardEvents = events.filter((event) => event.runKey);
        const first = shardEvents.find((event) => event.status === 'done');
        assert.ok(first, 'a shard must report done');
        assert.equal(
          first.observedRunning,
          1,
          'the first done must arrive while only one subagent has run, not after all three',
        );

        // Identity: a renderer must be able to key rows without parsing labels.
        assert.deepEqual(
          shardEvents.filter((event) => event.status === 'done').map((event) => event.item),
          ['auth', 'orders', 'billing'],
        );
        assert.deepEqual(
          shardEvents.filter((event) => event.status === 'done').map((event) => event.runKey),
          ['arch:auth', 'arch:orders', 'arch:billing'],
        );
        assert.ok(shardEvents.every((event) => event.stageId === 'arch'));

        // Aggregate counter advances monotonically and ends complete.
        assert.deepEqual(
          shardEvents.filter((event) => event.status === 'done').map((event) => event.runsDone),
          [1, 2, 3],
        );
        assert.ok(shardEvents.every((event) => event.runs === 3));

        // Every shard announces itself before doing work.
        assert.deepEqual(
          shardEvents.filter((event) => event.status === 'running' && !event.tool).map((event) => event.item),
          ['auth', 'orders', 'billing'],
        );
      },
    );
  });
});

test('30 — subagent tool activity reaches onProgress and is throttled', async () => {
  await withTempDir(async (dir) => {
    await withPipeline(
      '__t_activity',
      {
        label: 'shard activity',
        stages: [agentStage({ id: 'solo', skill: 'a', label: 'Solo' })],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const events = [];
        await runPipeline({
          cwd: dir,
          pipeline: '__t_activity',
          answers: {},
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          // The orchestrator must forward `onEvent`; without it the child's
          // activity is invisible and this test sees no tool events at all.
          runSubagent: async ({ onEvent }) => {
            assert.equal(typeof onEvent, 'function', 'onEvent must be forwarded to the child');
            for (let call = 0; call < 5; call += 1) onEvent({ type: 'tool_execution_start', name: 'read' });
            onEvent({ type: 'message_end', tokens: 0 });
            return fakeResult();
          },
          onProgress: (event) => events.push(event),
        });

        // Five rapid calls collapse to one immediate beat plus the pre-terminal
        // flush — never five. The flush is what keeps the last state visible.
        const activity = events.filter((event) => event.tool);
        assert.equal(activity.length, 2, 'one throttled beat plus one flush, not five');
        assert.ok(activity.every((event) => event.tool === 'read'));
        assert.ok(activity.every((event) => event.status === 'running'));
        assert.deepEqual(activity.map((event) => event.toolCalls), [1, 5], 'the flush carries the final count');

        // The count is never lost, even when the heartbeat is suppressed.
        const settled = events.find((event) => event.status === 'done' && event.runKey);
        assert.equal(settled.toolCalls, 5);
      },
    );
  });
});

test('31 — shards cancelled before launch are still reported exactly once', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.reversa', 'context'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'context', 'surface.json'),
      JSON.stringify({ modules: ['m1', 'm2', 'm3', 'm4'] }),
    );
    await withPipeline(
      '__t_cancelled',
      {
        label: 'cancelled shards',
        stages: [agentStage({ id: 'arch', skill: 'a', label: 'Arch', fanOut: 'modules' })],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const events = [];
        const result = await runPipeline({
          cwd: dir,
          pipeline: '__t_cancelled',
          answers: {},
          concurrency: 1,
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          runSubagent: async () =>
            fakeResult({ violations: [{ message: 'refusing to write outside allowed roots' }] }),
          onProgress: (event) => events.push(event),
        });
        assert.equal(result.status, 'blocked');

        // No shard may be announced twice: launched ones report themselves,
        // never-launched ones are swept up after withConcurrency returns.
        const settled = events.filter(
          (event) => event.runKey && event.status !== 'running',
        );
        assert.equal(new Set(settled.map((event) => event.runKey)).size, settled.length, 'no duplicate reports');
        assert.equal(settled.length, 4, 'every shard is accounted for');
        assert.equal(settled.filter((event) => event.status === 'skipped').length, 3);

        // The counter must reach the total: a stop at 1/4 that renders "1/4
        // runs" forever is exactly the frozen-progress bug.
        assert.deepEqual(settled.map((event) => event.runsDone), [1, 2, 3, 4]);
        assert.equal(settled.at(-1).runsDone, settled.at(-1).runs);

        // Cancelled shards must name their own item, not the bare stage label.
        for (const event of settled.filter((entry) => entry.status === 'skipped')) {
          assert.equal(event.stage, `Arch — ${event.item}`);
          assert.ok(['m2', 'm3', 'm4'].includes(event.item));
        }
      },
    );
  });
});

test('32 — accumulated tokens reach the UI while the child is still running', async () => {
  await withTempDir(async (dir) => {
    await withPipeline(
      '__t_tokens',
      {
        label: 'live tokens',
        stages: [agentStage({ id: 'solo', skill: 'a', label: 'Solo' })],
      },
      async () => {
        const skillPath = join(dir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: x\n---\nBody');
        const events = [];
        /** Resolves the child only after the assertions below have run. */
        let releaseChild;
        const childBlocked = new Promise((resolve) => { releaseChild = resolve; });
        /** Resolves once the child has emitted its two messages. */
        let emitted;
        const childEmitted = new Promise((resolve) => { emitted = resolve; });

        const run = runPipeline({
          cwd: dir,
          pipeline: '__t_tokens',
          answers: {},
          skillIndex: new Map([['a', { path: skillPath, baseDir: dir }]]),
          runSubagent: async ({ onEvent }) => {
            // Back to back inside one throttle window: the second beat is
            // suppressed, so only a trailing timer can surface the sum.
            onEvent({ type: 'message_end', tokens: 800 });
            onEvent({ type: 'message_end', tokens: 1300 });
            // No usage: must not emit anything new.
            onEvent({ type: 'message_end' });
            emitted();
            // The child stays pending: anything asserted below happened while
            // the subagent was still working, which is the whole contract.
            await childBlocked;
            return fakeResult({ usage: { total: 2100 } });
          },
          onProgress: (event) => events.push(event),
        });

        await childEmitted;
        const liveTotal = await waitFor(
          () => events.find((event) => event.status === 'running' && event.tokens === 2100),
          'accumulated tokens must repaint while the child runs, not after it returns',
        );

        // Proven live: the shard has not settled yet.
        assert.equal(
          events.some((event) => event.status === 'done'),
          false,
          'no terminal event may have fired yet',
        );
        assert.ok(
          events.some((event) => event.status === 'running' && event.tokens === 800),
          'the first message is visible immediately (leading edge)',
        );
        assert.equal(liveTotal.runKey, 'solo');

        releaseChild();
        await run;

        // Live total and authoritative total agree; no double counting.
        const settled = events.find((event) => event.status === 'done' && event.runKey);
        assert.equal(settled.tokens, 2100);
        assert.ok(
          events.indexOf(liveTotal) < events.indexOf(settled),
          'the live repaint precedes the terminal event',
        );
      },
    );
  });
});
