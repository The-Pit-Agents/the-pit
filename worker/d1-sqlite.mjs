// Minimal stand-in for a Cloudflare D1 binding on top of node:sqlite, for tests and local development.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function sqliteD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec('BEGIN'); try { for (const s of list) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}
