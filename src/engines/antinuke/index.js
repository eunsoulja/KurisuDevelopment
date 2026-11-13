'use strict';
const { AuditLogEvent } = require('discord.js');
const repo = require('../../database/repo');
const perms = require('../../permissions');
const recovery = require('../recovery');
const logging = require('../logging');
const punish = require('./punish');
const log = require('../../utils/logger');
const { MODULES, byAction } = require('./modules');
const { DANGEROUS_BITS, PUNISHED_LABEL } = require('../../config/settings');

// ---- in-memory state (durable burst state mirrored to MongoDB) ----
const windows = new Map();   // `${guild}:${exec}:${module}` -> [{ t, w, entry }]
const seen = new Map();      // audit entry id -> timestamp (dedupe)
const locks = new Map();     // `${guild}:${exec}` -> expiry; after a breach, more actions are mitigated but not re-punished
const mitigated = new Set(); // entry ids already reverted
const recent = new Map();    // `${guild}:${exec}` -> [{ t, keys, key, entry }] for the cross-module Nuke Guard
const loadedRecent = new Set(); // guildId -> persisted nuke_recent rows loaded once at startup/boot for this process
const alerted = new Map();   // `${guild}:${exec}:${module}` -> watch-alert expiry
const LOCK_MS = 60_000;
const NUKE_WATCH_MS = 24 * 3600 * 1000;

const humanize = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
const actionLabel = (action) => humanize(AuditLogEvent[action] || `Action ${action}`);
const rowKey = (guildId, executorId) => `${guildId}:${executorId}`;

/** Sliding window counter. Returns { total, items }. Exported for tests. */
function slide(key, windowMs, weight, entry, nowMs = Date.now()) {
  const arr = (windows.get(key) || []).filter((x) => nowMs - x.t <= windowMs);
  arr.push({ t: nowMs, w: weight, entry });
  windows.set(key, arr);
  return { total: arr.reduce((a, b) => a + b.w, 0), items: arr };
}

/**
 * Track destructive actions across modules so mixed nukes cannot stay below
 * every threshold. Each entry keeps every matching module key, and the window
 * is mirrored to MongoDB so a burst survives a bot restart.
 *
 * Performance: persisted nuke_recent rows are loaded ONCE at startup/boot per guild,
 * not during per-audit-entry detection and not merely because the in-memory window
 * is empty. During detection, memory is authoritative; writes still persist rows.
 */
async function trackNuke(guildId, executorId, keys, entry, windowMs, nowMs = Date.now()) {
  const list = Array.isArray(keys) ? keys : [keys];
  const mapKey = rowKey(guildId, executorId);
  const cutoff = nowMs - windowMs;
  const byId = new Map();

  for (const item of (recent.get(mapKey) || [])) {
    if (item.t < cutoff) continue;
    const id = item.entry?.id != null ? String(item.entry.id) : `${item.t}:${item.key}`;
    byId.set(id, item);
  }

  if (entry?.id != null) byId.delete(String(entry.id));
  const arr = [...byId.values()].sort((a, b) => a.t - b.t);
  arr.push({ t: nowMs, keys: list, key: list[0], entry });
  recent.set(mapKey, arr);
  if (entry?.id != null) {
    try { await repo.addNukeRecent(guildId, executorId, entry.id, list, nowMs); } catch (err) { log.debug('nuke recent save failed', err); }
  }
  return arr;
}

/** Load persisted nuke_recent rows once per guild for this process (startup/boot). */
async function ensureRecentLoaded(guildId, windowMs = 120_000, nowMs = Date.now()) {
  const gid = String(guildId);
  if (loadedRecent.has(gid)) return;
  loadedRecent.add(gid);
  const since = nowMs - Math.max(windowMs, 120_000);
  let rows = [];
  try {
    // list recent rows for guild across executors by querying collection directly for boot load
    rows = await getDb().collection('nuke_recent').find({ guild_id: gid, created_at: { $gte: since } }).sort({ created_at: 1 }).toArray();
  } catch (err) {
    log.debug('nuke recent boot load failed', err);
    return;
  }
  for (const row of rows) {
    let parsed = row.module_keys;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = []; } }
    if (!Array.isArray(parsed)) parsed = [];
    const mapKey = rowKey(gid, String(row.executor_id));
    const arr = recent.get(mapKey) || [];
    const id = String(row.entry_id);
    if (arr.some((x) => (x.entry?.id != null ? String(x.entry.id) : '') === id)) continue;
    arr.push({ t: Number(row.created_at || 0), keys: parsed, key: parsed[0], entry: { id } });
    arr.sort((a, b) => a.t - b.t);
    recent.set(mapKey, arr);
  }
}

