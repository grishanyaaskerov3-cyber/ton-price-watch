#!/usr/bin/env node
// watch.mjs — GitHub Actions TON jetton price watcher.
// Dependency-free Node 20. Never trades. Never prints the webhook key or URL.
// Alerts only on cumulative drop >= 5% or pump >= 20% vs a per-coin reference.
// After a successful (2xx) alert, that coin's ref is reset to the alert price.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, 'state.json');
const TZ = 'Europe/Kiev';

const WALLET = 'UQDsZEJaCZSx1I2TPf69OSaIZDaeDgJMpyMcUJZaRv4BJLZ2';
const FALLBACK_COINS = [
  { symbol: 'STORM', master: 'EQBsosmcZrD6FHijA7qWGLw5wo_aH8UN435hi935jJ_STORM' },
  { symbol: 'CHERRY', master: 'EQBKRSNRkeP1-2jcg5T_f__0s5Hj-vrbfNLMQy8dnZs7xd_p' },
  { symbol: 'SP', master: 'EQACLXDwit01stiqK9FvYiJo15luVzfD5zU8uwDSq6JXxbP8' },
];

const DROP_PCT = 5;
const PUMP_PCT = 20;
const DEBOUNCE_MIN = 20;
const MAX_ALERTS_PER_DAY = 12;
const INTERVAL_MS = 60_000;
const WINDOW_MS = Number(process.env.WATCH_WINDOW_MS) || 4.5 * 60 * 1000;
const ONCE = process.env.WATCH_ONCE === '1' || process.argv.includes('--once');
const DRY = process.env.WATCH_DRY === '1' || process.argv.includes('--dry');
const DUST_USD = 0.001;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function kyivParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const map = {};
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value;
  return map;
}

