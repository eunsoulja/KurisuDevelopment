'use strict';
const { MessageFlags } = require('discord.js');
const ui = require('../common/ui');
const about = require('../common/about');
const perms = require('../../permissions');
const dashboard = require('../dashboard');
const text = require('../../text');
const { BRANDING_GIF } = require('../../config/branding');

const { E } = ui;
const PER_PAGE = 8;

const CATEGORIES = {
  security: { emoji: E.clearShield, name: 'Security', desc: 'Antinuke and server protection', blurb: 'Antinuke and server protection tools.' },
  raid: { emoji: E.modernRaid, name: 'Raid Protection', desc: 'Raid detection and lockdown', blurb: 'Raid detection, lockdown and levels.' },
  moderation: { emoji: E.banHammer, name: 'Moderation', desc: 'Manage members and punishments', blurb: 'Member management and moderation tools.' },
  configuration: { emoji: E.modernRules, name: 'Configuration', desc: 'Configure Kurisu for your server', blurb: 'Logs and server configuration.' },
  administration: { emoji: E.administrator, name: 'Administration', desc: 'Permissions and management', blurb: 'Trusted users and permissions.' },
  verification: { emoji: E.modernVerify, name: 'Verification', desc: 'Verification and access control', blurb: 'Verification and access control.' },
  utility: { emoji: E.redDot, name: 'Utility', desc: 'General bot commands', blurb: 'General bot commands.' },
};

const TYPE_LABEL = { 3: 'text', 4: 'number', 5: 'true/false', 6: 'member', 7: 'channel', 8: 'role', 10: 'number', 11: 'file' };