function getDb() { return require('../../database').get(); }

async function cleanup() {
  const n = Date.now();
  for (const [k, v] of seen) if (n - v > 120_000) seen.delete(k);
  for (const [k, v] of locks) if (v < n) locks.delete(k);
  for (const [k, arr] of windows) { const f = arr.filter((x) => n - x.t < 300_000); if (f.length) windows.set(k, f); else windows.delete(k); }
  for (const [k, arr] of recent) { const f = arr.filter((x) => n - x.t < 120_000); if (f.length) recent.set(k, f); else recent.delete(k); }
  for (const [k, v] of alerted) if (v < n) alerted.delete(k);
  if (mitigated.size > 5000) mitigated.clear();
  try { await repo.pruneNukeWatch(n); } catch (err) { log.debug('nuke watch cleanup failed', err); }
  try { await repo.pruneNukeRecent(n - 120_000); } catch (err) { log.debug('nuke recent cleanup failed', err); }
}
setInterval(() => { cleanup().catch((err) => log.debug('nuke cleanup failed', err)); }, 60_000).unref();

const changeOf = (entry, key) => entry.changes?.find((c) => c.key === key);

/** Which modules does this audit entry feed, and with what weight? */
function classify(entry, guild) {
  const mods = (byAction.get(entry.action) || []).slice();
  const out = [];
  for (const key of mods) {
    let weight = 1;
    if (key === 'massDelete') weight = Number(entry.extra?.count) || 1;
    if (key === 'vanityChange') { if (!changeOf(entry, 'vanity_url_code')) continue; }
    if (key === 'guildUpdate') {
      const others = (entry.changes || []).filter((c) => c.key !== 'vanity_url_code');
      if (!others.length && entry.changes?.length) continue;
    }
    if (key === 'permEscalation') {
      if (entry.action === AuditLogEvent.RoleUpdate) {
        const p = changeOf(entry, 'permissions');
        if (!p) continue;
        if (!(BigInt(p.new ?? 0) & ~BigInt(p.old ?? 0) & DANGEROUS_BITS)) continue;
      } else if (entry.action === AuditLogEvent.MemberRoleUpdate) {
        const added = changeOf(entry, '$add')?.new || [];
        const dangerous = added.some((r) => {
          const role = guild.roles.cache.get(r.id);
          return role && (role.permissions.bitfield & DANGEROUS_BITS);
        });
        if (!dangerous) continue;
      }
    }
    out.push({ key, weight });
  }
  return out;
}

/** Durable 24h watch: a kicked nuke executor is banned the moment they act or rejoin. */
async function watchExecutor(guild, executorId, reason) {
  await repo.addNukeWatch(guild.id, executorId, reason, Date.now() + NUKE_WATCH_MS);
}

async function handleAuditEntry(entry, guild) {
  try {
    if (!entry?.id || seen.has(entry.id)) return;
    seen.set(entry.id, Date.now());
    const executorId = entry.executorId;
    if (!executorId) return; // cannot attribute: never punish an arbitrary member
    await ensureRecentLoaded(guild.id).catch(() => {});
    const g = await repo.getGuild(guild.id);
    if (!g.antinuke_enabled) return;

    const lockKey = rowKey(guild.id, executorId);
    if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) {
      for (const { key } of classify(entry, guild)) await mitigate(guild, key, entry, executorId);
      return;
    }

    const watch = await repo.getNukeWatch(guild.id, executorId);
    if (watch && !await perms.isExempt(guild, executorId, 'general', null)) {
      await respondWatch(guild, executorId, watch, entry);
      return;
    }

    const mods = classify(entry, guild);

    // Nuke Guard runs BEFORE per-module thresholds, so a mixed burst is stopped at once.
    const guard = await repo.getModule(guild.id, 'nukeGuard', MODULES);
    let activeNuke = [];
    if (guard.enabled) {
      for (const { key } of mods) {
        if (!MODULES[key]?.nuke) continue;
        const mc = await repo.getModule(guild.id, key, MODULES);
        if (!mc.enabled) continue;
        if (await perms.isExempt(guild, executorId, MODULES[key].group || 'general', key)) continue;
        activeNuke.push({ key });
      }
    }
    if (activeNuke.length) {
      const items = await trackNuke(guild.id, executorId, activeNuke.map(({ key }) => key), entry, guard.window_sec * 1000);
      if (items.length >= guard.threshold) {
        await respondNuke(guild, guard, executorId, items);
        return;
      }
    }

    for (const { key, weight } of mods) {
      await evaluate(guild, key, executorId, entry, weight);
    }
  } catch (err) {
    log.error(`antinuke pipeline error in ${guild?.id}`, err);
  }
}

