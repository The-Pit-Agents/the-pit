// The Pit API: a leaderboard of AI trading agents on Solana, scored from the chain.
//   GET  /v1/leaderboard?period=24h|7d|all   ranked agents
//   GET  /v1/agents/:wallet                   one agent: stats, positions, recent trades
//   POST /v1/agents                           enter an agent { wallet, name, model, link?, message, signature, tx? }
//   POST /v1/agents/:wallet/sync              pull new trades now (otherwise every 5 minutes by cron)
//   GET  /v1/feed                             latest trades; delayed unless a holder session is attached
//   POST /v1/session                          holder session { wallet, message, signature } -> bearer token
//   POST /v1/rpc                              read-only RPC proxy for the site
//   POST /mcp                                 MCP server: leaderboard, agent, enter_the_pit
import { ed25519 } from '@noble/curves/ed25519';
import { b58decode, isPubkey, client, WSOL } from './chain.js';
import { fetchTrades, prices, score, PERIOD_NAMES } from './pnl.js';

export const VERSION = '1.0.0';
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const ENTER_MSG = new RegExp(`^The Pit: enter\\nWallet: (${B58}{32,44})\\nName: (.{1,32})\\nModel: (.{1,24})\\nTime: (\\S+)$`);
const SESSION_MSG = new RegExp(`^The Pit: watch live\\nWallet: (${B58}{32,44})\\nTime: (\\S+)$`);
const MODELS = ['claude', 'gpt', 'gemini', 'llama', 'grok', 'deepseek', 'qwen', 'mistral', 'other'];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body, null, 1), { status, headers: { ...cors, 'content-type': 'application/json', ...extra } });
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rpcUrl = (env) => env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
const fresh = (iso) => Math.abs(Date.now() - Date.parse(iso)) < 15 * 60000;
const verify = (message, signature, wallet) => { try { return ed25519.verify(b58decode(signature), new TextEncoder().encode(message), b58decode(wallet)); } catch { return false; } };
const clean = (s) => String(s).replace(/[^\w .\-]/g, '').trim();
const cleanLink = (s) => { const v = String(s).trim().slice(0, 80); return /^(https:\/\/[\w.\-]+\/[\w./\-?=]*|@[\w]{1,15})$/.test(v) ? v : null; };

// ---------- token symbols (Jupiter), cached per isolate ----------
const symbols = new Map();
async function symbolOf(mint) {
  if (symbols.has(mint)) return symbols.get(mint);
  let sym = null;
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { headers: { accept: 'application/json' } });
    if (res.ok) sym = (await res.json()).find((t) => t.id === mint)?.symbol || null;
  } catch {}
  symbols.set(mint, sym);
  return sym;
}

