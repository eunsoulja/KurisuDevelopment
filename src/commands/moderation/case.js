'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const repo = require('../../database/repo');
const ui = require('../../components/common/ui');
const { clip, formatDuration } = require('../../utils/helpers');

const { E } = ui;
const PER_PAGE = 5;

function caseView(row) {
  const duration = row.duration_sec ? [`Duration **${formatDuration(row.duration_sec)}**`] : [];
  return [
    `### ${E.modernStaff} CASE #${row.case_number}`,
    `-# ${row.action.toUpperCase()} · <t:${Math.floor(row.created_at / 1000)}:R>`,
    'sep',
    `Target  ·  <@${row.user_id}>\nModerator  ·  <@${row.moderator_id}>`,
    ...duration,
    `Reason  ·  ${clip(row.reason, 300) || 'No reason provided'}`,
  ];
}

async function userView(guild, userId, page = 0) {
  const total = await repo.countUserCases(guild.id, userId);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = await repo.pageUserCases(guild.id, userId, PER_PAGE, p * PER_PAGE);
  const body = rows.length
    ? rows.map((r) => `**#${r.case_number}** · ${r.action.toUpperCase()} · <t:${Math.floor(r.created_at / 1000)}:d>\n-# <@${r.moderator_id}> · ${clip(r.reason, 180) || 'No reason provided'}`).join('\n\n')
    : 'No cases on record.';
  return [
    `### ${E.modernStaff} CASES FOR <@${userId}>`,
    `-# ${total} case(s) · page ${p + 1}/${pages}`,
    'sep',
    body,
  ];
}

module.exports = {
  category: 'moderation', permission: 'Moderate Members',
  examples: { view: '/case view case:12', user: '/case user user:@member page:1' },
  caseView, userView,
  data: new SlashCommandBuilder().setName('case').setDescription('View moderation cases.')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addSubcommand((s) => s.setName('view').setDescription('Show one case by number.')
      .addIntegerOption((o) => o.setName('case').setDescription('Case number').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('user').setDescription('Show a member\'s case history.')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(1000))),
  async execute(i) {
    const err = guard(i, { user: [P.ModerateMembers] });
    if (err) return fail(i, err);
    const sub = i.options.getSubcommand();
    if (sub === 'view') {
      const row = await repo.getCase(i.guild.id, i.options.getInteger('case', true));
      if (!row) return fail(i, 'That case does not exist.');
      return i.reply(ui.message(caseView(row), { ephemeral: true }));
    }
    const user = i.options.getUser('user', true);
    const page = (i.options.getInteger('page') || 1) - 1;
    return i.reply(ui.message(await userView(i.guild, user.id, page), { ephemeral: true }));
  },
};
