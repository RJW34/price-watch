import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/service.mjs';

function database() {
  const used = new Map();
  return { used, prepare(sql) { return { bind(bucket, key, max) { return { async first() { const id = `${bucket}/${key}`; const n = used.get(id) || 0; if (n >= max) return null; used.set(id, n + 1); return { used: n + 1 }; } }; }, async run() {} }; } };
}
const context = { waitUntil(promise) { void promise; } };
const query = 'https://example.test/v1/inquiry/search?q=Hertz%20CPK%20690&ceiling=400&currency=USD&marketplace=EBAY_US';

test('service limits the API surface and validates inquiries', async () => {
  const env = { DB: database(), RATE_LIMIT_SALT: 'test-salt' };
  assert.equal((await handleRequest(new Request('https://example.test/health'), env, context)).status, 200);
  for (const url of ['https://example.test/v1/anything', 'https://example.test/v1/inquiry/search?q=*&ceiling=100', 'https://example.test/v1/inquiry/search?q=speaker&ceiling=-1', 'https://example.test/v1/inquiry/reference?id=invalid']) {
    assert.equal((await handleRequest(new Request(url), env, context)).status, 400);
  }
  assert.equal((await handleRequest(new Request(query, { method: 'POST' }), env, context)).status, 405);
  assert.equal(env.DB.used.size, 0);
});

test('performs a scoped search without exposing credentials or tokens', async () => {
  const env = { DB: database(), RATE_LIMIT_SALT: 'test-salt', EBAY_CLIENT_ID: 'private-id', EBAY_CLIENT_SECRET: 'private-secret' };
  let requests = 0;
  const outbound = async (url, options) => {
    requests++;
    if (url.includes('/identity/')) return Response.json({ access_token: 'private-token', expires_in: 7200 });
    assert.match(url, /item_summary\/search/);
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    return Response.json({ total: 1, itemSummaries: [{ itemId: 'one', title: 'Speaker', itemWebUrl: 'https://www.ebay.com/itm/123456789012', price: { value: '200', currency: 'USD' }, internal: 'omit' }] });
  };
  const response = await handleRequest(new Request(query, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), env, context, outbound);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /private-secret|private-token|internal/);
  assert.equal(JSON.parse(body).itemSummaries[0].title, 'Speaker');
  assert.equal(requests, 2);
});

test('caps eBay calls and client requests with durable counters', async () => {
  const db = database();
  const day = new Date().toISOString().slice(0, 10);
  db.used.set(`${day}/ebay:global`, 500);
  const response = await handleRequest(new Request(query), { DB: db, RATE_LIMIT_SALT: 'salt' }, context, async () => { throw new Error('should not call eBay'); });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /Daily service limit/);
  const other = database();
  for (let i = 0; i < 61; i++) {
    const r = await handleRequest(new Request(query), { DB: other, RATE_LIMIT_SALT: 'salt' }, context, async () => new Response('', { status: 503 }));
    if (i === 60) assert.equal(r.status, 429);
  }
});
