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

// ---- in-memory state (everything durable lives in SQLite) ----
const windows = new Map();   // `${guild}:${exec}:${module}` -> [{ t, w, entry }]
const seen = new Map();      // audit entry id -> timestamp (dedupe)
const locks = new Map();     // `${guild}:${exec}` -> expiry; after a breach, more actions are mitigated but not re-punished
const mitigated = new Set(); // entry ids already reverted
const recent = new Map();    // `${guild}:${exec}` -> [{ t, keys, key, entry }] for the cross-module Nuke Guard
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
 * is mirrored to SQLite so a burst survives a bot restart.
 */
function trackNuke(guildId, executorId, keys, entry, windowMs, nowMs = Date.now()) {
  const list = Array.isArray(keys) ? keys : [keys];
  const mapKey = rowKey(guildId, executorId);
  const cutoff = nowMs - windowMs;
  const byId = new Map();

  const memory = recent.get(mapKey) || [];

  // Load persisted actions only when this process has no window yet (startup
  // or after a response). During a live burst, memory is authoritative, so we
  // avoid a SQLite read on every audit entry.
  if (!memory.length) {
    let persisted = [];
    try { persisted = repo.listNukeRecent(guildId, executorId, cutoff); } catch (err) { log.debug('nuke recent load failed', err); }
    for (const row of persisted) {
      let parsed = [];
      try { parsed = JSON.parse(row.module_keys || '[]'); } catch { /* ignore malformed row */ }
      if (!Array.isArray(parsed)) parsed = [];
      byId.set(String(row.entry_id), {
        t: row.created_at, keys: parsed, key: parsed[0], entry: { id: row.entry_id },
      });
    }
  }

  // In-memory actions are newer and keep the full audit entry for mitigation.
  for (const item of memory) {
    if (item.t < cutoff) continue;
    const id = item.entry?.id != null ? String(item.entry.id) : `${item.t}:${item.key}`;
    byId.set(id, item);
  }

  // Re-processing the same audit entry must not double-count it.
  if (entry?.id != null) byId.delete(String(entry.id));
  const arr = [...byId.values()].sort((a, b) => a.t - b.t);
  arr.push({ t: nowMs, keys: list, key: list[0], entry });
  recent.set(mapKey, arr);
  if (entry?.id != null) {
    try { repo.addNukeRecent(guildId, executorId, entry.id, list, nowMs); } catch (err) { log.debug('nuke recent save failed', err); }
  }
  return arr;
}

function cleanup() {
  const n = Date.now();
  for (const [k, v] of seen) if (n - v > 120_000) seen.delete(k);
  for (const [k, v] of locks) if (v < n) locks.delete(k);
  for (const [k, arr] of windows) { const f = arr.filter((x) => n - x.t < 300_000); if (f.length) windows.set(k, f); else windows.delete(k); }
  for (const [k, arr] of recent) { const f = arr.filter((x) => n - x.t < 120_000); if (f.length) recent.set(k, f); else recent.delete(k); }
  for (const [k, v] of alerted) if (v < n) alerted.delete(k);
  if (mitigated.size > 5000) mitigated.clear();
  try { repo.pruneNukeWatch(n); } catch (err) { log.debug('nuke watch cleanup failed', err); }
  try { repo.pruneNukeRecent(n - 120_000); } catch (err) { log.debug('nuke recent cleanup failed', err); }
}
setInterval(cleanup, 60_000).unref();

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
function watchExecutor(guild, executorId, reason) {
  repo.addNukeWatch(guild.id, executorId, reason, Date.now() + NUKE_WATCH_MS);
}

