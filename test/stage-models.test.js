import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PIPELINES, reviewStages } from '../extensions/lib/pipelines.js';
import {
  countStageOverrides,
  formatModelRef,
  parseModelRef,
  readStageModels,
  resolveStageModels,
  writeStageModels,
} from '../extensions/lib/stage-models.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'reversa-models-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Registry stub: resolves anything, echoing the parsed reference back. */
const echoRegistry = { find: (provider, id) => ({ provider, id, name: `${provider}:${id}` }) };

/**
 * `assert.deepEqual` compares prototypes, and the config maps are deliberately
 * null-prototype. Compare the data, and assert the prototype separately where
 * it is the thing under test.
 */
const assertConfig = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

test('parseModelRef splits on the first slash only', () => {
  assert.deepEqual(parseModelRef('anthropic/claude-opus-4-5'), { provider: 'anthropic', id: 'claude-opus-4-5' });
  assert.deepEqual(parseModelRef('openrouter/openai/gpt-5'), { provider: 'openrouter', id: 'openai/gpt-5' });
  assert.equal(parseModelRef('bogus'), null);
  assert.equal(parseModelRef('/leading'), null);
  assert.equal(parseModelRef('trailing/'), null);
  assert.equal(parseModelRef(undefined), null);
  assert.equal(formatModelRef({ provider: 'openrouter', id: 'openai/gpt-5' }), 'openrouter/openai/gpt-5');
});

test('writeStageModels round-trips without touching other config sections', async () => {
  await withTempDir((dir) => {
    const configPath = join(dir, '.reversa', 'config.toml');
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    writeFileSync(configPath, '[specs]\ngranularity = "module"\n');

    writeStageModels(dir, {
      default: 'anthropic/claude-sonnet-4-5',
      pipelines: { discovery: { 'review-structural': 'anthropic/claude-opus-4-5' } },
    });

    const written = readFileSync(configPath, 'utf8');
    assert.match(written, /\[specs\]\ngranularity = "module"/);
    assert.match(written, /\[models\]\ndefault = "anthropic\/claude-sonnet-4-5"/);
    assert.match(written, /\[models\.discovery\]\nreview-structural = "anthropic\/claude-opus-4-5"/);

    assertConfig(readStageModels(dir), {
      default: 'anthropic/claude-sonnet-4-5',
      review: null,
      pipelines: { discovery: { 'review-structural': 'anthropic/claude-opus-4-5' } },
    });

    // Dropping the last override removes the whole table, [specs] survives.
    writeStageModels(dir, { default: 'anthropic/claude-sonnet-4-5', pipelines: {} });
    const pruned = readFileSync(configPath, 'utf8');
    assert.doesNotMatch(pruned, /\[models\.discovery\]/);
    assert.match(pruned, /\[specs\]\ngranularity = "module"/);
    assert.match(pruned, /\[models\]/);

    // Emptying everything leaves only the untouched sections.
    writeStageModels(dir, { default: null, pipelines: {} });
    assert.equal(readFileSync(configPath, 'utf8'), '[specs]\ngranularity = "module"\n');
    assertConfig(readStageModels(dir), { default: null, review: null, pipelines: {} });
  });
});

test('readStageModels on a missing file yields a fresh empty config', async () => {
  await withTempDir((dir) => {
    const first = readStageModels(dir);
    assertConfig(first, { default: null, review: null, pipelines: {} });
    first.pipelines.discovery = { scout: 'a/b' };
    assertConfig(readStageModels(dir), { default: null, review: null, pipelines: {} }, 'must not share mutable state');
  });
});

test('readStageModels drops entries that are not model references', async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'config.toml'),
      [
        '[models]',
        '# a comment',
        'default = "anthropic/opus"',
        'bogus = 1',
        '',
        '[models.discovery]',
        'scout = "openrouter/openai/gpt-5"',
        'broken = "noslash"',
        '',
        '[specs]',
        'granularity = "module"',
        '',
      ].join('\n'),
    );

    assertConfig(readStageModels(dir), {
      default: 'anthropic/opus',
      review: null,
      pipelines: { discovery: { scout: 'openrouter/openai/gpt-5' } },
    });
  });
});

test('resolveStageModels applies stage > pipeline default > global default', () => {
  const config = {
    default: 'a/x',
    pipelines: { discovery: { default: 'b/y', 'review-structural': 'c/z' } },
  };

  const discovery = resolveStageModels({
    config,
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: echoRegistry,
  });

  assert.equal(discovery.labels['review-structural'], 'c/z');
  assert.equal(discovery.labels.scout, 'b/y');
  assert.deepEqual(discovery.models['review-structural'], { provider: 'c', id: 'z', name: 'c:z' });
  assert.equal('preflight' in discovery.labels, false, 'controller stages never run a model');
  assert.equal('quality-gate' in discovery.labels, false);
  assert.deepEqual(discovery.warnings, []);

  const migrate = resolveStageModels({
    config,
    pipeline: 'migrate',
    stages: PIPELINES.migrate.stages,
    registry: echoRegistry,
  });
  assert.equal(migrate.labels.strategist, 'a/x', 'a pipeline with no table falls back to the global default');
});

