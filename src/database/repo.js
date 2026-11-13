'use strict';
const { get } = require('./index');

const now = () => Date.now();

// ---------- guild settings ----------
function ensureGuild(guildId) {
  get().prepare('INSERT OR IGNORE INTO guild_settings (guild_id, created_at) VALUES (?, ?)').run(guildId, now());
  get().prepare('INSERT OR IGNORE INTO raid_config (guild_id) VALUES (?)').run(guildId);
}
function getGuild(guildId) {
  ensureGuild(guildId);
  return get().prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
}
const GUILD_COLS = new Set(['antinuke_enabled', 'raid_enabled', 'escalation_threshold', 'quarantine_role_id', 'prefix']);
function setGuild(guildId, col, value) {
  if (!GUILD_COLS.has(col)) throw new Error(`invalid guild column ${col}`);
  ensureGuild(guildId);
  get().prepare(`UPDATE guild_settings SET ${col} = ? WHERE guild_id = ?`).run(value, guildId);
}

// ---------- antinuke modules ----------
// `defs` = module registry (key -> defaults) supplied by the engine, to keep this layer dumb.
function getModule(guildId, key, defs) {
  const row = get().prepare('SELECT * FROM antinuke_modules WHERE guild_id = ? AND module = ?').get(guildId, key);
  const d = defs[key];
  if (!row) return { module: key, enabled: d.defaults.enabled ? 1 : 0, threshold: d.defaults.threshold, window_sec: d.defaults.windowSec, punishment: d.defaults.punishment };
  return row;
}
function getAllModules(guildId, defs) {
  const rows = new Map(get().prepare('SELECT * FROM antinuke_modules WHERE guild_id = ?').all(guildId).map((r) => [r.module, r]));
  return Object.keys(defs).map((k) => rows.get(k) || getModule(guildId, k, defs));
}
function saveModule(guildId, key, cfg) {
  get().prepare(`INSERT INTO antinuke_modules (guild_id, module, enabled, threshold, window_sec, punishment)
    VALUES (@guild_id, @module, @enabled, @threshold, @window_sec, @punishment)
    ON CONFLICT(guild_id, module) DO UPDATE SET enabled=@enabled, threshold=@threshold, window_sec=@window_sec, punishment=@punishment`)
    .run({ guild_id: guildId, module: key, enabled: cfg.enabled ? 1 : 0, threshold: cfg.threshold, window_sec: cfg.window_sec, punishment: cfg.punishment });
}

// ---------- raid config ----------
function getRaid(guildId) {
  ensureGuild(guildId);
  return get().prepare('SELECT * FROM raid_config WHERE guild_id = ?').get(guildId);
}
const RAID_COLS = new Set(['window_sec', 'elevated_joins', 'high_joins', 'lockdown_joins', 'min_account_age_days', 'lockdown_minutes',
  'auto_lockdown', 'kick_suspicious', 'level', 'verification_active', 'prev_verification_level', 'lockdown_active', 'lockdown_expires_at']);
function setRaid(guildId, patch) {
  ensureGuild(guildId);
  const keys = Object.keys(patch);
  for (const k of keys) if (!RAID_COLS.has(k)) throw new Error(`invalid raid column ${k}`);
  if (!keys.length) return;
  get().prepare(`UPDATE raid_config SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE guild_id = @guild_id`).run({ ...patch, guild_id: guildId });
}
function getLockedChannels(guildId) { return get().prepare('SELECT * FROM lockdown_channels WHERE guild_id = ?').all(guildId); }
function saveLockedChannel(guildId, channelId, prev) {
  get().prepare('INSERT OR REPLACE INTO lockdown_channels (guild_id, channel_id, prev_state) VALUES (?, ?, ?)').run(guildId, channelId, prev);
}
function clearLockedChannels(guildId) { get().prepare('DELETE FROM lockdown_channels WHERE guild_id = ?').run(guildId); }
function activeLockdowns() { return get().prepare('SELECT guild_id, lockdown_expires_at FROM raid_config WHERE lockdown_active = 1').all(); }

