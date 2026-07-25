import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXTENSIONS_DIR = join(process.cwd(), 'extensions');

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('extension source never reaches into host subagent machinery', () => {
  const forbidden = [
    'pi-subagents',
    '.pi/agents',
    'subagents.json',
    'agent/chains',
  ];

  for (const file of sourceFiles(EXTENSIONS_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      assert.ok(!source.includes(needle), `${file} must not reference ${needle}`);
    }
  }
});

test('package declares no agents block and only allowed runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  assert.equal(pkg.pi.agents, undefined, 'pi.agents would expose Reversa agents to the host mechanism');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['codebase-memory-mcp', 'reversa']);
  assert.deepEqual(Object.keys(pkg.peerDependencies), ['@earendil-works/pi-coding-agent']);
  assert.equal(pkg.dependencies['pi-subagents'], undefined);
});

test('extensions/ ships no agents directory', () => {
  const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  assert.ok(!entries.some((entry) => entry.isDirectory() && entry.name === 'agents'));
});
