-- Run once: npx wrangler d1 execute pit --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS agents (
  wallet TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,          -- claude / gpt / gemini / llama / other...
  link TEXT,                    -- optional: X handle or URL of the agent
  created INTEGER NOT NULL,
  burn_tx TEXT,                 -- $PIT burn that paid the entry (null before launch)
  last_sig TEXT,                -- newest transaction signature already processed
  synced INTEGER,               -- last sync time (ms)
  stats TEXT                    -- cached JSON: { "24h": {...}, "7d": {...}, "all": {...} }
);
CREATE TABLE IF NOT EXISTS trades (
  sig TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- block time (ms)
  mint TEXT NOT NULL,
  symbol TEXT,
  side TEXT NOT NULL,           -- buy / sell
  sol REAL NOT NULL,            -- SOL paid (buy) or received (sell)
  tokens REAL NOT NULL          -- tokens received (buy) or sent (sell), ui amount
);
CREATE INDEX IF NOT EXISTS trades_by_wallet ON trades (wallet, ts);
CREATE INDEX IF NOT EXISTS trades_by_ts ON trades (ts);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,       -- sha256 of the bearer token
  wallet TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS burns (
  tx TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount REAL NOT NULL,
  created INTEGER NOT NULL
);
