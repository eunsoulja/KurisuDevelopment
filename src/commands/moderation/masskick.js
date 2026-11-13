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
  category: 'moderation', permission: 'Kick Members',
  examples: { '': '/masskick ids:123456789012345678 234567890123456789 reason:Raid accounts' },
  data: new SlashCommandBuilder().setName('masskick').setDescription(`Kick up to ${LIMITS.massKickMax} members by ID, with confirmation.`)
    .setDefaultMemberPermissions(P.KickMembers)
    .addStringOption((o) => o.setName('ids').setDescription('User IDs separated by spaces or commas').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
  async execute(i) {
    const err = guard(i, { user: [P.KickMembers], bot: [P.KickMembers] });
    if (err) return fail(i, err);

    // Mass kicks are destructive. Only staff who are already exempt from the
    // mass kick module may run one, otherwise antinuke would (correctly) fire.
    if (!await perms.isExempt(i.guild, i.user.id, 'general', 'massKick', i.member)) {
      return fail(i, 'Mass kick requires a whitelist exemption for the mass kick module. Ask the owner to whitelist you first.');
    }

    const ids = parseIds(i.options.getString('ids', true));
    if (!ids.length) return fail(i, 'No valid user IDs found.');
    if (ids.length > LIMITS.massKickMax) return fail(i, `Mass kick is limited to ${LIMITS.massKickMax} members per run.`);
    const reason = i.options.getString('reason') || 'Mass kick';

    const ok = []; const skipped = [];
    for (const id of ids) {
      const member = i.guild.members.cache.get(id) || await i.guild.members.fetch(id).catch(() => null);
      if (!member) { skipped.push(`<@${id}>: not in the server`); continue; }
      const bad = perms.checkTarget({ guild: i.guild, moderator: i.member, targetId: id, targetMember: member, verb: 'kick' });
      if (bad) skipped.push(`<@${id}>: ${bad}`); else ok.push(member);
    }
    if (!ok.length) return fail(i, `Nothing to kick.\n${skipped.slice(0, 5).join('\n')}`);

    return confirm.ask(i, {
      title: 'Confirm mass kick',
      lines: [`Kick **${ok.length}** member(s).`, ...(skipped.length ? [`Skipped ${skipped.length}:`, ...skipped.slice(0, 5)] : []), `Reason: ${reason}`],
      run: async (btn) => {
        const kicked = []; const failed = [];
        for (const member of ok) {
          try {
            await member.kick(`${i.user.tag}: masskick: ${reason}`.slice(0, 480));
            await moderation.record(i.guild, { userId: member.id, moderatorId: i.user.id, action: 'masskick', reason });
            kicked.push(member.id);
          } catch { failed.push(member.id); }
        }
        await btn.editReply(ui.edit([`${ui.E.moderatorShield} Kicked **${kicked.length}** of ${ok.length}.${failed.length ? `\nFailed: ${failed.map((x) => `<@${x}>`).join(' ')}` : ''}`]));
      },
    });
  },
};
