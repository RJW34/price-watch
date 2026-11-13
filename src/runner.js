import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { recoverZipUpdate } from './zip-updater.js';

const worker = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; if (child && !child.killed) child.kill(signal); });

function run() {
  child = spawn(process.execPath, [worker, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, PRICE_WATCH_SUPERVISED: '1' } });
  child.on('error', error => { console.error(`Cannot start watcher: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (!stopping && code === 75) { console.log('Restarting Price Watch with the update.'); run(); return; }
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
recoverZipUpdate(dirname(dirname(worker))).then(run).catch(error => {
  console.error(`Cannot safely recover an interrupted update: ${error.message}`);
  process.exitCode = 1;
});
