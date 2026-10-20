import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Section } from './chunk.ts';
import type { Sheet } from './manifest.ts';
import { dataPaths } from './paths.ts';

export type DB = Database.Database;

const SCHEMA_VERSION = 1;

/** Open (and create or migrate) index.db. Everything in it is rebuildable from the library. */
export function openDb(file = dataPaths().db): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sheets (
      id      TEXT PRIMARY KEY,
      sha256  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sections (
      id       INTEGER PRIMARY KEY,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      idx      INTEGER NOT NULL,
      heading  TEXT NOT NULL,
      text     TEXT NOT NULL,
      UNIQUE (sheet_id, idx)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
      title, heading, text, tags,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function removeSheet(db: DB, id: string): void {
  db.prepare('DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE sheet_id = ?)').run(id);
  db.prepare('DELETE FROM sheets WHERE id = ?').run(id);
}

/** Replace everything indexed for one sheet. */
export function indexSheet(db: DB, sheet: Sheet, sections: Section[]): void {
  const insertSection = db.prepare('INSERT INTO sections (sheet_id, idx, heading, text) VALUES (?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO sections_fts (rowid, title, heading, text, tags) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    removeSheet(db, sheet.id);
    db.prepare('INSERT INTO sheets (id, sha256) VALUES (?, ?)').run(sheet.id, sheet.sha256);
    const tags = sheet.tags.join(' ');
    for (const s of sections) {
      const { lastInsertRowid } = insertSection.run(sheet.id, s.idx, s.heading, s.text);
      insertFts.run(lastInsertRowid, sheet.title, s.heading, s.text, tags);
    }
  })();
}

/** sheet id to indexed sha256. */
export function indexedSheets(db: DB): Map<string, string> {
  const rows = db.prepare('SELECT id, sha256 FROM sheets').all() as { id: string; sha256: string }[];
  return new Map(rows.map((r) => [r.id, r.sha256]));
}

export function sectionCount(db: DB): number {
  return (db.prepare('SELECT count(*) AS n FROM sections').get() as { n: number }).n;
}