function addJoin(guildId, userId, joinedAt, createdAt, suspicious) {
  get().prepare('INSERT INTO join_history (guild_id, user_id, joined_at, account_created_at, suspicious) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, userId, joinedAt, createdAt, suspicious ? 1 : 0);
}
function countJoins(guildId, since) {
  return get().prepare('SELECT COUNT(*) c, COALESCE(SUM(suspicious),0) s FROM join_history WHERE guild_id = ? AND joined_at >= ?').get(guildId, since);
}
function recentJoins(guildId, limit = 10) {
  return get().prepare('SELECT * FROM join_history WHERE guild_id = ? ORDER BY joined_at DESC LIMIT ?').all(guildId, limit);
}
function pruneJoins(before) { get().prepare('DELETE FROM join_history WHERE joined_at < ?').run(before); }

// ---------- whitelist ----------
function getWhitelist(guildId, userId) {
  return get().prepare('SELECT * FROM whitelist WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}
function listWhitelist(guildId) {
  return get().prepare('SELECT * FROM whitelist WHERE guild_id = ? ORDER BY added_at').all(guildId);
}
function roleWhitelist(guildId) {
  return get().prepare("SELECT * FROM whitelist WHERE guild_id = ? AND target_type = 'role'").all(guildId);
}
function countWhitelist(guildId) { return get().prepare('SELECT COUNT(*) c FROM whitelist WHERE guild_id = ?').get(guildId).c; }
function addWhitelist(guildId, userId, level, addedBy, { targetType = 'user', scopes = null } = {}) {
  get().prepare(`INSERT INTO whitelist (guild_id, user_id, level, added_by, added_at, target_type, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET level = excluded.level, added_by = excluded.added_by, added_at = excluded.added_at,
      target_type = excluded.target_type, scopes = excluded.scopes`)
    .run(guildId, userId, level, addedBy, now(), targetType, scopes && scopes.length ? JSON.stringify(scopes) : null);
}
function removeWhitelist(guildId, userId) {
  return get().prepare('DELETE FROM whitelist WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes > 0;
}

// ---------- moderation ----------
function addCase(guildId, { userId, moderatorId, action, reason, durationSec }) {
  const tx = get().transaction(() => {
    const next = get().prepare('SELECT COALESCE(MAX(case_number), 0) + 1 n FROM mod_cases WHERE guild_id = ?').get(guildId).n;
    get().prepare(`INSERT INTO mod_cases (guild_id, case_number, user_id, moderator_id, action, reason, duration_sec, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(guildId, next, userId, moderatorId, action, reason || null, durationSec || null, now());
    return get().prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ?').get(guildId, next);
  });
  return tx();
}
function userCases(guildId, userId, limit = 10) {
  return get().prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?').all(guildId, userId, limit);
}
function getCase(guildId, caseNumber) {
  return get().prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ?').get(guildId, caseNumber);
}
function countUserCases(guildId, userId) {
  return get().prepare('SELECT COUNT(*) c FROM mod_cases WHERE guild_id = ? AND user_id = ?').get(guildId, userId).c;
}
function pageUserCases(guildId, userId, limit, offset) {
  return get().prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(guildId, userId, limit, offset);
}
function addWarning(guildId, userId, moderatorId, reason) {
  const info = get().prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, userId, moderatorId, reason || null, now());
  return info.lastInsertRowid;
}
function countWarnings(guildId, userId) {
  return get().prepare('SELECT COUNT(*) c FROM warnings WHERE guild_id = ? AND user_id = ?').get(guildId, userId).c;
}
function pageWarnings(guildId, userId, limit, offset) {
  return get().prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(guildId, userId, limit, offset);
}

// ---------- incidents ----------
function addIncident(guildId, i) {
  return get().prepare(`INSERT INTO incidents (guild_id, executor_id, module, action, count, threshold, response, status, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(guildId, i.executorId, i.module, i.action, i.count, i.threshold, i.response, i.status, i.details || null, now()).lastInsertRowid;
}
function countIncidents(guildId) { return get().prepare('SELECT COUNT(*) c FROM incidents WHERE guild_id = ?').get(guildId).c; }
function countIncidentsSince(guildId, since) {
  return get().prepare('SELECT COUNT(*) c FROM incidents WHERE guild_id = ? AND created_at >= ?').get(guildId, since).c;
}
function lastIncident(guildId) { return get().prepare('SELECT * FROM incidents WHERE guild_id = ? ORDER BY created_at DESC LIMIT 1').get(guildId); }
function pageIncidents(guildId, limit, offset) {
  return get().prepare('SELECT * FROM incidents WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(guildId, limit, offset);
}
function countExecutorIncidents(guildId, executorId, since) {
  return get().prepare('SELECT COUNT(*) c FROM incidents WHERE guild_id = ? AND executor_id = ? AND created_at >= ?').get(guildId, executorId, since).c;
}
function recentIncidentSince(guildId, since) {
  return get().prepare('SELECT 1 FROM incidents WHERE guild_id = ? AND created_at >= ? LIMIT 1').get(guildId, since) !== undefined;
}

// ---------- logs ----------
function getLogChannel(guildId, type) {
  return get().prepare('SELECT channel_id FROM log_channels WHERE guild_id = ? AND type = ?').get(guildId, type)?.channel_id || null;
}
function allLogChannels(guildId) {
  return Object.fromEntries(get().prepare('SELECT type, channel_id FROM log_channels WHERE guild_id = ?').all(guildId).map((r) => [r.type, r.channel_id]));
}
function setLogChannel(guildId, type, channelId) {
  if (!channelId) { get().prepare('DELETE FROM log_channels WHERE guild_id = ? AND type = ?').run(guildId, type); return; }
  get().prepare('INSERT OR REPLACE INTO log_channels (guild_id, type, channel_id) VALUES (?, ?, ?)').run(guildId, type, channelId);
}

// ---------- recovery ----------
function saveSnapshot(guildId, kind, targetId, name, data) {
  get().prepare('INSERT OR REPLACE INTO snapshots (guild_id, kind, target_id, name, data, taken_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, kind, targetId, name, JSON.stringify(data), now());
}
function getSnapshot(guildId, kind, targetId) {
  const r = get().prepare('SELECT * FROM snapshots WHERE guild_id = ? AND kind = ? AND target_id = ?').get(guildId, kind, targetId);
  return r ? { ...r, data: JSON.parse(r.data) } : null;
}
function listSnapshots(guildId, kind) {
  return get().prepare('SELECT * FROM snapshots WHERE guild_id = ? AND kind = ?').all(guildId, kind).map((r) => ({ ...r, data: JSON.parse(r.data) }));
}
function deleteSnapshot(guildId, kind, targetId) { get().prepare('DELETE FROM snapshots WHERE guild_id = ? AND kind = ? AND target_id = ?').run(guildId, kind, targetId); }
function addRecovery(guildId, kind, targetId, result, details) {
  get().prepare('INSERT INTO recovery_log (guild_id, kind, target_id, result, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guildId, kind, targetId || null, result, details || null, now());
}

// ---------- nuke watch ----------
function addNukeWatch(guildId, userId, reason, expiresAt) {
  get().prepare(`INSERT INTO nuke_watch (guild_id, user_id, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, expires_at = excluded.expires_at`)
    .run(guildId, userId, reason || null, now(), expiresAt);
}
function getNukeWatch(guildId, userId, nowMs = Date.now()) {
  const row = get().prepare('SELECT * FROM nuke_watch WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!row) return null;
  if (row.expires_at <= nowMs) { removeNukeWatch(guildId, userId); return null; }
  return row;
}
function listNukeWatch(guildId, nowMs = Date.now()) {
  get().prepare('DELETE FROM nuke_watch WHERE guild_id = ? AND expires_at <= ?').run(guildId, nowMs);
  return get().prepare('SELECT * FROM nuke_watch WHERE guild_id = ? ORDER BY expires_at DESC').all(guildId);
}
function countNukeWatch(guildId, nowMs = Date.now()) {
  return get().prepare('SELECT COUNT(*) c FROM nuke_watch WHERE guild_id = ? AND expires_at > ?').get(guildId, nowMs).c;
}
function removeNukeWatch(guildId, userId) {
  return get().prepare('DELETE FROM nuke_watch WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes > 0;
}
function pruneNukeWatch(nowMs = Date.now()) {
  get().prepare('DELETE FROM nuke_watch WHERE expires_at <= ?').run(nowMs);
}

// ---------- nuke recent burst ----------
function addNukeRecent(guildId, executorId, entryId, keys, at = now()) {
  get().prepare(`INSERT OR REPLACE INTO nuke_recent (guild_id, executor_id, entry_id, module_keys, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(guildId, executorId, String(entryId), JSON.stringify(keys || []), at);
}
function listNukeRecent(guildId, executorId, since) {
  return get().prepare('SELECT * FROM nuke_recent WHERE guild_id = ? AND executor_id = ? AND created_at >= ? ORDER BY created_at ASC')
    .all(guildId, executorId, since);
}
function clearNukeRecent(guildId, executorId) {
  get().prepare('DELETE FROM nuke_recent WHERE guild_id = ? AND executor_id = ?').run(guildId, executorId);
}
function pruneNukeRecent(before) {
  get().prepare('DELETE FROM nuke_recent WHERE created_at < ?').run(before);
}

// ---------- quarantine ----------
function saveQuarantine(guildId, userId, roles) {
  get().prepare('INSERT OR REPLACE INTO quarantine (guild_id, user_id, roles, created_at) VALUES (?, ?, ?, ?)').run(guildId, userId, JSON.stringify(roles), now());
}
function getQuarantine(guildId, userId) {
  const r = get().prepare('SELECT * FROM quarantine WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  return r ? { ...r, roles: JSON.parse(r.roles) } : null;
}
function clearQuarantine(guildId, userId) { get().prepare('DELETE FROM quarantine WHERE guild_id = ? AND user_id = ?').run(guildId, userId); }

module.exports = {
  ensureGuild, getGuild, setGuild, getModule, getAllModules, saveModule, getRaid, setRaid, getLockedChannels, saveLockedChannel,
  clearLockedChannels, activeLockdowns, addJoin, countJoins, recentJoins, pruneJoins, getWhitelist, listWhitelist, roleWhitelist, countWhitelist,
  addWhitelist, removeWhitelist, addCase, userCases, getCase, countUserCases, pageUserCases,
  addWarning, countWarnings, pageWarnings, addIncident, countIncidents, countIncidentsSince,
  lastIncident, pageIncidents, countExecutorIncidents, recentIncidentSince, getLogChannel, allLogChannels, setLogChannel,
  saveSnapshot, getSnapshot, listSnapshots, deleteSnapshot, addRecovery, saveQuarantine, getQuarantine, clearQuarantine,
  addNukeWatch, getNukeWatch, listNukeWatch, countNukeWatch, removeNukeWatch, pruneNukeWatch,
  addNukeRecent, listNukeRecent, clearNukeRecent, pruneNukeRecent,
};
