'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const logging = require('../../engines/logging');
const ui = require('../../components/common/ui');
const { WHITELIST_LEVELS } = require('../../config/settings');
const { SCOPE_LABELS, SCOPE_PRESETS, storedScopes, parseScopes, scopesLabel } = require('../../config/whitelist');
const { KEYS } = require('../../engines/antinuke/modules');
const { clip } = require('../../utils/helpers');

const { E } = ui;
const levelChoices = Object.entries(WHITELIST_LEVELS).map(([value, name]) => ({ name, value }));
const mention = (targetType, id) => (targetType === 'role' ? `<@&${id}>` : `<@${id}>`);

/** Shared by the command and the dashboard so both enforce identical rules. Returns { ok, message }. */
async function addEntry(guild, actorMember, target, level, { targetType = 'user', scopes = null } = {}) {
  const can = await perms.canGrantLevel(guild, actorMember, level);
  if (!can.ok) return { ok: false, message: can.reason };
  if (targetType === 'user') {
    if (target.id === guild.client.user.id) return { ok: false, message: 'Kurisu is always exempt.' };
    if (perms.isOwnerClass(guild, target.id)) return { ok: false, message: 'Owners are always exempt and need no entry.' };
    if (level === 'bot' && !target.bot) return { ok: false, message: 'The Trusted Bot level is for bot accounts only.' };
    if (level !== 'bot' && target.bot) return { ok: false, message: 'Bots can only be added as Trusted Bot.' };
  } else {
    if (level === 'bot') return { ok: false, message: 'The Trusted Bot level is for bot accounts only.' };
    if (target.id === guild.id) return { ok: false, message: 'The @everyone role cannot be whitelisted.' };
  }
  const existing = await repo.getWhitelist(guild.id, target.id);
  if (existing) {
    const cur = await perms.canGrantLevel(guild, actorMember, existing.level);
    if (!cur.ok) return { ok: false, message: 'You cannot change that existing entry.' };
  }
  await repo.addWhitelist(guild.id, target.id, level, actorMember.id, { targetType, scopes });
  await logging.send(guild, 'config', `${E.modernRules} WHITELIST UPDATED`, [
    `${targetType === 'role' ? 'Role' : 'User'}: ${mention(targetType, target.id)}`,
    `Level: ${WHITELIST_LEVELS[level]}`,
    `Scope: ${scopesLabel(scopes)}`,
    `By: <@${actorMember.id}>`,
  ]);
  return { ok: true, message: `${mention(targetType, target.id)} is now **${WHITELIST_LEVELS[level]}** (${scopesLabel(scopes)}).` };
}

async function removeEntry(guild, actorMember, target) {
  const can = await perms.canRemoveEntry(guild, actorMember, target.id);
  if (!can.ok) return { ok: false, message: can.reason };
  const entry = await repo.getWhitelist(guild.id, target.id);
  const targetType = entry?.target_type === 'role' ? 'role' : 'user';
  await repo.removeWhitelist(guild.id, target.id);
  await logging.send(guild, 'config', `${E.modernRules} WHITELIST UPDATED`, [`Removed: ${mention(targetType, target.id)}`, `By: <@${actorMember.id}>`]);
  return { ok: true, message: `Removed ${mention(targetType, target.id)} from the whitelist.` };
}

/** Direct entry plus every role entry that applies to this user. */
async function describe(guild, userId) {
  if (userId === guild.client.user.id) return 'Kurisu (always exempt)';
  if (perms.isGuildOwner(guild, userId)) return 'Server Owner (always exempt)';
  if (perms.isBotOwner(userId)) return 'Bot Owner (always exempt)';
  const lines = [];
  const entry = await repo.getWhitelist(guild.id, userId);
  if (entry) lines.push(`${WHITELIST_LEVELS[entry.level]}  ·  ${scopesLabel(storedScopes(entry.scopes))}`);
  const member = guild.members.cache.get(userId);
  if (member) {
    for (const roleEntry of await repo.roleWhitelist(guild.id)) {
      if (member.roles.cache.has(roleEntry.user_id)) {
        lines.push(`via <@&${roleEntry.user_id}>  ·  ${WHITELIST_LEVELS[roleEntry.level]}  ·  ${scopesLabel(storedScopes(roleEntry.scopes))}`);
      }
    }
  }
  return lines.length ? lines.join('\n') : 'Not whitelisted';
}

