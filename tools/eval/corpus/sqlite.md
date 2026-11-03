# SQLite reference

The sqlite3 shell and features I use for small local databases.

## Shell basics

sqlite3 app.db opens a database. .tables lists tables, .schema users shows a CREATE statement,
.mode box makes query output readable, and .quit leaves.

## Full text search

CREATE VIRTUAL TABLE docs_fts USING fts5(title, body) builds a keyword index.
Query it with SELECT * FROM docs_fts WHERE docs_fts MATCH 'docker AND volume' ORDER BY rank;
bm25(docs_fts) gives the relevance score.

## WAL mode

PRAGMA journal_mode=WAL lets readers keep reading while one writer writes.
The database then has -wal and -shm files next to it; do not copy only the .db file while it is open.

## Backups

.backup backup.db in the shell makes a consistent copy of a live database.
VACUUM INTO 'copy.db' does the same from SQL and also compacts the file.

## Why is my query slow

EXPLAIN QUERY PLAN SELECT ... shows whether SQLite scans the whole table or uses an index.
SCAN means a full table read; SEARCH ... USING INDEX means an index was used.