async function handleAuditEntry(entry, guild) {
  try {
    if (!entry?.id || seen.has(entry.id)) return;
    seen.set(entry.id, Date.now());
    const executorId = entry.executorId;
    if (!executorId) return; // cannot attribute: never punish an arbitrary member
    if (!repo.getGuild(guild.id).antinuke_enabled) return;

    const lockKey = rowKey(guild.id, executorId);
    if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) {
      for (const { key } of classify(entry, guild)) await mitigate(guild, key, entry, executorId);
      return;
    }

    const watch = repo.getNukeWatch(guild.id, executorId);
    if (watch && !perms.isExempt(guild, executorId, 'general', null)) {
      await respondWatch(guild, executorId, watch, entry);
      return;
    }

    const mods = classify(entry, guild);

    // Nuke Guard runs BEFORE per-module thresholds, so a mixed burst is stopped at once.
    const guard = repo.getModule(guild.id, 'nukeGuard', MODULES);
    const activeNuke = guard.enabled
      ? mods.filter(({ key }) => MODULES[key]?.nuke
        && repo.getModule(guild.id, key, MODULES).enabled
        && !perms.isExempt(guild, executorId, MODULES[key].group || 'general', key))
      : [];
    if (activeNuke.length) {
      const items = trackNuke(guild.id, executorId, activeNuke.map(({ key }) => key), entry, guard.window_sec * 1000);
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
function refreshSnapshot(guild, entry) {
  const A = AuditLogEvent;
  if ([A.ChannelCreate, A.ChannelUpdate, A.ChannelOverwriteCreate, A.ChannelOverwriteUpdate, A.ChannelOverwriteDelete].includes(entry.action)) {
    const ch = guild.channels.cache.get(entry.targetId); if (ch) recovery.snapshotChannel(ch);
  } else if ([A.RoleCreate, A.RoleUpdate].includes(entry.action)) {
    const r = guild.roles.cache.get(entry.targetId); if (r) recovery.snapshotRole(r);
  }
}

/** Early warning: log the first hit on a destructive module while it is still below threshold. */
function maybeAlert(guild, key, executorId, total, cfg) {
  if (!MODULES[key]?.nuke) return;
  const k = `${guild.id}:${executorId}:${key}`;
  const now = Date.now();
  if ((alerted.get(k) || 0) > now) return;
  alerted.set(k, now + cfg.window_sec * 1000);
  void logging.watchLog(guild, {
    executorId, actionLabel: MODULES[key].name, count: total, threshold: cfg.threshold,
  }).catch(() => {});
}

async function evaluate(guild, key, executorId, entry, weight) {
  const mod = MODULES[key];
  const cfg = repo.getModule(guild.id, key, MODULES);
  if (!cfg.enabled) return;
  if (perms.isExempt(guild, executorId, mod.group, key)) { if (entry?.action) refreshSnapshot(guild, entry); return; }

  const lockKey = rowKey(guild.id, executorId);
  if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) {
    if (entry) await mitigate(guild, key, entry, executorId);
    return;
  }
  const { total, items } = slide(`${guild.id}:${executorId}:${key}`, cfg.window_sec * 1000, weight, entry);
  if (total < cfg.threshold) { maybeAlert(guild, key, executorId, total, cfg); return; }

  alerted.delete(`${guild.id}:${executorId}:${key}`);
  locks.set(lockKey, Date.now() + LOCK_MS);
  windows.delete(`${guild.id}:${executorId}:${key}`);
  await respond(guild, key, cfg, executorId, total, items.map((i) => i.entry).filter(Boolean), entry);
}

async function respond(guild, key, cfg, executorId, total, entries, lastEntry) {
  const mod = MODULES[key];
  let kind = cfg.punishment;
  const g = repo.getGuild(guild.id);
  const prior = repo.countExecutorIncidents(guild.id, executorId, Date.now() - 24 * 3600 * 1000);
  let escalated = false;
  if (g.escalation_threshold > 0 && prior + 1 >= g.escalation_threshold && kind !== 'ban') { kind = 'ban'; escalated = true; }
  const member = await punish.fetchMember(guild, executorId);
  if (member?.user.bot && kind !== 'ban') kind = 'ban';

  const result = await punish.apply(guild, executorId, kind, `Kurisu antinuke: ${mod.name}`);

  // A kicked executor goes on the 24h nuke watch: rejoin or act again and they are banned.
  if (result.ok && result.kind === 'ban') repo.removeNukeWatch(guild.id, executorId);
  else if (result.ok && result.kind === 'kick') watchExecutor(guild, executorId, `Kurisu antinuke: ${mod.name}`);

  const notes = [];
  for (const e of entries) { const n = await mitigate(guild, key, e, executorId); if (n) notes.push(n); }
  if (key === 'everyoneMention' || key === 'massMention') notes.push('offending messages removed');

  const response = result.ok ? PUNISHED_LABEL[result.kind] : 'Punishment failed';
  const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
  const details = [escalated ? 'escalated after repeat offence' : null, result.detail, ...notes].filter(Boolean).join('; ').slice(0, 400);
  const label = lastEntry?.action !== undefined ? actionLabel(lastEntry.action) : mod.name.replace(/^Anti-/, '');
  repo.addIncident(guild.id, { executorId, module: key, action: label, count: total, threshold: cfg.threshold, response, status, details });
  await logging.incidentLog(guild, { executorId, actionLabel: label, count: total, threshold: cfg.threshold, response, status, details });
}

/** Cross-module destructive burst. Default response: immediate kick, then 24h watch. */
async function respondNuke(guild, cfg, executorId, items) {
  const lockKey = rowKey(guild.id, executorId);
  recent.delete(lockKey);
  try { repo.clearNukeRecent(guild.id, executorId); } catch (err) { log.debug('nuke recent clear failed', err); }
  locks.set(lockKey, Date.now() + LOCK_MS); // block concurrent duplicate responses

  const labels = [...new Set(items
    .flatMap((i) => i.keys || [i.key])
    .filter(Boolean)
    .map((key) => MODULES[key]?.name || key))];
  const result = await punish.apply(guild, executorId, cfg.punishment, 'Kurisu nuke guard: destructive burst');
  if (!result.ok) locks.delete(lockKey);
  if (result.ok && result.kind === 'ban') repo.removeNukeWatch(guild.id, executorId);
  else if (result.ok && result.kind === 'kick') watchExecutor(guild, executorId, 'Kurisu nuke guard: destructive burst');

  const notes = [];
  for (const it of items) { const n = await mitigate(guild, it.key, it.entry, executorId); if (n) notes.push(n); }

  const response = result.ok ? PUNISHED_LABEL[result.kind] : 'Punishment failed';
  const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
  const details = [result.detail, ...notes].filter(Boolean).join('; ').slice(0, 400);
  const label = `Nuke attempt (${labels.join(', ')})`;
  repo.addIncident(guild.id, { executorId, module: 'nukeGuard', action: label, count: items.length, threshold: cfg.threshold, response, status, details });
  await logging.incidentLog(guild, { executorId, actionLabel: label, count: items.length, threshold: cfg.threshold, response, status, details });
}

/** A watched user performed any auditable action: ban now, then mitigate the action. */
async function respondWatch(guild, executorId, watch, entry) {
  const lockKey = rowKey(guild.id, executorId);
  if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) return;
  locks.set(lockKey, Date.now() + LOCK_MS); // block duplicate ban requests from a burst
  const result = await punish.apply(guild, executorId, 'ban', `Kurisu nuke watch: ${watch.reason}`);
  if (result.ok) repo.removeNukeWatch(guild.id, executorId);
  else locks.delete(lockKey);
  // Revert what the watched user just did. The permEscalation key makes sure
  // dangerous roles they handed out are removed too.
  const note = entry ? await mitigate(guild, 'permEscalation', entry, executorId) : null;
  const response = result.ok ? PUNISHED_LABEL.ban : 'Punishment failed';
  const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
  const details = [result.detail, note].filter(Boolean).join('; ').slice(0, 400);
  repo.addIncident(guild.id, {
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
    if (!guild || !repo.getGuild(guild.id).antinuke_enabled) return false;
    const watch = repo.getNukeWatch(guild.id, member.id);
    if (!watch) return false;
    if (perms.isExempt(guild, member.id, 'general', null, member)) return false;

    const result = await punish.apply(guild, member.id, 'ban', `Kurisu nuke watch: ${watch.reason}`);
    if (result.ok) repo.removeNukeWatch(guild.id, member.id);
    const response = result.ok ? PUNISHED_LABEL.ban : 'Punishment failed';
    const status = result.ok ? 'Neutralized' : 'Unresolved - manual action needed';
    const details = result.detail || watch.reason || null;
    repo.addIncident(guild.id, {
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
    if (!repo.getGuild(message.guild.id).antinuke_enabled) return;
    const guild = message.guild;
    const authorId = message.author.id;

    const watch = repo.getNukeWatch(guild.id, authorId);
    if (watch && !perms.isExempt(guild, authorId, 'general', null, message.member)) {
      await message.delete().catch(() => {});
      await respondWatch(guild, authorId, watch, null);
      return;
    }

    const checks = [];
    if (message.mentions.everyone) checks.push(['everyoneMention', 1]);
    const n = message.mentions.users.size + message.mentions.roles.size;
    if (n > 1) checks.push(['massMention', n]);
    for (const [key, weight] of checks) {
      const cfg = repo.getModule(guild.id, key, MODULES);
      if (!cfg.enabled || perms.isExempt(guild, authorId, 'message', key, message.member)) continue;
      if (key === 'everyoneMention') await message.delete().catch(() => {});
      else if (weight >= cfg.threshold) await message.delete().catch(() => {});
      await evaluateMessage(guild, key, authorId, weight, message);
    }
  } catch (err) { log.error('antinuke message handler error', err); }
}

async function evaluateMessage(guild, key, executorId, weight, message) {
  const cfg = repo.getModule(guild.id, key, MODULES);
  const lockKey = rowKey(guild.id, executorId);
  if (locks.has(lockKey) && locks.get(lockKey) > Date.now()) { await message.delete().catch(() => {}); return; }
  const { total, items } = slide(`${guild.id}:${executorId}:${key}`, cfg.window_sec * 1000, weight, null);
  if (total < cfg.threshold) return;
  locks.set(lockKey, Date.now() + LOCK_MS);
  windows.delete(`${guild.id}:${executorId}:${key}`);
  void items;
  await respond(guild, key, cfg, executorId, total, [], null);
}

module.exports = {
  handleAuditEntry, handleMessage, handleJoin, slide, classify, trackNuke, actionLabel,
  _state: { windows, seen, locks, recent, alerted },
};
