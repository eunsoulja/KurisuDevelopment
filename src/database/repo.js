'use strict';
const { get } = require('./index');

const now = () => Date.now();
const idStr = (v) => (v === null || v === undefined ? v : String(v));
const clean = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;
  const out = { ...doc };
  delete out._id;
  return out;
};

// ---- in-memory caches for hot reads (invalidate on write) ----
const guildCache = new Map();      // guildId -> guild_settings doc
const raidCache = new Map();       // guildId -> raid_config doc
const modulesCache = new Map();    // guildId -> Map(module -> row)
const whitelistCache = new Map();  // guildId -> { byId: Map, roles: [] }
const logCache = new Map();        // guildId -> { type: channelId }

const dropGuild = (guildId) => {
  guildCache.delete(guildId);
  raidCache.delete(guildId);
  modulesCache.delete(guildId);
  whitelistCache.delete(guildId);
  logCache.delete(guildId);
};

function isDup(err) { return err?.code === 11000; }

// ---------- counters (numeric IDs preserved) ----------
async function nextId(name) {
  const doc = await get().collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return Number(doc?.seq || 0);
}

async function ensureCounterAtLeast(name, value) {
  const v = Number(value) || 0;
  if (!v) return;
  await get().collection('counters').updateOne({ _id: name }, { $max: { seq: v } }, { upsert: true });
}

// ---------- guild settings ----------
async function ensureGuild(guildId) {
  const gid = idStr(guildId);
  if (guildCache.has(gid) && raidCache.has(gid)) return;
  const t = now();
  const col = get().collection('guild_settings');
  const raidCol = get().collection('raid_config');
  await Promise.all([
    col.updateOne(
      { _id: gid },
      { $setOnInsert: { _id: gid, antinuke_enabled: 0, raid_enabled: 0, escalation_threshold: 2, quarantine_role_id: null, prefix: '!', created_at: t } },
      { upsert: true },
    ),
    raidCol.updateOne(
      { _id: gid },
      {
        $setOnInsert: {
          _id: gid, window_sec: 10, elevated_joins: 5, high_joins: 10, lockdown_joins: 20,
          min_account_age_days: 7, lockdown_minutes: 15, auto_lockdown: 1, kick_suspicious: 0,
          level: 'NORMAL', verification_active: 0, prev_verification_level: null,
          lockdown_active: 0, lockdown_expires_at: null,
        },
      },
      { upsert: true },
    ),
  ]);
}

async function getGuild(guildId) {
  const gid = idStr(guildId);
  if (guildCache.has(gid)) return guildCache.get(gid);
  await ensureGuild(gid);
  const doc = await get().collection('guild_settings').findOne({ _id: gid });
  const row = { guild_id: gid, antinuke_enabled: 0, raid_enabled: 0, escalation_threshold: 2, quarantine_role_id: null, prefix: '!', created_at: now(), ...clean(doc) };
  row.guild_id = gid;
  guildCache.set(gid, row);
  return row;
}

const GUILD_COLS = new Set(['antinuke_enabled', 'raid_enabled', 'escalation_threshold', 'quarantine_role_id', 'prefix']);
async function setGuild(guildId, col, value) {
  if (!GUILD_COLS.has(col)) throw new Error(`invalid guild column ${col}`);
  const gid = idStr(guildId);
  await ensureGuild(gid);
  await get().collection('guild_settings').updateOne({ _id: gid }, { $set: { [col]: value } }, { upsert: true });
  const cached = guildCache.get(gid) || await getGuild(gid);
  cached[col] = value;
  guildCache.set(gid, cached);
}

// ---------- antinuke modules ----------
async function loadModulesMap(guildId) {
  const gid = idStr(guildId);
  if (modulesCache.has(gid)) return modulesCache.get(gid);
  const rows = await get().collection('antinuke_modules').find({ guild_id: gid }).toArray();
  const map = new Map(rows.map((r) => [r.module, clean(r)]));
  modulesCache.set(gid, map);
  return map;
}

