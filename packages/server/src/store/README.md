# Store

SQLite persistence layer for sessions, decisions, feedback, patterns, pattern_stats, packs, and settings.

Status: **implemented and tested**.

## Overview

The store manages local state in a single SQLite database file using `better-sqlite3`.
The default database location is `~/.browserreflex/browserreflex.db`, with custom paths injectable via `createStore(dbPath)` or the `BROWSERREFLEX_DB_PATH` environment variable.

The store provides:
- Idempotent migration runner tracking applied migrations in `schema_migrations`.
- The 7 core tables: `sessions`, `packs`, `patterns`, `pattern_stats`, `decisions`, `feedback`, and `settings`.
- Foreign key enforcement and write-ahead logging (WAL) mode.
- Fully typed repository functions for creating, reading, querying, updating, and deleting records across all 7 tables.
