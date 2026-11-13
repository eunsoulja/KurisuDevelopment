'use strict';
const { SlashCommandBuilder } = require('discord.js');
const perms = require('../../permissions');
const ui = require('../../components/common/ui');
const { LIMITS } = require('../../config/settings');
const { clip, describeError } = require('../../utils/helpers');

const { E } = ui;
const PAGE = LIMITS.guildsPerPage;
const CACHE_MS = 60_000;
const FETCH_CONCURRENCY = 4;

const num = (n) => Number(n || 0).toLocaleString('en-US');

/** Run an async mapper over a list with a small concurrency cap. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Live network snapshot. Guild counts come from Discord's REST guild endpoint
 * (approximate_member_count / approximate_presence_count), so this needs no
 * privileged presence intent. Results are cached briefly to avoid rate limits.
 */
async function collect(client) {
  const guilds = [...client.guilds.cache.values()];
  const rows = await mapLimit(guilds, FETCH_CONCURRENCY, async (guild) => {
    let full = null;
    try {
      full = await client.guilds.fetch({ guild: guild.id, force: true, withCounts: true });
    } catch { /* fall back to cached member count */ }
    const members = Number.isFinite(full?.approximateMemberCount) ? full.approximateMemberCount : (guild.memberCount || 0);
    const active = Number.isFinite(full?.approximatePresenceCount) ? full.approximatePresenceCount : null;
    return { id: guild.id, name: guild.name, members, active };
  });
  rows.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
  return {
    at: Date.now(),
    rows,
    totals: {
      servers: rows.length,
      members: rows.reduce((sum, r) => sum + r.members, 0),
      active: rows.reduce((sum, r) => sum + (r.active || 0), 0),
    },
  };
}

let cached = null;
async function snapshot(client, { force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached;
  cached = await collect(client);
  return cached;
}

/**
 * Clean Components V2 network card:
 *   - total servers, total active users, total members
 *   - per-server members and active users
 *   - grey pagination only
 */
function render(snap, page = 0, viewerId = '') {
  const { rows, totals } = snap;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(p * PAGE, (p + 1) * PAGE);
  const list = slice.map((g) =>
    `${E.redDot} **${clip(g.name, 80)}**\n-# ${num(g.members)} members  ·  ${g.active === null ? '—' : num(g.active)} active  ·  \`${g.id}\``);

  return [
    `### ${E.shinyVerified} KURISU NETWORK`,
    `-# Every server the bot is in  ·  updated <t:${Math.floor(snap.at / 1000)}:R>`,
    'sep',
    `${E.clearShield} Servers  **${num(totals.servers)}**\n${E.redDot} Active Users  **${num(totals.active)}**\n${E.modernStaff} Total Members  **${num(totals.members)}**`,
    'sep',
    ...(list.length ? list : ['No servers.']),
    ...(pages > 1 ? ['sep', ui.buttons(
      ui.btn(`kg:${viewerId}:${p - 1}`, 'Previous', { disabled: p === 0 }),
      ui.btn(`kg:${viewerId}:${p + 1}`, 'Next', { disabled: p >= pages - 1 }),
    )] : []),
    `-# Page ${p + 1}/${pages}  ·  Discord approximate online count`,
  ];
}

module.exports = {
  category: 'utility', permission: 'Bot Owner',
  examples: { '': '/guilds', lookup: '/guilds page:1' },
  render, collect, snapshot,
  data: new SlashCommandBuilder().setName('guilds').setDescription('Bot owner: every server the bot is in, with active and member counts.')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(1000)),
  async execute(i) {
    if (!perms.isBotOwner(i.user.id)) return i.reply(ui.error('Only the bot owner can use this command.'));

    await i.deferReply({ flags: 64 });
    try {
      const snap = await snapshot(i.client);
      const page = (i.options.getInteger('page') || 1) - 1;
      return i.editReply(ui.edit(render(snap, page, i.user.id)));
    } catch (err) {
      return i.editReply(ui.edit([`${E.redDot} ${describeError(err)}`]));
    }
  },
  /** customId: kg:<viewerId>:<page> */
  async component(i) {
    if (!perms.isBotOwner(i.user.id)) return i.reply(ui.error('Only the bot owner can use this command.'));
    const [, viewerId, page] = i.customId.split(':');
    if (i.user.id !== viewerId) return i.reply(ui.error('These controls are not yours.'));
    try {
      const snap = await snapshot(i.client);
      return i.update(ui.edit(render(snap, Number(page) || 0, viewerId)));
    } catch (err) {
      return i.reply(ui.error(describeError(err)));
    }
  },
};
