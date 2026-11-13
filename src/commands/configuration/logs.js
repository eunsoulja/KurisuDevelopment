'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const ui = require('../../components/common/ui');
const { LOG_TYPES } = require('../../config/settings');

const { E } = ui;
const typeChoices = Object.entries(LOG_TYPES).map(([value, name]) => ({ name, value }));

module.exports = {
  category: 'configuration', permission: 'Server Owner or Trusted Administrator',
  examples: { set: '/logs set type:Antinuke channel:#security-logs', clear: '/logs clear type:Antinuke', view: '/logs view' },
  data: new SlashCommandBuilder().setName('logs').setDescription('Configure log channels.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('set').setDescription('Set the channel for a log type.')
      .addStringOption((o) => o.setName('type').setDescription('Log type').setRequired(true).addChoices(...typeChoices))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('clear').setDescription('Stop logging a type.')
      .addStringOption((o) => o.setName('type').setDescription('Log type').setRequired(true).addChoices(...typeChoices)))
    .addSubcommand((s) => s.setName('view').setDescription('Show configured log channels.')),
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!await perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');
    const sub = i.options.getSubcommand();
    if (sub === 'set') {
      const ch = i.options.getChannel('channel', true);
      const full = i.guild.channels.cache.get(ch.id);
      if (!full?.permissionsFor(i.guild.members.me)?.has(['ViewChannel', 'SendMessages'])) return fail(i, 'I cannot send messages in that channel.');
      await repo.setLogChannel(i.guild.id, i.options.getString('type', true), ch.id);
      return i.reply(ui.notice(E.modernRules, `${LOG_TYPES[i.options.getString('type')]} logs will go to <#${ch.id}>.`, { ephemeral: true }));
    }
    if (sub === 'clear') {
      await repo.setLogChannel(i.guild.id, i.options.getString('type', true), null);
      return i.reply(ui.notice(E.modernRules, `${LOG_TYPES[i.options.getString('type')]} logs disabled.`, { ephemeral: true }));
    }
    const chans = await repo.allLogChannels(i.guild.id);
    return i.reply(ui.message([`### ${E.modernRules} LOG CHANNELS`, 'sep', Object.entries(LOG_TYPES).map(([k, l]) => `${l}  ·  ${chans[k] ? `<#${chans[k]}>` : 'not set'}`).join('\n')], { ephemeral: true }));
  },
};