function nowIso(d = new Date()) {
  const p = kyivParts(d);
  let off = p.timeZoneName || 'GMT+2';
  const m = off.match(/GMT([+-])(\d+)(?::?(\d+))?/i);
  const offset = m
    ? `${m[1]}${String(m[2]).padStart(2, '0')}:${String(m[3] || '00').padStart(2, '0')}`
    : '+02:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

function kyivDate(d = new Date()) {
  const p = kyivParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

function logLine(msg) {
  // Never print secrets. Callers must not pass URL or key material.
  process.stdout.write(`${nowIso()} ${msg}\n`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== null && e?.code === 'ENOENT') return fallback;
    throw e;
  }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// --- TON address helpers (no @ton/core) ---

function crc16(data) {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function parseTonAddr(addr) {
  if (!addr || typeof addr !== 'string') throw new Error('bad addr');
  if (addr.includes(':')) {
    const [wc, hash] = addr.split(':');
    const h = hash.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('bad raw addr');
    return { wc: Number(wc), hash: Buffer.from(h, 'hex') };
  }
  let s = addr.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  if (pad) s += '='.repeat(pad);
  const buf = Buffer.from(s, 'base64');
  if (buf.length !== 36) throw new Error('bad friendly addr');
  return { wc: buf.readInt8(1), hash: Buffer.from(buf.subarray(2, 34)) };
}

function rawAddr(addr) {
  const { wc, hash } = parseTonAddr(addr);
  return `${wc}:${hash.toString('hex')}`;
}

function friendlyBounceable(addr) {
  const { wc, hash } = parseTonAddr(addr);
  const body = Buffer.alloc(34);
  body[0] = 0x11;
  body.writeInt8(wc, 1);
  hash.copy(body, 2);
  const crc = crc16(body);
  const full = Buffer.concat([body, Buffer.from([(crc >> 8) & 0xff, crc & 0xff])]);
  return full.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameAddr(a, b) {
  try {
    return rawAddr(a) === rawAddr(b);
  } catch {
    return a === b;
  }
}

function isStable(symbol, name) {
  const raw = String(symbol || '').toUpperCase();
  const alnum = raw.replace(/[^A-Z0-9]/g, '');
  const stables = new Set([
    'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FRAX', 'USDE', 'USD1',
    'PYUSD', 'CUSD', 'USD', 'JUSDT', 'JUSDC', 'OUSDT', 'OUSDC',
  ]);
  if (stables.has(alnum)) return true;
  if (raw.includes('USDT') || raw.includes('USDC')) return true;
  const n = String(name || '').toLowerCase();
  if (n.includes('tether') || n.includes('usd coin') || n.includes('stablecoin')) return true;
  return false;
}

function isDust(balanceRaw, decimals, usdPrice) {
  try {
    if (BigInt(balanceRaw || '0') === 0n) return true;
  } catch {
    if (!balanceRaw || Number(balanceRaw) === 0) return true;
  }
  const dec = Number(decimals) || 0;
  const amt = Number(balanceRaw) / 10 ** dec;
  if (Number.isFinite(amt) && amt <= 0) return true;
  if (usdPrice != null && Number.isFinite(Number(usdPrice)) && Number.isFinite(amt)) {
    if (amt * Number(usdPrice) < DUST_USD) return true;
  }
  return false;
}

function pct(now, ref) {
  if (!ref || !Number.isFinite(ref) || ref === 0) return null;
  return ((now - ref) / ref) * 100;
}

function loadState() {
  const st = readJson(STATE_PATH, {});
  if (!st || typeof st !== 'object') {
    return {
      kyiv_date: kyivDate(),
      alerts_today: 0,
      last_alert_ts: {},
      ref: {},
      entry: {},
      peak: {},
      masters: {},
    };
  }
  st.last_alert_ts = st.last_alert_ts || {};
  st.ref = st.ref || {};
  st.entry = st.entry || {};
  st.peak = st.peak || {};
  st.masters = st.masters || {};
  st.alerts_today = st.alerts_today || 0;
  return st;
}

function rollDailyCap(st) {
  const today = kyivDate();
  if (st.kyiv_date !== today) {
    st.kyiv_date = today;
    st.alerts_today = 0;
  }
}

function loadWebhook() {
  const url = (process.env.TON_ALERT_WEBHOOK_URL || '').trim();
  let key = (process.env.TON_ALERT_WEBHOOK_KEY || '').trim();
  let authorization = '';
  if (key) {
    authorization = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
  }
  return { url, authorization, present: Boolean(url && authorization) };
}

async function fetchJson(url, { retries = 6, timeoutMs = 20000 } = {}) {
  let wait = 1000;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(t);
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(ra) && ra > 0 ? Math.max(ra * 1000, wait) : wait;
        logLine(`tonapi 429, backing off ${Math.round(delay)}ms`);
        await sleep(delay);
        wait = Math.min(wait * 2, 30000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${body.slice(0, 180)}`);
      }
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i === retries - 1) break;
      logLine(`fetch error (${e.message || e}), retry in ${wait}ms`);
      await sleep(wait);
      wait = Math.min(wait * 2, 30000);
    }
  }
  throw lastErr || new Error('fetch retries exhausted');
}

async function fetchRates(masters) {
  const tokens = ['ton', ...masters].join(',');
  const url = `https://tonapi.io/v2/rates?tokens=${encodeURIComponent(tokens)}&currencies=usd`;
  const data = await fetchJson(url);
  const rates = data?.rates || {};
  const out = {};
  for (const [k, v] of Object.entries(rates)) {
    const usd = v?.prices?.USD ?? v?.prices?.usd;
    if (typeof usd === 'number' && Number.isFinite(usd)) out[k] = usd;
  }
  return out;
}

function rateFor(rates, master) {
  if (rates[master] != null) return rates[master];
  for (const [k, v] of Object.entries(rates)) {
    if (/^ton$/i.test(k)) continue;
    if (sameAddr(k, master)) return v;
  }
  return undefined;
}

function tonUsd(rates) {
  return rates.TON ?? rates.ton ?? rates.Ton;
}

function usdFromJettonPrice(price) {
  if (!price || typeof price !== 'object') return undefined;
  const usd = price.prices?.USD ?? price.prices?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined;
}

async function loadHoldings() {
  const url = `https://tonapi.io/v2/accounts/${WALLET}/jettons?currencies=usd`;
  const data = await fetchJson(url);
  const holdings = [];
  const seen = new Set();
  for (const b of data?.balances || []) {
    const j = b.jetton || {};
    const symbol = j.symbol || j.name;
    const masterRaw = j.address;
    if (!symbol || !masterRaw) continue;
    if (isStable(j.symbol, j.name)) {
      logLine(`skip stable ${symbol}`);
      continue;
    }
    const jettonUsd = usdFromJettonPrice(b.price);
    if (isDust(b.balance, j.decimals, jettonUsd)) {
      logLine(`skip dust ${symbol}`);
      continue;
    }
    let master;
    try {
      master = friendlyBounceable(masterRaw);
    } catch {
      master = masterRaw;
    }
    const key = rawAddr(master);
    if (seen.has(key)) continue;
    seen.add(key);
    holdings.push({ symbol, master, jettonUsd });
  }

  // Fallback masters are always tracked, even if the wallet read lags.
  for (const fb of FALLBACK_COINS) {
    const key = rawAddr(fb.master);
    if (seen.has(key)) continue;
    seen.add(key);
    holdings.push({ symbol: fb.symbol, master: fb.master, jettonUsd: undefined, fallback: true });
    logLine(`fallback track ${fb.symbol} (not in current non-dust holdings)`);
  }
  return holdings;
}

function symbolKey(holdings, coin, st) {
  // Prefer the existing state key if this master is already known under another symbol.
  for (const [sym, m] of Object.entries(st.masters || {})) {
    if (m && sameAddr(m, coin.master)) return sym;
  }
  if (holdings.filter((h) => h.symbol === coin.symbol).length <= 1) return coin.symbol;
  const short = rawAddr(coin.master).slice(-6);
  return `${coin.symbol}_${short}`;
}

async function postWebhook(hook, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (hook.authorization) headers.Authorization = hook.authorization;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    // Do not log response body — it might echo request data.
    logLine(`webhook POST status=${res.status} type=${payload.type} coin=${payload.coin}`);
    return res.status;
  } catch (e) {
    clearTimeout(t);
    logLine(`webhook POST failed type=${payload.type} coin=${payload.coin}: ${e.message || e}`);
    return null;
  }
}

async function maybeAlert(coin, payload, st, hook) {
  const now = Date.now();
  const last = Number(st.last_alert_ts[coin] || 0);
  const debounceMs = DEBOUNCE_MIN * 60 * 1000;
  if (last && now - last < debounceMs) {
    logLine(`debounce skip ${coin} ${payload.type} (last ${Math.round((now - last) / 1000)}s ago)`);
    return false;
  }
  if (st.alerts_today >= MAX_ALERTS_PER_DAY) {
    logLine(`daily cap ${MAX_ALERTS_PER_DAY} reached, skip ${coin} ${payload.type}`);
    return false;
  }
  logLine(`ALERT ${payload.type} ${coin} price=${payload.price} ref=${payload.ref_price} change=${payload.change_pct}% pnl=${payload.pnl_pct}%`);
  if (DRY) {
    logLine('dry-run: webhook not sent; ref/last_alert not updated');
    return false;
  }
  if (!hook.present) {
    logLine('webhook unset; ref/last_alert not updated');
    return false;
  }
  const status = await postWebhook(hook, payload);
  if (!(typeof status === 'number' && status >= 200 && status < 300)) {
    logLine(`webhook not 2xx; ref/last_alert not updated for ${coin}`);
    return false;
  }
  st.last_alert_ts[coin] = now;
  st.alerts_today = (st.alerts_today || 0) + 1;
  st.ref[coin] = payload.price;
  return true;
}

async function tick(st, hook) {
  rollDailyCap(st);
  const holdings = await loadHoldings();
  if (!holdings.length) {
    logLine('no holdings to watch');
    return st;
  }
  const masters = holdings.map((h) => h.master);
  const rates = await fetchRates(masters);
  const ton = tonUsd(rates);
  if (ton == null) throw new Error('tonapi rates missing TON/USD');

  const parts = [`TON=${ton}`];

  for (const h of holdings) {
    const key = symbolKey(holdings, h, st);
    const usd = rateFor(rates, h.master) ?? h.jettonUsd;
    if (usd == null) {
      logLine(`missing rate: ${key}`);
      parts.push(`${key}=missing`);
      continue;
    }
    if (!st.masters[key]) st.masters[key] = h.master;
    const isNew = st.ref[key] == null;
    if (isNew) {
      st.ref[key] = usd;
      if (st.entry[key] == null) st.entry[key] = usd;
      if (st.peak[key] == null) st.peak[key] = usd;
      logLine(`new coin ${key} ref=${usd} (no alert)`);
    }
    const ref = st.ref[key];
    const entry = st.entry[key] ?? ref;
    const peak = Math.max(st.peak[key] ?? entry ?? 0, usd);
    if (usd > (st.peak[key] ?? 0)) st.peak[key] = usd;
    const change = pct(usd, ref);
    const pnl = pct(usd, entry);
    parts.push(
      `${key}=${usd} (ref=${ref} ${change == null ? '?' : change.toFixed(2) + '%'} pnl=${pnl == null ? '?' : pnl.toFixed(2) + '%'} peak=${peak})`
    );

    if (isNew || change == null) continue;
    let typ = null;
    if (change <= -DROP_PCT) typ = 'drop';
    else if (change >= PUMP_PCT) typ = 'pump';
    if (!typ) continue;

    const payload = {
      type: typ,
      coin: key,
      master: st.masters[key] || h.master,
      price: usd,
      ref_price: ref,
      change_pct: Number(change.toFixed(4)),
      entry,
      pnl_pct: pnl == null ? null : Number(pnl.toFixed(4)),
      peak,
      ts: nowIso(),
      source: 'github-actions',
    };
    await maybeAlert(key, payload, st, hook);
  }

  logLine((DRY ? 'DRY ' : '') + 'scan ' + parts.join(' | '));
  return st;
}

async function main() {
  const hook = loadWebhook();
  let st = loadState();
  logLine(
    `watch start once=${ONCE} window_ms=${WINDOW_MS} interval=60s ` +
    `drop=${DROP_PCT}% pump=${PUMP_PCT}% debounce=${DEBOUNCE_MIN}m cap=${MAX_ALERTS_PER_DAY}/day ` +
    `webhook=${hook.present ? 'yes' : 'no'} dry=${DRY} source=github-actions`
  );

  const start = Date.now();
  let i = 0;
  while (true) {
    try {
      st = await tick(st, hook);
      try { atomicWrite(STATE_PATH, st); }
      catch (e) { logLine(`state write failed: ${e.message}`); }
    } catch (e) {
      logLine(`tick error: ${e.message || e}`);
    }
    if (ONCE) break;
    i += 1;
    const next = start + i * INTERVAL_MS;
    if (next > start + WINDOW_MS) break;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
  }
  logLine('watch done');
}

main().catch((e) => {
  logLine(`fatal: ${e.message || e}`);
  process.exit(1);
});
