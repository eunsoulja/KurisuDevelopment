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

function statusView(guild) {
  const g = repo.getGuild(guild.id);
  const mods = repo.getAllModules(guild.id, MODULES);
  const enabled = mods.filter((m) => m.enabled).length;
  const guard = repo.getModule(guild.id, 'nukeGuard', MODULES);
  const last = repo.lastIncident(guild.id);
  const recent = repo.countIncidentsSince(guild.id, Date.now() - 24 * 3600 * 1000);
  return [
    `### ${E.clearShield} ANTINUKE`,
    '-# Real-time audit-log protection',
    'sep',
    `Status  ·  **${g.antinuke_enabled ? 'Enabled' : 'Disabled'}**\nModules  ·  **${enabled}/${KEYS.length} enabled**\nNuke Guard  ·  **${guard.enabled ? `${PUNISHMENT_LABEL[guard.punishment]} after ${guard.threshold} actions in ${guard.window_sec}s` : 'Off'}**\nNuke Watch  ·  **${repo.countNukeWatch(guild.id)}**`,
    `Incidents (24h)  ·  **${recent}**\nLast Incident  ·  ${last ? `<t:${Math.floor(last.created_at / 1000)}:R>` : 'None'}`,
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
    if (!perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can use this.');

    const sub = i.options.getSubcommand();
    if (sub === 'status') return i.reply(ui.message(statusView(i.guild), { ephemeral: true }));

    const enable = sub === 'enable';
    if (!enable && !perms.isOwnerClass(i.guild, i.user.id)) {
      return fail(i, 'Only the server owner or a bot owner can disable antinuke.');
    }
    const current = repo.getGuild(i.guild.id).antinuke_enabled;
    if (!!current === enable) return i.reply(ui.notice(E.clearShield, `Antinuke is already **${enable ? 'enabled' : 'disabled'}**.`, { ephemeral: true }));

    repo.setGuild(i.guild.id, 'antinuke_enabled', enable ? 1 : 0);
    await logging.send(i.guild, 'config', `${E.modernRules} CONFIGURATION CHANGED`, [
      `Antinuke: ${enable ? 'enabled' : 'disabled'}`,
      `By: <@${i.user.id}>`,
    ]);
    return i.reply(ui.notice(E.clearShield, `Antinuke ${enable ? 'enabled' : 'disabled'}.${enable ? '' : ' Raid protection stays independent.'}`, { ephemeral: true }));
  },
};
