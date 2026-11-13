'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { fail } = require('../_util');
const perms = require('../../permissions');
const dashboard = require('../../components/dashboard');
const ui = require('../../components/common/ui');

module.exports = {
  category: 'security', permission: 'Server Owner or Trusted Administrator',
  examples: { '': '/security' },
  data: new SlashCommandBuilder().setName('security').setDescription('Open the Kurisu Security Center.')
    .setDefaultMemberPermissions(P.Administrator),
  async execute(i) {
    if (!i.inGuild()) return fail(i, 'This command only works in a server.');
    if (!await perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can open the security center.');
    return i.reply(ui.message(await dashboard.main(i.guild), { ephemeral: true }));
  },
};
