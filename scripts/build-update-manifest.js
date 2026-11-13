import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['README.md', 'ALERTS.md', 'config.example.json', 'package.json', 'start-watcher.ps1'];
async function collect(dir) {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Manifest cannot include symbolic links.');
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await collect(relative);
    else if (entry.isFile()) files.push(relative);
  }
}
for (const dir of ['src', 'test', 'scripts']) await collect(dir);
files.sort();
const hashes = {};
for (const name of files) hashes[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
await writeFile(join(root, 'update-manifest.json'), JSON.stringify({ version: 1, files: hashes }, null, 2) + '\n');
console.log(`Updated manifest for ${files.length} files.`);
