'use strict';
const { PermissionFlagsBits: P } = require('discord.js');
const repo = require('../database/repo');
const { WHITELIST_LEVELS } = require('../config/settings');
const { entryAllows } = require('../config/whitelist');

const botOwners = () => (process.env.OWNER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const isBotOwner = (id) => botOwners().includes(id);
const isGuildOwner = (guild, id) => guild.ownerId === id;

/** Full-power actors: guild owner and bot owners. Cannot be removed or punished. */
const isOwnerClass = (guild, id) => isGuildOwner(guild, id) || isBotOwner(id);

function isTrustedAdmin(guild, member) {
  if (!member) return false;
  if (!member.permissions.has(P.Administrator)) return false;
  const entry = repo.getWhitelist(guild.id, member.id);
  if (entry?.level === 'trusted_admin') return true;
  for (const roleEntry of repo.roleWhitelist(guild.id)) {
    if (roleEntry.level === 'trusted_admin' && member.roles?.cache?.has(roleEntry.user_id)) return true;
  }
  return false;
}

/** Who may open /security and change protection settings. Checked on EVERY interaction. */
function canManageSecurity(guild, member) {
  if (!member) return false;
  return isOwnerClass(guild, member.id) || isTrustedAdmin(guild, member);
}

/** Whitelist authority. Trusted administrators may only manage trusted_mod and bot entries. */
function canGrantLevel(guild, member, level) {
  if (!WHITELIST_LEVELS[level]) return { ok: false, reason: 'Unknown whitelist level.' };
  if (isOwnerClass(guild, member.id)) return { ok: true };
  if (isTrustedAdmin(guild, member) && (level === 'trusted_mod' || level === 'bot')) return { ok: true };
  return { ok: false, reason: 'Only the server owner or bot owner can grant that level.' };
}

function canRemoveEntry(guild, member, targetId) {
  if (isOwnerClass(guild, targetId)) return { ok: false, reason: 'Owner protections cannot be removed.' };
  const entry = repo.getWhitelist(guild.id, targetId);
  if (!entry) return { ok: false, reason: 'That user or role is not whitelisted.' };
  return canGrantLevel(guild, member, entry.level);
}

/**
 * Antinuke immunity. Administrator permission alone grants nothing.
 * `moduleKey` makes scoped entries work; `member` lets role entries be checked even
 * when the member is not in the cache yet (message events always have one).
 */
function isExempt(guild, userId, group = 'general', moduleKey = null, member = null) {
  if (userId === guild.client.user.id) return true;
  if (isOwnerClass(guild, userId)) return true;
  const direct = repo.getWhitelist(guild.id, userId);
  if (direct && entryAllows(direct, group, moduleKey)) return true;
  const m = member || guild.members.cache.get(userId);
  if (m?.roles?.cache) {
    for (const roleEntry of repo.roleWhitelist(guild.id)) {
      if (roleEntry.user_id !== guild.id && m.roles.cache.has(roleEntry.user_id) && entryAllows(roleEntry, group, moduleKey)) return true;
    }
  }
  return false;
}

/** Returns an error string, or null when the action is allowed. */
function checkTarget({ guild, moderator, targetId, targetMember, verb }) {
  const me = guild.members.me;
  if (targetId === moderator.id) return `You cannot ${verb} yourself.`;
  if (targetId === guild.client.user.id) return `I cannot ${verb} myself.`;
  if (targetId === guild.ownerId) return `You cannot ${verb} the server owner.`;
  if (targetMember) {
    if (moderator.id !== guild.ownerId && targetMember.roles.highest.position >= moderator.roles.highest.position) {
      return `You cannot ${verb} someone with an equal or higher role.`;
    }
    if (me && targetMember.roles.highest.position >= me.roles.highest.position) {
      return 'That member\'s highest role is above or equal to mine.';
    }
  }
  return null;
}

function botMissing(guild, channel, perms) {
  const me = guild.members.me;
  const has = (channel ? channel.permissionsFor(me) : me.permissions);
  const missing = perms.filter((p) => !has?.has(p));
  return missing.length ? missing : null;
}

/**
 * Discord role hierarchy decides whether the bot can punish, strip or restore.
 * Returns null when the member or role cache is incomplete (caller skips the row).
 */
function rolePosition(guild, member = guild.members.me) {
  const cache = guild.roles?.cache;
  if (!member?.roles?.highest || !cache || cache.size === 0) return null; // cache not filled yet
  const top = member.roles.highest.position || 0;
  let highest = 0;
  for (const role of cache.values()) highest = Math.max(highest, role?.position || 0);
  return { position: top, highest, above: top >= highest };
}

module.exports = {
  botOwners, isBotOwner, isGuildOwner, isOwnerClass, isTrustedAdmin, canManageSecurity,
  canGrantLevel, canRemoveEntry, isExempt, checkTarget, botMissing, rolePosition,
};