/** Builds help entries from the REAL command definitions, so help can never go stale. */
function collect(commands, prefix = '!') {
  const out = [];
  for (const cmd of commands.values()) {
    const json = cmd.data.toJSON();
    const subs = (json.options || []).filter((o) => o.type === 1);
    const examples = cmd.examples || {};
    const make = (name, sub, desc, options) => {
      const example = examples[sub || ''] || examples[''] || `/${name}${sub ? ` ${sub}` : ''}`;
      return {
        key: sub ? `${name}.${sub}` : name,
        label: sub ? `/${name} ${sub}` : `/${name}`,
        name, sub, description: desc, category: cmd.category,
        permission: cmd.permission || 'None',
        example,
        textExample: example.replace(/^\/([a-zA-Z0-9]+)/, `${prefix}$1`),
        options: (options || []).map((o) => ({ name: o.name, required: !!o.required, type: TYPE_LABEL[o.type] || 'text', description: o.description })),
      };
    };
    if (subs.length) for (const s of subs) out.push(make(json.name, s.name, s.description, s.options));
    else out.push(make(json.name, null, json.description, json.options));
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const byCategory = (entries, cat) => entries.filter((e) => e.category === cat);
const uid = (id) => `kh:${id}`;

const footer = (id, extra = []) => ui.buttons(...extra, ui.btn(`${uid(id)}:close`, 'Close'));
const categorySelect = (id, current) => ui.select(`${uid(id)}:sel`, 'Select a category',
  Object.entries(CATEGORIES).map(([value, c]) => ({ label: c.name, value, description: c.desc, emoji: c.emoji, default: value === current })));

function mainView(id, prefix = '!') {
  const lines = Object.values(CATEGORIES).map((c) => `${c.emoji} **${c.name}**\n-# ${c.desc}`).join('\n\n');
  return [
    `### ${E.crown} KURISU COMMAND CENTER`,
    `**Antinuke, Security & Moderation**\n-# Browse commands and manage your server with Kurisu.\n-# Text prefix: \`${prefix}\`  ·  Slash commands also work.`,
    { media: BRANDING_GIF },
    'sep',
    `-# COMMAND CATEGORIES\n${lines}`,
    'sep',
    '-# Select a category below.',
    categorySelect(id),
    ui.buttons(ui.btn(`${uid(id)}:dash`, 'Dashboard'), ui.btn(`${uid(id)}:about`, 'Bot Info'), ui.btn(`${uid(id)}:close`, 'Close')),
  ];
}

function categoryView(id, entries, cat, page = 0) {
  const c = CATEGORIES[cat];
  if (!c) return mainView(id);
  const list = byCategory(entries, cat);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
  const body = slice.length ? slice.map((e) => `**${e.label}**\n${e.description}\n-# Requires: ${e.permission}`).join('\n\n') : 'No commands in this category yet.';
  const nav = [ui.btn(`${uid(id)}:main`, 'Back')];
  if (pages > 1) nav.push(ui.btn(`${uid(id)}:cat:${cat}:${p - 1}`, 'Previous', { disabled: p === 0 }), ui.btn(`${uid(id)}:cat:${cat}:${p + 1}`, 'Next', { disabled: p >= pages - 1 }));
  return [
    `### ${c.emoji} ${c.name.toUpperCase()}`,
    `${c.blurb}${pages > 1 ? `\n-# Page ${p + 1}/${pages}` : ''}`,
    'sep', body, 'sep',
    ...(slice.length ? [ui.select(`${uid(id)}:csel:${cat}:${p}`, 'View command details', slice.map((e) => ({ label: e.label, value: e.key, description: e.description })))] : []),
    footer(id, nav),
  ];
}

function detailView(id, entries, key, cat, page, prefix = '!') {
  const e = entries.find((x) => x.key === key);
  if (!e) return mainView(id);
  const c = CATEGORIES[e.category];
  const usage = `${e.label}${e.options.map((o) => ` ${o.name}:<${o.type}>`).join('')}`;
  const opts = e.options.length ? e.options.map((o) => `\`${o.name}\`  ${o.required ? 'Required' : 'Optional'}  ·  ${o.description}`).join('\n') : 'None';
  return [
    `### ${c.emoji} ${e.label}`,
    e.description,
    'sep',
    `-# USAGE\n\`${usage}\``,
    `-# OPTIONS\n${opts}`,
    `-# PERMISSION\n${e.permission}`,
    `-# SLASH EXAMPLE\n\`${e.example}\``,
    `-# TEXT EXAMPLE\n\`${e.textExample || e.example}\``,
    'sep',
    footer(id, [ui.btn(`${uid(id)}:cat:${cat || e.category}:${page || 0}`, 'Back')]),
  ];
}

function aboutView(id, client) {
  return about.items(client, ['sep', footer(id, [ui.btn(`${uid(id)}:main`, 'Back')])]);
}

/** Resolve /help category:<..> command:<..> to the right first page. */
async function initial(id, entries, { category, command, prefix = '!' }) {
  if (command) {
    const key = command.replace(/^\//, '').trim().replace(/\s+/g, '.');
    const e = entries.find((x) => x.key === key) || entries.find((x) => x.name === key);
    if (e) return detailView(id, entries, e.key, e.category, 0, prefix);
  }
  if (category) return categoryView(id, entries, category, 0);
  return mainView(id, prefix);
}

async function autocomplete(i) {
  const entries = collect(i.client.commands);
  const q = i.options.getFocused().toLowerCase().replace(/^\//, '');
  await i.respond(entries.filter((e) => e.label.toLowerCase().includes(q)).slice(0, 25).map((e) => ({ name: e.label, value: e.key })));
}

/** customId: kh:<ownerId>:<action>[:args] */
async function handle(i) {
  const [, owner, action, ...arg] = i.customId.split(':');
  if (i.user.id !== owner) return i.reply(ui.error('This menu belongs to someone else. Run /help to open your own.'));
  const prefix = i.guild ? await text.getPrefix(i.guild.id) : '!';
  const entries = collect(i.client.commands, prefix);
  const show = (items) => i.update(ui.edit(items));
  try {
    switch (action) {
      case 'main': return show(mainView(owner, prefix));
      case 'sel': return show(categoryView(owner, entries, i.values[0], 0));
      case 'cat': return show(categoryView(owner, entries, arg[0], Number(arg[1]) || 0));
      case 'csel': return show(detailView(owner, entries, i.values[0], arg[0], Number(arg[1]) || 0, prefix));
      case 'about': return show(aboutView(owner, i.client));
      case 'dash':
        if (!i.guild || !await perms.canManageSecurity(i.guild, i.member)) return i.reply(ui.error('Only the server owner, bot owner or a Trusted Administrator can open the security center.'));
        return show(await dashboard.main(i.guild));
      case 'close':
        if (i.message.flags.has(MessageFlags.Ephemeral)) return show(['-# Closed. Run /help to open it again.']);
        await i.message.delete().catch(() => {});
        return undefined;
      default: return show(mainView(owner, prefix));
    }
  } catch (err) {
    if ([10062, 40060, 10008].includes(err.code)) return undefined;
    throw err;
  }
}

module.exports = { CATEGORIES, collect, mainView, categoryView, detailView, initial, autocomplete, handle };
