import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, withServiceDefaults, DEFAULT_SERVICE_URL, qualifies, processBatch, search, sendDiscord, getToken, listingId, getListing, MAX_HISTORY, retryDelayMinutes, migrateStateFile } from '../src/watcher.js';

const config = { marketplace: 'EBAY_US', currency: 'USD', intervalMinutes: 30, watches: [{ id: 'speaker', query: 'specific speaker', maxPrice: 100 }] };
const item = { itemId: 'one', itemWebUrl: 'https://www.ebay.com/itm/1', title: 'Speaker', price: { value: '99.99', currency: 'USD' } };

test('new and older configurations use shared service unless explicitly disabled', () => {
  const resolved = withServiceDefaults(config);
  assert.equal(resolved.serviceUrl, DEFAULT_SERVICE_URL);
  assert.equal(config.serviceUrl, undefined);
  assert.equal(validateConfig(resolved).serviceUrl, DEFAULT_SERVICE_URL);
  assert.equal(validateConfig(withServiceDefaults({ ...config, serviceUrl: null })).serviceUrl, null);
  assert.throws(() => validateConfig(withServiceDefaults({ ...config, currency: 'EUR' })), /marketplace and currency/);
});

test('validates watches and prevents duplicate ids', () => {
  assert.equal(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, watches: [config.watches[0], config.watches[0]] }), /unique id/);
  assert.throws(() => validateConfig({ ...config, intervalMinutes: 0 }), /between 5 and 1440/);
  assert.throws(() => validateConfig({ ...config, intervalMinutes: 1500 }), /between 5 and 1440/);
});

test('price must be strictly under ceiling and in configured currency', () => {
  const watch = config.watches[0];
  assert.equal(qualifies(item, watch, 'USD'), true);
  assert.equal(qualifies({ ...item, price: { value: '100', currency: 'USD' } }, watch, 'USD'), false);
  assert.equal(qualifies({ ...item, price: { value: '1', currency: 'EUR' } }, watch, 'USD'), false);
  assert.equal(qualifies({ ...item, price: { value: 'NaN', currency: 'USD' } }, watch, 'USD'), false);
  assert.equal(qualifies({ ...item, price: { value: '', currency: 'USD' } }, watch, 'USD'), false);
  assert.equal(qualifies({ ...item, itemWebUrl: 'javascript:alert(1)' }, watch, 'USD'), false);
});

test('zero-priced items do not cause repeated alerts', async () => {
  const state = { version: 1, alerted: {} }; let messages = 0;
  const free = { ...item, price: { value: '0.00', currency: 'USD' } };
  const run = () => processBatch([{ watch: config.watches[0], items: [free] }], state, async () => { messages++; }, async () => {});
  await run(); await run();
  assert.equal(messages, 1);
});

test('alerts once per listing, then only after a drop of at least five percent', async () => {
  const state = { version: 1, alerted: {} }; const messages = []; let saves = 0;
  const run = items => processBatch([{ items, watch: config.watches[0] }], state, async message => messages.push(message), async () => { saves++; });
  assert.equal(await run([item]), 1);
  assert.equal(await run([item]), 0);
  assert.equal(await run([{ ...item, price: { ...item.price, value: '96' } }]), 0);
  assert.equal(await run([{ ...item, price: { ...item.price, value: '94.99' } }]), 1);
  assert.equal(messages.length, 2); assert.equal(saves, 4);
});

test('does not record a failed notification', async () => {
  const state = { version: 1, alerted: {} };
  await assert.rejects(processBatch([{ items: [item], watch: config.watches[0] }], state, async () => { throw new Error('offline'); }, async () => {}), /offline/);
  assert.deepEqual(state.alerted, {});
});

test('batches many results into one bounded notification and records omitted results', async () => {
  const state = { version: 1, alerted: {} }; const messages = [];
  const items = Array.from({ length: 30 }, (_, i) => ({ ...item, itemId: String(i), itemWebUrl: `https://www.ebay.com/itm/${i}` }));
  const run = () => processBatch([{ items, watch: config.watches[0] }], state, async message => messages.push(message), async () => {});
  assert.equal(await run(), 30);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /25 more/);
  assert.ok(messages[0].length < 1900);
  assert.equal(await run(), 0);
  assert.equal(messages.length, 1);
});

test('history remains capped and keeps recently observed entries', async () => {
  const state = { version: 1, alerted: Object.fromEntries(Array.from({ length: MAX_HISTORY }, (_, i) => [`old-${i}`, 1])) };
  await processBatch([{ items: [item], watch: config.watches[0] }], state, async () => {}, async () => {});
  assert.equal(Object.keys(state.alerted).length, MAX_HISTORY);
  assert.equal(state.alerted['old-0'], undefined);
  assert.equal(state.alerted[JSON.stringify(['speaker', 'one'])], 99.99);
});

