import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateZip, recoverZipUpdate } from '../src/zip-updater.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = files => JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, hash(contents)])) }, null, 2) + '\n';
const sha = 'a'.repeat(40);
const makeFetch = files => async url => {
  if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ sha }));
  const name = url.split(`/${sha}/`)[1];
  return Object.hasOwn(files, name) ? new Response(files[name]) : new Response('', { status: 404 });
};

test('updates an extracted ZIP without touching user settings or history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'price-watch-zip-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'cli.js'), 'old code');
    await writeFile(join(root, 'update-manifest.json'), manifest({ 'src/cli.js': 'old code' }));
    await writeFile(join(root, 'config.json'), 'private settings');
    await writeFile(join(root, '.price-watch-state.json'), 'alert history');
    const next = { 'src/cli.js': 'new code', 'src/new.js': 'new file' };
    const files = { ...next, 'update-manifest.json': manifest(next) };
    assert.equal((await updateZip({ cwd: root, fetchFn: makeFetch(files) })).status, 'updated');
    assert.equal(await readFile(join(root, 'src', 'cli.js'), 'utf8'), 'new code');
    assert.equal(await readFile(join(root, 'src', 'new.js'), 'utf8'), 'new file');
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'private settings');
    assert.equal(await readFile(join(root, '.price-watch-state.json'), 'utf8'), 'alert history');
    assert.equal((await updateZip({ cwd: root, fetchFn: makeFetch(files) })).status, 'current');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not overwrite a locally modified program file or a new-file collision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'price-watch-zip-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'cli.js'), 'edited');
    await writeFile(join(root, 'update-manifest.json'), manifest({ 'src/cli.js': 'old' }));
    const next = { 'src/cli.js': 'new', 'src/new.js': 'new file' };
    const fetchFn = makeFetch({ ...next, 'update-manifest.json': manifest(next) });
    assert.equal((await updateZip({ cwd: root, fetchFn })).status, 'skipped');
    assert.equal(await readFile(join(root, 'src', 'cli.js'), 'utf8'), 'edited');
    await writeFile(join(root, 'src', 'cli.js'), 'old');
    await writeFile(join(root, 'src', 'new.js'), 'personal file');
    assert.equal((await updateZip({ cwd: root, fetchFn })).status, 'skipped');
    assert.equal(await readFile(join(root, 'src', 'new.js'), 'utf8'), 'personal file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses corrupted downloads before replacing installed code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'price-watch-zip-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'cli.js'), 'old');
    await writeFile(join(root, 'update-manifest.json'), manifest({ 'src/cli.js': 'old' }));
    const files = { 'src/cli.js': 'tampered', 'update-manifest.json': manifest({ 'src/cli.js': 'expected' }) };
    assert.equal((await updateZip({ cwd: root, fetchFn: makeFetch(files) })).status, 'skipped');
    assert.equal(await readFile(join(root, 'src', 'cli.js'), 'utf8'), 'old');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers an interrupted install using its backup journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'price-watch-zip-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.price-watch-update', 'backup'), { recursive: true });
    await writeFile(join(root, 'src', 'cli.js'), 'new');
    await writeFile(join(root, '.price-watch-update', 'backup', hash('old')), 'old');
    await writeFile(join(root, '.price-watch-update', 'journal.json'), JSON.stringify({ version: 1, files: [{ path: 'src/cli.js', before: hash('old'), after: hash('new') }] }));
    await recoverZipUpdate(root);
    assert.equal(await readFile(join(root, 'src', 'cli.js'), 'utf8'), 'old');
  } finally { await rm(root, { recursive: true, force: true }); }
});