async function getModule(guildId, key, defs) {
  const gid = idStr(guildId);
  const map = await loadModulesMap(gid);
  const row = map.get(key);
  const d = defs[key];
  if (!row) return { module: key, enabled: d.defaults.enabled ? 1 : 0, threshold: d.defaults.threshold, window_sec: d.defaults.windowSec, punishment: d.defaults.punishment };
  return { ...row, module: key };
}

async function getAllModules(guildId, defs) {
  const gid = idStr(guildId);
  const map = await loadModulesMap(gid);
  return Object.keys(defs).map((k) => {
    const row = map.get(k);
    const d = defs[k];
    return row ? { ...row, module: k } : { module: k, enabled: d.defaults.enabled ? 1 : 0, threshold: d.defaults.threshold, window_sec: d.defaults.windowSec, punishment: d.defaults.punishment };
  });
}

async function saveModule(guildId, key, cfg) {
  const gid = idStr(guildId);
  const doc = {
    guild_id: gid, module: key, enabled: cfg.enabled ? 1 : 0,
    threshold: cfg.threshold, window_sec: cfg.window_sec, punishment: cfg.punishment,
  };
  await get().collection('antinuke_modules').updateOne(
    { guild_id: gid, module: key },
    { $set: doc },
    { upsert: true },
  );
  const map = modulesCache.get(gid) || new Map();
  map.set(key, doc);
  modulesCache.set(gid, map);
}

// ---------- raid config ----------
async function getRaid(guildId) {
  const gid = idStr(guildId);
  if (raidCache.has(gid)) return raidCache.get(gid);
  await ensureGuild(gid);
  const doc = await get().collection('raid_config').findOne({ _id: gid });
  const row = {
    guild_id: gid, window_sec: 10, elevated_joins: 5, high_joins: 10, lockdown_joins: 20,
    min_account_age_days: 7, lockdown_minutes: 15, auto_lockdown: 1, kick_suspicious: 0,
    level: 'NORMAL', verification_active: 0, prev_verification_level: null,
    lockdown_active: 0, lockdown_expires_at: null, ...clean(doc),
  };
  row.guild_id = gid;
  raidCache.set(gid, row);
  return row;
}

const RAID_COLS = new Set(['window_sec', 'elevated_joins', 'high_joins', 'lockdown_joins', 'min_account_age_days', 'lockdown_minutes',
  'auto_lockdown', 'kick_suspicious', 'level', 'verification_active', 'prev_verification_level', 'lockdown_active', 'lockdown_expires_at']);
async function setRaid(guildId, patch) {
  const gid = idStr(guildId);
  await ensureGuild(gid);
  const keys = Object.keys(patch);
  for (const k of keys) if (!RAID_COLS.has(k)) throw new Error(`invalid raid column ${k}`);
  if (!keys.length) return;
  await get().collection('raid_config').updateOne({ _id: gid }, { $set: patch }, { upsert: true });
  const cached = raidCache.get(gid) || await getRaid(gid);
  Object.assign(cached, patch);
  raidCache.set(gid, cached);
}

async function getLockedChannels(guildId) {
  const rows = await get().collection('lockdown_channels').find({ guild_id: idStr(guildId) }).toArray();
  return rows.map(clean);
}
async function saveLockedChannel(guildId, channelId, prev) {
  await get().collection('lockdown_channels').updateOne(
    { guild_id: idStr(guildId), channel_id: idStr(channelId) },
    { $set: { guild_id: idStr(guildId), channel_id: idStr(channelId), prev_state: prev } },
    { upsert: true },
  );
}
async function clearLockedChannels(guildId) {
  await get().collection('lockdown_channels').deleteMany({ guild_id: idStr(guildId) });
}
async function activeLockdowns() {
  const rows = await get().collection('raid_config').find({ lockdown_active: 1 }).project({ _id: 1, lockdown_expires_at: 1 }).toArray();
  return rows.map((r) => ({ guild_id: r._id, lockdown_expires_at: r.lockdown_expires_at }));
}