/** Keep snapshots current, but only from changes made by trusted actors. */
async function refreshSnapshot(guild, entry) {
  const A = AuditLogEvent;
  if ([A.ChannelCreate, A.ChannelUpdate, A.ChannelOverwriteCreate, A.ChannelOverwriteUpdate, A.ChannelOverwriteDelete].includes(entry.action)) {
    const ch = guild.channels.cache.get(entry.targetId); if (ch) await recovery.snapshotChannel(ch);
  } else if ([A.RoleCreate, A.RoleUpdate].includes(entry.action)) {
    const r = guild.roles.cache.get(entry.targetId); if (r) await recovery.snapshotRole(r);
  }
}

/** Early warning: log the first hit on a destructive module while it is still below threshold. */
async function maybeAlert(guild, key, executorId, total, cfg) {
  if (!MODULES[key]?.nuke) return;
  const k = `${guild.id}:${executorId}:${key}`;
  const now = Date.now();
  if ((alerted.get(k) || 0) > now) return;
  alerted.set(k, now + cfg.window_sec * 1000);
  await logging.watchLog(guild, {
    executorId, actionLabel: MODULES[key].name, count: total, threshold: cfg.threshold,
  }).catch(() => {});
}

async function evaluate(guild, key, executorId, entry, weight) {
  const mod = MODULES[key];
  const cfg = await repo.getModule(guild.id, key, MODULES);
  if (!cfg.enabled) return;
  if (await perms.isExempt(guild, executorId, mod.group, key)) { if (entry?.action) await refreshSnapshot(guild, entry); return; }

  const lockKey = rowKey(guild.id, executorId);
  if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) {
    if (entry) await mitigate(guild, key, entry, executorId);
    return;
  }
  const { total, items } = slide(`${guild.id}:${executorId}:${key}`, cfg.window_sec * 1000, weight, entry);
  if (total < cfg.threshold) { await maybeAlert(guild, key, executorId, total, cfg); return; }

  alerted.delete(`${guild.id}:${executorId}:${key}`);
  locks.set(lockKey, Date.now() + LOCK_MS);
  windows.delete(`${guild.id}:${executorId}:${key}`);
  await respond(guild, key, cfg, executorId, total, items.map((i) => i.entry).filter(Boolean), entry);
}

async function respond(guild, key, cfg, executorId, total, entries, lastEntry) {
  const mod = MODULES[key];
  let kind = cfg.punishment;
  const g = await repo.getGuild(guild.id);
  const prior = await repo.countExecutorIncidents(guild.id, executorId, Date.now() - 24 * 3600 * 1000);
  let escalated = false;
  if (g.escalation_threshold > 0 && prior + 1 >= g.escalation_threshold && kind !== 'ban') { kind = 'ban'; escalated = true; }
  const member = await punish.fetchMember(guild, executorId);
  if (member?.user.bot && kind !== 'ban') kind = 'ban';

  const result = await punish.apply(guild, executorId, kind, `Kurisu antinuke: ${mod.name}`);

  if (result.ok && result.kind === 'ban') await repo.removeNukeWatch(guild.id, executorId);
  else if (result.ok && result.kind === 'kick') await watchExecutor(guild, executorId, `Kurisu antinuke: ${mod.name}`);

  const notes = [];
  for (const e of entries) { const n = await mitigate(guild, key, e, executorId); if (n) notes.push(n); }
  if (key === 'everyoneMention' || key === 'massMention') notes.push('offending messages removed');

  const response = result.ok ? PUNISHED_LABEL[result.kind] : 'Punishment failed';
  const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
  const details = [escalated ? 'escalated after repeat offence' : null, result.detail, ...notes].filter(Boolean).join('; ').slice(0, 400);
  const label = lastEntry?.action !== undefined ? actionLabel(lastEntry.action) : mod.name.replace(/^Anti-/, '');
  await repo.addIncident(guild.id, { executorId, module: key, action: label, count: total, threshold: cfg.threshold, response, status, details });
  await logging.incidentLog(guild, { executorId, actionLabel: label, count: total, threshold: cfg.threshold, response, status, details });
}

