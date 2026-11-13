'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const logging = require('../../engines/logging');
const ui = require('../../components/common/ui');
const text = require('../../text');

const { E } = ui;
// Letters, numbers and punctuation that render safely in Discord messages.
const PREFIX_RE = /^[A-Za-z0-9!?.,:;$%&+\-~=<>|]{1,5}$/;

module.exports = {
  category: 'configuration', permission: 'Server Owner or Trusted Administrator',
  examples: { '': '/prefix prefix:!' },
  data: new SlashCommandBuilder().setName('prefix').setDescription('Set the text command prefix for this server.')
    .setDefaultMemberPermissions(P.Administrator)
    .addStringOption((o) => o.setName('prefix').setDescription('New prefix (1-5 characters, no spaces or slashes). Omit to view it.').setMinLength(1).setMaxLength(5)),
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!await perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can change the prefix.');

    const raw = i.options.getString('prefix');
    if (raw === null) {
      const g = await repo.getGuild(i.guild.id);
      return i.reply(ui.notice(E.modernRules, `The server prefix is \`${g.prefix}\`.`, { ephemeral: true }));
    }

    const value = raw.trim();
    if (!PREFIX_RE.test(value)) return fail(i, 'Use 1-5 letters, numbers or simple punctuation (no spaces or slashes).');

    await repo.setGuild(i.guild.id, 'prefix', value);
    text.clearPrefix(i.guild.id);
    await logging.send(i.guild, 'config', `${E.modernRules} CONFIGURATION CHANGED`, [`Prefix: \`${value}\``, `By: <@${i.user.id}>`]);
    return i.reply(ui.notice(E.modernRules, `Server prefix set to \`${value}\`.`, { ephemeral: true }));
  },
};
