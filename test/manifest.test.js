import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('ZIP update manifest matches the packaged files', async () => {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const manifest = JSON.parse(await readFile(join(root, 'update-manifest.json'), 'utf8'));
  const names = ['README.md', 'ALERTS.md', 'config.example.json', 'package.json', 'start-watcher.ps1'];
  async function collect(dir) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error(`Unsupported entry: ${name}`);
    }
  }
  for (const dir of ['src', 'test', 'scripts']) await collect(dir);
  assert.deepEqual(Object.keys(manifest.files).sort(), names.sort(), 'ZIP update manifest file list is stale');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    assert.equal(actual, expected, `${name} changed; run npm run build:update-manifest`);
  }
});
