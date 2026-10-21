import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Section } from './chunk.ts';
import type { Sheet } from './manifest.ts';
import { dataPaths } from './paths.ts';
import { sha256 } from './util.ts';

export type DB = Database.Database;

const SCHEMA_VERSION = 3;

/** Section text beyond this is not embedded (bge-m3 reads about 8k tokens; the model truncates anyway). */
const EMBED_MAX_CHARS = 8000;

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

const EMBEDDINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS embeddings (
    hash  TEXT NOT NULL,
    model TEXT NOT NULL,
    vec   BLOB NOT NULL,
    PRIMARY KEY (hash, model)
  ) WITHOUT ROWID;`;

function migrate(db: DB): void {
  let version = db.pragma('user_version', { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;
  if (version === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sheets (
        id      TEXT PRIMARY KEY,
        sha256  TEXT NOT NULL,
        meta    TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS sections (
        id       INTEGER PRIMARY KEY,
        sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        idx      INTEGER NOT NULL,
        heading  TEXT NOT NULL,
        text     TEXT NOT NULL,
        hash     TEXT NOT NULL DEFAULT '',
        UNIQUE (sheet_id, idx)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
        title, heading, text, tags,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
      ${EMBEDDINGS_TABLE}
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    return;
  }
  db.transaction(() => {
    // v2 added sheets.meta (title and tags as indexed), so a tag edit in manifest.json re-indexes.
    if (version === 1) {
      db.exec(`ALTER TABLE sheets ADD COLUMN meta TEXT NOT NULL DEFAULT ''`);
      version = 2;
    }
    // v3 added embeddings, keyed by the hash of the embedded text so unchanged sections keep
    // their vectors when a sheet is re-indexed. Old rows get their hash on the next embed run.
    if (version === 2) {
      db.exec(`ALTER TABLE sections ADD COLUMN hash TEXT NOT NULL DEFAULT ''; ${EMBEDDINGS_TABLE}`);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

/** What gets embedded for a section: the sheet title gives short sections their context. */
export function embedInput(title: string, text: string): string {
  return `${title}

