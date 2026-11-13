'use strict';
const { MongoClient } = require('mongodb');
const log = require('../utils/logger');

let client = null;
let db = null;
let openedWith = null;

const COLLECTIONS = [
  'guild_settings', 'antinuke_modules', 'raid_config', 'lockdown_channels', 'whitelist', 'warnings',
  'mod_cases', 'incidents', 'log_channels', 'snapshots', 'recovery_log', 'quarantine', 'join_history',
  'nuke_watch', 'nuke_recent', 'counters',
];

function databaseNameFromUri(uri) {
  try {
    const parsed = new URL(uri);
    const name = decodeURIComponent((parsed.pathname || '').replace(/^\//, '')).trim();
    if (name) return name;
  } catch { /* ignore malformed URI; Mongo will report the real error */ }
  return process.env.DATABASE_NAME || 'prismo';
}

function redactUri(err) {
  const uri = process.env.DATABASE_URL || '';
  let msg = String(err && (err.stack || err.message || err));
  if (!uri) return msg;
  try {
    const u = new URL(uri);
    const user = decodeURIComponent(u.username || '');
    const pass = decodeURIComponent(u.password || '');
    if (user) msg = msg.split(user).join('<redacted-user>');
    if (pass) msg = msg.split(pass).join('<redacted-password>');
    msg = msg.split(uri).join('<redacted-uri>');
    if (u.host) msg = msg.split(u.host).join('<redacted-host>');
  } catch {
    msg = msg.split(uri).join('<redacted-uri>');
  }
  return msg;
}

async function ensureIndexes(database) {
  const create = (name, spec, options = {}) => database.collection(name).createIndex(spec, options).catch(async (err) => {
    // Ignore "equivalent index already exists with different options" only when harmless; otherwise rethrow.
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') return;
    if (err?.code === 86 || err?.codeName === 'IndexKeySpecsConflict') return;
    throw err;
  });

  await Promise.all(COLLECTIONS.map((n) => database.collection(n))); // ensure collection handles are valid

  await create('antinuke_modules', { guild_id: 1, module: 1 }, { unique: true });
  await create('lockdown_channels', { guild_id: 1, channel_id: 1 }, { unique: true });
  await create('whitelist', { guild_id: 1, user_id: 1 }, { unique: true });
  await create('whitelist', { guild_id: 1, target_type: 1 });
  await create('warnings', { guild_id: 1, user_id: 1, created_at: -1 });
  await create('warnings', { guild_id: 1, id: 1 }, { unique: true, sparse: true });
  await create('mod_cases', { guild_id: 1, user_id: 1, created_at: -1 });
  await create('mod_cases', { guild_id: 1, id: 1 }, { unique: true, sparse: true });
  await create('mod_cases', { guild_id: 1, case_number: 1 }, { unique: true });
  await create('incidents', { guild_id: 1, created_at: -1 });
  await create('incidents', { guild_id: 1, executor_id: 1, created_at: -1 });
  await create('incidents', { guild_id: 1, id: 1 }, { unique: true, sparse: true });
  await create('log_channels', { guild_id: 1, type: 1 }, { unique: true });
  await create('snapshots', { guild_id: 1, kind: 1, target_id: 1 }, { unique: true });
  await create('recovery_log', { guild_id: 1, created_at: -1 });
  await create('recovery_log', { guild_id: 1, id: 1 }, { unique: true, sparse: true });
  await create('quarantine', { guild_id: 1, user_id: 1 }, { unique: true });
  await create('join_history', { guild_id: 1, joined_at: -1 });
  await create('join_history', { guild_id: 1, id: 1 }, { unique: true, sparse: true });
  await create('nuke_watch', { guild_id: 1, user_id: 1 }, { unique: true });
  await create('nuke_watch', { expires_at_date: 1 }, { expireAfterSeconds: 0 });
  await create('nuke_recent', { guild_id: 1, executor_id: 1, created_at: -1 });
  await create('nuke_recent', { guild_id: 1, executor_id: 1, entry_id: 1 }, { unique: true });
  await create('nuke_recent', { created_at_date: 1 }, { expireAfterSeconds: 0 });
  // counters use the built-in unique _id index (no explicit create needed)
}

async function open(uri = process.env.DATABASE_URL, { dbName } = {}) {
  if (db) return db;
  if (!uri) throw new Error('DATABASE_URL is not set. Add it to the environment variables (or .env).');
  const name = dbName || process.env.DATABASE_NAME || databaseNameFromUri(uri);
  const mongo = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
  try {
    await mongo.connect();
    const database = mongo.db(name);
    await database.command({ ping: 1 });
    await ensureIndexes(database);
    client = mongo;
    db = database;
    openedWith = { name, uri: '<configured>' };
    log.info(`connected to MongoDB database ${name}`);
    return db;
  } catch (err) {
    try { await mongo.close(); } catch { /* ignore */ }
    const e = new Error(redactUri(err));
    e.cause = undefined;
    throw e;
  }
}

function get() {
  if (!db) throw new Error('database is not connected. Call and await db.open() before use.');
  return db;
}

async function close() {
  const c = client;
  client = null;
  db = null;
  openedWith = null;
  if (c) {
    try { await c.close(); } catch (err) { log.warn('error closing MongoDB client', redactUri(err)); }
  }
}

async function ping() {
  if (!db) return { ok: false, error: 'not connected' };
  try {
    await db.command({ ping: 1 });
    return { ok: true, db: openedWith?.name || null };
  } catch (err) {
    return { ok: false, error: redactUri(err).split('\n')[0] };
  }
}

function info() { return openedWith ? { ...openedWith } : null; }

module.exports = { open, get, close, ping, info, ensureIndexes, redactUri, databaseNameFromUri };
