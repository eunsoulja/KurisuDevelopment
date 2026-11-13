'use strict';
const { SlashCommandBuilder } = require('discord.js');
const help = require('../../components/help');
const ui = require('../../components/common/ui');
const text = require('../../text');

module.exports = {
  category: 'utility', permission: 'None',
  examples: { '': '/help category:Moderation' },
  data: new SlashCommandBuilder().setName('help').setDescription('Open the Kurisu Command Center.')
    .addStringOption((o) => o.setName('category').setDescription('Jump to a category').addChoices(
      ...Object.entries(help.CATEGORIES).map(([value, c]) => ({ name: c.name, value }))))
    .addStringOption((o) => o.setName('command').setDescription('Show details for a command').setAutocomplete(true))
    .addBooleanOption((o) => o.setName('visible').setDescription('Show the help menu to everyone (default: only you)')),
  autocomplete: help.autocomplete,
  async execute(i) {
    const prefix = i.guild ? await text.getPrefix(i.guild.id) : '!';
    const entries = help.collect(i.client.commands, prefix);
    const items = await help.initial(i.user.id, entries, {
      category: i.options.getString('category'), command: i.options.getString('command'), prefix,
    });
    return i.reply(ui.message(items, { ephemeral: !i.options.getBoolean('visible') }));
  },
};