async function addJoin(guildId, userId, joinedAt, createdAt, suspicious) {
  const id = await nextId('join_history');
  await get().collection('join_history').insertOne({
    id, guild_id: idStr(guildId), user_id: idStr(userId), joined_at: joinedAt, account_created_at: createdAt, suspicious: suspicious ? 1 : 0,
  });
  return id;
}
async function countJoins(guildId, since) {
  const rows = await get().collection('join_history').aggregate([
    { $match: { guild_id: idStr(guildId), joined_at: { $gte: since } } },
    { $group: { _id: null, c: { $sum: 1 }, s: { $sum: '$suspicious' } } },
  ]).toArray();
  const r = rows[0] || { c: 0, s: 0 };
  return { c: r.c || 0, s: r.s || 0 };
}
async function recentJoins(guildId, limit = 10) {
  const rows = await get().collection('join_history').find({ guild_id: idStr(guildId) }).sort({ joined_at: -1 }).limit(limit).toArray();
  return rows.map(clean);
}
async function pruneJoins(before) { await get().collection('join_history').deleteMany({ joined_at: { $lt: before } }); }

// ---------- whitelist ----------
async function loadWhitelistCache(guildId) {
  const gid = idStr(guildId);
  if (whitelistCache.has(gid)) return whitelistCache.get(gid);
  const rows = (await get().collection('whitelist').find({ guild_id: gid }).toArray()).map((r) => {
    const o = clean(r);
    if (o.scopes && typeof o.scopes !== 'string') o.scopes = JSON.stringify(o.scopes);
    return o;
  });
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  const roles = rows.filter((r) => r.target_type === 'role');
  const cache = { rows, byId, roles };
  whitelistCache.set(gid, cache);
  return cache;
}

async function getWhitelist(guildId, userId) {
  const cache = await loadWhitelistCache(guildId);
  return cache.byId.get(idStr(userId)) || null;
}
async function listWhitelist(guildId) {
  const cache = await loadWhitelistCache(guildId);
  return [...cache.rows].sort((a, b) => (a.added_at || 0) - (b.added_at || 0));
}
async function roleWhitelist(guildId) {
  const cache = await loadWhitelistCache(guildId);
  return [...cache.roles];
}
async function countWhitelist(guildId) {
  const cache = await loadWhitelistCache(guildId);
  return cache.rows.length;
}
async function addWhitelist(guildId, userId, level, addedBy, { targetType = 'user', scopes = null } = {}) {
  const gid = idStr(guildId);
  const uid = idStr(userId);
  const doc = {
    guild_id: gid, user_id: uid, level, added_by: idStr(addedBy), added_at: now(),
    target_type: targetType, scopes: scopes && scopes.length ? scopes : null,
  };
  await get().collection('whitelist').updateOne(
    { guild_id: gid, user_id: uid },
    { $set: doc },
    { upsert: true },
  );
  whitelistCache.delete(gid);
}
async function removeWhitelist(guildId, userId) {
  const gid = idStr(guildId);
  const res = await get().collection('whitelist').deleteOne({ guild_id: gid, user_id: idStr(userId) });
  whitelistCache.delete(gid);
  return res.deletedCount > 0;
}

