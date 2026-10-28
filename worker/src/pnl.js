// Reads an agent's trades from the chain and scores them.
// A trade = one transaction where the wallet's SOL moved one way and exactly one token moved the other way.
import { client, WSOL } from './chain.js';

const LAMPORTS = 1e9;
const PERIODS = { '24h': 86400000, '7d': 7 * 86400000, all: Infinity };
export const PERIOD_NAMES = Object.keys(PERIODS);

// ---------- one transaction -> one trade (or null) ----------
export function tradeFrom(tx, wallet) {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  let sol = (meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS;
  const tokens = {};
  const add = (list, sign) => {
    for (const b of list || []) {
      if (b.owner !== wallet) continue;
      const amt = Number(b.uiTokenAmount?.uiAmount ?? 0) * sign;
      if (b.mint === WSOL) sol += amt; else tokens[b.mint] = (tokens[b.mint] || 0) + amt;
    }
  };
  add(meta.preTokenBalances, -1);
  add(meta.postTokenBalances, 1);
  const moved = Object.entries(tokens).filter(([, v]) => Math.abs(v) > 0);
  if (moved.length !== 1) return null;
  const [mint, amount] = moved[0];
  if (amount > 0 && sol < -0.000005) return { mint, side: 'buy', sol: -sol, tokens: amount };
  if (amount < 0 && sol > 0) return { mint, side: 'sell', sol, tokens: -amount };
  return null;
}

// ---------- pull new trades for a wallet ----------
// Walks signatures newest-first until `lastSig`, fetches at most `max` transactions, returns trades oldest-first.
export async function fetchTrades(rpcUrl, wallet, lastSig, max = 40) {
  const rpc = client(rpcUrl);
  const sigs = await rpc.call('getSignaturesForAddress', [wallet, { limit: Math.min(max, 100), ...(lastSig ? { until: lastSig } : {}) }]);
  const fresh = sigs.filter((s) => !s.err);
  const trades = [];
  for (const s of fresh.reverse()) {
    const tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null);
    if (!tx) continue;
    const t = tradeFrom(tx, wallet);
    if (t) trades.push({ sig: s.signature, ts: (tx.blockTime || s.blockTime || 0) * 1000, ...t });
  }
  return { trades, newest: sigs[0]?.signature || lastSig || null, more: sigs.length >= Math.min(max, 100), calls: rpc.calls };
}

// ---------- prices (Jupiter) ----------
export async function prices(mints) {
  const out = {};
  const ids = [...new Set([WSOL, ...mints])];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.slice(i, i + 50).join(',')}`, { headers: { accept: 'application/json' } }).catch(() => null);
    if (!res?.ok) continue;
    const j = await res.json();
    for (const [k, v] of Object.entries(j)) if (v?.usdPrice) out[k] = v.usdPrice;
  }
  return out;
}

// ---------- scoring ----------
// trades: all trades of the wallet, any order. priceUsd: mint -> usd (WSOL included). Returns stats per period.
export function score(trades, priceUsd, now = Date.now()) {
  const solUsd = priceUsd[WSOL] || 0;
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const out = {};
  for (const [name, span] of Object.entries(PERIODS)) {
    const since = span === Infinity ? 0 : now - span;
    const pos = {};
    let n = 0;
    for (const t of sorted) {
      if (t.ts < since) continue;
      n++;
      const p = pos[t.mint] ||= { mint: t.mint, symbol: t.symbol, boughtSol: 0, soldSol: 0, tokensIn: 0, tokensOut: 0, first: t.ts, last: t.ts };
      p.last = t.ts;
      if (t.side === 'buy') { p.boughtSol += t.sol; p.tokensIn += t.tokens; } else { p.soldSol += t.sol; p.tokensOut += t.tokens; }
    }
    let invested = 0, realized = 0, unrealized = 0, wins = 0, closed = 0, best = null, worst = null, rugged = 0;
    const positions = [];
    for (const p of Object.values(pos)) {
      const avgCost = p.tokensIn > 0 ? p.boughtSol / p.tokensIn : 0;
      const sold = Math.min(p.tokensOut, p.tokensIn);
      const left = Math.max(0, p.tokensIn - p.tokensOut);
      const costSold = avgCost * sold;
      const r = p.soldSol - costSold;                      // realized SOL on the part that was sold
      const leftSol = solUsd && priceUsd[p.mint] ? (left * priceUsd[p.mint]) / solUsd : null;
      const u = leftSol == null ? 0 : leftSol - avgCost * left; // unrealized SOL on what is still held
      const isClosed = p.tokensIn > 0 && left <= p.tokensIn * 0.01;
      const pnl = r + u;
      const pct = p.boughtSol > 0 ? (pnl / p.boughtSol) * 100 : 0;
      invested += p.boughtSol; realized += r; unrealized += u;
      if (isClosed) { closed++; if (r > 0) wins++; }
      if (!isClosed && left > 0 && leftSol != null && avgCost > 0 && leftSol < avgCost * left * 0.1) rugged++;
      if (p.boughtSol > 0 && (!best || pct > best.pct)) best = { mint: p.mint, symbol: p.symbol, pct, sol: pnl };
      if (p.boughtSol > 0 && (!worst || pct < worst.pct)) worst = { mint: p.mint, symbol: p.symbol, pct, sol: pnl };
      positions.push({ ...p, left, realizedSol: r, unrealizedSol: u, pnlSol: pnl, pnlPct: pct, closed: isClosed, priced: leftSol != null });
    }
    const pnl = realized + unrealized;
    out[name] = {
      trades: n, positions: positions.length, closed, investedSol: invested, realizedSol: realized, unrealizedSol: unrealized,
      pnlSol: pnl, pnlPct: invested > 0 ? (pnl / invested) * 100 : 0, winRate: closed > 0 ? (wins / closed) * 100 : null,
      best, worst, rugged,
      topPositions: positions.sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 8),
    };
  }
  return out;
}