test('resolveStageModels degrades to the session model when a reference is unknown', () => {
  const resolved = resolveStageModels({
    config: { default: null, pipelines: { discovery: { scout: 'ghost/model' } } },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: { find: () => undefined },
  });

  assert.equal('scout' in resolved.models, false);
  assert.equal('scout' in resolved.labels, false);
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /ghost\/model/);
  assert.match(resolved.warnings[0], /scout/);
});

test('resolveStageModels warns once about an unknown stage key', () => {
  const resolved = resolveStageModels({
    config: { default: null, pipelines: { discovery: { nope: 'a/x' } } },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: echoRegistry,
  });

  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /`nope`/);
  assert.deepEqual(resolved.labels, {});
});

test('resolveStageModels without a registry is warning-only and never throws', () => {
  const withEntries = resolveStageModels({
    config: { default: 'a/x', pipelines: {} },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: null,
  });
  assert.deepEqual(withEntries.models, {});
  assert.equal(withEntries.warnings.length, 1);
  assert.match(withEntries.warnings[0], /registry de modelos indisponível/);

  const empty = resolveStageModels({
    config: { default: null, pipelines: {} },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: null,
  });
  assert.deepEqual(empty, { models: {}, labels: {}, warnings: [] }, 'no config means no noise');
});

test('countStageOverrides excludes the group keys', () => {
  const config = {
    default: null,
    pipelines: { discovery: { default: 'a/x', review: 'r/r', scout: 'b/y', writer: 'c/z' } },
  };
  assert.equal(countStageOverrides(config, 'discovery'), 2);
  assert.equal(countStageOverrides(config, 'migrate'), 0);
});

test('review stages are tagged in every pipeline', () => {
  // Hardcoded on purpose: an upstream workflow change must force a maintainer
  // decision instead of silently reshaping the group.
  assert.deepEqual(reviewStages('discovery').map((stage) => stage.id), [
    'evidence-audit-initial',
    'review-structural',
    'review-adversarial',
    'review-coverage',
    'review-domain',
    'review-consistency',
    'adjudicate',
    'evidence-audit-final',
    'regression-check',
  ]);
  assert.deepEqual(reviewStages('migrate').map((stage) => stage.id), ['inspector']);
  assert.deepEqual(reviewStages('docs'), []);
});

test('no stage id collides with a reserved group key', () => {
  for (const [pipeline, { stages }] of Object.entries(PIPELINES)) {
    for (const stage of stages) {
      assert.ok(
        stage.id !== 'default' && stage.id !== 'review',
        `${pipeline}/${stage.id} shadows a reserved group key`,
      );
    }
  }
});

test('resolveStageModels applies stage > pipeline review > pipeline default > global review > global default', () => {
  const scoped = resolveStageModels({
    config: {
      default: 'g/def',
      review: 'g/rev',
      pipelines: { discovery: { default: 'p/def', review: 'p/rev', 'review-structural': 's/own' } },
    },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: echoRegistry,
  });

  assert.equal(scoped.labels['review-structural'], 's/own');
  assert.equal(scoped.labels.adjudicate, 'p/rev');
  assert.equal(scoped.labels['regression-check'], 'p/rev');
  assert.equal(scoped.labels.scout, 'p/def');
  assert.deepEqual(scoped.warnings, []);

  // Without a pipeline table, the global group key still beats the global default.
  const global = resolveStageModels({
    config: { default: 'g/def', review: 'g/rev', pipelines: {} },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: echoRegistry,
  });
  assert.equal(global.labels.adjudicate, 'g/rev');
  assert.equal(global.labels.scout, 'g/def');
});

test('a review key on a pipeline without review stages warns instead of silently doing nothing', () => {
  const resolved = resolveStageModels({
    config: { default: null, review: null, pipelines: { docs: { review: 'a/x' } } },
    pipeline: 'docs',
    stages: PIPELINES.docs.stages,
    registry: echoRegistry,
  });

  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /docs/);
  assert.match(resolved.warnings[0], /review/);
  assert.deepEqual(resolved.labels, {});
});

test('the review group is not reported as an unknown stage key', () => {
  const resolved = resolveStageModels({
    config: { default: null, review: null, pipelines: { discovery: { review: 'a/x' } } },
    pipeline: 'discovery',
    stages: PIPELINES.discovery.stages,
    registry: echoRegistry,
  });

  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.labels.adjudicate, 'a/x');
});