// ---------- moderation ----------
async function addCase(guildId, { userId, moderatorId, action, reason, durationSec }) {
  const gid = idStr(guildId);
  // Atomic per-guild case number using a guild-scoped counter key.
  const c = await get().collection('counters').findOneAndUpdate(
    { _id: `mod_cases:${gid}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const caseNumber = Number(c?.seq || 0);
  const id = await nextId('mod_cases');
  const row = {
    id, guild_id: gid, case_number: caseNumber, user_id: idStr(userId), moderator_id: idStr(moderatorId),
    action, reason: reason || null, duration_sec: durationSec || null, created_at: now(),
  };
  try {
    await get().collection('mod_cases').insertOne(row);
  } catch (err) {
    if (isDup(err)) {
      // Extremely rare counter race recovery: retry once with a fresh number.
      const c2 = await get().collection('counters').findOneAndUpdate(
        { _id: `mod_cases:${gid}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
      );
      row.case_number = Number(c2?.seq || caseNumber + 1);
      await get().collection('mod_cases').insertOne(row);
    } else throw err;
  }
  return row;
}
async function userCases(guildId, userId, limit = 10) {
  const rows = await get().collection('mod_cases').find({ guild_id: idStr(guildId), user_id: idStr(userId) }).sort({ created_at: -1 }).limit(limit).toArray();
  return rows.map(clean);
}
async function getCase(guildId, caseNumber) {
  const row = await get().collection('mod_cases').findOne({ guild_id: idStr(guildId), case_number: Number(caseNumber) });
  return row ? clean(row) : null;
}
async function countUserCases(guildId, userId) {
  return get().collection('mod_cases').countDocuments({ guild_id: idStr(guildId), user_id: idStr(userId) });
}
async function pageUserCases(guildId, userId, limit, offset) {
  const rows = await get().collection('mod_cases').find({ guild_id: idStr(guildId), user_id: idStr(userId) }).sort({ created_at: -1 }).skip(offset).limit(limit).toArray();
  return rows.map(clean);
}
async function addWarning(guildId, userId, moderatorId, reason) {
  const id = await nextId('warnings');
  await get().collection('warnings').insertOne({
    id, guild_id: idStr(guildId), user_id: idStr(userId), moderator_id: idStr(moderatorId), reason: reason || null, created_at: now(),
  });
  return id;
}
async function countWarnings(guildId, userId) {
  return get().collection('warnings').countDocuments({ guild_id: idStr(guildId), user_id: idStr(userId) });
}
async function pageWarnings(guildId, userId, limit, offset) {
  const rows = await get().collection('warnings').find({ guild_id: idStr(guildId), user_id: idStr(userId) }).sort({ created_at: -1 }).skip(offset).limit(limit).toArray();
  return rows.map(clean);
}

// ---------- incidents ----------
async function addIncident(guildId, i) {
  const id = await nextId('incidents');
  await get().collection('incidents').insertOne({
    id, guild_id: idStr(guildId), executor_id: idStr(i.executorId), module: i.module, action: i.action,
    count: i.count, threshold: i.threshold, response: i.response, status: i.status,
    details: i.details || null, created_at: now(),
  });
  return id;
}
async function countIncidents(guildId) { return get().collection('incidents').countDocuments({ guild_id: idStr(guildId) }); }
async function countIncidentsSince(guildId, since) {
  return get().collection('incidents').countDocuments({ guild_id: idStr(guildId), created_at: { $gte: since } });
}
async function lastIncident(guildId) {
  const row = await get().collection('incidents').find({ guild_id: idStr(guildId) }).sort({ created_at: -1 }).limit(1).next();
  return row ? clean(row) : null;
}
async function pageIncidents(guildId, limit, offset) {
  const rows = await get().collection('incidents').find({ guild_id: idStr(guildId) }).sort({ created_at: -1 }).skip(offset).limit(limit).toArray();
  return rows.map(clean);
}
async function countExecutorIncidents(guildId, executorId, since) {
  return get().collection('incidents').countDocuments({ guild_id: idStr(guildId), executor_id: idStr(executorId), created_at: { $gte: since } });
}
async function recentIncidentSince(guildId, since) {
  const row = await get().collection('incidents').findOne({ guild_id: idStr(guildId), created_at: { $gte: since } }, { projection: { _id: 1 } });
  return row !== null;
}

