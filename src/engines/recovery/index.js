'use strict';
const { ChannelType, PermissionsBitField } = require('discord.js');
const repo = require('../../database/repo');
const log = require('../../utils/logger');
const { sleep, retry } = require('../../utils/helpers');
const { DANGEROUS_BITS } = require('../../config/settings');

/*
 * Recovery limits (Discord API):
 *  - message history of a deleted channel cannot be recovered
 *  - members of a deleted role cannot be re-assigned unless they were captured (they are not)
 *  - a restored channel/role gets a NEW id
 *  - vanity URLs and server icons cannot be restored through the API
 */

const deletedCache = new Map(); // `${kind}:${id}` -> { data, t }
const TTL = 15 * 60 * 1000;
function remember(kind, id, data) {
  deletedCache.set(`${kind}:${id}`, { data, t: Date.now() });
  for (const [k, v] of deletedCache) if (Date.now() - v.t > TTL) deletedCache.delete(k);
}

const BITS = (v) => BigInt(v);

function serializeChannel(ch) {
  return {
    id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId || null,
    topic: ch.topic ?? null, nsfw: !!ch.nsfw, rateLimitPerUser: ch.rateLimitPerUser ?? 0,
    bitrate: ch.bitrate ?? null, userLimit: ch.userLimit ?? null, position: ch.rawPosition ?? 0,
    overwrites: [...(ch.permissionOverwrites?.cache.values() || [])].map((o) => ({
      id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
    })),
  };
}
function serializeRole(r) {
  return {
    id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable,
    permissions: r.permissions.bitfield.toString(), position: r.position, managed: r.managed,
  };
}

function snapshotChannel(channel) {
  if (!channel.guild || channel.isThread?.()) return;
  repo.saveSnapshot(channel.guild.id, 'channel', channel.id, channel.name, serializeChannel(channel));
}
function snapshotRole(role) {
  if (role.managed || role.id === role.guild.id) return;
  repo.saveSnapshot(role.guild.id, 'role', role.id, role.name, serializeRole(role));
}
/** Full refresh. Called on boot and periodically while no incident is active. */
function snapshotGuild(guild) {
  const known = { channel: new Set(), role: new Set() };
  for (const ch of guild.channels.cache.values()) { if (!ch.isThread?.()) { snapshotChannel(ch); known.channel.add(ch.id); } }
  for (const r of guild.roles.cache.values()) { snapshotRole(r); known.role.add(r.id); }
  for (const kind of ['channel', 'role']) {
    for (const s of repo.listSnapshots(guild.id, kind)) {
      if (!known[kind].has(s.target_id) && !deletedCache.has(`${kind}:${s.target_id}`)) repo.deleteSnapshot(guild.id, kind, s.target_id);
    }
  }
}

function noteDeletedChannel(ch) { if (ch.guild) remember('channel', ch.id, serializeChannel(ch)); }
function noteDeletedRole(r) { if (!r.managed) remember('role', r.id, serializeRole(r)); }

async function lookup(guildId, kind, id) {
  for (let i = 0; i < 6; i++) {
    const hit = deletedCache.get(`${kind}:${id}`);
    if (hit) return hit.data;
    await sleep(250);
  }
  return repo.getSnapshot(guildId, kind, id)?.data || null;
}

function sanitizeOverwrites(guild, overwrites) {
  let stripped = 0;
  const out = [];
  for (const o of overwrites) {
    const exists = o.type === 0 ? guild.roles.cache.has(o.id) : guild.members.cache.has(o.id);
    if (!exists) continue;
    const allow = BITS(o.allow);
    const safe = allow & ~DANGEROUS_BITS;
    if (safe !== allow) stripped++;
    out.push({ id: o.id, type: o.type, allow: safe, deny: BITS(o.deny) });
  }
  return { overwrites: out, stripped };
}

const note = (guild, kind, id, result, details) => { repo.addRecovery(guild.id, kind, id, result, details); return `${result}${details ? ` (${details})` : ''}`; };

async function restoreChannel(guild, oldId) {
  const data = await lookup(guild.id, 'channel', oldId);
  if (!data) return note(guild, 'channel', oldId, 'skipped', 'no snapshot available');
  try {
    const { overwrites, stripped } = sanitizeOverwrites(guild, data.overwrites);
    const parent = data.parentId && guild.channels.cache.get(data.parentId) ? data.parentId : undefined;
    const opts = { name: data.name, type: data.type, parent, permissionOverwrites: overwrites, position: data.position, reason: 'Kurisu recovery: channel restored' };
    if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(data.type)) {
      opts.topic = data.topic || undefined; opts.nsfw = data.nsfw; opts.rateLimitPerUser = data.rateLimitPerUser;
    }
    if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(data.type)) {
      if (data.bitrate) opts.bitrate = Math.min(data.bitrate, guild.maximumBitrate);
      opts.userLimit = data.userLimit || 0;
    }
    const created = await retry(() => guild.channels.create(opts));
    if (data.type === ChannelType.GuildCategory) {
      for (const s of repo.listSnapshots(guild.id, 'channel')) {
        if (s.data.parentId === oldId) {
          const child = guild.channels.cache.get(s.target_id);
          if (child) await child.setParent(created.id, { lockPermissions: false }).catch(() => {});
        }
      }
    }
    repo.deleteSnapshot(guild.id, 'channel', oldId);
    // Re-snapshotting is an optimisation, not part of the restore: a partial member
    // cache must not turn a successful restore into a reported failure.
    try { snapshotChannel(created); } catch (err) { log.debug('re-snapshot of restored channel failed', err); }
    return note(guild, 'channel', oldId, 'restored', `${data.name}${stripped ? `, ${stripped} dangerous overwrite(s) sanitised` : ''}; messages cannot be recovered`);
  } catch (err) {
    log.warn('channel restore failed', err);
    return note(guild, 'channel', oldId, 'failed', err.message);
  }
}

