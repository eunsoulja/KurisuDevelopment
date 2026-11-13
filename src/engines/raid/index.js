'use strict';
const { ChannelType, GuildVerificationLevel, PermissionFlagsBits: P } = require('discord.js');
const repo = require('../../database/repo');
const logging = require('../logging');
const moderation = require('../moderation');
const perms = require('../../permissions');
const log = require('../../utils/logger');
const { E } = require('../../components/common/ui');

const LEVELS = ['NORMAL', 'ELEVATED', 'HIGH', 'LOCKDOWN'];
const rank = (l) => LEVELS.indexOf(l);
const LOCKABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
const INVITES_KEY = '__invites__';
const busy = new Set(); // per-guild transition lock

/** Pure: which level do `joins` joins inside the window correspond to? */
function levelFor(cfg, joins) {
  if (joins >= cfg.lockdown_joins) return 'LOCKDOWN';
  if (joins >= cfg.high_joins) return 'HIGH';
  if (joins >= cfg.elevated_joins) return 'ELEVATED';
  return 'NORMAL';
}

async function raidLog(guild, head, lines, status) {
  await repo.addIncident(guild.id, { executorId: 'system', module: 'raid', action: head, count: 0, threshold: 0, response: head, status: status || 'Logged', details: lines.join('; ').slice(0, 300) });
  return logging.send(guild, 'raid', `${E.modernRaid} ${head}`, lines);
}

async function onJoin(member) {
  const guild = member.guild;
  try {
    const g = await repo.getGuild(guild.id);
    if (!g.raid_enabled) return;
    const cfg = await repo.getRaid(guild.id);
    const now = Date.now();
    const ageDays = (now - member.user.createdTimestamp) / 86400000;
    const suspicious = ageDays < cfg.min_account_age_days;
    await repo.addJoin(guild.id, member.id, now, member.user.createdTimestamp, suspicious);

    // During lockdown optionally remove (kick, never ban) brand-new accounts.
    if (cfg.lockdown_active && cfg.kick_suspicious && suspicious && !await perms.isExempt(guild, member.id, 'general', null, member)) {
      const kicked = await member.kick('Kurisu raid protection: new account during lockdown').then(() => true).catch(() => false);
      if (kicked) await moderation.record(guild, { userId: member.id, moderatorId: guild.client.user.id, action: 'kick', reason: 'Raid lockdown: account younger than minimum age' });
      return;
    }

    const joins = (await repo.countJoins(guild.id, now - cfg.window_sec * 1000)).c;
    const target = levelFor(cfg, joins);
    if (rank(target) > rank(cfg.level)) await escalate(guild, cfg, target, joins);
  } catch (err) { log.error('raid join handler error', err); }
}

async function escalate(guild, cfg, level, joins) {
  if (busy.has(guild.id)) return;
  busy.add(guild.id);
  try {
    await repo.setRaid(guild.id, { level });
    const lines = [`Joins: ${joins} in ${cfg.window_sec}s`, `Level: ${level}`];
    if (level === 'HIGH') {
      const done = await setVerification(guild, GuildVerificationLevel.High, 2);
      lines.push(done ? 'Verification level raised' : 'Verification change failed (check permissions)');
    }
    if (level === 'LOCKDOWN') {
      if (cfg.auto_lockdown) {
        const r = await lockdown(guild, cfg.lockdown_minutes, null, true);
        lines.push(r.ok ? `Automatic lockdown for ${cfg.lockdown_minutes}m` : `Lockdown failed: ${r.error}`);
      } else lines.push('Automatic lockdown is disabled');
    }
    await raidLog(guild, `RAID LEVEL ${level}`, lines, level === 'ELEVATED' ? 'Monitoring' : 'Responding');
  } finally { busy.delete(guild.id); }
}

async function setVerification(guild, level, mode) {
  try {
    const cfg = await repo.getRaid(guild.id);
    if (!cfg.verification_active) await repo.setRaid(guild.id, { prev_verification_level: guild.verificationLevel });
    if (guild.verificationLevel < level) await guild.setVerificationLevel(level, 'Kurisu raid protection');
    await repo.setRaid(guild.id, { verification_active: mode });
    return true;
  } catch (err) { log.warn('verification change failed', err); return false; }
}
async function clearVerification(guild) {
  const cfg = await repo.getRaid(guild.id);
  if (!cfg.verification_active) return false;
  try {
    if (cfg.prev_verification_level !== null && cfg.prev_verification_level !== undefined) {
      await guild.setVerificationLevel(cfg.prev_verification_level, 'Kurisu raid protection: restored');
    }
    await repo.setRaid(guild.id, { verification_active: 0, prev_verification_level: null });
    return true;
  } catch (err) { log.warn('verification restore failed', err); return false; }
}

