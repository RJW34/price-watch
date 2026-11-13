import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateConfig, getToken, search, qualifies, loadState, migrateStateFile, saveState, processBatch, sendDiscord, retryDelayMinutes } from './watcher.js';
import { checkForUpdate, UPDATE_INTERVAL_MS } from './updater.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm start -- [--once] [--config path]\n       npm run demo\n\nWithout --once, checks repeat at the configured interval.');
  process.exit(0);
}
if (args.some((arg, i) => !['--once', '--demo', '--config'].includes(arg) && args[i - 1] !== '--config') || (args.includes('--config') && (!args[args.indexOf('--config') + 1] || args[args.indexOf('--config') + 1].startsWith('--')))) {
  console.error('Invalid arguments. Run npm start -- --help.'); process.exit(1);
}

const demo = args.includes('--demo');
const configIndex = args.indexOf('--config');
const configPath = resolve(configIndex >= 0 ? args[configIndex + 1] : demo ? 'config.example.json' : 'config.json');
const statePath = resolve('.price-watch-state.json');

async function main() {
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  let lastUpdateCheck = 0;
  const updateIfDue = async () => {
    if (demo || config.autoUpdate === false || process.env.PRICE_WATCH_SUPERVISED !== '1' || Date.now() - lastUpdateCheck < UPDATE_INTERVAL_MS) return false;
    lastUpdateCheck = Date.now();
    const result = await checkForUpdate();
    if (result.status === 'updated') { console.log('An update was installed.'); process.exitCode = 75; return true; }
    if (result.status === 'skipped') console.log(`Automatic update skipped: ${result.reason}`);
    return false;
  };
  if (await updateIfDue()) return;
  if (!demo) await migrateStateFile(statePath, resolve('.speaker-watch-state.json'));
  const state = demo ? { version: 1, alerted: {} } : await loadState(statePath);
  const run = async () => {
    console.log(`\nChecking ${config.watches.length} watch(es) at ${new Date().toISOString()}${demo ? ' (demo data)' : ''}`);
    const token = demo ? null : await getToken(process.env.EBAY_CLIENT_ID, process.env.EBAY_CLIENT_SECRET);
    let failures = 0;
    const batches = [];
    for (const watch of config.watches) {
      try {
        const samples = [
          { itemId: 'demo-1', title: 'Example car speaker — verify model and condition', price: { value: (watch.maxPrice * 0.8).toFixed(2), currency: config.currency }, itemWebUrl: 'https://www.ebay.com/', shippingOptions: [{ shippingCost: { value: '12.00', currency: config.currency } }] },
          { itemId: 'demo-2', title: 'Example at the ceiling (excluded)', price: { value: String(watch.maxPrice), currency: config.currency }, itemWebUrl: 'https://www.ebay.com/' }
        ];
        const items = demo ? samples.filter(item => qualifies(item, watch, config.currency)) : await search(watch, config, token);
        batches.push({ watch, items });
        console.log(`${watch.id}: ${items.length} matching result(s).`);
      } catch (error) {
        failures++; console.error(`${watch.id}: ${error.message}`);
        if ([401, 403, 429].includes(error.status)) { console.error('Stopping this check to avoid further requests.'); break; }
      }
    }
    const count = await processBatch(batches, state, async message => {
      const useDiscord = config.notification === 'discord' || (!config.notification && process.env.DISCORD_WEBHOOK_URL);
      if (!demo && useDiscord) {
        if (!process.env.DISCORD_WEBHOOK_URL) throw new Error('Discord is selected, but DISCORD_WEBHOOK_URL is not set.');
        await sendDiscord(process.env.DISCORD_WEBHOOK_URL, message);
      }
      console.log(`\n${message}`);
    }, async current => { if (!demo) await saveState(statePath, current); });
    console.log(`${count} new or reduced listing(s) in this check.`);
    if (failures) throw new Error(`${failures} watch(es) failed.`);
  };
  if (demo || args.includes('--once')) return run();
  let failures = 0;
  while (true) {
    if (await updateIfDue()) return;
    try { await run(); failures = 0; } catch (error) { failures++; console.error(error.message); }
    const delay = retryDelayMinutes(config.intervalMinutes, failures);
    console.log(`Next check in ${delay} minute(s)${failures ? ' (retry backoff)' : ''}. Press Ctrl+C to stop.`);
    await new Promise(resolveWait => setTimeout(resolveWait, delay * 60000));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