test('writeStageModels serializes group keys before stage keys', async () => {
  await withTempDir((dir) => {
    writeStageModels(dir, {
      default: 'a/x',
      review: 'b/y',
      pipelines: { discovery: { scout: 'c/z', review: 'd/w', default: 'e/v' } },
    });

    const written = readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8');
    assert.match(written, /\[models\]\ndefault = "a\/x"\nreview = "b\/y"/);
    assert.match(written, /\[models\.discovery\]\ndefault = "e\/v"\nreview = "d\/w"\nscout = "c\/z"/);

    assertConfig(readStageModels(dir), {
      default: 'a/x',
      review: 'b/y',
      pipelines: { discovery: { default: 'e/v', review: 'd/w', scout: 'c/z' } },
    });
  });
});

test('inherited section and stage names never mutate Object.prototype', async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, '.reversa'), { recursive: true });
    writeFileSync(
      join(dir, '.reversa', 'config.toml'),
      [
        '[models.__proto__]',
        'pwned = "a/x"',
        '',
        '[models.constructor]',
        'pwned2 = "a/x"',
        '',
        '[models.toString]',
        'pwned3 = "a/x"',
        '',
        '[models.discovery]',
        '__proto__ = "a/x"',
        'constructor = "a/x"',
        'scout = "b/y"',
        '',
      ].join('\n'),
    );

    try {
      const config = readStageModels(dir);

      assert.equal({}.pwned, undefined, 'a [models.__proto__] table must not reach Object.prototype');
      assert.equal({}.pwned2, undefined);
      assert.equal({}.pwned3, undefined);
      // `toString` is a legal TOML bare key; harmless as an own key on a
      // null-prototype map, so it survives — `__proto__` and `constructor` do not.
      assert.deepEqual(Object.keys(config.pipelines), ['toString', 'discovery']);
      assertConfig(config.pipelines.discovery, { scout: 'b/y' }, 'inherited stage keys are dropped');
      assert.equal(Object.getPrototypeOf(config.pipelines), null);
      assert.equal(Object.getPrototypeOf(config.pipelines.discovery), null);

      // The sanitized config round-trips and stays JSON-renderable
      // (`/reversa-models` prints it verbatim in headless mode). The inert
      // `toString` table survives as ordinary data; the dangerous ones are gone.
      writeStageModels(dir, config);
      const written = readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8');
      assert.equal(written, '[models.discovery]\nscout = "b/y"\n\n[models.toString]\npwned3 = "a/x"\n');
      assert.doesNotMatch(written, /__proto__|constructor/);
      assert.equal(
        JSON.stringify(readStageModels(dir)),
        '{"default":null,"review":null,"pipelines":{"discovery":{"scout":"b/y"},"toString":{"pwned3":"a/x"}}}',
      );
    } finally {
      delete Object.prototype.pwned;
      delete Object.prototype.pwned2;
      delete Object.prototype.pwned3;
    }
  });
});

test('a hostile caller-supplied config neither serializes nor resolves inherited keys', async () => {
  await withTempDir((dir) => {
    // Plain objects, as any in-memory caller (or a test) would build them.
    const hostile = {
      default: null,
      pipelines: { discovery: { scout: 'b/y', 'evil]\ninjected': 'c/z' }, 'bad name': { scout: 'd/w' } },
    };

    writeStageModels(dir, hostile);
    assert.equal(
      readFileSync(join(dir, '.reversa', 'config.toml'), 'utf8'),
      '[models.discovery]\nscout = "b/y"\n',
      'keys that are not TOML bare keys must never reach the file',
    );

    // `toString` and `constructor` resolve off the prototype of a plain object;
    // an own-key read is what keeps them out of the resolution result.
    const resolved = resolveStageModels({
      config: { default: null, pipelines: { discovery: { scout: 'b/y' } } },
      pipeline: 'discovery',
      stages: [
        { id: 'scout', kind: 'agent' },
        { id: 'toString', kind: 'agent' },
        { id: 'constructor', kind: 'agent' },
      ],
      registry: echoRegistry,
    });
    assert.deepEqual(Object.keys(resolved.labels), ['scout']);

    // A pipeline name off the prototype chain must not look configured.
    assert.deepEqual(
      resolveStageModels({
        config: { default: null, pipelines: {} },
        pipeline: 'toString',
        stages: [{ id: 'scout', kind: 'agent' }],
        registry: echoRegistry,
      }),
      { models: {}, labels: {}, warnings: [] },
    );
    assert.equal(countStageOverrides({ default: null, pipelines: {} }, 'toString'), 0);
  });
});
