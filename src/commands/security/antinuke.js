'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const logging = require('../../engines/logging');
const ui = require('../../components/common/ui');
const { MODULES, KEYS } = require('../../engines/antinuke/modules');
const { PUNISHMENT_LABEL } = require('../../config/settings');

const { E } = ui;

async function statusView(guild) {
  const g = await repo.getGuild(guild.id);
  const mods = await repo.getAllModules(guild.id, MODULES);
  const enabled = mods.filter((m) => m.enabled).length;
  const guard = await repo.getModule(guild.id, 'nukeGuard', MODULES);
  const last = await repo.lastIncident(guild.id);
  const recent = await repo.countIncidentsSince(guild.id, Date.now() - 24 * 3600 * 1000);
  const watched = await repo.countNukeWatch(guild.id);
  return [
    `### ${E.clearShield} ANTINUKE`,
    '-# Real-time audit-log protection',
    'sep',
    `${g.antinuke_enabled ? E.redDot : E.smallRedDot} **Status**  ·  ${g.antinuke_enabled ? 'Enabled' : 'Disabled'}\n${E.modernRules} **Modules**  ·  ${enabled} / ${KEYS.length} enabled`,
    'sep',
    `${E.banHammer} **Nuke Guard**  ·  ${guard.enabled ? 'Armed' : 'Off'}\n-# ${guard.enabled ? `${PUNISHMENT_LABEL[guard.punishment]} after ${guard.threshold} destructive actions in ${guard.window_sec}s` : 'Cross-module burst detection is disabled'}\n${E.ownerShield} **Nuke Watch**  ·  **${watched}**`,
    'sep',
    `${E.modernStaff} **Incidents (24h)**  ·  ${recent}\n**Last Incident**  ·  ${last ? `<t:${Math.floor(last.created_at / 1000)}:R>` : 'None'}`,
    'sep',
    ui.buttons(ui.btn('ks:v:main', 'Security Center')),
  ];
}

module.exports = {
  category: 'security', permission: 'Server Owner or Trusted Administrator',
  examples: { status: '/antinuke status', enable: '/antinuke enable', disable: '/antinuke disable' },
  statusView,
  data: new SlashCommandBuilder().setName('antinuke').setDescription('Antinuke status and master switch.')
    .setDefaultMemberPermissions(P.Administrator)
    .addSubcommand((s) => s.setName('status').setDescription('Show antinuke, nuke guard and watch status.'))
    .addSubcommand((s) => s.setName('enable').setDescription('Enable antinuke.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Disable antinuke (server owner only).')),
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!await perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');

    const sub = i.options.getSubcommand();
    if (sub === 'status') return i.reply(ui.message(await statusView(i.guild), { ephemeral: true }));

    const enable = sub === 'enable';
    if (!enable && !perms.isOwnerClass(i.guild, i.user.id)) {
      return fail(i, 'Only the server owner or a bot owner can disable antinuke.');
    }
    const current = (await repo.getGuild(i.guild.id)).antinuke_enabled;
    if (!!current === enable) return i.reply(ui.notice(E.clearShield, `Antinuke is already **${enable ? 'enabled' : 'disabled'}**.`, { ephemeral: true }));

    await repo.setGuild(i.guild.id, 'antinuke_enabled', enable ? 1 : 0);
    await logging.send(i.guild, 'config', `${E.modernRules} CONFIGURATION CHANGED`, [
      `Antinuke: ${enable ? 'enabled' : 'disabled'}`,
      `By: <@${i.user.id}>`,
    ]);
    return i.reply(ui.notice(E.clearShield, `Antinuke ${enable ? 'enabled' : 'disabled'}.${enable ? '' : ' Raid protection stays independent.'}`, { ephemeral: true }));
  },
};
