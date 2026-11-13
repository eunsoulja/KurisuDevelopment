'use strict';
require('dotenv').config();

const path = require('path');

function scrub(s) {
  return String(s || '').replace(/mongodb(?:\+srv)?:\/\/[^\s'")]+/gi, '[redacted-database-url]');
}

function tableExists(sqlite, name) {
  return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function getColumns(sqlite, table) {
  if (!tableExists(sqlite, table)) return new Set();
  return new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

async function upsertMany(col, docs, keyFn) {
  let n = 0;
  for (const doc of docs) {
    const filter = keyFn(doc);
    await col.updateOne(filter, { $set: doc }, { upsert: true });
    n++;
  }
  return n;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const uri = process.env.DATABASE_URL;
  const dbPath = process.env.DATABASE_PATH || './data/kurisu.db';
  if (!uri) {
    console.error('[migrate] DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  console.log('[migrate] IMPORTANT: back up data/kurisu.db before running. This script never prints the MongoDB URI.');
  console.log(`[migrate] SQLite source: ${dbPath}${dryRun ? ' (dry-run, Mongo writes skipped)' : ''}`);

  let Database;
  try { Database = require('better-sqlite3'); } catch (err) {
    console.error('[migrate] better-sqlite3 is required for migration reads. Install it or keep it available until migration is verified.');
    process.exit(1);
  }
  const sqlitePath = path.resolve(dbPath);
  let sqlite;
  try { sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true }); } catch (err) {
    console.error(`[migrate] could not open SQLite database at ${sqlitePath}: ${scrub(err.message)}`);
    process.exit(1);
  }

  const dbmod = require('../src/database');
  const repo = require('../src/database/repo');
  let mdb;
  if (!dryRun) {
    await dbmod.open(uri);
    mdb = dbmod.get();
  }

  const results = [];
  const countersMax = { cases: 0, incidents: 0, warnings: 0, recovery_log: 0, join_history: 0 };

  async function migrateTable(table, mapper, keyFn, collectionName = table) {
    if (!tableExists(sqlite, table)) {
      results.push({ table, sqlite: 0, mongo: 0, ok: true, note: 'missing in sqlite' });
      return;
    }
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    const docs = rows.map(mapper);
    if (dryRun) {
      results.push({ table, sqlite: rows.length, mongo: '(dry-run)', ok: true });
      return;
    }
    const col = mdb.collection(collectionName);
    await upsertMany(col, docs, keyFn);
    const mongo = await col.countDocuments();
    results.push({ table, sqlite: rows.length, mongo, ok: mongo >= rows.length });
  }

  const has = (t, c) => getColumns(sqlite, t).has(c);

  await migrateTable('guild_settings', (r) => ({
    _id: String(r.guild_id), antinuke_enabled: r.antinuke_enabled ?? 0, raid_enabled: r.raid_enabled ?? 0,
    escalation_threshold: r.escalation_threshold ?? 2, quarantine_role_id: r.quarantine_role_id ?? null,
    prefix: r.prefix ?? '!', created_at: r.created_at ?? Date.now(),
  }), (d) => ({ _id: d._id }));

  await migrateTable('antinuke_modules', (r) => ({
    guild_id: String(r.guild_id), module: r.module, enabled: r.enabled ?? 0,
    threshold: r.threshold, window_sec: r.window_sec, punishment: r.punishment,
  }), (d) => ({ guild_id: d.guild_id, module: d.module }));

  await migrateTable('raid_config', (r) => ({
    _id: String(r.guild_id), window_sec: r.window_sec ?? 10, elevated_joins: r.elevated_joins ?? 5,
    high_joins: r.high_joins ?? 10, lockdown_joins: r.lockdown_joins ?? 20,
    min_account_age_days: r.min_account_age_days ?? 7, lockdown_minutes: r.lockdown_minutes ?? 15,
    auto_lockdown: r.auto_lockdown ?? 1, kick_suspicious: r.kick_suspicious ?? 0,
    level: r.level ?? 'NORMAL', verification_active: r.verification_active ?? 0,
    prev_verification_level: r.prev_verification_level ?? null,
    lockdown_active: r.lockdown_active ?? 0, lockdown_expires_at: r.lockdown_expires_at ?? null,
  }), (d) => ({ _id: d._id }));

  await migrateTable('lockdown_channels', (r) => ({
    guild_id: String(r.guild_id), channel_id: String(r.channel_id), prev_state: r.prev_state ?? 'neutral',
  }), (d) => ({ guild_id: d.guild_id, channel_id: d.channel_id }));

  await migrateTable('join_history', (r) => {
    const id = Number(r.id || 0); countersMax.join_history = Math.max(countersMax.join_history, id);
    return { id, guild_id: String(r.guild_id), user_id: String(r.user_id), joined_at: Number(r.joined_at || 0), account_created_at: Number(r.account_created_at || 0), suspicious: r.suspicious ?? 0 };
  }, (d) => ({ id: d.id }));

  await migrateTable('whitelist', (r) => {
    let scopes = r.scopes ?? null;
    if (typeof scopes === 'string') { try { scopes = JSON.parse(scopes); } catch { /* keep string */ } }
    return { guild_id: String(r.guild_id), user_id: String(r.user_id), level: r.level, added_by: r.added_by ? String(r.added_by) : null, added_at: Number(r.added_at || 0), target_type: r.target_type || 'user', scopes };
  }, (d) => ({ guild_id: d.guild_id, user_id: d.user_id }));

  await migrateTable('mod_cases', (r) => {
    const id = Number(r.id || 0), cn = Number(r.case_number || 0);
    countersMax.cases = Math.max(countersMax.cases, id);
    return { id, guild_id: String(r.guild_id), case_number: cn, user_id: String(r.user_id), moderator_id: r.moderator_id ? String(r.moderator_id) : null, action: r.action, reason: r.reason ?? null, duration_sec: r.duration_sec ?? null, created_at: Number(r.created_at || 0) };
  }, (d) => ({ guild_id: d.guild_id, case_number: d.case_number }));

  await migrateTable('warnings', (r) => {
    const id = Number(r.id || 0); countersMax.warnings = Math.max(countersMax.warnings, id);
    return { id, guild_id: String(r.guild_id), user_id: String(r.user_id), moderator_id: r.moderator_id ? String(r.moderator_id) : null, reason: r.reason ?? null, created_at: Number(r.created_at || 0) };
  }, (d) => ({ id: d.id }));

  await migrateTable('incidents', (r) => {
    const id = Number(r.id || 0); countersMax.incidents = Math.max(countersMax.incidents, id);
    return { id, guild_id: String(r.guild_id), executor_id: r.executor_id != null ? String(r.executor_id) : null, module: r.module, action: r.action, count: r.count ?? 0, threshold: r.threshold ?? 0, response: r.response ?? null, status: r.status ?? null, details: r.details ?? null, created_at: Number(r.created_at || 0) };
  }, (d) => ({ id: d.id }));

  await migrateTable('log_channels', (r) => ({
    guild_id: String(r.guild_id), type: r.type, channel_id: String(r.channel_id),
  }), (d) => ({ guild_id: d.guild_id, type: d.type }));

  await migrateTable('snapshots', (r) => {
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* keep */ } }
    return { guild_id: String(r.guild_id), kind: r.kind, target_id: String(r.target_id), name: r.name ?? null, data, taken_at: Number(r.taken_at || 0) };
  }, (d) => ({ guild_id: d.guild_id, kind: d.kind, target_id: d.target_id }));

  await migrateTable('recovery_log', (r) => {
    const id = Number(r.id || 0); countersMax.recovery_log = Math.max(countersMax.recovery_log, id);
    return { id, guild_id: String(r.guild_id), kind: r.kind, target_id: r.target_id != null ? String(r.target_id) : null, result: r.result, details: r.details ?? null, created_at: Number(r.created_at || 0) };
  }, (d) => ({ id: d.id }));

  await migrateTable('nuke_watch', (r) => {
    const exp = Number(r.expires_at || 0);
    return { guild_id: String(r.guild_id), user_id: String(r.user_id), reason: r.reason ?? null, created_at: Number(r.created_at || 0), expires_at: exp, expires_at_date: exp ? new Date(exp) : null };
  }, (d) => ({ guild_id: d.guild_id, user_id: d.user_id }));

  await migrateTable('nuke_recent', (r) => {
    let keys = r.module_keys;
    if (typeof keys === 'string') { try { keys = JSON.parse(keys); } catch { keys = []; } }
    const at = Number(r.created_at || 0);
    return { guild_id: String(r.guild_id), executor_id: String(r.executor_id), entry_id: String(r.entry_id), module_keys: Array.isArray(keys) ? keys : [], created_at: at, created_at_date: at ? new Date(at) : null };
  }, (d) => ({ guild_id: d.guild_id, executor_id: d.executor_id, entry_id: d.entry_id }));

  await migrateTable('quarantine', (r) => {
    let roles = r.roles;
    if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch { roles = []; } }
    return { guild_id: String(r.guild_id), user_id: String(r.user_id), roles: Array.isArray(roles) ? roles : [], created_at: Number(r.created_at || 0) };
  }, (d) => ({ guild_id: d.guild_id, user_id: d.user_id }));

  if (!dryRun) {
    // per-guild mod_cases counters
    if (tableExists(sqlite, 'mod_cases')) {
      const perGuild = sqlite.prepare('SELECT guild_id, MAX(case_number) m FROM mod_cases GROUP BY guild_id').all();
      for (const row of perGuild) await repo.ensureCounterAtLeast(`mod_cases:${String(row.guild_id)}`, Number(row.m || 0));
    }
    await repo.ensureCounterAtLeast('cases', countersMax.cases);
    await repo.ensureCounterAtLeast('incidents', countersMax.incidents);
    await repo.ensureCounterAtLeast('warnings', countersMax.warnings);
    await repo.ensureCounterAtLeast('recovery_log', countersMax.recovery_log);
    await repo.ensureCounterAtLeast('join_history', countersMax.join_history);
  }

  sqlite.close();

  console.log('\n[migrate] verification:');
  let failed = false;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) failed = true;
    const note = r.note ? ` (${r.note})` : '';
    console.log(`  ${status}  ${r.table}: sqlite=${r.sqlite} mongo=${r.mongo}${note}`);
  }
  if (!dryRun) {
    console.log('[migrate] counters set to max numeric IDs from SQLite (global + per-guild mod_cases).');
    await dbmod.close();
  }
  if (failed) {
    console.error('[migrate] one or more tables failed verification.');
    process.exit(2);
  }
  console.log(`[migrate] ${dryRun ? 'dry-run complete' : 'migration complete'}.`);
}

main().catch((err) => {
  console.error(`[migrate] failed: ${scrub(err.stack || err.message || err)}`);
  process.exit(1);
});
