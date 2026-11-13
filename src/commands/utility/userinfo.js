'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { guard, fail } = require('../_util');
const repo = require('../../database/repo');
const whitelist = require('../whitelist/whitelist');
const ui = require('../../components/common/ui');
const { DANGEROUS_BITS } = require('../../config/settings');
const { clip } = require('../../utils/helpers');

const { E } = ui;

module.exports = {
  category: 'utility', permission: 'None',
  examples: { '': '/userinfo user:@member' },
  data: new SlashCommandBuilder().setName('userinfo').setDescription('Show account, roles and security details for a user.')
    .addUserOption((o) => o.setName('user').setDescription('User to inspect (default: you)')),
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    const user = i.options.getUser('user') || i.user;
    const member = i.options.getMember('user')
      || i.guild.members.cache.get(user.id)
      || await i.guild.members.fetch(user.id).catch(() => null);

    const created = `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`;
    const joined = member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Not in this server';
    const roles = member
      ? [...member.roles.cache.filter((r) => r.id !== i.guild.id).values()].sort((a, b) => b.position - a.position)
      : [];
    const dangerous = member
      ? member.roles.cache.filter((r) => r.id !== i.guild.id && (r.permissions.bitfield & DANGEROUS_BITS)).size
      : 0;
    const roleLine = roles.length ? clip(roles.slice(0, 12).map((r) => `<@&${r.id}>`).join(' '), 400) : 'None';

    return i.reply(ui.message([
      `### ${E.modernStaff} USER INFO`,
      {
        section: `**${clip(user.username, 60)}**\n-# ${user.bot ? 'Bot account' : 'User account'}  ·  \`${user.id}\``,
        thumbnail: user.displayAvatarURL({ extension: 'png', size: 256 }),
      },
      'sep',
      `Account created  ·  ${created}\nJoined server  ·  ${joined}`,
      'sep',
      `Roles  ·  **${roles.length}**\nTop role  ·  ${member?.roles?.highest && member.roles.highest.id !== i.guild.id ? `<@&${member.roles.highest.id}>` : 'None'}\nDangerous roles  ·  **${dangerous}**\n${roleLine}`,
      'sep',
      `Warnings  ·  **${repo.countWarnings(i.guild.id, user.id)}**\nModeration cases  ·  **${repo.countUserCases(i.guild.id, user.id)}**`,
      `Security  ·  ${whitelist.describe(i.guild, user.id)}`,
    ]));
  },
};