/** Cross-module destructive burst. Default response: immediate kick, then 24h watch. */
async function respondNuke(guild, cfg, executorId, items) {
  const lockKey = rowKey(guild.id, executorId);
  recent.delete(lockKey);
  try { await repo.clearNukeRecent(guild.id, executorId); } catch (err) { log.debug('nuke recent clear failed', err); }
  locks.set(lockKey, Date.now() + LOCK_MS);

  const labels = [...new Set(items
    .flatMap((i) => i.keys || [i.key])
    .filter(Boolean)
    .map((key) => MODULES[key]?.name || key))];
  const result = await punish.apply(guild, executorId, cfg.punishment, 'Kurisu nuke guard: destructive burst');
  if (!result.ok) locks.delete(lockKey);
  if (result.ok && result.kind === 'ban') await repo.removeNukeWatch(guild.id, executorId);
  else if (result.ok && result.kind === 'kick') await watchExecutor(guild, executorId, 'Kurisu nuke guard: destructive burst');

  const notes = [];
  for (const it of items) { const n = await mitigate(guild, it.key, it.entry, executorId); if (n) notes.push(n); }

  const response = result.ok ? PUNISHED_LABEL[result.kind] : 'Punishment failed';
  const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
  const details = [result.detail, ...notes].filter(Boolean).join('; ').slice(0, 400);
  const label = `Nuke attempt (${labels.join(', ')})`;
  await repo.addIncident(guild.id, { executorId, module: 'nukeGuard', action: label, count: items.length, threshold: cfg.threshold, response, status, details });
  await logging.incidentLog(guild, { executorId, actionLabel: label, count: items.length, threshold: cfg.threshold, response, status, details });
}

/** A watched user performed any auditable action: ban now, then mitigate the action. */
async function respondWatch(guild, executorId, watch, entry) {
  const lockKey = rowKey(guild.id, executorId);
  if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) return;
  locks.set(lockKey, Date.now() + LOCK_MS);
  const result = await punish.apply(guild, executorId, 'ban', `Kurisu nuke watch: ${watch.reason}`);
  if (result.ok) await repo.removeNukeWatch(guild.id, executorId);
  else locks.delete(lockKey);
  const note = entry ? await mitigate(guild, 'permEscalation', entry, executorId) : null;
  const response = result.ok ? PUNISHED_LABEL.ban : 'Punishment failed';
  const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
  const details = [result.detail, note].filter(Boolean).join('; ').slice(0, 400);
  await repo.addIncident(guild.id, {
    executorId, module: 'nukeGuard', action: 'Watched executor acted', count: 1, threshold: 1, response, status, details,
  });
  await logging.incidentLog(guild, {
    executorId, actionLabel: 'Watched executor acted', count: 1, threshold: 1, response, status, details,
  });
}

/** Called from GuildMemberAdd: watched executors are banned before they can act. */
async function handleJoin(member) {
  const guild = member?.guild;
  try {
    if (!guild) return false;
    const g = await repo.getGuild(guild.id);
    if (!g.antinuke_enabled) return false;
    const watch = await repo.getNukeWatch(guild.id, member.id);
    if (!watch) return false;
    if (await perms.isExempt(guild, member.id, 'general', null, member)) return false;

    const result = await punish.apply(guild, member.id, 'ban', `Kurisu nuke watch: ${watch.reason}`);
    if (result.ok) await repo.removeNukeWatch(guild.id, member.id);
    const response = result.ok ? PUNISHED_LABEL.ban : 'Punishment failed';
    const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
    const details = result.detail || watch.reason || null;
    await repo.addIncident(guild.id, {
      executorId: member.id, module: 'nukeGuard', action: 'Watched executor rejoined', count: 1, threshold: 1, response, status, details,
    });
    await logging.incidentLog(guild, {
      executorId: member.id, actionLabel: 'Watched executor rejoined', count: 1, threshold: 1, response, status, details,
    });
    return result.ok;
  } catch (err) {
    log.error(`nuke watch join handler error in ${guild?.id}`, err);
    return false;
  }
}

