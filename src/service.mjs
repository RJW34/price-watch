const EBAY_API = 'https://api.ebay.com';
const DAILY_LIMIT = 500;
const HOURLY_CLIENT_LIMIT = 60;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
let cachedToken;
let tokenExpires = 0;
let tokenPromise;

async function tokenFor(env, outbound) {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) throw new Error('Service credentials not configured');
    const response = await outbound(`${EBAY_API}/identity/v1/oauth2/token`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Basic ${btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' })
    });
    if (!response.ok) { const error = new Error('eBay authentication failed'); error.upstreamStatus = response.status; throw error; }
    const data = await response.json();
    if (!data.access_token || !Number.isFinite(Number(data.expires_in))) throw new Error('Invalid eBay token response');
    cachedToken = data.access_token;
    tokenExpires = Date.now() + Math.max(0, Number(data.expires_in) - 120) * 1000;
    return cachedToken;
  })();
  try { return await tokenPromise; } finally { tokenPromise = undefined; }
}

async function reserve(db, bucket, key, maximum) {
  const sql = 'INSERT INTO quota (bucket, quota_key, used) VALUES (?, ?, 1) ON CONFLICT(bucket, quota_key) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used';
  return Boolean(await db.prepare(sql).bind(bucket, key, maximum).first());
}
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function requestDetails(url) {
  const allowed = { EBAY_US: 'USD', EBAY_GB: 'GBP', EBAY_CA: 'CAD', EBAY_AU: 'AUD', EBAY_DE: 'EUR', EBAY_FR: 'EUR', EBAY_IT: 'EUR', EBAY_ES: 'EUR' };
  const marketplace = url.searchParams.get('marketplace') || 'EBAY_US';
  const currency = url.searchParams.get('currency') || 'USD';
  if (allowed[marketplace] !== currency) return null;
  if (url.pathname === '/v1/inquiry/search') {
    const query = url.searchParams.get('q')?.trim();
    const ceiling = url.searchParams.get('ceiling');
    if (!query || query.length > 100 || /[\x00-\x1f*]/.test(query) || !ceiling || !/^\d{1,9}(?:\.\d{1,2})?$/.test(ceiling) || Number(ceiling) <= 0) return null;
    const params = new URLSearchParams({ q: query, filter: `price:[0..${Number(ceiling)}],priceCurrency:${currency}`, limit: '200', sort: 'newlyListed' });
    return { marketplace, path: `/buy/browse/v1/item_summary/search?${params}`, kind: 'search' };
  }
  if (url.pathname === '/v1/inquiry/reference') {
    const id = url.searchParams.get('id');
    if (!/^\d{9,15}$/.test(id || '')) return null;
    return { marketplace, path: `/buy/browse/v1/item/get_item_by_legacy_id?${new URLSearchParams({ legacy_item_id: id })}`, kind: 'reference' };
  }
  return null;
}

export async function handleRequest(request, env, ctx, outbound = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (url.pathname === '/health') return json({ status: 'ok' });
  const details = requestDetails(url);
  if (!details) return json({ error: 'Invalid inquiry' }, 400);
  if (!env.DB || !env.RATE_LIMIT_SALT) return json({ error: 'Service is not configured' }, 503);
  let stage = 'rate-limit';
  try {
    const now = new Date().toISOString();
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const clientKey = await hash(`${env.RATE_LIMIT_SALT}:${ip}`);
    if (!await reserve(env.DB, now.slice(0, 13), `client:${clientKey}`, HOURLY_CLIENT_LIMIT)) return json({ error: 'Too many requests; try again later.' }, 429);
    stage = 'cache';
    let cache, cacheKey;
    try {
      cache = globalThis.caches?.default;
      cacheKey = new Request(`https://price-watch.internal/${await hash(`${details.marketplace}:${details.path}`)}`);
      const cached = cache && await cache.match(cacheKey);
      if (cached) return json(await cached.json());
    } catch { cache = null; }
    stage = 'daily-limit';
    if (!await reserve(env.DB, now.slice(0, 10), 'ebay:global', DAILY_LIMIT)) return json({ error: 'Daily service limit reached; try again tomorrow.' }, 429);
    if (Math.random() < 0.01) ctx.waitUntil(env.DB.prepare("DELETE FROM quota WHERE substr(bucket, 1, 10) < date('now', '-2 day')").run().catch(() => {}));
    stage = 'authentication';
    const token = await tokenFor(env, outbound);
    stage = 'ebay-search';
    const response = await outbound(`${EBAY_API}${details.path}`, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': details.marketplace }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return json({ error: 'eBay search temporarily unavailable.' }, response.status === 429 ? 429 : 502);
    const data = await response.json();
    if (Array.isArray(data.errors) && data.errors.length) return json({ error: 'eBay rejected this inquiry.' }, 502);
    let result;
    if (details.kind === 'reference') {
      if (typeof data.title !== 'string') return json({ error: 'Listing not available.' }, 404);
      result = { title: data.title.slice(0, 200), condition: typeof data.condition === 'string' ? data.condition.slice(0, 100) : undefined };
    } else {
      if (data.itemSummaries === undefined && data.total === 0) result = { itemSummaries: [], total: 0 };
      else if (!Array.isArray(data.itemSummaries)) return json({ error: 'Unexpected eBay response.' }, 502);
      else result = { total: Number(data.total) || 0, itemSummaries: data.itemSummaries.slice(0, 200).map(item => ({ itemId: item.itemId, title: item.title, itemWebUrl: item.itemWebUrl, price: item.price, shippingOptions: item.shippingOptions })) };
    }
    if (cache) { try { ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })).catch(() => {})); } catch {} }
    return json(result);
  } catch (error) { console.error(`Price Watch service failure at ${stage}: ${error?.name || 'Error'}`); return json({ error: 'Service temporarily unavailable.' }, 503); }
}

export default { fetch: handleRequest };
