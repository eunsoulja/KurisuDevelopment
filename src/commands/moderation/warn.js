'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail, done } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const moderation = require('../../engines/moderation');
const { E } = require('../../components/common/ui');

module.exports = {
  category: 'moderation', permission: 'Moderate Members',
  examples: { '': '/warn user:@member reason:Please follow the rules' },
  data: new SlashCommandBuilder().setName('warn').setDescription('Issue a moderation warning.')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(400)),
  async execute(i) {
    const err = guard(i, { user: [P.ModerateMembers] });
    if (err) return fail(i, err);
    const user = i.options.getUser('user', true);
    if (user.bot) return fail(i, 'Bots cannot be warned.');
    const bad = perms.checkTarget({ guild: i.guild, moderator: i.member, targetId: user.id, targetMember: i.options.getMember('user'), verb: 'warn' });
    if (bad) return fail(i, bad);
    const reason = i.options.getString('reason', true);
    await i.deferReply();
    await repo.addWarning(i.guild.id, user.id, i.user.id, reason);
    const c = await moderation.record(i.guild, { userId: user.id, moderatorId: i.user.id, action: 'warn', reason });
    const total = await repo.countWarnings(i.guild.id, user.id);
    return done(i, E.modernRules, `Warned **${user.username}** (${total} total). Case #${c.case_number}`);
  },
};
