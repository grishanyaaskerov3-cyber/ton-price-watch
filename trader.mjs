#!/usr/bin/env node
// trader.mjs — autonomous stop / trailing-stop seller for the TON wallet below.
// Only ever sends ONE kind of message: a STON.fi jetton->TON swap (jetton transfer to the STON.fi router).
// Never buys, never approves, never sends TON anywhere. Never prints the mnemonic.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4, internal, SendMode, Address } from '@ton/ton';
import { Client, dexFactory } from '@ston-fi/sdk';
import { StonApiClient } from '@ston-fi/api';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(DIR, 'state.json');
const TRADES = path.join(DIR, 'trades.log');
const WALLET = 'UQDsZEJaCZSx1I2TPf69OSaIZDaeDgJMpyMcUJZaRv4BJLZ2';
const TON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';

// ---- rules ----
const HARD_STOP = 0.12;        // -12% from entry
const ARM_BE = 0.15;           // at +15% peak: stop -> breakeven
const TRAIL = 0.15;            // then trail 15% below highest price seen
const CONFIRM_TICKS = 2;       // stop must be breached on 2 consecutive checks (~1 min apart)
const LIQUIDATE_FROM = '2026-11-26'; // Kyiv date: from 26 Nov 00:00 (i.e. after 25 Nov) sell everything
const SLIPPAGE = '0.07';
const MIN_TON_GAS = 0.15;      // keep at least this much TON
const MAX_GAS_ATTACH = 0.5;    // refuse a swap that attaches more TON than this
const RESEND_AFTER_MS = 10 * 60 * 1000;

const ONCE = process.env.WATCH_ONCE === '1';
const DRY = process.env.TRADE_DRY === '1';
const WINDOW_MS = Number(process.env.WATCH_WINDOW_MS) || 4.5 * 60 * 1000;
const INTERVAL_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kyiv = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d).replace(' ', 'T');
const log = (m) => process.stdout.write(`${kyiv()} Kyiv ${m}\n`);
const trade = (o) => { fs.appendFileSync(TRADES, JSON.stringify({ t: kyiv() + ' Kyiv', ...o }) + '\n'); log('TRADES.LOG ' + JSON.stringify(o)); };
const save = (st) => fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n');
const raw = (a) => Address.parse(a).toRawString();

