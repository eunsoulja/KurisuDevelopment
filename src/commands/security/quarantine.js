'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail, done } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const punish = require('../../engines/antinuke/punish');
const logging = require('../../engines/logging');
const { E } = require('../../components/common/ui');
const { DANGEROUS_BITS } = require('../../config/settings');

module.exports = {
  category: 'security', permission: 'Server Owner or Trusted Administrator',
  examples: { release: '/quarantine release user:@member' },
  data: new SlashCommandBuilder().setName('quarantine').setDescription('Manage quarantined members.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('release').setDescription('Restore a quarantined or stripped member.')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
  async execute(i) {
    const err = guard(i, { bot: [P.ManageRoles] });
    if (err) return fail(i, err);
    if (!(await perms.canManageSecurity(i.guild, i.member))) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');
    const user = i.options.getUser('user', true);
    const saved = await repo.getQuarantine(i.guild.id, user.id);
    const member = await punish.fetchMember(i.guild, user.id);
    if (!saved || !member) return fail(i, 'That member has no saved quarantine record.');
    await i.deferReply({ flags: 64 });
    const me = i.guild.members.me;
    const ownerClass = perms.isOwnerClass(i.guild, i.user.id);
    const restore = []; const withheld = [];
    for (const id of saved.roles) {
      const role = i.guild.roles.cache.get(id);
      if (!role || role.managed || role.position >= me.roles.highest.position) continue;
      if ((role.permissions.bitfield & DANGEROUS_BITS) && !ownerClass) withheld.push(role.name); else restore.push(id);
    }
    try {
      const guild = await repo.getGuild(i.guild.id);
      const qRole = guild?.quarantine_role_id;
      if (qRole && member.roles.cache.has(qRole)) await member.roles.remove(qRole, 'Kurisu: quarantine released');
      if (restore.length) await member.roles.add(restore, 'Kurisu: quarantine released');
      await member.timeout(null, 'Kurisu: quarantine released').catch(() => {});
      await repo.clearQuarantine(i.guild.id, user.id);
      await logging.send(i.guild, 'antinuke', `${E.clearShield} QUARANTINE RELEASED`, [`User: <@${user.id}>`, `By: <@${i.user.id}>`, `Roles restored: ${restore.length}`]);
      return done(i, E.clearShield, `Released **${user.username}**. Restored ${restore.length} role(s).${withheld.length ? ` Withheld privileged roles (owner only): ${withheld.join(', ')}.` : ''}`);
    } catch (e) { return fail(i, e.message); }
  },
};