${text}`.slice(0, EMBED_MAX_CHARS);
}

export function embedHash(title: string, text: string): string {
  return sha256(embedInput(title, text));
}

export function removeSheet(db: DB, id: string): void {
  db.prepare('DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE sheet_id = ?)').run(id);
  db.prepare('DELETE FROM sheets WHERE id = ?').run(id);
}

/** What, besides the file content, ends up in the index for a sheet. */
export function sheetMeta(sheet: Sheet): string {
  return JSON.stringify([sheet.title, sheet.tags]);
}

/** Replace everything indexed for one sheet. */
export function indexSheet(db: DB, sheet: Sheet, sections: Section[]): void {
  const insertSection = db.prepare('INSERT INTO sections (sheet_id, idx, heading, text, hash) VALUES (?, ?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO sections_fts (rowid, title, heading, text, tags) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    removeSheet(db, sheet.id);
    db.prepare('INSERT INTO sheets (id, sha256, meta) VALUES (?, ?, ?)').run(sheet.id, sheet.sha256, sheetMeta(sheet));
    const tags = sheet.tags.join(' ');
    for (const s of sections) {
      const { lastInsertRowid } = insertSection.run(sheet.id, s.idx, s.heading, s.text, embedHash(sheet.title, s.text));
      insertFts.run(lastInsertRowid, sheet.title, s.heading, s.text, tags);
    }
  })();
}

/** sheet id to indexed sha256. */
export function indexedSheets(db: DB): Map<string, string> {
  const rows = db.prepare('SELECT id, sha256 FROM sheets').all() as { id: string; sha256: string }[];
  return new Map(rows.map((r) => [r.id, r.sha256]));
}

/** sheet id to what was indexed: content hash and sheetMeta(). */
export function indexedState(db: DB): Map<string, { sha256: string; meta: string }> {
  const rows = db.prepare('SELECT id, sha256, meta FROM sheets').all() as { id: string; sha256: string; meta: string }[];
  return new Map(rows.map((r) => [r.id, { sha256: r.sha256, meta: r.meta }]));
}

export function sectionCount(db: DB): number {
  return (db.prepare('SELECT count(*) AS n FROM sections').get() as { n: number }).n;
}

// Embeddings. Vectors are unit length (float32 blobs), so cosine similarity is a dot product.

export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy into an aligned buffer; SQLite blobs may start at any offset.
  const out = new Float32Array(blob.byteLength / 4);
  new Uint8Array(out.buffer).set(blob);
  return out;
}

/** Sections whose text has no vector from `model` yet, one per distinct text. */
export function sectionsToEmbed(db: DB, model: string): { hash: string; input: string }[] {
  // Sections indexed before schema v3 have no hash yet.
  const unhashed = db.prepare(`SELECT s.id, s.text, sh.meta FROM sections s JOIN sheets sh ON sh.id = s.sheet_id WHERE s.hash = ''`).all() as { id: number; text: string; meta: string }[];
  if (unhashed.length) {
    const set = db.prepare('UPDATE sections SET hash = ? WHERE id = ?');
    db.transaction(() => {
      for (const r of unhashed) set.run(embedHash(metaTitle(r.meta), r.text), r.id);
    })();
  }
  const rows = db
    .prepare(
      `SELECT s.hash AS hash, min(s.text) AS text, min(sh.meta) AS meta
         FROM sections s JOIN sheets sh ON sh.id = s.sheet_id
        WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = s.hash AND e.model = ?)
        GROUP BY s.hash`,
    )
    .all(model) as { hash: string; text: string; meta: string }[];
  return rows.map((r) => ({ hash: r.hash, input: embedInput(metaTitle(r.meta), r.text) }));
}

function metaTitle(meta: string): string {
  try {
    const parsed = JSON.parse(meta) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : '';
  } catch {
    return '';
  }
}

export function storeEmbeddings(db: DB, model: string, rows: { hash: string; vec: Float32Array }[]): void {
  const put = db.prepare('INSERT OR REPLACE INTO embeddings (hash, model, vec) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const r of rows) put.run(r.hash, model, toBlob(r.vec));
  })();
}

/** Drop vectors from other models and for text no section has any more. Returns rows dropped per reason. */
export function pruneEmbeddings(db: DB, model: string): { otherModel: number; orphaned: number } {
  const otherModel = db.prepare('DELETE FROM embeddings WHERE model <> ?').run(model).changes;
  const orphaned = db.prepare('DELETE FROM embeddings WHERE hash NOT IN (SELECT hash FROM sections)').run().changes;
  return { otherModel, orphaned };
}

/** Embedding models with stored vectors. */
export function embeddingModels(db: DB): string[] {
  return (db.prepare('SELECT DISTINCT model FROM embeddings').all() as { model: string }[]).map((r) => r.model);
}

/** Sections in the index, and how many of them have a vector from `model`. */
export function embeddingCoverage(db: DB, model: string): { sections: number; embedded: number } {
  const r = db
    .prepare(
      `SELECT count(*) AS sections,
              sum(EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = s.hash AND e.model = ?)) AS embedded
         FROM sections s`,
    )
    .get(model) as { sections: number; embedded: number | null };
  return { sections: r.sections, embedded: r.embedded ?? 0 };
}

export interface SectionVector {
  sheetId: string;
  idx: number;
  heading: string;
  vec: Float32Array;
}

export function sectionVectors(db: DB, model: string): SectionVector[] {
  const rows = db
    .prepare(
      `SELECT s.sheet_id AS sheetId, s.idx AS idx, s.heading AS heading, e.vec AS vec
         FROM sections s JOIN embeddings e ON e.hash = s.hash AND e.model = ?`,
    )
    .all(model) as (Omit<SectionVector, 'vec'> & { vec: Buffer })[];
  return rows.map((r) => ({ ...r, vec: fromBlob(r.vec) }));
}

export function sectionText(db: DB, sheetId: string, idx: number): string {
  const r = db.prepare('SELECT text FROM sections WHERE sheet_id = ? AND idx = ?').get(sheetId, idx) as { text: string } | undefined;
  return r?.text ?? '';
}
