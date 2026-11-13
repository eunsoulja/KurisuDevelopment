'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const raid = require('../../engines/raid');
const ui = require('../../components/common/ui');

const { E } = ui;

module.exports = {
  category: 'raid', permission: 'Server Owner or Trusted Administrator',
  examples: { status: '/raid status', lockdown: '/raid lockdown minutes:30', unlock: '/raid unlock' },
  data: new SlashCommandBuilder().setName('raid').setDescription('Raid protection controls.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('status').setDescription('Show the current raid protection level.'))
    .addSubcommand((s) => s.setName('lockdown').setDescription('Lock the server down now.')
      .addIntegerOption((o) => o.setName('minutes').setDescription('Auto-unlock after (0 = manual, default 15)').setMinValue(0).setMaxValue(1440)))
    .addSubcommand((s) => s.setName('unlock').setDescription('End a lockdown and restore channels.')),
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!(await perms.canManageSecurity(i.guild, i.member))) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');
    const sub = i.options.getSubcommand();
    if (sub === 'status') {
      const c = await repo.getRaid(i.guild.id);
      const joins = await repo.countJoins(i.guild.id, Date.now() - c.window_sec * 1000);
      return i.reply(ui.message([
        `### ${E.modernRaid} RAID PROTECTION`, `Level: **${c.level}**`,
        `Joins (last ${c.window_sec}s): ${joins.c} (${joins.s} new accounts)`,
        `Lockdown: ${c.lockdown_active ? `active${c.lockdown_expires_at ? ` · ends <t:${Math.floor(c.lockdown_expires_at / 1000)}:R>` : ''}` : 'off'}`,
        `Verification mode: ${c.verification_active ? 'on' : 'off'}`,
      ], { ephemeral: true }));
    }
    await i.deferReply({ flags: 64 });
    if (sub === 'lockdown') {
      const raidCfg = await repo.getRaid(i.guild.id);
      const minutes = i.options.getInteger('minutes') ?? raidCfg.lockdown_minutes;
      const r = await raid.lockdown(i.guild, minutes, i.user.id);
      return r.ok ? i.editReply(ui.edit([`${E.modernRaid} Lockdown enabled. ${r.locked} channel(s) locked.`])) : fail(i, r.error);
    }
    const r = await raid.unlock(i.guild, i.user.id);
    return r.ok ? i.editReply(ui.edit([`${E.modernRaid} Lockdown ended. ${r.restored} channel(s) restored.`])) : fail(i, r.error);
  },
};
