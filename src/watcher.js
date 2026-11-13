import { access, readFile, writeFile, rename } from 'node:fs/promises';

const API = 'https://api.ebay.com';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

export function validateConfig(config) {
  if (!config || !/^[A-Z]{3}$/.test(config.currency || '') || !/^EBAY_[A-Z]+$/.test(config.marketplace || '')) throw new Error('Set a valid currency (e.g. USD) and marketplace (e.g. EBAY_US).');
  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 5 || config.intervalMinutes > 1440) throw new Error('intervalMinutes must be between 5 and 1440.');
  if (config.notification && !['terminal', 'discord'].includes(config.notification)) throw new Error('notification must be terminal or discord.');
  if (!Array.isArray(config.watches) || config.watches.length === 0) throw new Error('Add at least one watch.');
  if (config.watches.length > 20) throw new Error('At most 20 watches are supported per configuration.');
  const ids = new Set();
  for (const watch of config.watches) {
    if (!watch || typeof watch.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(watch.id) || ids.has(watch.id)) throw new Error('Each watch needs a unique id of up to 40 letters, numbers, underscores, or hyphens.');
    if (typeof watch.query !== 'string' || !watch.query.trim() || watch.query.length > 100) throw new Error(`Watch ${watch.id}: query must be 1–100 characters.`);
    if (typeof watch.maxPrice !== 'number' || !Number.isFinite(watch.maxPrice) || watch.maxPrice <= 0) throw new Error(`Watch ${watch.id}: maxPrice must be a positive number.`);
    ids.add(watch.id);
  }
  return config;
}

export function listingId(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !/^(?:www\.)?ebay\.(?:com|co\.uk|ca|com\.au|de|fr|it|es)$/.test(host)) return null;
  const match = url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})(?:\/|$)/);
  return match?.[1] || null;
}

export async function getListing(id, config, token, fetchFn = fetch) {
  if (!/^\d{9,15}$/.test(id)) throw new Error('Invalid eBay item ID.');
  const params = new URLSearchParams({ legacy_item_id: id });
  const response = await fetchFn(`${API}/buy/browse/v1/item/get_item_by_legacy_id?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': config.marketplace }, signal: AbortSignal.timeout(15000)
  });
  const data = await jsonResponse(response, 'eBay listing lookup');
  if (!data.title) throw new Error('This listing has no title available.');
  return data;
}

async function jsonResponse(response, operation) {
  if (!response.ok) {
    // Do not echo response bodies: they could contain sensitive information.
    const error = new Error(`${operation} failed (HTTP ${response.status}). Check credentials, Browse API access, marketplace, and eBay service status.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function getToken(clientId, clientSecret, fetchFn = fetch) {
  if (!clientId || !clientSecret) throw new Error('Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET before running a live search.');
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchFn(`${API}/identity/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }), signal: AbortSignal.timeout(15000)
  });
  const data = await jsonResponse(response, 'eBay authentication');
  if (!data.access_token) throw new Error('eBay authentication returned no access token.');
  return data.access_token;
}

export async function search(watch, config, token, fetchFn = fetch) {
  const params = new URLSearchParams({ q: watch.query, filter: `price:[0..${watch.maxPrice}],priceCurrency:${config.currency}`, limit: '200', sort: 'newlyListed' });
  const response = await fetchFn(`${API}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': config.marketplace }, signal: AbortSignal.timeout(15000)
  });
  const data = await jsonResponse(response, 'eBay search');
  return (data.itemSummaries || []).filter(item => qualifies(item, watch, config.currency));
}

export function qualifies(item, watch, currency) {
  if (!item || !item.itemId || !item.itemWebUrl || item.price?.currency !== currency) return false;
  const price = Number(item.price?.value);
  return item.price?.value != null && Number.isFinite(price) && price >= 0 && price < watch.maxPrice;
}

export function describe(item, watch) {
  const shipping = item.shippingOptions?.[0]?.shippingCost;
  const shippingText = shipping ? `${shipping.value} ${shipping.currency}` : 'unknown';
  return `[${watch.id}] ${item.title || 'Untitled listing'}\nItem price: ${item.price.value} ${item.price.currency} (shipping: ${shippingText})\n${item.itemWebUrl}`;
}

export async function sendDiscord(webhook, message, fetchFn = fetch) {
  if (!webhook) return;
  const url = new URL(webhook);
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) throw new Error('DISCORD_WEBHOOK_URL must be a Discord HTTPS webhook URL.');
  const response = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message.slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Discord notification failed (HTTP ${response.status}); it will be retried on the next check.`);
}

export async function loadState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (!state || state.version !== 1 || !state.alerted || typeof state.alerted !== 'object' || Array.isArray(state.alerted)) throw new Error('Invalid state format');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, alerted: {} };
    throw new Error(`Cannot read state file ${file}: ${error.message}`);
  }
}

export async function migrateStateFile(file, legacyFile) {
  try { await access(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(legacyFile, file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function saveState(file, state) {
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(temp, file);
}

export const MAX_HISTORY = 10000;
export const DIGEST_ITEMS = 5;
export function retryDelayMinutes(interval, failures) {
  return Math.min(1440, interval * 2 ** Math.min(failures, 12));
}

export async function processBatch(batches, state, notify, persist) {
  const next = { version: 1, alerted: { ...state.alerted } };
  const pending = [];
  const pendingKeys = new Set();
  let observed = false;
  for (const { watch, items } of batches) {
    for (const item of items) {
      observed = true;
      const key = JSON.stringify([watch.id, item.itemId]);
      const amount = Number(item.price.value);
      const previous = next.alerted[key];
      const isNew = !Object.hasOwn(next.alerted, key);
      // Move seen records to the end, retaining recently seen listings if the cap is reached.
      if (!isNew) { delete next.alerted[key]; next.alerted[key] = previous; }
      if ((isNew || amount <= previous * 0.95 + 1e-9) && !pendingKeys.has(key)) {
        pending.push({ key, amount, item, watch });
        pendingKeys.add(key);
      }
    }
  }
  if (pending.length) {
    const lines = [`Price Watch: ${pending.length} new or reduced listing(s).`];
    for (const { item, watch } of pending.slice(0, DIGEST_ITEMS)) {
      const title = String(item.title || 'Untitled listing').replace(/[\r\n]/g, ' ').slice(0, 80);
      // Strip tracking parameters to keep links compact.
      let link = item.itemWebUrl;
      try { const url = new URL(link); url.search = ''; url.hash = ''; link = url.toString(); if (link.length > 150) link = '(find this title on eBay)'; } catch { link = '(find this title on eBay)'; }
      lines.push(`\n[${watch.id}] ${title}\n${String(item.price.value).slice(0, 30)} ${item.price.currency} — ${link}`);
    }
    if (pending.length > DIGEST_ITEMS) lines.push(`\n${pending.length - DIGEST_ITEMS} more matching listing(s) omitted. Refine your search if needed.`);
    lines.push('\nCheck the listing and delivered cost before buying.');
    await notify(lines.join('\n'));
    for (const { key, amount } of pending) { delete next.alerted[key]; next.alerted[key] = amount; }
  }
  const keys = Object.keys(next.alerted);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_HISTORY))) delete next.alerted[key];
  if (observed || keys.length > MAX_HISTORY) await persist(next);
  state.alerted = next.alerted;
  return pending.length;
}
