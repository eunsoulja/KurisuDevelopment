'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const confirm = require('../../components/common/confirm');
const moderation = require('../../engines/moderation');
const ui = require('../../components/common/ui');
const { LIMITS } = require('../../config/settings');
const { parseIds } = require('../../utils/helpers');

module.exports = {
  category: 'moderation', permission: 'Ban Members',
  examples: { '': '/massban ids:123456789012345678 234567890123456789 reason:Raid accounts' },
  data: new SlashCommandBuilder().setName('massban').setDescription(`Ban up to ${LIMITS.massBanMax} users by ID, with confirmation.`)
    .setDefaultMemberPermissions(P.BanMembers)
    .addStringOption((o) => o.setName('ids').setDescription('User IDs separated by spaces or commas').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
  async execute(i) {
    const err = guard(i, { user: [P.BanMembers], bot: [P.BanMembers] });
    if (err) return fail(i, err);

    // A mass ban is itself the kind of action antinuke watches. Require the
    // invoker to be exempt so they cannot trip their own protection.
    if (!perms.isExempt(i.guild, i.user.id, 'general', 'massBan', i.member)) {
      return fail(i, 'Mass ban requires a whitelist exemption for the mass ban module. Ask the owner to whitelist you first.');
    }

    const ids = parseIds(i.options.getString('ids', true));
    if (!ids.length) return fail(i, 'No valid user IDs found.');
    if (ids.length > LIMITS.massBanMax) return fail(i, `Mass ban is limited to ${LIMITS.massBanMax} users per run.`);
    const reason = i.options.getString('reason') || 'Mass ban';

    // Validate everything up front; only safe targets reach the confirmation.
    const ok = []; const skipped = [];
    for (const id of ids) {
      const member = i.guild.members.cache.get(id) || await i.guild.members.fetch(id).catch(() => null);
      const bad = perms.checkTarget({ guild: i.guild, moderator: i.member, targetId: id, targetMember: member, verb: 'ban' });
      if (bad) skipped.push(`<@${id}>: ${bad}`); else ok.push(id);
    }
    if (!ok.length) return fail(i, `Nothing to ban.\n${skipped.slice(0, 5).join('\n')}`);

    return confirm.ask(i, {
      title: 'Confirm mass ban',
      lines: [`Ban **${ok.length}** user(s).`, ...(skipped.length ? [`Skipped ${skipped.length}:`, ...skipped.slice(0, 5)] : []), `Reason: ${reason}`],
      run: async (btn) => {
        const bannedIds = []; const failed = [];
        for (const id of ok) {
          try {
            await i.guild.members.ban(id, { reason: `${i.user.tag}: massban: ${reason}`.slice(0, 480) });
            await moderation.record(i.guild, { userId: id, moderatorId: i.user.id, action: 'massban', reason });
            bannedIds.push(id);
          } catch { failed.push(id); }
        }
        await btn.editReply(ui.edit([`${ui.E.banHammer} Banned **${bannedIds.length}** of ${ok.length}.${failed.length ? `\nFailed: ${failed.map((x) => `<@${x}>`).join(' ')}` : ''}`]));
      },
    });
  },
};
