'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const ui = require('../../components/common/ui');
const { LIMITS } = require('../../config/settings');
const { clip, describeError } = require('../../utils/helpers');

const { E } = ui;
const FETCH_LIMIT = 200;

function render(guild, bans, page = 0, viewerId) {
  const total = bans.length;
  const pages = Math.max(1, Math.ceil(total / LIMITS.bansPerPage));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = bans.slice(p * LIMITS.bansPerPage, (p + 1) * LIMITS.bansPerPage);
  const body = slice.length ? slice.map((b) => `**${clip(b.user.username, 40)}** · <@${b.user.id}>\n-# ${clip(b.reason, 180) || 'No reason provided'}`).join('\n\n') : 'No bans on record.';
  const nav = pages > 1 ? ['sep', ui.buttons(
    ui.btn(`kb:${viewerId}:${p - 1}`, 'Previous', { disabled: p === 0 }),
    ui.btn(`kb:${viewerId}:${p + 1}`, 'Next', { disabled: p >= pages - 1 }),
  )] : [];
  return [
    `### ${E.banHammer} BAN LIST`,
    `-# ${total} ban(s) · page ${p + 1}/${pages}${total >= FETCH_LIMIT ? ` · showing the first ${FETCH_LIMIT}` : ''}`,
    'sep',
    body,
    ...nav,
  ];
}

async function fetchBans(guild) {
  const bans = await guild.bans.fetch({ limit: FETCH_LIMIT });
  return [...bans.values()];
}

module.exports = {
  category: 'moderation', permission: 'Ban Members',
  examples: { '': '/banlist page:1', lookup: '/banlist user:@member' },
  data: new SlashCommandBuilder().setName('banlist').setDescription('List banned users or check one ban.')
    .setDefaultMemberPermissions(P.BanMembers)
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Check a specific user')),
  render,
  async execute(i) {
    const err = guard(i, { user: [P.BanMembers], bot: [P.BanMembers] });
    if (err) return fail(i, err);
    await i.deferReply({ flags: 64 });
    try {
      const user = i.options.getUser('user');
      if (user) {
        const ban = await i.guild.bans.fetch(user.id).catch(() => null);
        return i.editReply(ui.edit(ban
          ? [`### ${E.banHammer} BAN LOOKUP`, `<@${user.id}> is **banned**.`, `-# Reason: ${clip(ban.reason, 300) || 'No reason provided'}`]
          : [`### ${E.banHammer} BAN LOOKUP`, `<@${user.id}> is **not banned**.`]));
      }
      const all = await fetchBans(i.guild);
      return i.editReply(ui.edit(render(i.guild, all, (i.options.getInteger('page') || 1) - 1, i.user.id)));
    } catch (e) { return fail(i, describeError(e)); }
  },
  /** customId: kb:<viewerId>:<page> */
  async component(i) {
    if (!i.memberPermissions?.has(P.BanMembers)) return i.reply(ui.error('You need Ban Members to view the ban list.'));
    const [, viewerId, page] = i.customId.split(':');
    if (i.user.id !== viewerId) return i.reply(ui.error('These controls are not yours.'));
    await i.deferUpdate();
    try {
      const all = await fetchBans(i.guild);
      return i.editReply(ui.edit(render(i.guild, all, Number(page) || 0, viewerId)));
    } catch (e) {
      return i.editReply(ui.edit([`${E.redDot} ${describeError(e)}`]));
    }
  },
};
