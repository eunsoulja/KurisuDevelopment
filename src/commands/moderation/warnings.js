'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const repo = require('../../database/repo');
const ui = require('../../components/common/ui');
const { LIMITS } = require('../../config/settings');
const { clip } = require('../../utils/helpers');

const { E } = ui;

async function render(guildId, userId, page, viewerId) {
  const total = await repo.countWarnings(guildId, userId);
  const pages = Math.max(1, Math.ceil(total / LIMITS.warningsPerPage));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = await repo.pageWarnings(guildId, userId, LIMITS.warningsPerPage, p * LIMITS.warningsPerPage);
  const body = rows.length
    ? rows.map((w) => `**#${w.id}** · <t:${Math.floor(w.created_at / 1000)}:d> · <@${w.moderator_id}>\n-# ${clip(w.reason, 200) || 'No reason'}`).join('\n\n')
    : 'No warnings on record.';
  const nav = pages > 1 ? ['sep', ui.buttons(
    ui.btn(`kw:${viewerId}:${userId}:${p - 1}`, 'Previous', { disabled: p === 0 }),
    ui.btn(`kw:${viewerId}:${userId}:${p + 1}`, 'Next', { disabled: p >= pages - 1 }),
  )] : [];
  return [`### ${E.modernRules} WARNINGS`, `<@${userId}> · ${total} total · page ${p + 1}/${pages}`, 'sep', body, ...nav];
}

module.exports = {
  category: 'moderation', permission: 'Moderate Members',
  examples: { '': '/warnings user:@member' },
  data: new SlashCommandBuilder().setName('warnings').setDescription('View warning history.')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
  render,
  async execute(i) {
    const err = guard(i, { user: [P.ModerateMembers] });
    if (err) return fail(i, err);
    const user = i.options.getUser('user', true);
    return i.reply(ui.message(await render(i.guild.id, user.id, 0, i.user.id), { ephemeral: true }));
  },
  /** customId: kw:<viewerId>:<userId>:<page> */
  async component(i) {
    const [, viewerId, userId, page] = i.customId.split(':');
    if (i.user.id !== viewerId) return i.reply(ui.error('These controls are not yours.'));
    if (!i.memberPermissions?.has(P.ModerateMembers)) return i.reply(ui.error('You no longer have permission to view warnings.'));
    return i.update(ui.edit(await render(i.guildId, userId, Number(page) || 0, viewerId)));
  },
};
