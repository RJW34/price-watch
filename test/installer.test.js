import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const installer = fileURLToPath(new URL('../scripts/Install-PriceWatch.ps1', import.meta.url));
const install = async (target, previous) => {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Destination', target, '-NonInteractive', '-NoShortcuts', '-SkipNodeCheck'];
  if (previous) args.push('-PreviousInstall', previous);
  return execFile('powershell.exe', args, { timeout: 30000 });
};

test('Windows installer migrates old settings and history and removes recognized program files', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'price-watch-install-'));
  const old = join(root, 'old'), target = join(root, 'installed');
  try {
    await mkdir(join(old, 'src'), { recursive: true });
    await writeFile(join(old, 'package.json'), '{"name":"speaker-watch"}');
    await writeFile(join(old, 'src', 'watcher.js'), 'old program');
    await writeFile(join(old, 'src', 'cli.js'), 'old cli');
    await writeFile(join(old, 'config.json'), 'saved config');
    await writeFile(join(old, '.speaker-watch-state.json'), 'saved history');
    await writeFile(join(old, 'personal-notes.txt'), 'keep me');
    await install(target, old);
    assert.equal(await readFile(join(target, 'config.json'), 'utf8'), 'saved config');
    assert.equal(await readFile(join(target, '.speaker-watch-state.json'), 'utf8'), 'saved history');
    await assert.rejects(readFile(join(old, 'src', 'watcher.js')), { code: 'ENOENT' });
    assert.equal(await readFile(join(old, 'personal-notes.txt'), 'utf8'), 'keep me');
    await writeFile(join(target, 'personal-notes.txt'), 'another note');
    await install(target);
    assert.equal(await readFile(join(target, 'config.json'), 'utf8'), 'saved config');
    const backups = (await readdir(root)).filter(name => name.startsWith('installed.previous-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(root, backups[0], 'personal-notes.txt'), 'utf8'), 'another note');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer refuses an unrecognized previous folder', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'price-watch-install-'));
  try {
    const old = join(root, 'personal'); await mkdir(old);
    await writeFile(join(old, 'notes.txt'), 'keep me');
    await assert.rejects(install(join(root, 'installed'), old));
    assert.equal(await readFile(join(old, 'notes.txt'), 'utf8'), 'keep me');
  } finally { await rm(root, { recursive: true, force: true }); }
});