// ---------- logs ----------
async function loadLogCache(guildId) {
  const gid = idStr(guildId);
  if (logCache.has(gid)) return logCache.get(gid);
  const rows = await get().collection('log_channels').find({ guild_id: gid }).toArray();
  const map = {};
  for (const r of rows) map[r.type] = r.channel_id;
  logCache.set(gid, map);
  return map;
}
async function getLogChannel(guildId, type) {
  const map = await loadLogCache(guildId);
  return map[type] || null;
}
async function allLogChannels(guildId) {
  const map = await loadLogCache(guildId);
  return { ...map };
}
async function setLogChannel(guildId, type, channelId) {
  const gid = idStr(guildId);
  if (!channelId) {
    await get().collection('log_channels').deleteOne({ guild_id: gid, type });
  } else {
    await get().collection('log_channels').updateOne(
      { guild_id: gid, type },
      { $set: { guild_id: gid, type, channel_id: idStr(channelId) } },
      { upsert: true },
    );
  }
  logCache.delete(gid);
}

// ---------- recovery ----------
async function saveSnapshot(guildId, kind, targetId, name, data) {
  await get().collection('snapshots').updateOne(
    { guild_id: idStr(guildId), kind, target_id: idStr(targetId) },
    { $set: { guild_id: idStr(guildId), kind, target_id: idStr(targetId), name, data, taken_at: now() } },
    { upsert: true },
  );
}
async function getSnapshot(guildId, kind, targetId) {
  const r = await get().collection('snapshots').findOne({ guild_id: idStr(guildId), kind, target_id: idStr(targetId) });
  return r ? { ...clean(r), data: r.data } : null;
}
async function listSnapshots(guildId, kind) {
  const rows = await get().collection('snapshots').find({ guild_id: idStr(guildId), kind }).toArray();
  return rows.map((r) => ({ ...clean(r), data: r.data }));
}
async function deleteSnapshot(guildId, kind, targetId) {
  await get().collection('snapshots').deleteOne({ guild_id: idStr(guildId), kind, target_id: idStr(targetId) });
}
async function addRecovery(guildId, kind, targetId, result, details) {
  const id = await nextId('recovery_log');
  await get().collection('recovery_log').insertOne({
    id, guild_id: idStr(guildId), kind, target_id: targetId ? idStr(targetId) : null, result, details: details || null, created_at: now(),
  });
  return id;
}

// ---------- nuke watch ----------
async function addNukeWatch(guildId, userId, reason, expiresAt) {
  const t = now();
  await get().collection('nuke_watch').updateOne(
    { guild_id: idStr(guildId), user_id: idStr(userId) },
    { $set: { guild_id: idStr(guildId), user_id: idStr(userId), reason: reason || null, created_at: t, expires_at: expiresAt, expires_at_date: new Date(expiresAt) } },
    { upsert: true },
  );
}
async function getNukeWatch(guildId, userId, nowMs = Date.now()) {
  const row = await get().collection('nuke_watch').findOne({ guild_id: idStr(guildId), user_id: idStr(userId) });
  if (!row) return null;
  if (row.expires_at <= nowMs) { await removeNukeWatch(guildId, userId); return null; }
  return clean(row);
}
async function listNukeWatch(guildId, nowMs = Date.now()) {
  await get().collection('nuke_watch').deleteMany({ guild_id: idStr(guildId), expires_at: { $lte: nowMs } }).catch(() => {});
  const rows = await get().collection('nuke_watch').find({ guild_id: idStr(guildId), expires_at: { $gt: nowMs } }).sort({ expires_at: -1 }).toArray();
  return rows.map(clean);
}
async function countNukeWatch(guildId, nowMs = Date.now()) {
  return get().collection('nuke_watch').countDocuments({ guild_id: idStr(guildId), expires_at: { $gt: nowMs } });
}
async function removeNukeWatch(guildId, userId) {
  const res = await get().collection('nuke_watch').deleteOne({ guild_id: idStr(guildId), user_id: idStr(userId) });
  return res.deletedCount > 0;
}
async function pruneNukeWatch(nowMs = Date.now()) {
  await get().collection('nuke_watch').deleteMany({ expires_at: { $lte: nowMs } });
}