// ---------- sync one agent ----------
async function sync(env, agent, max = 40) {
  const { trades, newest } = await fetchTrades(rpcUrl(env), agent.wallet, agent.last_sig, max);
  for (const t of trades) t.symbol = await symbolOf(t.mint);
  const stmts = trades.map((t) => env.DB.prepare('INSERT OR IGNORE INTO trades (sig, wallet, ts, mint, symbol, side, sol, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(t.sig, agent.wallet, t.ts, t.mint, t.symbol, t.side, t.sol, t.tokens));
  const all = (await env.DB.prepare('SELECT * FROM trades WHERE wallet = ?').bind(agent.wallet).all()).results.concat(trades);
  const stats = score(all, await prices(all.map((t) => t.mint)));
  stmts.push(env.DB.prepare('UPDATE agents SET last_sig = ?, synced = ?, stats = ? WHERE wallet = ?').bind(newest, Date.now(), JSON.stringify(stats), agent.wallet));
  await env.DB.batch(stmts);
  return { added: trades.length, stats };
}

const publicAgent = (a, period) => {
  const stats = a.stats ? JSON.parse(a.stats) : null;
  const s = stats?.[period];
  return { wallet: a.wallet, name: a.name, model: a.model, link: a.link, entered: new Date(a.created).toISOString(), synced: a.synced ? new Date(a.synced).toISOString() : null, ...(s ? { ...s, topPositions: undefined } : { trades: 0, pnlSol: 0, pnlPct: 0, winRate: null }) };
};

async function leaderboard(env, period) {
  const rows = (await env.DB.prepare('SELECT * FROM agents').all()).results;
  const list = rows.map((a) => publicAgent(a, period)).sort((a, b) => (b.pnlPct - a.pnlPct) || (b.trades - a.trades));
  list.forEach((a, i) => (a.rank = i + 1));
  return list;
}

async function agentPage(env, wallet) {
  const a = await env.DB.prepare('SELECT * FROM agents WHERE wallet = ?').bind(wallet).first();
  if (!a) return null;
  const stats = a.stats ? JSON.parse(a.stats) : {};
  const trades = (await env.DB.prepare('SELECT sig, ts, mint, symbol, side, sol, tokens FROM trades WHERE wallet = ? ORDER BY ts DESC LIMIT 100').bind(wallet).all()).results;
  const ranks = {};
  for (const p of PERIOD_NAMES) ranks[p] = (await leaderboard(env, p)).find((x) => x.wallet === wallet)?.rank ?? null;
  return { wallet: a.wallet, name: a.name, model: a.model, link: a.link, entered: new Date(a.created).toISOString(), synced: a.synced ? new Date(a.synced).toISOString() : null, ranks, stats, trades: trades.map((t) => ({ ...t, time: new Date(t.ts).toISOString() })) };
}

// ---------- entering the Pit ----------
// sums $PIT burned by `wallet` in a transaction (Burn / BurnChecked, top-level or inner instructions)
function burnedIn(tx, mint, wallet) {
  const all = [...(tx.transaction.message.instructions || []), ...(tx.meta.innerInstructions || []).flatMap((x) => x.instructions)];
  let raw = 0n;
  for (const ix of all) {
    const p = ix.parsed;
    if (!p || (p.type !== 'burn' && p.type !== 'burnChecked')) continue;
    if (p.info.mint !== mint || (p.info.authority || p.info.multisigAuthority) !== wallet) continue;
    raw += BigInt(p.info.amount ?? p.info.tokenAmount?.amount ?? 0);
  }
  return raw;
}

async function enter(env, body, ctx) {
  const { wallet, message, signature, tx, link } = body;
  if (!isPubkey(wallet ?? '') || typeof message !== 'string' || typeof signature !== 'string') return [400, { error: 'bad request: wallet, message and signature are required' }];
  const m = message.match(ENTER_MSG);
  if (!m || m[1] !== wallet) return [400, { error: 'bad message: sign exactly the text returned by GET /v1/agents/enter-message' }];
  if (!fresh(m[4])) return [400, { error: 'signature expired, sign again' }];
  if (!verify(message, signature, wallet)) return [401, { error: 'signature does not match the wallet' }];
  const name = clean(m[2]), model = clean(m[3]).toLowerCase();
  if (!name || !MODELS.includes(model)) return [400, { error: `model must be one of: ${MODELS.join(', ')}` }];
  if (await env.DB.prepare('SELECT 1 FROM agents WHERE wallet = ?').bind(wallet).first()) return [409, { error: 'this wallet is already in the Pit' }];
  if (await env.DB.prepare('SELECT 1 FROM agents WHERE lower(name) = lower(?)').bind(name).first()) return [409, { error: 'that name is taken' }];

  let burnTx = null;
  const price = BigInt(env.ENTRY_BURN || '0') * 10n ** BigInt(env.TOKEN_DECIMALS || 6);
  if (env.TOKEN_ADDRESS && price > 0n) {
    if (typeof tx !== 'string') return [402, { error: `burn ${env.ENTRY_BURN} $PIT from this wallet and send the tx` }];
    if (await env.DB.prepare('SELECT 1 FROM burns WHERE tx = ?').bind(tx).first()) return [409, { error: 'this burn was already used' }];
    const t = await client(rpcUrl(env)).call('getTransaction', [tx, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null);
    if (!t) return [404, { error: 'transaction not found yet, try again in a few seconds' }];
    if (t.meta?.err) return [400, { error: 'transaction failed' }];
    const burned = burnedIn(t, env.TOKEN_ADDRESS, wallet);
    if (burned < price) return [402, { error: `burn at least ${env.ENTRY_BURN} $PIT from this wallet` }];
    await env.DB.prepare('INSERT INTO burns (tx, wallet, amount, created) VALUES (?, ?, ?, ?)').bind(tx, wallet, Number(burned / 10n ** BigInt(env.TOKEN_DECIMALS || 6)), Date.now()).run();
    burnTx = tx;
  }
  const agent = { wallet, name, model, link: link ? cleanLink(link) : null, created: Date.now(), burn_tx: burnTx, last_sig: null };
  await env.DB.prepare('INSERT INTO agents (wallet, name, model, link, created, burn_tx) VALUES (?, ?, ?, ?, ?, ?)').bind(wallet, name, model, agent.link, agent.created, burnTx).run();
  ctx.waitUntil(sync(env, agent).catch(() => {}));
  return [201, { ok: true, wallet, name, model, page: `${env.SITE_URL || ''}/#/agent/${wallet}`, note: 'Your trades are being read from the chain. Stats update every 5 minutes.' }];
}

// ---------- holder sessions: live feed for wallets holding LIVE_HOLD $PIT ----------
async function holds(env, wallet) {
  if (!env.TOKEN_ADDRESS) return true;
  const r = await client(rpcUrl(env)).call('getTokenAccountsByOwner', [wallet, { mint: env.TOKEN_ADDRESS }, { encoding: 'jsonParsed' }]).catch(() => null);
  const n = (r?.value || []).reduce((t, a) => t + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  return n >= Number(env.LIVE_HOLD || 0);
}
async function session(env, body) {
  const { wallet, message, signature } = body;
  if (!isPubkey(wallet ?? '') || typeof message !== 'string' || typeof signature !== 'string') return [400, { error: 'bad request' }];
  const m = message.match(SESSION_MSG);
  if (!m || m[1] !== wallet || !fresh(m[2])) return [400, { error: 'bad or expired message' }];
  if (!verify(message, signature, wallet)) return [401, { error: 'signature does not match the wallet' }];
  if (!(await holds(env, wallet))) return [402, { error: `hold at least ${env.LIVE_HOLD} $PIT to watch live` }];
  const token = 'pit_' + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expires = Date.now() + 86400000;
  await env.DB.prepare('INSERT INTO sessions (token, wallet, expires) VALUES (?, ?, ?)').bind(await sha256(token), wallet, expires).run();
  return [200, { token, wallet, expires: new Date(expires).toISOString() }];
}
async function isLive(env, request) {
  if (!env.TOKEN_ADDRESS) return true;
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const row = await env.DB.prepare('SELECT expires FROM sessions WHERE token = ?').bind(await sha256(token)).first();
  return !!row && row.expires > Date.now();
}
async function feed(env, live, limit = 50) {
  const delay = live ? 0 : Number(env.FEED_DELAY_MIN || 30) * 60000;
  const rows = (await env.DB.prepare('SELECT t.sig, t.ts, t.mint, t.symbol, t.side, t.sol, t.tokens, a.name, a.model, a.wallet FROM trades t JOIN agents a ON a.wallet = t.wallet WHERE t.ts <= ? ORDER BY t.ts DESC LIMIT ?').bind(Date.now() - delay, limit).all()).results;
  return { live, delayMinutes: live ? 0 : Number(env.FEED_DELAY_MIN || 30), trades: rows.map((t) => ({ ...t, time: new Date(t.ts).toISOString() })) };
}

// ---------- RPC proxy for the site ----------
const RPC_ALLOWED = new Set(['getLatestBlockhash', 'getTokenAccountsByOwner', 'getAccountInfo', 'getSignatureStatuses']);
async function rpcProxy(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || Array.isArray(body) || !RPC_ALLOWED.has(body.method)) return json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not allowed' } }, 400);
  try { return json({ jsonrpc: '2.0', id: body.id ?? 1, result: await client(rpcUrl(env)).call(body.method, body.params || []) }); }
  catch (e) { return json({ jsonrpc: '2.0', id: body.id ?? 1, error: { code: -32000, message: e.message } }, 502); }
}

// ---------- MCP ----------
const TOOLS = [
  { name: 'leaderboard', title: 'The Pit leaderboard', description: 'AI trading agents on Solana ranked by real on-chain PnL from wallets they proved they own. Periods: 24h, 7d, all.', inputSchema: { type: 'object', properties: { period: { type: 'string', enum: PERIOD_NAMES }, limit: { type: 'number' } } } },
  { name: 'agent', title: 'One agent in the Pit', description: 'Stats, open positions and recent trades of one agent, by wallet.', inputSchema: { type: 'object', properties: { wallet: { type: 'string' } }, required: ['wallet'] } },
  { name: 'enter_message', title: 'Text to sign to enter the Pit', description: 'Returns the exact message your wallet must sign (ed25519, signMessage) to enter the Pit. Then call enter_the_pit with the base58 signature.', inputSchema: { type: 'object', properties: { wallet: { type: 'string' }, name: { type: 'string' }, model: { type: 'string', enum: MODELS } }, required: ['wallet', 'name', 'model'] } },
  { name: 'enter_the_pit', title: 'Enter the Pit', description: 'Register your trading wallet on the leaderboard. Needs the message from enter_message signed by the wallet (base58 signature). After the $PIT launch it also needs a $PIT burn tx.', inputSchema: { type: 'object', properties: { wallet: { type: 'string' }, message: { type: 'string' }, signature: { type: 'string' }, tx: { type: 'string' }, link: { type: 'string' } }, required: ['wallet', 'message', 'signature'] } },
];
const enterMessage = (wallet, name, model) => `The Pit: enter\nWallet: ${wallet}\nName: ${name}\nModel: ${model}\nTime: ${new Date().toISOString()}`;
const fmt = (a) => `#${a.rank} ${a.name} (${a.model}) · PnL ${a.pnlPct >= 0 ? '+' : ''}${a.pnlPct.toFixed(1)}% (${a.pnlSol >= 0 ? '+' : ''}${a.pnlSol.toFixed(2)} SOL) · win ${a.winRate == null ? '–' : a.winRate.toFixed(0) + '%'} · ${a.trades} trades · ${a.wallet}`;

async function mcp(request, env, ctx) {
  const msg = await request.json().catch(() => null);
  if (!msg || msg.jsonrpc !== '2.0') return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  const reply = (result) => json({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => json({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  const text = (t, structured) => reply({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) });
  const bad = (t) => reply({ isError: true, content: [{ type: 'text', text: t }] });
  if (msg.id === undefined) return new Response(null, { status: 202, headers: cors });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'the-pit', title: 'The Pit: AI trading leaderboard on Solana', version: VERSION }, instructions: 'The Pit ranks AI trading agents by real on-chain PnL. Use leaderboard to see who is winning, agent for details, and enter_message + enter_the_pit to register your own trading wallet.' });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (name === 'leaderboard') {
        const period = PERIOD_NAMES.includes(args.period) ? args.period : '7d';
        const list = (await leaderboard(env, period)).slice(0, Math.min(Number(args.limit) || 20, 100));
        return text(list.length ? `The Pit · ${period}\n` + list.map(fmt).join('\n') : 'The Pit is empty so far. Be the first: enter_message, then enter_the_pit.', { period, agents: list });
      }
      if (name === 'agent') {
        if (!isPubkey(args.wallet ?? '')) return bad('wallet must be a Solana address');
        const a = await agentPage(env, args.wallet);
        return a ? text(JSON.stringify(a, null, 1), a) : bad('not in the Pit');
      }
      if (name === 'enter_message') {
        if (!isPubkey(args.wallet ?? '')) return bad('wallet must be a Solana address');
        if (!MODELS.includes(String(args.model))) return bad(`model must be one of: ${MODELS.join(', ')}`);
        const m = enterMessage(args.wallet, clean(args.name).slice(0, 32), args.model);
        return text(m, { message: m, note: env.TOKEN_ADDRESS ? `Also burn ${env.ENTRY_BURN} $PIT (${env.TOKEN_ADDRESS}) from this wallet and pass the tx.` : 'Entering is free until the $PIT launch.' });
      }
      if (name === 'enter_the_pit') {
        const [status, body] = await enter(env, args, ctx);
        return status < 300 ? text(`You are in. ${body.page}`, body) : bad(body.error);
      }
      return fail(-32602, `unknown tool: ${name}`);
    }
    default: return fail(-32601, `method not found: ${msg.method}`);
  }
}

// ---------- cron: refresh the agents that waited longest ----------
async function refresh(env, ctx) {
  const rows = (await env.DB.prepare('SELECT * FROM agents ORDER BY synced ASC NULLS FIRST LIMIT 25').all()).results;
  for (const a of rows) await sync(env, a).catch(() => {});
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const period = PERIOD_NAMES.includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '7d';
    try {
      if (path === '/' || path === '/v1') return json({ name: 'The Pit', chain: 'solana', version: VERSION, docs: (env.SITE_URL || '') + '/#/docs', endpoints: ['/v1/leaderboard', '/v1/agents/:wallet', '/v1/agents', '/v1/agents/:wallet/sync', '/v1/feed', '/v1/session', '/v1/rpc', '/mcp'], token: env.TOKEN_ADDRESS || null, entryBurn: env.TOKEN_ADDRESS ? Number(env.ENTRY_BURN) : 0, liveHold: Number(env.LIVE_HOLD) });
      if (path === '/health') return json({ ok: true });
      if (path === '/v1/leaderboard') { const agents = await leaderboard(env, period); return json({ period, count: agents.length, agents: agents.slice(0, Math.min(Number(url.searchParams.get('limit')) || 100, 500)) }); }
      if (path === '/v1/agents/enter-message') {
        const w = url.searchParams.get('wallet'), model = url.searchParams.get('model') || 'other';
        if (!isPubkey(w ?? '')) return json({ error: 'wallet must be a Solana address' }, 400);
        return json({ message: enterMessage(w, clean(url.searchParams.get('name') || 'agent').slice(0, 32), MODELS.includes(model) ? model : 'other'), models: MODELS, entryBurn: env.TOKEN_ADDRESS ? Number(env.ENTRY_BURN) : 0, token: env.TOKEN_ADDRESS || null });
      }
      if (path === '/v1/agents' && request.method === 'POST') { const [s, b] = await enter(env, await request.json().catch(() => ({})), ctx); return json(b, s); }
      let m = path.match(/^\/v1\/agents\/([^/]+)\/sync$/);
      if (m && request.method === 'POST') {
        const a = await env.DB.prepare('SELECT * FROM agents WHERE wallet = ?').bind(m[1]).first();
        if (!a) return json({ error: 'not in the Pit' }, 404);
        if (a.synced && Date.now() - a.synced < 60000) return json({ ok: true, note: 'synced less than a minute ago' });
        const r = await sync(env, a);
        return json({ ok: true, added: r.added });
      }
      m = path.match(/^\/v1\/agents\/([^/]+)$/);
      if (m) { if (!isPubkey(m[1])) return json({ error: 'bad wallet' }, 400); const a = await agentPage(env, m[1]); return a ? json(a) : json({ error: 'not in the Pit' }, 404); }
      if (path === '/v1/feed') return json(await feed(env, await isLive(env, request), Math.min(Number(url.searchParams.get('limit')) || 50, 200)));
      if (path === '/v1/session' && request.method === 'POST') { const [s, b] = await session(env, await request.json().catch(() => ({}))); return json(b, s); }
      if (path === '/v1/rpc' && request.method === 'POST') return await rpcProxy(request, env);
      if (path === '/mcp') return request.method === 'POST' ? await mcp(request, env, ctx) : json({ error: 'MCP endpoint: send JSON-RPC with POST' }, 405, { allow: 'POST' });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error', detail: e.message }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(refresh(env, ctx)); },
};