test('backs off failed checks and caps the delay', () => {
  assert.equal(retryDelayMinutes(30, 0), 30);
  assert.equal(retryDelayMinutes(30, 1), 60);
  assert.equal(retryDelayMinutes(30, 20), 1440);
});

test('moves old alert history once and never replaces newer history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'price-watch-'));
  const oldPath = join(dir, 'old.json');
  const newPath = join(dir, 'new.json');
  try {
    await writeFile(oldPath, 'old history');
    await migrateStateFile(newPath, oldPath);
    assert.equal(await readFile(newPath, 'utf8'), 'old history');
    await writeFile(oldPath, 'other history');
    await migrateStateFile(newPath, oldPath);
    assert.equal(await readFile(newPath, 'utf8'), 'old history');
    assert.equal(await readFile(oldPath, 'utf8'), 'other history');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('search sends API filter and excludes ceiling results', async () => {
  let request;
  const fetchFn = async (url, options) => { request = { url: new URL(url), options }; return { ok: true, json: async () => ({ itemSummaries: [item, { ...item, price: { value: '100', currency: 'USD' } }] }) }; };
  const results = await search(config.watches[0], config, 'token', fetchFn);
  assert.equal(results.length, 1);
  assert.equal(request.url.searchParams.get('filter'), 'price:[0..100],priceCurrency:USD');
  assert.equal(request.options.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
});

test('shared service searches and reference lookups require no eBay credentials', async () => {
  const shared = { ...config, serviceUrl: 'https://service.example' };
  const calls = [];
  const fetchFn = async (url, options) => { calls.push({ url: new URL(url), options }); return { ok: true, json: async () => calls.length === 1 ? { itemSummaries: [item] } : { title: 'Reference speaker' } }; };
  assert.equal((await search(config.watches[0], shared, null, fetchFn)).length, 1);
  assert.equal((await getListing('123456789012', shared, null, fetchFn)).title, 'Reference speaker');
  assert.equal(calls[0].url.pathname, '/v1/inquiry/search');
  assert.equal(calls[1].url.pathname, '/v1/inquiry/reference');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.throws(() => validateConfig({ ...shared, serviceUrl: 'http://example.test' }), /HTTPS origin/);
});

test('treats API error payloads as failed searches, not empty results', async () => {
  await assert.rejects(search(config.watches[0], config, 'token', async () => ({ ok: true, json: async () => ({ errors: [{ errorId: 1 }] }) })), /search error/);
  await assert.rejects(search(config.watches[0], config, 'token', async () => ({ ok: true, json: async () => ({}) })), /invalid search response/);
  assert.deepEqual(await search(config.watches[0], config, 'token', async () => ({ ok: true, json: async () => ({ total: 0 }) })), []);
});

test('authentication encodes client credentials and uses OAuth scope', async () => {
  let request;
  const token = await getToken('id', 'secret', async (url, options) => { request = options; return { ok: true, json: async () => ({ access_token: 'example' }) }; });
  assert.equal(token, 'example');
  assert.equal(request.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.equal(request.body.get('grant_type'), 'client_credentials');
});

test('Discord rejects non-Discord URLs and reports failed delivery', async () => {
  await assert.rejects(sendDiscord('https://example.com/api/webhooks/x/y', 'hello'), /Discord HTTPS/);
  await assert.rejects(sendDiscord('https://discord.com/api/webhooks/x/y', 'hello', async () => ({ ok: false, status: 429 })), /429/);
  let options;
  await sendDiscord('https://discord.com/api/webhooks/x/y', 'hello', async (_url, o) => { options = o; return { ok: true }; });
  assert.equal(options.redirect, 'error');
  await assert.rejects(sendDiscord('https://name@discord.com/api/webhooks/x/y', 'hello'), /Discord HTTPS/);
});

test('extracts item IDs only from supported eBay listing URLs', () => {
  assert.equal(listingId('https://www.ebay.com/itm/speaker-name/123456789012?hash=abc'), '123456789012');
  assert.equal(listingId('https://www.ebay.com/itm/123456789012'), '123456789012');
  assert.equal(listingId('https://ebay.com.evil.example/itm/123456789012'), null);
  assert.equal(listingId('https://www.ebay.com/sch/i.html'), null);
});

test('retrieves the reference listing using its legacy item ID', async () => {
  let request;
  const listing = await getListing('123456789012', config, 'token', async (url, options) => {
    request = { url: new URL(url), options };
    return { ok: true, json: async () => ({ title: 'Reference speaker' }) };
  });
  assert.equal(listing.title, 'Reference speaker');
  assert.equal(request.url.searchParams.get('legacy_item_id'), '123456789012');
  assert.equal(request.options.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
});
