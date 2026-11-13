import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.github.com/repos/RJW34/price-watch/commits/master';
const RAW = 'https://raw.githubusercontent.com/RJW34/price-watch';
const MANIFEST = 'update-manifest.json';
const STAGING = '.price-watch-update';
const MAX_BYTES = 2 * 1024 * 1024;
const sha256 = data => createHash('sha256').update(data).digest('hex');

function validPath(path) {
  return typeof path === 'string' && path.length < 200 && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) && /^(?:src|test|scripts)\/[a-zA-Z0-9_./-]+$|^(?:README\.md|ALERTS\.md|config\.example\.json|package\.json|start-watcher\.ps1)$/.test(path);
}
function parseManifest(bytes) {
  const data = JSON.parse(bytes.toString('utf8'));
  const entries = data && data.version === 1 && data.files && !Array.isArray(data.files) && typeof data.files === 'object' ? Object.entries(data.files) : [];
  if (!entries.length || entries.length > 100 || entries.some(([name, hash]) => !validPath(name) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid update manifest.');
  return data;
}
async function safePath(root, name, createParents = false) {
  if (name !== MANIFEST && !validPath(name)) throw new Error('Unsafe update path.');
  const parts = name.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe update directory.'); }
    catch (error) { if (error.code !== 'ENOENT' || !createParents) throw error; await mkdir(current); }
  }
  const target = join(current, parts.at(-1));
  try { const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe update file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
async function optionalBytes(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function download(url, fetchFn) {
  const response = await fetchFn(url, { headers: { 'User-Agent': 'Price-Watch', Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Update download failed.');
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BYTES) throw new Error('Update file is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Update file is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Called before the worker starts. A journal means a prior update did not finish.
export async function recoverZipUpdate(root) {
  const stage = join(root, STAGING);
  try { const stat = await lstat(stage); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe update recovery directory.'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const journalBytes = await optionalBytes(join(stage, 'journal.json'));
  if (!journalBytes) return;
  const journal = JSON.parse(journalBytes.toString('utf8'));
  if (journal.version !== 1 || !Array.isArray(journal.files) || journal.files.length > 101) throw new Error('Invalid update recovery journal.');
  for (const entry of journal.files) {
    if ((entry.path !== MANIFEST && !validPath(entry.path)) || !/^[a-f0-9]{64}$/.test(entry.after) || (entry.before !== null && !/^[a-f0-9]{64}$/.test(entry.before))) throw new Error('Invalid update recovery entry.');
    const target = await safePath(root, entry.path, true);
    const current = await optionalBytes(target);
    const currentHash = current && sha256(current);
    if (currentHash === entry.before) continue;
    if (currentHash !== entry.after) throw new Error('An update was interrupted and a file was changed afterward; manual recovery is needed.');
    if (entry.before === null) await rm(target);
    else {
      const backup = join(stage, 'backup', entry.before);
      const bytes = await readFile(backup);
      if (sha256(bytes) !== entry.before) throw new Error('Update backup is invalid.');
      await writeFile(`${target}.price-watch-restore`, bytes, { flag: 'wx' });
      await rename(`${target}.price-watch-restore`, target);
    }
  }
  await rm(stage, { recursive: true, force: true });
  console.log('Recovered an interrupted Price Watch update.');
}

export async function updateZip({ cwd, fetchFn = fetch } = {}) {
  const stage = join(cwd, STAGING);
  let journalWritten = false;
  let stageCreated = false;
  try {
    const oldBytes = await readFile(join(cwd, MANIFEST));
    const oldManifest = parseManifest(oldBytes);
    const revision = JSON.parse((await download(API, fetchFn)).toString('utf8')).sha;
    if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid update revision.');
    const remoteBytes = await download(`${RAW}/${revision}/${MANIFEST}`, fetchFn);
    const remote = parseManifest(remoteBytes);
    if (oldBytes.equals(remoteBytes)) return { status: 'current' };
    // Refuse to replace any locally modified or missing managed file.
    for (const [name, expected] of Object.entries(oldManifest.files)) {
      const bytes = await optionalBytes(await safePath(cwd, name));
      if (!bytes || sha256(bytes) !== expected) return { status: 'skipped', reason: 'A program file was modified or removed; no update was applied.' };
    }
    for (const name of Object.keys(remote.files)) {
      if (!Object.hasOwn(oldManifest.files, name)) {
        try { if (await optionalBytes(await safePath(cwd, name))) return { status: 'skipped', reason: 'A new update file conflicts with a local file.' }; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    // A pre-existing staging directory may contain recovery data; never overwrite it.
    await mkdir(stage);
    stageCreated = true;
    await mkdir(join(stage, 'backup'));
    await mkdir(join(stage, 'incoming'));
    const entries = [];
    const changes = Object.entries(remote.files).filter(([name, hash]) => oldManifest.files[name] !== hash);
    changes.push([MANIFEST, sha256(remoteBytes)]);
    for (const [name, after] of changes) {
      const target = await safePath(cwd, name, true);
      const beforeBytes = await optionalBytes(target);
      const before = beforeBytes ? sha256(beforeBytes) : null;
      const expectedBefore = name === MANIFEST ? sha256(oldBytes) : oldManifest.files[name] || null;
      if (before !== expectedBefore) throw new Error('A local file changed during the update.');
      const bytes = name === MANIFEST ? remoteBytes : await download(`${RAW}/${revision}/${name}`, fetchFn);
      if (sha256(bytes) !== after) throw new Error('Update integrity check failed.');
      if (before) await writeFile(join(stage, 'backup', before), beforeBytes);
      await writeFile(join(stage, 'incoming', after), bytes);
      entries.push({ path: name, before, after });
    }
    await writeFile(join(stage, 'journal.tmp'), JSON.stringify({ version: 1, files: entries }));
    await rename(join(stage, 'journal.tmp'), join(stage, 'journal.json'));
    journalWritten = true;
    for (const entry of entries) {
      const target = await safePath(cwd, entry.path, true);
      const current = await optionalBytes(target);
      if ((current ? sha256(current) : null) !== entry.before) throw new Error('A local file changed during the update.');
      const temporary = `${target}.price-watch-new`;
      await writeFile(temporary, await readFile(join(stage, 'incoming', entry.after)), { flag: 'wx' });
      await rename(temporary, target);
    }
    await rm(stage, { recursive: true, force: true });
    return { status: 'updated' };
  } catch (error) {
    if (journalWritten) {
      try { await recoverZipUpdate(cwd); } catch { return { status: 'skipped', reason: 'Update was interrupted; manual recovery is required. See README.' }; }
    } else if (stageCreated) await rm(stage, { recursive: true, force: true });
    return { status: 'skipped', reason: 'ZIP update check failed or local files need attention; the installed version will continue.' };
  }
}
