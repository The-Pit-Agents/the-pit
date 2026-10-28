// Minimal Solana helpers: JSON-RPC with retries, base58, program-derived addresses and pump.fun account layouts.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; // pump.fun bonding curves
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'; // PumpSwap, where tokens graduate
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const PUMP_SUPPLY = 1_000_000_000n * 10n ** 6n; // every pump.fun token: 1B, 6 decimals
export const CURVE_TOKENS = 793_100_000n * 10n ** 6n; // tokens sold on the curve before graduation

// ---------- base58 ----------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { if (MAP[c] === undefined) throw new Error('bad base58'); n = n * 58n + MAP[c]; }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
export const isPubkey = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && (() => { try { return b58decode(s).length === 32; } catch { return false; } })();

// ---------- program-derived addresses ----------
const onCurve = (b) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
export function findPda(seeds, program) {
  const enc = new TextEncoder();
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds.map((s) => (typeof s === 'string' ? enc.encode(s) : s)), Uint8Array.of(bump), prog, enc.encode('ProgramDerivedAddress')];
    const buf = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    const h = sha256(buf);
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error('no PDA');
}
export const bondingCurve = (mint) => findPda(['bonding-curve', b58decode(mint)], PUMP);
export const ata = (owner, mint, tokenProgram) => findPda([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA);

// ---------- account layouts ----------
const u64 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// pump.fun BondingCurve: 8-byte discriminator, 5 x u64 reserves, complete flag, creator (newer curves)
export function decodeCurve(b64) {
  const b = fromB64(b64);
  if (b.length < 49) return null;
  return {
    virtualToken: u64(b, 8), virtualSol: u64(b, 16), realToken: u64(b, 24), realSol: u64(b, 32), supply: u64(b, 40),
    complete: b[48] === 1,
    creator: b.length >= 81 ? b58encode(b.slice(49, 81)) : null,
  };
}
// SPL token account: mint(32) owner(32) amount(u64)
export function decodeTokenAccount(b64) {
  const b = fromB64(b64);
  if (b.length < 72) return null;
  return { mint: b58encode(b.slice(0, 32)), owner: b58encode(b.slice(32, 64)), amount: u64(b, 64) };
}

// ---------- JSON-RPC ----------
export function client(url) {
  let calls = 0;
  async function call(method, params, retries = 4) {
    for (let attempt = 0; ; attempt++) {
      calls++;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200)); continue; }
      if (!res.ok) { const e = new Error(`Solana RPC busy (${res.status}), try again in a moment`); e.status = 503; throw e; }
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    }
  }
  return { call, get calls() { return calls; } };
}