async function autocomplete(i) {
  const query = i.options.getFocused().toLowerCase();
  const choices = [
    ...Object.entries(SCOPE_PRESETS).map(([value, preset]) => ({ name: preset.name, value })),
    ...KEYS.map((key) => ({ name: `${SCOPE_LABELS[key]} (${key})`, value: key })),
  ];
  await i.respond(choices.filter((c) => c.name.toLowerCase().includes(query) || c.value.includes(query)).slice(0, 25));
}

module.exports = {
  category: 'administration', permission: 'Server Owner or Trusted Administrator',
  examples: {
    add: '/whitelist add user:@member level:Trusted Moderator scopes:pings',
    remove: '/whitelist remove role:@Moderators',
    list: '/whitelist list',
    check: '/whitelist check user:@member',
  },
  addEntry, removeEntry, describe,
  data: new SlashCommandBuilder().setName('whitelist').setDescription('Manage antinuke exemptions.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('add').setDescription('Add or update a trusted user or role.')
      .addStringOption((o) => o.setName('level').setDescription('Trust level').setRequired(true).addChoices(...levelChoices))
      .addUserOption((o) => o.setName('user').setDescription('User to whitelist').setRequired(false))
      .addRoleOption((o) => o.setName('role').setDescription('Role to whitelist').setRequired(false))
      .addStringOption((o) => o.setName('scopes').setDescription('Specific modules/presets, comma separated (default: level default)').setRequired(false).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a trusted user or role.')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(false))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(false)))
    .addSubcommand((s) => s.setName('list').setDescription('List trusted users and roles.'))
    .addSubcommand((s) => s.setName('check').setDescription('Check a user\'s exemption status.')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))),
  autocomplete,
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!await perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');
    const sub = i.options.getSubcommand();
    if (sub === 'add') {
      const user = i.options.getUser('user');
      const role = i.options.getRole('role');
      if (!!user === !!role) return fail(i, 'Choose either a user or a role.');
      const parsed = parseScopes(i.options.getString('scopes'));
      if (!parsed.ok) return fail(i, parsed.error);
      const r = await addEntry(i.guild, i.member, user || role, i.options.getString('level', true), {
        targetType: user ? 'user' : 'role', scopes: parsed.scopes,
      });
      return r.ok ? i.reply(ui.notice(E.modernRules, r.message, { ephemeral: true })) : fail(i, r.message);
    }
    if (sub === 'remove') {
      const user = i.options.getUser('user');
      const role = i.options.getRole('role');
      if (!!user === !!role) return fail(i, 'Choose either a user or a role.');
      const r = await removeEntry(i.guild, i.member, user || role);
      return r.ok ? i.reply(ui.notice(E.modernRules, r.message, { ephemeral: true })) : fail(i, r.message);
    }
    if (sub === 'check') {
      const u = i.options.getUser('user', true);
      return i.reply(ui.message([`${E.modernRules} <@${u.id}>`, await describe(i.guild, u.id)], { ephemeral: true }));
    }
    const rows = await repo.listWhitelist(i.guild.id);
    const lines = rows.length ? clip(rows.slice(0, 30).map((r) => {
      const targetType = r.target_type === 'role' ? 'role' : 'user';
      return `${mention(targetType, r.user_id)}  ·  ${WHITELIST_LEVELS[r.level]}  ·  ${scopesLabel(storedScopes(r.scopes))}`;
    }).join('\n'), 3000) : 'No whitelist entries. Owners are always exempt.';
    return i.reply(ui.message([`### ${E.modernRules} WHITELIST`, 'sep', lines], { ephemeral: true }));
  },
};
