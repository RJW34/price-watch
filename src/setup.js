import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { validateConfig, listingId, getListing, getToken, search, describe } from './watcher.js';

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Setup requires an interactive terminal. Run npm run setup.');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const ask = async prompt => (await rl.question(prompt)).trim();
const configFile = 'config.json';

async function main() {
  let config;
  try { config = validateConfig(JSON.parse(await readFile(configFile, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot use existing config: ${error.message}`);
    config = { marketplace: 'EBAY_US', currency: 'USD', intervalMinutes: 30, watches: [] };
  }
  console.log('\nPRODUCT INQUIRY\nFind a product by name or use an eBay listing as a starting point.');
  console.log(`Marketplace: ${config.marketplace}; currency: ${config.currency}. Change these in config.json if needed.`);
  const token = await getToken(process.env.EBAY_CLIENT_ID, process.env.EBAY_CLIENT_SECRET);
  const starter = config.watches.length === 0;
  let source;
  let useStarter = false;
  if (starter) {
    console.log('Starter inquiry: Hertz Cento Pro CPK 690 speaker set, item price under 400 USD.');
    source = await ask('\nProduct name or full eBay item URL [Hertz CPK 690]: ');
    useStarter = !source;
    if (useStarter) source = 'Hertz CPK 690';
  }
  while (!source) source = await ask('\nProduct name or full eBay item URL: ');
  let suggestion = source;
  if (/^https?:\/\//i.test(source)) {
    const id = listingId(source);
    if (!id) throw new Error('Use a full supported eBay item URL (not a shortened link), or restart and enter a product name.');
    try {
      const item = await getListing(id, config, token);
      console.log(`\nReference listing: ${item.title}`);
      if (item.condition) console.log(`Condition: ${item.condition}`);
      suggestion = item.title.slice(0, 100);
      console.log('Listing titles can contain extra words. Keep only the brand, model, and essential details.');
    } catch (error) {
      console.log(`Could not load that listing: ${error.message}`);
      suggestion = '';
      console.log('You can still enter a product name manually.');
    }
  }
  let query;
  while (true) {
    query = (await ask(`\nSearch terms${suggestion ? ` [${suggestion}]` : ''}: `)) || suggestion;
    if (query && query.length <= 100 && !query.includes('*')) break;
    console.log('Enter 1–100 characters without a wildcard (*).');
  }
  let maxPrice;
  do {
    const answer = await ask(`Alert when item price is below (${config.currency})${useStarter ? ' [400]' : ''}: `);
    maxPrice = Number(answer || (useStarter ? '400' : ''));
  } while (!Number.isFinite(maxPrice) || maxPrice <= 0);
  console.log('The ceiling excludes shipping, tax, and fees. Exact-ceiling prices do not qualify.');
  let id = `watch-${Date.now()}`;
  while (config.watches.some(w => w.id === id)) id += 'x';
  const watch = { id, query, maxPrice };
  try {
    const items = await search(watch, config, token);
    console.log(`\nPREVIEW: ${items.length} result(s) below the item-price ceiling (up to 200 checked).`);
    for (const item of items.slice(0, 5)) console.log(`\n${describe(item, watch)}`);
    console.log('\nReview model, condition, and shipping on eBay. Results are candidates, not verified matches.');
  } catch (error) {
    console.log(`\nPreview unavailable: ${error.message}`);
    console.log('You can save the inquiry and retry the search later.');
  }
  console.log('\nNOTIFICATIONS\n1. Terminal only: shown while the watcher is running.\n2. Discord: sent to a channel via your webhook, and shown in the terminal.\nSee ALERTS.md for step-by-step setup and troubleshooting.');
  if (config.watches.length) console.log('This choice applies to every watch in this configuration.');
  let choice;
  const defaultChoice = config.notification === 'discord' ? '2' : '1';
  do { choice = (await ask(`Choose 1 or 2 [${defaultChoice}]: `)) || defaultChoice; } while (!['1', '2'].includes(choice));
  config.notification = choice === '2' ? 'discord' : 'terminal';
  if (config.notification === 'discord') {
    console.log('Set DISCORD_WEBHOOK_URL in the same terminal before starting the watcher. The webhook is not stored in config.json.');
    if (!process.env.DISCORD_WEBHOOK_URL) console.log('No webhook is set in this session yet.');
  }
  console.log(`\nReady to save: ${query} below ${maxPrice} ${config.currency}; ${config.notification} alerts every ${config.intervalMinutes} minutes.`);
  if (!/^y(?:es)?$/i.test(await ask('Save this inquiry? [y/N]: '))) { console.log('Nothing saved.'); return; }
  config.watches.push(watch);
  validateConfig(config);
  await writeFile(`${configFile}.tmp`, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await rename(`${configFile}.tmp`, configFile);
  console.log('Saved. Start the watcher to receive a digest; each check shows up to five listings and summarizes any extras.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => rl.close());