// ---------- nuke recent burst ----------
async function addNukeRecent(guildId, executorId, entryId, keys, at = now()) {
  await get().collection('nuke_recent').updateOne(
    { guild_id: idStr(guildId), executor_id: idStr(executorId), entry_id: String(entryId) },
    { $set: { guild_id: idStr(guildId), executor_id: idStr(executorId), entry_id: String(entryId), module_keys: Array.isArray(keys) ? keys : [], created_at: at, created_at_date: new Date(at) } },
    { upsert: true },
  );
}
async function listNukeRecent(guildId, executorId, since) {
  const rows = await get().collection('nuke_recent').find({ guild_id: idStr(guildId), executor_id: idStr(executorId), created_at: { $gte: since } }).sort({ created_at: 1 }).toArray();
  return rows.map((r) => {
    const o = clean(r);
    if (typeof o.module_keys === 'string') { try { o.module_keys = JSON.parse(o.module_keys); } catch { o.module_keys = []; } }
    return o;
  });
}
async function clearNukeRecent(guildId, executorId) {
  await get().collection('nuke_recent').deleteMany({ guild_id: idStr(guildId), executor_id: idStr(executorId) });
}
async function pruneNukeRecent(before) {
  await get().collection('nuke_recent').deleteMany({ created_at: { $lt: before } });
}

// ---------- quarantine ----------
async function saveQuarantine(guildId, userId, roles) {
  await get().collection('quarantine').updateOne(
    { guild_id: idStr(guildId), user_id: idStr(userId) },
    { $set: { guild_id: idStr(guildId), user_id: idStr(userId), roles: Array.isArray(roles) ? roles : [], created_at: now() } },
    { upsert: true },
  );
}
async function getQuarantine(guildId, userId) {
  const r = await get().collection('quarantine').findOne({ guild_id: idStr(guildId), user_id: idStr(userId) });
  if (!r) return null;
  const o = clean(r);
  if (typeof o.roles === 'string') { try { o.roles = JSON.parse(o.roles); } catch { o.roles = []; } }
  return o;
}
async function clearQuarantine(guildId, userId) {
  await get().collection('quarantine').deleteOne({ guild_id: idStr(guildId), user_id: idStr(userId) });
}

// Exposed for tests/migration utilities
function _dropCaches() { guildCache.clear(); raidCache.clear(); modulesCache.clear(); whitelistCache.clear(); logCache.clear(); }

module.exports = {
  ensureGuild, getGuild, setGuild, getModule, getAllModules, saveModule, getRaid, setRaid, getLockedChannels, saveLockedChannel,
  clearLockedChannels, activeLockdowns, addJoin, countJoins, recentJoins, pruneJoins, getWhitelist, listWhitelist, roleWhitelist, countWhitelist,
  addWhitelist, removeWhitelist, addCase, userCases, getCase, countUserCases, pageUserCases,
  addWarning, countWarnings, pageWarnings, addIncident, countIncidents, countIncidentsSince,
  lastIncident, pageIncidents, countExecutorIncidents, recentIncidentSince, getLogChannel, allLogChannels, setLogChannel,
  saveSnapshot, getSnapshot, listSnapshots, deleteSnapshot, addRecovery, saveQuarantine, getQuarantine, clearQuarantine,
  addNukeWatch, getNukeWatch, listNukeWatch, countNukeWatch, removeNukeWatch, pruneNukeWatch,
  addNukeRecent, listNukeRecent, clearNukeRecent, pruneNukeRecent,
  nextId, ensureCounterAtLeast, _dropCaches, dropGuild,
};
