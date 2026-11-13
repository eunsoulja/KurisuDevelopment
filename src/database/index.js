'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const log = require('../utils/logger');

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY,
        antinuke_enabled INTEGER NOT NULL DEFAULT 1,
        raid_enabled INTEGER NOT NULL DEFAULT 1,
        escalation_threshold INTEGER NOT NULL DEFAULT 2,
        quarantine_role_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE antinuke_modules (
        guild_id TEXT NOT NULL,
        module TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        threshold INTEGER NOT NULL,
        window_sec INTEGER NOT NULL,
        punishment TEXT NOT NULL,
        PRIMARY KEY (guild_id, module)
      );
      CREATE TABLE raid_config (
        guild_id TEXT PRIMARY KEY,
        window_sec INTEGER NOT NULL DEFAULT 10,
        elevated_joins INTEGER NOT NULL DEFAULT 5,
        high_joins INTEGER NOT NULL DEFAULT 10,
        lockdown_joins INTEGER NOT NULL DEFAULT 20,
        min_account_age_days INTEGER NOT NULL DEFAULT 7,
        lockdown_minutes INTEGER NOT NULL DEFAULT 15,
        auto_lockdown INTEGER NOT NULL DEFAULT 1,
        kick_suspicious INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT 'NORMAL',
        verification_active INTEGER NOT NULL DEFAULT 0,
        prev_verification_level INTEGER,
        lockdown_active INTEGER NOT NULL DEFAULT 0,
        lockdown_expires_at INTEGER
      );
      CREATE TABLE lockdown_channels (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        prev_state TEXT NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
      );
      CREATE TABLE whitelist (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        level TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_warnings_user ON warnings (guild_id, user_id, created_at);
      CREATE TABLE mod_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        case_number INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        duration_sec INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (guild_id, case_number)
      );
      CREATE INDEX idx_cases_user ON mod_cases (guild_id, user_id, created_at);
      CREATE TABLE incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        count INTEGER NOT NULL,
        threshold INTEGER NOT NULL,
        response TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_incidents_guild ON incidents (guild_id, created_at);
      CREATE INDEX idx_incidents_exec ON incidents (guild_id, executor_id, created_at);
      CREATE TABLE log_channels (
        guild_id TEXT NOT NULL,
        type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, type)
      );
      CREATE TABLE snapshots (
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        name TEXT,
        data TEXT NOT NULL,
        taken_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, kind, target_id)
      );
      CREATE TABLE recovery_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_id TEXT,
        result TEXT NOT NULL,
        details TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE quarantine (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        roles TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE join_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        account_created_at INTEGER NOT NULL,
        suspicious INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_joins_guild ON join_history (guild_id, joined_at);
    `,
  },
  {
    version: 2,
    name: 'guild prefix',
    sql: `ALTER TABLE guild_settings ADD COLUMN prefix TEXT NOT NULL DEFAULT '!';`,
  },
  {
    version: 3,
    name: 'whitelist roles and scopes',
    sql: `
      ALTER TABLE whitelist ADD COLUMN target_type TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE whitelist ADD COLUMN scopes TEXT;
    `,
  },
  {
    version: 4,
    name: 'nuke watch',
    sql: `
      CREATE TABLE nuke_watch (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX idx_nuke_watch_expiry ON nuke_watch (guild_id, expires_at);
    `,
  },
];

let db = null;

function open(file = process.env.DATABASE_PATH || './data/kurisu.db') {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(handle) {
  handle.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
  const applied = new Set(handle.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    handle.transaction(() => {
      handle.exec(m.sql);
      handle.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    })();
    log.info(`database migration ${m.version} applied: ${m.name}`);
  }
}

function get() { return db || open(); }
function close() { if (db) { db.close(); db = null; } }

module.exports = { open, get, close };