async function restoreRole(guild, oldId) {
  const data = await lookup(guild.id, 'role', oldId);
  if (!data) return note(guild, 'role', oldId, 'skipped', 'no snapshot available');
  try {
    const perms = BITS(data.permissions);
    const safe = perms & ~DANGEROUS_BITS;
    const role = await retry(() => guild.roles.create({
      name: data.name, color: data.color, hoist: data.hoist, mentionable: data.mentionable,
      permissions: new PermissionsBitField(safe), reason: 'Kurisu recovery: role restored',
    }));
    const me = guild.members.me;
    const pos = Math.min(data.position, me.roles.highest.position - 1);
    if (pos > 0) await role.setPosition(pos).catch(() => {});
    repo.deleteSnapshot(guild.id, 'role', oldId);
    try { snapshotRole(role); } catch (err) { log.debug('re-snapshot of restored role failed', err); }
    return note(guild, 'role', oldId, 'restored', `${data.name}${safe !== perms ? ', dangerous permissions withheld' : ''}; members must be re-assigned`);
  } catch (err) {
    log.warn('role restore failed', err);
    return note(guild, 'role', oldId, 'failed', err.message);
  }
}

const changeOf = (entry, key) => entry.changes?.find((c) => c.key === key);

/** Revert a role edit using the audit log's old values. Never grants permissions, only removes added dangerous ones. */
async function revertRoleUpdate(guild, entry) {
  const role = guild.roles.cache.get(entry.targetId);
  if (!role || role.managed) return note(guild, 'role', entry.targetId, 'skipped', 'role unavailable');
  try {
    const patch = {};
    for (const [key, prop] of [['name', 'name'], ['color', 'color'], ['hoist', 'hoist'], ['mentionable', 'mentionable']]) {
      const c = changeOf(entry, key);
      if (c && c.old !== undefined) patch[prop] = c.old;
    }
    const p = changeOf(entry, 'permissions');
    let removed = 0n;
    if (p) {
      const added = BITS(p.new ?? 0) & ~BITS(p.old ?? 0) & DANGEROUS_BITS;
      removed = added;
      if (added) patch.permissions = new PermissionsBitField(role.permissions.bitfield & ~added);
    }
    if (!Object.keys(patch).length) return note(guild, 'role', role.id, 'skipped', 'nothing to revert');
    await role.edit({ ...patch, reason: 'Kurisu recovery: unauthorised role change reverted' });
    snapshotRole(role);
    return note(guild, 'role', role.id, 'reverted', removed ? 'dangerous permissions removed' : 'role properties reverted');
  } catch (err) { return note(guild, 'role', entry.targetId, 'failed', err.message); }
}

async function revertChannelUpdate(guild, entry) {
  const ch = guild.channels.cache.get(entry.targetId);
  if (!ch) return note(guild, 'channel', entry.targetId, 'skipped', 'channel unavailable');
  const map = { name: 'name', topic: 'topic', nsfw: 'nsfw', rate_limit_per_user: 'rateLimitPerUser' };
  const patch = {};
  for (const [k, prop] of Object.entries(map)) { const c = changeOf(entry, k); if (c && c.old !== undefined) patch[prop] = c.old; }
  if (!Object.keys(patch).length) return note(guild, 'channel', ch.id, 'skipped', 'overwrite or unsupported change, not auto-reverted');
  try { await ch.edit({ ...patch, reason: 'Kurisu recovery: channel change reverted' }); return note(guild, 'channel', ch.id, 'reverted', Object.keys(patch).join(', ')); }
  catch (err) { return note(guild, 'channel', ch.id, 'failed', err.message); }
}

async function revertGuildUpdate(guild, entry) {
  const c = changeOf(entry, 'name');
  if (c?.old) {
    try { await guild.setName(c.old, 'Kurisu recovery: server name reverted'); return note(guild, 'guild', guild.id, 'reverted', 'server name'); }
    catch (err) { return note(guild, 'guild', guild.id, 'failed', err.message); }
  }
  return note(guild, 'guild', guild.id, 'skipped', 'icon, banner and vanity URL cannot be restored through the API');
}

async function deleteWebhook(guild, id) {
  try {
    const hooks = await guild.fetchWebhooks();
    const hook = hooks.get(id);
    if (!hook) return note(guild, 'webhook', id, 'skipped', 'webhook not found');
    await hook.delete('Kurisu recovery: unauthorised webhook removed');
    return note(guild, 'webhook', id, 'removed');
  } catch (err) { return note(guild, 'webhook', id, 'failed', err.message); }
}

async function removeBot(guild, botId) {
  try {
    const m = await guild.members.fetch(botId);
    await m.kick('Kurisu recovery: unapproved bot removed');
    return note(guild, 'bot', botId, 'removed');
  } catch (err) { return note(guild, 'bot', botId, 'failed', err.message); }
}

async function deleteInvitesBy(guild, userId) {
  try {
    const invites = await guild.invites.fetch();
    const mine = invites.filter((i) => i.inviterId === userId);
    for (const i of mine.values()) await i.delete('Kurisu recovery: invite spam').catch(() => {});
    return note(guild, 'invite', userId, 'removed', `${mine.size} invite(s)`);
  } catch (err) { return note(guild, 'invite', userId, 'failed', err.message); }
}

module.exports = {
  snapshotChannel, snapshotRole, snapshotGuild, noteDeletedChannel, noteDeletedRole,
  restoreChannel, restoreRole, revertRoleUpdate, revertChannelUpdate, revertGuildUpdate,
  deleteWebhook, removeBot, deleteInvitesBy, serializeChannel, serializeRole,
};
