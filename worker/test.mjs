// Exercises the worker in Node: node:sqlite stands in for D1; trade reads hit the live chain (public RPC unless SOL_RPC_URL is set).
// Run: node test.mjs
import { ed25519 } from '@noble/curves/ed25519';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';
import { b58encode } from './src/chain.js';
import { tradeFrom, score } from './src/pnl.js';

const RPC = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
const env = { DB: sqliteD1(), SOL_RPC_URL: RPC, TOKEN_ADDRESS: '', TOKEN_DECIMALS: '6', ENTRY_BURN: '250000', LIVE_HOLD: '500000', FEED_DELAY_MIN: '30', SITE_URL: 'https://pit.test' };
const LIVE_WALLET = 'HnYgQ67S1oDDgYVv5jBkFwisRHg6U2GjXoyrkaJ7ZTaq'; // a real wallet with pump.fun trades
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail).slice(0, 400)}`); };
const call = async (path, init = {}) => {
  const res = await worker.fetch(new Request('https://api.pit.test' + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : null];
};
const wallet = () => { const sk = ed25519.utils.randomPrivateKey(); return { sk, address: b58encode(ed25519.getPublicKey(sk)) }; };
const sign = (w, message) => b58encode(ed25519.sign(new TextEncoder().encode(message), w.sk));
const rpc = (method, params, id = 1) => call('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });

// ---------- pure: trade parsing ----------
const W = 'WaLLet111111111111111111111111111111111111';
const tx = (pre, post, preTok, postTok) => ({ meta: { err: null, preBalances: [pre], postBalances: [post], preTokenBalances: preTok, postTokenBalances: postTok }, transaction: { message: { accountKeys: [{ pubkey: W }] } } });
const tb = (mint, amt, owner = W) => ({ mint, owner, uiTokenAmount: { uiAmount: amt } });
check('buy parsed', JSON.stringify(tradeFrom(tx(2e9, 1e9, [], [tb('MintA', 1000)]), W)) === JSON.stringify({ mint: 'MintA', side: 'buy', sol: 1, tokens: 1000 }));
check('sell parsed', JSON.stringify(tradeFrom(tx(1e9, 1.5e9, [tb('MintA', 1000)], [tb('MintA', 0)]), W)) === JSON.stringify({ mint: 'MintA', side: 'sell', sol: 0.5, tokens: 1000 }));
check('transfer ignored', tradeFrom(tx(1e9, 1e9 - 5000, [tb('MintA', 1000)], [tb('MintA', 0)]), W) === null);
check('two tokens ignored', tradeFrom(tx(2e9, 1e9, [], [tb('MintA', 1), tb('MintB', 1)]), W) === null);
check('other owner ignored', tradeFrom(tx(2e9, 1e9, [], [tb('MintA', 1000, 'someone')]), W) === null);
check('wsol counts as sol', JSON.stringify(tradeFrom(tx(1e9, 1e9, [tb('So11111111111111111111111111111111111111112', 2)], [tb('So11111111111111111111111111111111111111112', 0), tb('MintA', 10)]), W)) === JSON.stringify({ mint: 'MintA', side: 'buy', sol: 2, tokens: 10 }));

// ---------- pure: scoring ----------
const now = Date.now();
const trades = [
  { ts: now - 3600e3, mint: 'A', side: 'buy', sol: 1, tokens: 100 }, { ts: now - 1800e3, mint: 'A', side: 'sell', sol: 2, tokens: 100 },      // closed, +1 SOL
  { ts: now - 2 * 86400e3, mint: 'B', side: 'buy', sol: 1, tokens: 100 },                                                                  // open, priced at 0.5 SOL
  { ts: now - 10 * 86400e3, mint: 'C', side: 'buy', sol: 1, tokens: 100 }, { ts: now - 9 * 86400e3, mint: 'C', side: 'sell', sol: 0.5, tokens: 100 }, // closed, -0.5 SOL, older than 7d
];
const px = { So11111111111111111111111111111111111111112: 100, B: 0.5 };
const s = score(trades, px, now);
check('24h: one closed win', s['24h'].trades === 2 && s['24h'].pnlSol === 1 && s['24h'].winRate === 100 && s['24h'].pnlPct === 100, s['24h']);
check('7d: realized + unrealized', Math.abs(s['7d'].pnlSol - 0.5) < 1e-9 && s['7d'].positions === 2 && Math.abs(s['7d'].pnlPct - 25) < 1e-9, s['7d']);
check('all: includes the loss', s.all.closed === 2 && s.all.winRate === 50 && Math.abs(s.all.pnlSol - 0) < 1e-9, s.all);
check('rugged counts -90%', score([{ ts: now, mint: 'R', side: 'buy', sol: 1, tokens: 100 }], { So11111111111111111111111111111111111111112: 100, R: 0.01 }, now).all.rugged === 1);

// ---------- api ----------
let [st, b] = await call('/');
check('root', st === 200 && b.name === 'The Pit' && b.entryBurn === 0, b);
[st, b] = await call('/v1/leaderboard');
check('empty leaderboard', st === 200 && b.count === 0, b);

const w = wallet();
[st, b] = await call(`/v1/agents/enter-message?wallet=${w.address}&name=test%20bot&model=claude`);
check('enter message', st === 200 && b.message.includes(`Wallet: ${w.address}`) && b.message.includes('Name: test bot'), b);
const msg = b.message;
[st, b] = await call('/v1/agents', { method: 'POST', body: JSON.stringify({ wallet: w.address, message: msg, signature: sign(wallet(), msg) }) });
check('wrong signature rejected', st === 401, b);
[st, b] = await call('/v1/agents', { method: 'POST', body: JSON.stringify({ wallet: w.address, message: msg.replace('Model: claude', 'Model: skynet'), signature: sign(w, msg.replace('Model: claude', 'Model: skynet')) }) });
check('unknown model rejected', st === 400, b);
[st, b] = await call('/v1/agents', { method: 'POST', body: JSON.stringify({ wallet: w.address, message: msg, signature: sign(w, msg), link: 'https://x.com/testbot' }) });
check('entered (free before launch)', st === 201 && b.page.endsWith(w.address), b);
[st, b] = await call('/v1/agents', { method: 'POST', body: JSON.stringify({ wallet: w.address, message: msg, signature: sign(w, msg) }) });
check('double entry rejected', st === 409, b);
const w2 = wallet();
const msg2 = (await call(`/v1/agents/enter-message?wallet=${w2.address}&name=TEST%20BOT&model=gpt`))[1].message;
[st, b] = await call('/v1/agents', { method: 'POST', body: JSON.stringify({ wallet: w2.address, message: msg2, signature: sign(w2, msg2) }) });
check('taken name rejected', st === 409, b);
[st, b] = await call(`/v1/agents/${w.address}`);
check('agent page', st === 200 && b.name === 'test bot' && b.link === 'https://x.com/testbot', b);
[st, b] = await call('/v1/leaderboard');
check('leaderboard has the agent', st === 200 && b.count === 1 && b.agents[0].rank === 1 && b.agents[0].trades === 0, b);

// burn gate after launch
env.TOKEN_ADDRESS = 'PiTMint1111111111111111111111111111111111111'.slice(0, 44);
const msg3 = (await call(`/v1/agents/enter-message?wallet=${w2.address}&name=second&model=gpt`))[1].message;
[st, b] = await call('/v1/agents', { method: 'POST', body: JSON.stringify({ wallet: w2.address, message: msg3, signature: sign(w2, msg3) }) });
check('burn required after launch', st === 402, b);
[st, b] = await call('/v1/feed');
check('feed delayed without session', st === 200 && b.live === false && b.delayMinutes === 30, b);
env.TOKEN_ADDRESS = '';
[st, b] = await call('/v1/feed');
check('feed live before launch', st === 200 && b.live === true, b);

// live chain: a real wallet
const msgL = (await call(`/v1/agents/enter-message?wallet=${LIVE_WALLET}&name=live&model=other`))[1].message;
// cannot sign for a wallet we do not own: insert directly, then sync through the API
await env.DB.prepare('INSERT INTO agents (wallet, name, model, created) VALUES (?, ?, ?, ?)').bind(LIVE_WALLET, 'live', 'other', Date.now()).run();
[st, b] = await call(`/v1/agents/${LIVE_WALLET}/sync`, { method: 'POST' });
check('live sync', st === 200 && b.added > 0, b);
[st, b] = await call(`/v1/agents/${LIVE_WALLET}`);
check('live agent has trades and stats', st === 200 && b.trades.length > 0 && b.stats.all.trades > 0 && b.trades[0].symbol, { trades: b.trades?.length, stats: b.stats?.all });
[st, b] = await call('/v1/leaderboard?period=all');
check('live agent ranked', b.agents[0].wallet === LIVE_WALLET, b.agents);

// mcp
[st, b] = await rpc('initialize', { protocolVersion: '2025-06-18' });
check('mcp initialize', st === 200 && b.result.serverInfo.name === 'the-pit', b);
[st, b] = await rpc('tools/list');
check('mcp tools', b.result.tools.map((t) => t.name).join() === 'leaderboard,agent,enter_message,enter_the_pit', b);
[st, b] = await rpc('tools/call', { name: 'leaderboard', arguments: { period: 'all' } });
check('mcp leaderboard', b.result.content[0].text.includes('#1 live'), b);
const w3 = wallet();
[st, b] = await rpc('tools/call', { name: 'enter_message', arguments: { wallet: w3.address, name: 'mcp bot', model: 'claude' } });
const m3 = b.result.structuredContent.message;
[st, b] = await rpc('tools/call', { name: 'enter_the_pit', arguments: { wallet: w3.address, message: m3, signature: sign(w3, m3) } });
check('mcp enter', st === 200 && !b.result.isError && b.result.structuredContent.ok, b);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
