'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const raid = require('../../engines/raid');
const ui = require('../../components/common/ui');

const { E } = ui;

module.exports = {
  category: 'verification', permission: 'Server Owner or Trusted Administrator',
  examples: { enable: '/verification enable', disable: '/verification disable', status: '/verification status' },
  data: new SlashCommandBuilder().setName('verification').setDescription('Join verification mode.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('enable').setDescription('Raise the server verification level.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Restore the previous verification level.'))
    .addSubcommand((s) => s.setName('status').setDescription('Show verification mode status.')),
  async execute(i) {
    const err = guard(i, { bot: [P.ManageGuild] });
    if (err) return fail(i, err);
    if (!(await perms.canManageSecurity(i.guild, i.member))) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');
    const sub = i.options.getSubcommand();
    if (sub === 'status') {
      const c = await repo.getRaid(i.guild.id);
      return i.reply(ui.message([`${E.modernVerify} Verification mode is **${c.verification_active ? 'on' : 'off'}**.`], { ephemeral: true }));
    }
    await i.deferReply({ flags: 64 });
    const ok = await raid.setManualVerification(i.guild, sub === 'enable');
    return ok ? i.editReply(ui.edit([`${E.modernVerify} Verification mode ${sub === 'enable' ? 'enabled' : 'disabled'}.`])) : fail(i, 'Could not change the verification level.');
  },
};
