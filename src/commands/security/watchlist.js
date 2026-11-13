'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const logging = require('../../engines/logging');
const ui = require('../../components/common/ui');
const { clip } = require('../../utils/helpers');

const { E } = ui;
const WATCH_MS = 24 * 3600 * 1000;

function render(guild) {
  const rows = repo.listNukeWatch(guild.id);
  const body = rows.length
    ? rows.map((r) => `<@${r.user_id}>  ·  expires <t:${Math.floor(r.expires_at / 1000)}:R>\n-# ${clip(r.reason, 200) || 'No reason provided'}`).join('\n\n')
    : 'No executors on the nuke watch.';
  return [
    `### ${E.banHammer} NUKE WATCH`,
    '-# A kicked nuke executor is banned the moment they act or rejoin.',
    'sep',
    body,
  ];
}

module.exports = {
  category: 'security', permission: 'Server Owner or Trusted Administrator',
  examples: { list: '/watchlist list', add: '/watchlist add user:@member reason:Attempted nuke', remove: '/watchlist remove user:@member' },
  render,
  data: new SlashCommandBuilder().setName('watchlist').setDescription('Manage the nuke watch list.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('list').setDescription('Show watched executors.'))
    .addSubcommand((s) => s.setName('add').setDescription('Watch a user (server owner only).')
      .addUserOption((o) => o.setName('user').setDescription('User to watch').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(200)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a user from the watch list.')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))),
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');

    const sub = i.options.getSubcommand();
    if (sub === 'list') return i.reply(ui.message(render(i.guild), { ephemeral: true }));

    const user = i.options.getUser('user', true);
    if (sub === 'add') {
      if (!perms.isOwnerClass(i.guild, i.user.id)) return fail(i, 'Only the server owner or a bot owner can add a watch entry.');
      if (perms.isOwnerClass(i.guild, user.id)) return fail(i, 'Owners are always exempt and cannot be watched.');
      const reason = i.options.getString('reason') || 'Manual watch';
      repo.addNukeWatch(i.guild.id, user.id, reason, Date.now() + WATCH_MS);
      await logging.send(i.guild, 'config', `${E.banHammer} NUKE WATCH UPDATED`, [`User: <@${user.id}>`, `Action: watch added`, `Reason: ${reason}`, `By: <@${i.user.id}>`]);
      return i.reply(ui.message([`${E.banHammer} <@${user.id}> is on the nuke watch for 24h.`, '-# Any auditable action or rejoin results in a ban.'], { ephemeral: true }));
    }

    const removed = repo.removeNukeWatch(i.guild.id, user.id);
    if (!removed) return fail(i, 'That user is not on the watch list.');
    await logging.send(i.guild, 'config', `${E.banHammer} NUKE WATCH UPDATED`, [`User: <@${user.id}>`, `Action: watch removed`, `By: <@${i.user.id}>`]);
    return i.reply(ui.notice(E.banHammer, `<@${user.id}> was removed from the nuke watch.`, { ephemeral: true }));
  },
};
