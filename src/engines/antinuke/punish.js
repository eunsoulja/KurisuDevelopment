'use strict';
const { PermissionsBitField } = require('discord.js');
const repo = require('../../database/repo');
const log = require('../../utils/logger');
const { retry } = require('../../utils/helpers');
const { DANGEROUS_BITS, LIMITS } = require('../../config/settings');

const FALLBACKS = {
  ban: ['kick', 'quarantine', 'timeout'],
  kick: ['quarantine', 'timeout'],
  strip: ['quarantine', 'timeout'],
  quarantine: ['timeout'],
  timeout: [],
};

async function fetchMember(guild, id) {
  return guild.members.cache.get(id) || guild.members.fetch(id).catch(() => null);
}

/** Roles that can be removed from the member by the bot. */
function removable(guild, member, onlyDangerous) {
  const me = guild.members.me;
  return member.roles.cache.filter((r) => {
    if (r.id === guild.id || r.managed) return false;
    if (r.position >= me.roles.highest.position) return false;
    if (onlyDangerous && !(r.permissions.bitfield & DANGEROUS_BITS)) return false;
    return true;
  });
}

async function getQuarantineRole(guild) {
  const settings = await repo.getGuild(guild.id);
  let role = settings.quarantine_role_id && guild.roles.cache.get(settings.quarantine_role_id);
  if (!role) {
    role = await guild.roles.create({
      name: 'Quarantine', permissions: new PermissionsBitField(0n), mentionable: false,
      reason: 'Kurisu: quarantine role',
    });
    await repo.setGuild(guild.id, 'quarantine_role_id', role.id);
  }
  return role;
}

async function attempt(guild, userId, kind, reason) {
  const member = await fetchMember(guild, userId);
  switch (kind) {
    case 'ban':
      await retry(() => guild.members.ban(userId, { reason, deleteMessageSeconds: 0 }));
      return 'ok';
    case 'kick':
      if (!member) throw new Error('executor is not in the server');
      await retry(() => member.kick(reason));
      return 'ok';
    case 'timeout':
      if (!member) throw new Error('executor is not in the server');
      await retry(() => member.timeout(LIMITS.timeoutMaxSec * 1000, reason));
      return 'ok';
    case 'strip': {
      if (!member) throw new Error('executor is not in the server');
      const roles = removable(guild, member, true);
      if (!roles.size) throw new Error('no strippable dangerous roles');
      await repo.saveQuarantine(guild.id, userId, member.roles.cache.filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id));
      await retry(() => member.roles.remove([...roles.keys()], reason));
      return 'ok';
    }
    case 'quarantine': {
      if (!member) throw new Error('executor is not in the server');
      const roles = removable(guild, member, false);
      const role = await getQuarantineRole(guild);
      await repo.saveQuarantine(guild.id, userId, member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.id !== role.id).map((r) => r.id));
      if (roles.size) await retry(() => member.roles.remove([...roles.keys()], reason));
      await member.roles.add(role, reason);
      await member.timeout(LIMITS.timeoutMaxSec * 1000, reason).catch(() => {});
      return 'ok';
    }
    default: throw new Error(`unknown punishment ${kind}`);
  }
}

/**
 * Apply `kind`, walking the fallback chain if Discord refuses (hierarchy, permissions).
 * Never targets the guild owner or the bot itself.
 */
async function apply(guild, userId, kind, reason) {
  if (userId === guild.ownerId || userId === guild.client.user.id) return { ok: false, kind: null, detail: 'protected account' };
  const chain = [kind, ...(FALLBACKS[kind] || [])];
  const errors = [];
  for (const k of chain) {
    try {
      await attempt(guild, userId, k, reason);
      return { ok: true, kind: k, detail: k === kind ? null : `fallback from ${kind}` };
    } catch (err) {
      errors.push(`${k}: ${err.message}`);
      log.warn(`punishment ${k} failed for ${userId} in ${guild.id}`, err);
    }
  }
  return { ok: false, kind: null, detail: errors.join('; ').slice(0, 300) };
}

module.exports = { apply, removable, fetchMember, getQuarantineRole };