const overwriteState = (ch, everyoneId) => {
  const o = ch.permissionOverwrites.cache.get(everyoneId);
  if (!o) return 'neutral';
  if (o.deny.has(P.SendMessages)) return 'deny';
  if (o.allow.has(P.SendMessages)) return 'allow';
  return 'neutral';
};

async function lockdown(guild, minutes, by, automatic = false) {
  const cfg = await repo.getRaid(guild.id);
  if (cfg.lockdown_active) return { ok: false, error: 'a lockdown is already active' };
  const me = guild.members.me;
  if (!me.permissions.has(P.ManageChannels)) return { ok: false, error: 'I need Manage Channels' };
  const everyone = guild.roles.everyone;
  let locked = 0;
  await repo.setRaid(guild.id, { lockdown_active: 1, level: 'LOCKDOWN', lockdown_expires_at: minutes ? Date.now() + minutes * 60000 : null });
  for (const ch of guild.channels.cache.values()) {
    if (!LOCKABLE.includes(ch.type) || !ch.manageable) continue;
    const state = overwriteState(ch, everyone.id);
    if (state === 'deny') continue;
    await repo.saveLockedChannel(guild.id, ch.id, state);
    try { await ch.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: 'Kurisu lockdown' }); locked++; }
    catch (err) { log.warn(`lockdown: could not lock ${ch.id}`, err); }
  }
  await setVerification(guild, GuildVerificationLevel.VeryHigh, automatic ? 2 : 1);
  try {
    if (typeof guild.disableInvites === 'function' && !guild.features.includes('INVITES_DISABLED')) {
      await guild.disableInvites(true); await repo.saveLockedChannel(guild.id, INVITES_KEY, 'disabled');
    }
  } catch (err) { log.warn('lockdown: could not pause invites', err); }
  if (!automatic) await raidLog(guild, 'LOCKDOWN ENABLED', [`By: <@${by}>`, `Channels locked: ${locked}`, minutes ? `Expires: <t:${Math.floor((Date.now() + minutes * 60000) / 1000)}:R>` : 'No expiry'], 'Locked');
  return { ok: true, locked };
}

async function unlock(guild, by) {
  const cfg = await repo.getRaid(guild.id);
  if (!cfg.lockdown_active) return { ok: false, error: 'no lockdown is active' };
  const everyone = guild.roles.everyone;
  let restored = 0;
  for (const row of await repo.getLockedChannels(guild.id)) {
    if (row.channel_id === INVITES_KEY) { await guild.disableInvites?.(false).catch(() => {}); continue; }
    const ch = guild.channels.cache.get(row.channel_id);
    if (!ch) continue;
    const value = row.prev_state === 'allow' ? true : null;
    try { await ch.permissionOverwrites.edit(everyone, { SendMessages: value }, { reason: 'Kurisu lockdown ended' }); restored++; }
    catch (err) { log.warn(`unlock: could not restore ${ch.id}`, err); }
  }
  await repo.clearLockedChannels(guild.id);
  if (cfg.verification_active === 2 || cfg.verification_active === 1) await clearVerification(guild);
  await repo.setRaid(guild.id, { lockdown_active: 0, lockdown_expires_at: null, level: 'NORMAL' });
  await raidLog(guild, 'LOCKDOWN ENDED', [by ? `By: <@${by}>` : 'Expired automatically', `Channels restored: ${restored}`], 'Unlocked');
  return { ok: true, restored };
}

/** Timer: expire lockdowns and let the level fall back once joins calm down. */
async function tick(client) {
  for (const row of await repo.activeLockdowns()) {
    if (row.lockdown_expires_at && row.lockdown_expires_at <= Date.now()) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (guild) await unlock(guild, null).catch((e) => log.error('lockdown expiry failed', e));
    }
  }
  for (const guild of client.guilds.cache.values()) {
    const cfg = await repo.getRaid(guild.id);
    if (cfg.lockdown_active || cfg.level === 'NORMAL') continue;
    const recent = (await repo.countJoins(guild.id, Date.now() - cfg.window_sec * 3000)).c;
    if (levelFor(cfg, recent) === 'NORMAL') {
      if (cfg.verification_active === 2) await clearVerification(guild);
      await repo.setRaid(guild.id, { level: 'NORMAL' });
      await raidLog(guild, 'RAID LEVEL NORMAL', ['Join rate returned to normal'], 'Resolved');
    }
  }
  await repo.pruneJoins(Date.now() - 7 * 86400000);
}

async function setManualVerification(guild, on) {
  if (on) return setVerification(guild, GuildVerificationLevel.High, 1);
  return clearVerification(guild);
}

module.exports = { LEVELS, levelFor, onJoin, lockdown, unlock, tick, setManualVerification, clearVerification };
