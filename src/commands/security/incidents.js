'use strict';
const { SlashCommandBuilder, PermissionFlagsBits: P } = require('discord.js');
const { guard, fail } = require('../_util');
const perms = require('../../permissions');
const repo = require('../../database/repo');
const ui = require('../../components/common/ui');
const { LIMITS } = require('../../config/settings');
const { clip } = require('../../utils/helpers');

const { E } = ui;

function render(guild, page = 0, viewerId) {
  const total = repo.countIncidents(guild.id);
  const pages = Math.max(1, Math.ceil(total / LIMITS.incidentsPerPage));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = repo.pageIncidents(guild.id, LIMITS.incidentsPerPage, p * LIMITS.incidentsPerPage);
  const body = rows.length ? rows.map((r) => {
    const who = /^\d+$/.test(r.executor_id) ? `<@${r.executor_id}>` : 'System';
    const meta = [who, r.threshold ? `${r.count}/${r.threshold}` : null, r.response, r.status].filter(Boolean).join('  ·  ');
    const details = r.details ? `\n-# ${clip(r.details, 160)}` : '';
    return `**#${r.id}**  ·  ${r.action}\n-# <t:${Math.floor(r.created_at / 1000)}:R>  ·  ${meta}${details}`;
  }).join('\n\n') : 'No security incidents recorded.';
  const nav = pages > 1 ? [
    ui.btn(`kn:${viewerId}:${p - 1}`, 'Previous', { disabled: p === 0 }),
    ui.btn(`kn:${viewerId}:${p + 1}`, 'Next', { disabled: p >= pages - 1 }),
  ] : [];
  return [
    `### ${E.banHammer} SECURITY INCIDENTS`,
    `-# ${total} ${total === 1 ? 'incident' : 'incidents'}  ·  page ${p + 1}/${pages}`,
    'sep',
    clip(body, 3000),
    'sep',
    ui.buttons(...nav, ui.btn('ks:v:main', 'Security Center')),
  ];
}

module.exports = {
  category: 'security', permission: 'Server Owner or Trusted Administrator',
  examples: { '': '/incidents page:1' },
  data: new SlashCommandBuilder().setName('incidents').setDescription('Browse the security incident log.')
    .setDefaultMemberPermissions(P.Administrator)
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(1000)),
  render,
  async execute(i) {
    const err = guard(i, {});
    if (err) return fail(i, err);
    if (!perms.canManageSecurity(i.guild, i.member)) return fail(i, 'Only the server owner, bot owner or a Trusted Administrator can view security incidents.');
    const page = (i.options.getInteger('page') || 1) - 1;
    return i.reply(ui.message(render(i.guild, page, i.user.id), { ephemeral: true }));
  },
  /** customId: kn:<viewerId>:<page> */
  async component(i) {
    if (!i.guild || !perms.canManageSecurity(i.guild, i.member)) return i.reply(ui.error('You are not authorised to view security incidents.'));
    const [, viewerId, page] = i.customId.split(':');
    if (i.user.id !== viewerId) return i.reply(ui.error('These controls are not yours.'));
    return i.update(ui.edit(render(i.guild, Number(page) || 0, viewerId)));
  },
};
