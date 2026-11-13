import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate } from '../src/updater.js';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);

function fakeGit({ dirty = false, origin = 'https://github.com/RJW34/price-watch.git', branch = 'master', oldHead = 'old', newHead = 'new', diverged = false, secondDirty = false } = {}) {
  const calls = []; let statusCount = 0;
  const runGit = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return 'C:/price-watch-test';
    if (args[0] === 'remote') return origin;
    if (args[0] === 'branch') return branch;
    if (args[0] === 'status') return (++statusCount === 1 ? dirty : secondDirty) ? ' M file' : '';
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? oldHead : newHead;
    if (args[0] === 'merge-base' && diverged) throw new Error('diverged');
    return '';
  };
  return { runGit, calls };
}

test('updates a clean official checkout using fast-forward only', async () => {
  const fake = fakeGit();
  const result = await checkForUpdate({ cwd: 'C:/price-watch-test', runGit: fake.runGit });
  assert.equal(result.status, 'updated');
  assert.ok(fake.calls.includes('merge --ff-only --no-overwrite-ignore FETCH_HEAD'));
});

test('never updates dirty, unofficial, different-branch or diverged checkouts', async () => {
  for (const options of [{ dirty: true }, { origin: 'https://example.com/fork.git' }, { branch: 'feature' }, { diverged: true }, { secondDirty: true }]) {
    const fake = fakeGit(options);
    assert.equal((await checkForUpdate({ cwd: 'C:/price-watch-test', runGit: fake.runGit })).status, 'skipped');
    assert.equal(fake.calls.some(call => call.startsWith('merge --ff-only')), false);
  }
});

test('reports already current and handles missing Git without stopping the watcher', async () => {
  const fake = fakeGit({ oldHead: 'same', newHead: 'same' });
  assert.equal((await checkForUpdate({ cwd: 'C:/price-watch-test', runGit: fake.runGit })).status, 'current');
  const result = await checkForUpdate({ cwd: 'C:/price-watch-test', runGit: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.equal(result.status, 'skipped');
});

test('selects ZIP updating without running Git for an extracted installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'price-watch-zip-detect-'));
  try {
    let called = false;
    const result = await checkForUpdate({ cwd: dir, runZip: async ({ cwd }) => { called = cwd === dir; return { status: 'current' }; } });
    assert.equal(called, true);
    assert.equal(result.status, 'current');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fast-forwards a real Git checkout while preserving ignored settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'price-watch-update-'));
  const remote = join(dir, 'remote.git'), source = join(dir, 'source'), installed = join(dir, 'installed');
  const run = async (cwd, ...args) => (await execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, windowsHide: true })).stdout.trim();
  try {
    await run(dir, 'init', '--bare', '--initial-branch=master', remote);
    await mkdir(source);
    await run(source, 'init', '--initial-branch=master');
    await writeFile(join(source, '.gitignore'), 'config.json\n');
    await writeFile(join(source, 'program.txt'), 'v1');
    await run(source, 'add', '.');
    await run(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'v1');
    await run(source, 'remote', 'add', 'origin', remote);
    await run(source, 'push', '-u', 'origin', 'master');
    await run(dir, 'clone', remote, installed);
    await writeFile(join(installed, 'config.json'), 'personal settings');
    await writeFile(join(source, 'program.txt'), 'v2');
    await run(source, 'add', '.');
    await run(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'v2');
    await run(source, 'push');
    const runGit = async (args, cwd) => args.join(' ') === 'remote get-url origin' ? 'https://github.com/RJW34/price-watch.git' : run(cwd, ...args);
    assert.equal((await checkForUpdate({ cwd: installed, runGit })).status, 'updated');
    assert.equal(await readFile(join(installed, 'program.txt'), 'utf8'), 'v2');
    assert.equal(await readFile(join(installed, 'config.json'), 'utf8'), 'personal settings');
    await writeFile(join(source, 'config.json'), 'upstream settings');
    await run(source, 'add', '-f', 'config.json');
    await run(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'add config');
    await run(source, 'push');
    assert.equal((await checkForUpdate({ cwd: installed, runGit })).status, 'skipped');
    assert.equal(await readFile(join(installed, 'config.json'), 'utf8'), 'personal settings');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runner restarts its worker after an installed update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'price-watch-runner-'));
  try {
    const runner = await readFile(fileURLToPath(new URL('../src/runner.js', import.meta.url)), 'utf8');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'runner.js'), runner);
    await writeFile(join(dir, 'zip-updater.js'), 'export async function recoverZipUpdate() {}');
    await writeFile(join(dir, 'cli.js'), "import { existsSync, writeFileSync } from 'node:fs'; if (!existsSync('restarted')) { writeFileSync('restarted','yes'); process.exitCode=75; } else console.log('new worker started');");
    const result = await execFile(process.execPath, [join(dir, 'runner.js')], { cwd: dir, timeout: 10000 });
    assert.match(result.stdout, /Restarting Price Watch/);
    assert.match(result.stdout, /new worker started/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
