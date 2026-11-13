import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { updateZip } from './zip-updater.js';

const execFile = promisify(execFileCallback);
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL_REMOTE = 'https://github.com/RJW34/price-watch';
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function git(args, cwd) {
  const { stdout } = await execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'Never' }
  });
  return stdout.trim();
}

// Only update an unmodified checkout of the official repository on its default branch.
export async function checkForUpdate({ cwd = PROJECT_ROOT, runGit = git, runZip = updateZip } = {}) {
  try {
    if (runGit === git) {
      try { await lstat(resolve(cwd, '.git')); }
      catch (error) { if (error.code === 'ENOENT') return await runZip({ cwd }); throw error; }
    }
    const root = await runGit(['rev-parse', '--show-toplevel'], cwd);
    if (resolve(root).toLowerCase() !== resolve(cwd).toLowerCase()) return { status: 'skipped', reason: 'Not a standalone Git checkout.' };
    const origin = await runGit(['remote', 'get-url', 'origin'], cwd);
    if (origin.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase() !== OFFICIAL_REMOTE.toLowerCase()) return { status: 'skipped', reason: 'The origin is not the official Price Watch repository.' };
    if (await runGit(['branch', '--show-current'], cwd) !== 'master') return { status: 'skipped', reason: 'Automatic updates require the master branch.' };
    if (await runGit(['status', '--porcelain', '--untracked-files=normal'], cwd)) return { status: 'skipped', reason: 'Local changes are present; they were not overwritten.' };
    const before = await runGit(['rev-parse', 'HEAD'], cwd);
    await runGit(['fetch', '--no-tags', 'origin', 'refs/heads/master:refs/remotes/origin/master'], cwd);
    const after = await runGit(['rev-parse', 'FETCH_HEAD'], cwd);
    if (before === after) return { status: 'current' };
    try { await runGit(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], cwd); }
    catch { return { status: 'skipped', reason: 'Local history has diverged; no update was applied.' }; }
    // Recheck for edits made while fetch was in progress; Git also refuses conflicting files.
    if (await runGit(['status', '--porcelain', '--untracked-files=normal'], cwd)) return { status: 'skipped', reason: 'Local changes appeared during the update.' };
    await runGit(['merge', '--ff-only', '--no-overwrite-ignore', 'FETCH_HEAD'], cwd);
    return { status: 'updated' };
  } catch (error) {
    return { status: 'skipped', reason: error.code === 'ENOENT' ? 'Git is not installed.' : 'Update check failed; the installed version will continue running.' };
  }
}