/** Undo what a violating action did. Idempotent per audit entry. */
async function mitigate(guild, key, entry, executorId) {
  if (!entry?.id) return null;
  const A = AuditLogEvent;
  const id = `${entry.id}`;
  if (mitigated.has(id)) return null;
  mitigated.add(id);
  switch (entry.action) {
    case A.ChannelDelete: return `channel: ${await recovery.restoreChannel(guild, entry.targetId)}`;
    case A.RoleDelete: return `role: ${await recovery.restoreRole(guild, entry.targetId)}`;
    case A.ChannelCreate: { const c = guild.channels.cache.get(entry.targetId); if (c) { await c.delete('Kurisu: removed during antinuke response').catch(() => {}); return 'created channel removed'; } return null; }
    case A.RoleCreate: { const r = guild.roles.cache.get(entry.targetId); if (r) { await r.delete('Kurisu: removed during antinuke response').catch(() => {}); return 'created role removed'; } return null; }
    case A.ChannelUpdate: return `channel: ${await recovery.revertChannelUpdate(guild, entry)}`;
    case A.RoleUpdate: return `role: ${await recovery.revertRoleUpdate(guild, entry)}`;
    case A.WebhookCreate: return `webhook: ${await recovery.deleteWebhook(guild, entry.targetId)}`;
    case A.BotAdd: return `bot: ${await recovery.removeBot(guild, entry.targetId)}`;
    case A.InviteCreate: return `invites: ${await recovery.deleteInvitesBy(guild, executorId)}`;
    case A.GuildUpdate: return `server: ${await recovery.revertGuildUpdate(guild, entry)}`;
    case A.MemberRoleUpdate: {
      if (key !== 'permEscalation') return null;
      const target = await punish.fetchMember(guild, entry.targetId);
      const added = (changeOf(entry, '$add')?.new || []).map((r) => r.id).filter((rid) => {
        const role = guild.roles.cache.get(rid); return role && (role.permissions.bitfield & DANGEROUS_BITS) && role.position < guild.members.me.roles.highest.position;
      });
      if (target && added.length) { await target.roles.remove(added, 'Kurisu: unauthorised privileged role removed').catch(() => {}); return 'privileged roles removed from target'; }
      return null;
    }
    default: return null;
  }
}

/** Message-based modules: @everyone and mass mention. */
async function handleMessage(message) {
  try {
    if (!message.guild || !message.member || message.webhookId || message.system) return;
    const g = await repo.getGuild(message.guild.id);
    if (!g.antinuke_enabled) return;
    const guild = message.guild;
    const authorId = message.author.id;

    const watch = await repo.getNukeWatch(guild.id, authorId);
    if (watch && !await perms.isExempt(guild, authorId, 'general', null, message.member)) {
      await message.delete().catch(() => {});
      await respondWatch(guild, authorId, watch, null);
      return;
    }

    const checks = [];
    if (message.mentions.everyone) checks.push(['everyoneMention', 1]);
    const n = message.mentions.users.size + message.mentions.roles.size;
    if (n > 1) checks.push(['massMention', n]);
    for (const [key, weight] of checks) {
      const cfg = await repo.getModule(guild.id, key, MODULES);
      if (!cfg.enabled) continue;
      if (await perms.isExempt(guild, authorId, 'message', key, message.member)) continue;
      if (key === 'everyoneMention') await message.delete().catch(() => {});
      else if (weight >= cfg.threshold) await message.delete().catch(() => {});
      await evaluateMessage(guild, key, authorId, weight, message);
    }
  } catch (err) { log.error('antinuke message handler error', err); }
}

async function evaluateMessage(guild, key, executorId, weight, message) {
  const cfg = await repo.getModule(guild.id, key, MODULES);
  const lockKey = rowKey(guild.id, executorId);
  if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) { await message.delete().catch(() => {}); return; }
  const { total } = slide(`${guild.id}:${executorId}:${key}`, cfg.window_sec * 1000, weight, null);
  if (total < cfg.threshold) return;
  locks.set(lockKey, Date.now() + LOCK_MS);
  windows.delete(`${guild.id}:${executorId}:${key}`);
  await respond(guild, key, cfg, executorId, total, [], null);
}

module.exports = {
  handleAuditEntry, handleMessage, handleJoin, slide, classify, trackNuke, actionLabel, ensureRecentLoaded,
  _state: { windows, seen, locks, recent, alerted, loadedRecent },
};