async function getJson(url, tries = 6) {
  let w = 1000, err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.status === 429) { await sleep(w); w *= 2; continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { err = e; await sleep(w); w = Math.min(w * 2, 20000); }
  }
  throw err || new Error('fetch failed');
}
const retry429 = async (f) => {
  for (let i = 0; i < 8; i++) {
    try { return await f(); } catch (e) {
      const s = e?.response?.status ?? e?.status;
      if (s !== 429 && !/429|timeout|ECONNRESET/i.test(String(e?.message))) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error('retries exhausted');
};

async function tonBalance() {
  const a = await getJson(`https://tonapi.io/v2/accounts/${WALLET}`);
  return Number(a.balance) / 1e9;
}
async function jettonBalances() {
  const d = await getJson(`https://tonapi.io/v2/accounts/${WALLET}/jettons`);
  const out = {};
  for (const b of d.balances || []) out[raw(b.jetton.address)] = { units: BigInt(b.balance), jwallet: b.wallet_address?.address };
  return out;
}

let keyPair = null;
async function wallet() {
  if (keyPair) return keyPair;
  const m = (process.env.TON_MNEMONIC || '').trim().split(/\s+/);
  if (m.length < 12) throw new Error('TON_MNEMONIC secret missing');
  const k = await mnemonicToPrivateKey(m);
  const w = WalletContractV4.create({ workchain: 0, publicKey: k.publicKey });
  if (!w.address.equals(Address.parse(WALLET))) throw new Error('mnemonic does not match trading wallet; refusing');
  keyPair = { k, w };
  return keyPair;
}

const api = new StonApiClient();
const client = new Client({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

async function quote(master, units) {
  return retry429(() => api.simulateSwap({ offerAddress: master, askAddress: TON, offerUnits: units.toString(), slippageTolerance: SLIPPAGE, dexV2: true }));
}

async function sell(sym, pos, units, sim, jwallet, reason) {
  const { k, w } = await wallet();
  const { Router, pTON } = dexFactory(sim.router);
  const router = client.open(Router.create(sim.router.address));
  const proxyTon = pTON.create(sim.router.ptonMasterAddress);
  const p = await retry429(() => router.getSwapJettonToTonTxParams({
    userWalletAddress: WALLET, offerJettonAddress: pos.master, offerAmount: sim.offerUnits, minAskAmount: sim.minAskUnits, proxyTon,
  }));
  // Safety: message must go to OUR jetton wallet (a jetton transfer to the STON.fi router), small gas attach only.
  const attach = Number(p.value) / 1e9;
  if (jwallet && raw(p.to.toString()) !== raw(jwallet)) throw new Error(`${sym}: swap target is not our jetton wallet; refusing`);
  if (attach > MAX_GAS_ATTACH) throw new Error(`${sym}: gas attach ${attach} TON too high; refusing`);
  const tonBal = await tonBalance();
  if (tonBal - attach < 0.02) throw new Error(`${sym}: not enough TON for gas (${tonBal})`);
  log(`SELL ${sym} reason="${reason}" units=${sim.offerUnits} expect=${Number(sim.askUnits) / 1e9} TON min=${Number(sim.minAskUnits) / 1e9} TON router=${sim.router.address} gas_attach=${attach} dry=${DRY}`);
  if (DRY) return { sent: false };
  const wc = client.open(w);
  const seqno = await retry429(() => wc.getSeqno());
  await sleep(1200);
  await retry429(() => wc.sendTransfer({ seqno, secretKey: k.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS, messages: [internal(p)] }));
  for (let i = 0; i < 30; i++) { await sleep(3000); try { if ((await wc.getSeqno()) > seqno) break; } catch {} }
  return { sent: true, seqno };
}

function stopFor(pos) {
  const e = pos.entry_ton;
  if (pos.breakeven_armed || pos.peak_ton >= e * (1 + ARM_BE)) return { stop: Math.max(e, pos.peak_ton * (1 - TRAIL)), kind: 'trailing(>=breakeven)' };
  return { stop: e * (1 - HARD_STOP), kind: 'hard -12%' };
}

async function tick(st) {
  const liquidate = kyiv().slice(0, 10) >= LIQUIDATE_FROM;
  const bals = await jettonBalances();
  const tonBal = await tonBalance();
  const parts = [`TON=${tonBal.toFixed(4)}`];
  let totalTon = tonBal;
  for (const [sym, pos] of Object.entries(st.positions)) {
    if (pos.status === 'sold') continue;
    const b = bals[raw(pos.master)];
    const units = b?.units ?? 0n;
    if (units === 0n) {
      if (pos.status === 'selling') {
        const gained = tonBal - (pos.ton_before_sell ?? tonBal);
        trade({ event: 'SOLD_CONFIRMED', sym, ton_balance_after: tonBal, ton_delta_approx: Number(gained.toFixed(4)), entry_ton: pos.entry_ton, sell_price_ton: pos.sell_price_ton, pnl_pct: pos.sell_pnl_pct, reason: pos.sell_reason });
      } else trade({ event: 'POSITION_GONE', sym, note: 'balance is 0 on-chain' });
      pos.status = 'sold'; pos.closed = kyiv() + ' Kyiv';
      continue;
    }
    let sim;
    try { sim = await quote(pos.master, units); } catch (e) { log(`${sym} quote failed: ${e.message}`); parts.push(`${sym}=quote_failed`); continue; }
    const amt = Number(units) / 10 ** pos.decimals;
    const price = Number(sim.askUnits) / 1e9 / amt;   // real exit price (TON per token) for the whole position
    totalTon += Number(sim.askUnits) / 1e9;
    if (price > pos.peak_ton) pos.peak_ton = price;
    if (!pos.breakeven_armed && pos.peak_ton >= pos.entry_ton * (1 + ARM_BE)) { pos.breakeven_armed = true; log(`${sym} reached +15%: stop moved to breakeven, trailing 15% below peak`); }
    const { stop, kind } = stopFor(pos);
    const pnl = (price / pos.entry_ton - 1) * 100;
    pos.last_price_ton = price; pos.last_pnl_pct = Number(pnl.toFixed(2)); pos.stop_ton = stop; pos.stop_kind = kind; pos.last_check = kyiv() + ' Kyiv';
    parts.push(`${sym} px=${price.toPrecision(5)} entry=${pos.entry_ton} pnl=${pnl.toFixed(2)}% peak=${pos.peak_ton.toPrecision(5)} stop=${stop.toPrecision(5)}(${kind}) value=${(Number(sim.askUnits) / 1e9).toFixed(4)}TON`);

    let reason = null;
    if (liquidate) reason = 'deadline: after 25 Nov, sell everything';
    else if (price <= stop) {
      pos.below_stop_ticks = (pos.below_stop_ticks || 0) + 1;
      log(`${sym} below stop (${pos.below_stop_ticks}/${CONFIRM_TICKS})`);
      if (pos.below_stop_ticks >= CONFIRM_TICKS) reason = `${kind} stop hit: price ${price.toPrecision(5)} <= stop ${stop.toPrecision(5)} (pnl ${pnl.toFixed(2)}%)`;
    } else pos.below_stop_ticks = 0;
    if (!reason) continue;
    if (pos.status === 'selling' && Date.now() - (pos.sell_ts || 0) < RESEND_AFTER_MS) { log(`${sym} sell already in flight, waiting`); continue; }
    try {
      const before = tonBal;
      const r = await sell(sym, pos, units, sim, b?.jwallet, reason);
      if (r.sent) {
        Object.assign(pos, { status: 'selling', sell_ts: Date.now(), ton_before_sell: before, sell_reason: reason, sell_price_ton: price, sell_pnl_pct: Number(pnl.toFixed(2)) });
        trade({ event: 'SELL_SENT', sym, reason, units: units.toString(), expect_ton: Number(sim.askUnits) / 1e9, min_ton: Number(sim.minAskUnits) / 1e9, price_ton: price, entry_ton: pos.entry_ton, pnl_pct: Number(pnl.toFixed(2)), seqno: r.seqno });
      } else log(`${sym} DRY: would sell (${reason})`);
    } catch (e) { log(`${sym} SELL FAILED: ${e.message}`); trade({ event: 'SELL_FAILED', sym, reason, error: String(e.message).slice(0, 200) }); }
  }
  log('scan ' + parts.join(' | ') + ` | total≈${totalTon.toFixed(4)} TON`);
  st.last_total_ton = Number(totalTon.toFixed(4));
  if (tonBal < MIN_TON_GAS) log(`warning: TON balance ${tonBal} below ${MIN_TON_GAS} reserve`);

  if (liquidate && !st.final_liquidation_done && Object.values(st.positions).every((p) => p.status === 'sold')) {
    st.final_liquidation_done = true;
    trade({ event: 'FINAL', note: 'all positions sold to TON after 25 Nov; workflow will disable itself', ton_balance: tonBal });
    fs.writeFileSync(path.join(DIR, '.disable-workflow'), '1');
  }
  return st;
}

async function main() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  log(`trader start dry=${DRY} rules: hard stop -${HARD_STOP * 100}%, at +${ARM_BE * 100}% -> breakeven then trail ${TRAIL * 100}% below peak, confirm ${CONFIRM_TICKS} ticks, liquidate from ${LIQUIDATE_FROM} Kyiv; webhook: none`);
  if (st.final_liquidation_done) { log('final liquidation already done; nothing to do'); fs.writeFileSync(path.join(DIR, '.disable-workflow'), '1'); return; }
  if (!DRY) await wallet(); // verify secret matches wallet early (never printed)
  const start = Date.now();
  for (let i = 1; ; i++) {
    try { await tick(st); save(st); } catch (e) { log(`tick error: ${e.message}`); }
    if (ONCE || st.final_liquidation_done) break;
    const next = start + i * INTERVAL_MS;
    if (next > start + WINDOW_MS) break;
    await sleep(Math.max(0, next - Date.now()));
  }
  log('trader done');
}
main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
