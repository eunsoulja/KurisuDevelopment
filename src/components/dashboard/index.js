'use strict';
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const ui = require('../common/ui');
const repo = require('../../database/repo');
const perms = require('../../permissions');
const raid = require('../../engines/raid');
const logging = require('../../engines/logging');
const { MODULES, KEYS } = require('../../engines/antinuke/modules');
const { PUNISHMENTS, PUNISHMENT_LABEL, WHITELIST_LEVELS, LOG_TYPES } = require('../../config/settings');
const { storedScopes, scopesLabel, scopesForMask, maskId, parseMask, scopeOptions, ALL_MASK } = require('../../config/whitelist');
const whitelist = require('../../commands/whitelist/whitelist');
const { clip, describeError } = require('../../utils/helpers');

const { E } = ui;
const PAGE = 6;
const on = (b) => (b ? 'Enabled' : 'Disabled');

// ---------------------------------------------------------------- views
const PROT_PAGE = 10;

function main(guild) {
  const g = repo.getGuild(guild.id);
  const r = repo.getRaid(guild.id);
  const mods = repo.getAllModules(guild.id, MODULES);
  const enabled = mods.filter((m) => m.enabled).length;
  const guard = repo.getModule(guild.id, 'nukeGuard', MODULES);
  const last = repo.lastIncident(guild.id);
  const raidStatus = !g.raid_enabled ? 'Off' : r.lockdown_active ? 'Lockdown' : r.level === 'NORMAL' ? 'Active' : r.level;
  return [
    `### ${E.clearShield} KURISU SECURITY CENTER`,
    '-# Protection overview',
    'sep',
    `${E.clearShield} **Antinuke**  ·  ${g.antinuke_enabled ? 'Active' : 'Off'}\n${E.modernRaid} **Raid Protection**  ·  ${raidStatus}\n${E.modernRules} **Security Rules**  ·  ${enabled ? 'Active' : 'Off'}`,
    'sep',
    `**Overview**\nProtection Modules  **${enabled} / ${KEYS.length}**\nWhitelist Entries  **${repo.countWhitelist(guild.id)}**\nSecurity Incidents  **${repo.countIncidents(guild.id)}**`,
    'sep',
    `**Nuke Guard**  ·  ${guard.enabled ? 'Armed' : 'Off'}\n-# ${guard.enabled ? `${PUNISHMENT_LABEL[guard.punishment]} after ${guard.threshold} destructive actions in ${guard.window_sec}s` : 'Cross-module burst detection is disabled'}\n**Nuke Watch**  ·  **${repo.countNukeWatch(guild.id)}**\n**Last Incident**  ·  ${last ? `<t:${Math.floor(last.created_at / 1000)}:R>` : 'None'}`,
    'sep',
    ui.buttons(ui.btn('ks:v:prot:0', 'Protection'), ui.btn('ks:v:wl:trusted_mod', 'Whitelist')),
    ui.buttons(ui.btn('ks:v:logs:0', 'Security Logs'), ui.btn('ks:v:set', 'Settings')),
  ];
}

function protection(guild, page = 0) {
  const mods = repo.getAllModules(guild.id, MODULES);
  const enabled = mods.filter((m) => m.enabled).length;
  const pages = Math.max(1, Math.ceil(mods.length / PROT_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = mods.slice(p * PROT_PAGE, (p + 1) * PROT_PAGE);
  const lines = slice.map((m) => `${m.enabled ? E.redDot : E.smallRedDot} ${MODULES[m.module].name}  ·  ${PUNISHMENT_LABEL[m.punishment]}`);
  const options = slice.map((m) => ({
    label: MODULES[m.module].name,
    value: m.module,
    description: `${on(m.enabled)} · ${m.threshold} in ${m.window_sec}s`,
    emoji: E.clearShield,
  }));
  const nav = pages > 1 ? [
    ui.btn(`ks:v:prot:${p - 1}`, 'Previous', { disabled: p === 0 }),
    ui.btn(`ks:v:prot:${p + 1}`, 'Next', { disabled: p >= pages - 1 }),
  ] : [];
  return [
    `### ${E.clearShield} PROTECTION MODULES`,
    `-# ${enabled} of ${KEYS.length} enabled  ·  page ${p + 1}/${pages}`,
    'sep',
    lines.length ? lines.join('\n') : 'No protection modules.',
    'sep',
    ui.select(`ks:pick:${p}`, 'Configure a module on this page', options),
    ui.buttons(...nav, ui.btn('ks:v:main', 'Back')),
  ];
}

function moduleView(guild, key, page = 0) {
  const def = MODULES[key];
  if (!def) return protection(guild, page);
  const c = repo.getModule(guild.id, key, MODULES);
  return [
    `### ${E.clearShield} ${def.name}`,
    `-# ${def.desc}`,
    'sep',
    { section: `**Status**  ${on(c.enabled)}\n-# Toggle protection for this module`, button: ui.btn(`ks:tog:${key}:${page}`, c.enabled ? 'Disable' : 'Enable') },
    'sep',
    `**Trigger**  ·  **${c.threshold}** action(s) in **${c.window_sec}s**\n**Punishment**  ·  **${PUNISHMENT_LABEL[c.punishment]}**`,
    'sep',
    ui.select(`ks:pun:${key}:${page}`, 'Choose punishment', PUNISHMENTS.map((p) => ({ label: PUNISHMENT_LABEL[p], value: p, default: p === c.punishment }))),
    ui.buttons(ui.btn(`ks:thr:${key}:${page}`, 'Threshold'), ui.btn(`ks:v:prot:${page}`, 'Back')),
  ];
}

function whitelistView(guild, level = 'trusted_mod', mask = 0n) {
  if (!WHITELIST_LEVELS[level]) level = 'trusted_mod';
  const rows = repo.listWhitelist(guild.id);
  const list = rows.length ? rows.slice(0, 10).map((r) => {
    const targetType = r.target_type === 'role' ? 'role' : 'user';
    const target = targetType === 'role' ? `<@&${r.user_id}>` : `<@${r.user_id}>`;
    return `${target}  ·  ${WHITELIST_LEVELS[r.level]}  ·  ${scopesLabel(storedScopes(r.scopes))}`;
  }).join('\n') + (rows.length > 10 ? `\n-# +${rows.length - 10} more` : '') : 'No entries. Owners are always exempt.';
  const selected = scopesForMask(mask);
  const allOptions = scopeOptions();
  const chunks = [];
  for (let n = 0; n < allOptions.length; n += 25) chunks.push(allOptions.slice(n, n + 25));
  const scopeMenus = chunks.map((chunk, n) => {
    const options = chunk.map((o) => ({
      ...o,
      // "All modules" is an action, not a resting state: when every module is
      // selected it stays unselected so toggling one module off behaves as
      // expected. A concrete mask is shown by the module options themselves.
      default: o.value === 'default' ? mask === 0n
        : o.value === 'all' ? false
          : mask !== 0n && !!(mask & (1n << BigInt(KEYS.indexOf(o.value)))),
    }));
    return ui.select(`ks:wlsc:${level}:${maskId(mask)}:${n}`,
      chunks.length > 1 ? `Choose exemption scope (${n + 1}/${chunks.length})` : 'Choose exemption scope',
      options, { min: 1, max: Math.min(25, options.length) });
  });
  return [
    `### ${E.modernStaff} WHITELIST`,
    `-# ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}  ·  owners are always exempt`,
    'sep',
    list,
    'sep',
    `**Grant level**  ·  ${WHITELIST_LEVELS[level]}`,
    ui.select(`ks:wlvl:${maskId(mask)}`, 'Choose level', Object.entries(WHITELIST_LEVELS).map(([value, label]) => ({ label, value, default: value === level }))),
    `**Scope**  ·  ${mask === 0n ? 'Level default' : mask === ALL_MASK ? 'All modules' : scopesLabel(selected)}`,
    ...scopeMenus,
    'sep',
    '**Add or update**',
    ui.userSelect(`ks:wladd:${level}:${maskId(mask)}`, 'Add or update a user'),
    ui.roleSelect(`ks:wladdr:${level}:${maskId(mask)}`, 'Add or update a role'),
    'sep',
    '**Remove**',
    ui.userSelect(`ks:wlrm:${level}:${maskId(mask)}`, 'Remove a user'),
    ui.roleSelect(`ks:wlrmr:${level}:${maskId(mask)}`, 'Remove a role'),
    'sep',
    ui.buttons(ui.btn('ks:v:main', 'Back')),
  ];
}

function logsView(guild, page = 0) {
  const total = repo.countIncidents(guild.id);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = repo.pageIncidents(guild.id, PAGE, p * PAGE);
  const body = rows.length ? rows.map((r) => {
    const who = /^\d+$/.test(r.executor_id) ? `<@${r.executor_id}>` : 'System';
    const meta = [who, r.threshold ? `${r.count}/${r.threshold}` : null, r.response, r.status].filter(Boolean).join('  ·  ');
    return `**#${r.id}**  ·  ${r.action}\n-# <t:${Math.floor(r.created_at / 1000)}:R>  ·  ${meta}`;
  }).join('\n\n') : 'No security incidents recorded.';
  const nav = pages > 1 ? [
    ui.btn(`ks:v:logs:${p - 1}`, 'Previous', { disabled: p === 0 }),
    ui.btn(`ks:v:logs:${p + 1}`, 'Next', { disabled: p >= pages - 1 }),
  ] : [];
  return [
    `### ${E.banHammer} SECURITY LOGS`,
    `-# ${total} ${total === 1 ? 'incident' : 'incidents'}  ·  page ${p + 1}/${pages}`,
    'sep',
    clip(body, 3000),
    'sep',
    ui.buttons(...nav, ui.btn('ks:v:main', 'Back')),
  ];
}

function settings(guild, logType) {
  const g = repo.getGuild(guild.id);
  const chans = repo.allLogChannels(guild.id);
  const configured = Object.keys(LOG_TYPES).filter((k) => chans[k]).length;
  const lines = Object.entries(LOG_TYPES).map(([k, label]) => `${chans[k] ? E.redDot : E.smallRedDot} ${label}  ·  ${chans[k] ? `<#${chans[k]}>` : 'Not set'}`).join('\n');
  const items = [
    `### ${E.modernRules} SETTINGS`,
    '-# Protection, escalation and logging',
    'sep',
    '**Protection**',
    { section: `${E.clearShield} **Antinuke**\n-# ${on(g.antinuke_enabled)}`, button: ui.btn('ks:master:antinuke', g.antinuke_enabled ? 'Disable' : 'Enable') },
    { section: `${E.modernRaid} **Raid Protection**\n-# ${on(g.raid_enabled)}`, button: ui.btn('ks:master:raid', g.raid_enabled ? 'Disable' : 'Enable') },
    'sep',
    `**Escalation**  ·  ${g.escalation_threshold ? `ban after **${g.escalation_threshold}** incidents in 24h` : 'off'}\n**Prefix**  ·  **${g.prefix || '!'}**`,
    'sep',
    `**Log Channels**  ·  ${configured} / ${Object.keys(LOG_TYPES).length} configured\n${lines}`,
    'sep',
    ui.select('ks:lt', 'Choose a log type', Object.entries(LOG_TYPES).map(([value, label]) => ({ label, value, default: value === logType }))),
  ];
  if (logType && LOG_TYPES[logType]) items.push(ui.channelSelect(`ks:lc:${logType}`, `Channel for ${LOG_TYPES[logType]} logs`), ui.buttons(ui.btn(`ks:lclr:${logType}`, 'Clear Channel')));
  items.push(ui.buttons(ui.btn('ks:esc', 'Escalation'), ui.btn('ks:v:raid', 'Raid'), ui.btn('ks:v:main', 'Back')));
  return items;
}

function raidView(guild) {
  const c = repo.getRaid(guild.id);
  return [
    `### ${E.modernRaid} RAID PROTECTION`,
    '-# Join-velocity detection and lockdown',
    'sep',
    `**Status**\nLevel  **${c.level}**\nLockdown  **${c.lockdown_active ? 'Active' : 'Off'}**\nVerification  **${c.verification_active ? 'On' : 'Off'}**`,
    'sep',
    `**Join Thresholds**  ·  window ${c.window_sec}s\nElevated  **${c.elevated_joins}**\nHigh  **${c.high_joins}**  ·  raises verification\nLockdown  **${c.lockdown_joins}**  ·  ${c.auto_lockdown ? `auto, ${c.lockdown_minutes}m` : 'manual only'}`,
    'sep',
    `**Accounts**\nMinimum age  **${c.min_account_age_days ? `${c.min_account_age_days} days` : 'None'}**\nKick new accounts in lockdown  **${c.kick_suspicious ? 'Yes' : 'No'}**`,
    'sep',
    ui.buttons(ui.btn('ks:rth', 'Thresholds'), ui.btn('ks:rop', 'Options'), ui.btn('ks:v:set', 'Back')),
    ui.buttons(ui.btn(c.lockdown_active ? 'ks:rlk:off' : 'ks:rlk:on', c.lockdown_active ? 'Unlock' : 'Lockdown'),
      ui.btn(c.verification_active ? 'ks:rvf:off' : 'ks:rvf:on', c.verification_active ? 'Verify Off' : 'Verify On')),
  ];
}

function route(guild, r) {
  const [view, arg, extra] = r.split(':');
  switch (view) {
    case 'prot': return protection(guild, Number(arg) || 0);
    case 'mod': return moduleView(guild, arg, Number(extra) || 0);
    case 'wl': return whitelistView(guild, arg);
    case 'logs': return logsView(guild, Number(arg) || 0);
    case 'set': return settings(guild, arg);
    case 'raid': return raidView(guild);
    default: return main(guild);
  }
}

// ---------------------------------------------------------------- modals
const input = (id, label, value, placeholder) => new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setValue(String(value)).setPlaceholder(placeholder || '').setRequired(true).setMaxLength(6));
const modal = (id, title, ...rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...rows);
const intIn = (i, id, min, max) => { const n = Number(i.fields.getTextInputValue(id)); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const yn = (i, id) => { const v = i.fields.getTextInputValue(id).trim().toLowerCase(); return ['yes', 'y', 'true', 'on', '1'].includes(v) ? 1 : ['no', 'n', 'false', 'off', '0'].includes(v) ? 0 : null; };

async function audit(guild, i, line) {
  await logging.send(guild, 'config', `${E.modernRules} CONFIGURATION CHANGED`, [line, `By: <@${i.user.id}>`]);
}

/** Insert a success/error line just under the whitelist header. */
function withFeedback(items, result) {
  const line = `-# ${result.ok ? E.modernRules : E.redDot} ${result.message}`;
  return [...items.slice(0, 2), line, ...items.slice(2)];
}

// ---------------------------------------------------------------- handler
/** All customIds: ks:<action>[:args]. Authorization is re-validated on every single interaction. */
async function handle(i) {
  const guild = i.guild;
  if (!guild || !perms.canManageSecurity(guild, i.member)) {
    return i.reply(ui.error('You are not authorised to use the security center.'));
  }
  const parts = i.customId.split(':');
  const action = parts[1];
  const arg = parts.slice(2);
  const show = (items) => (i.isFromMessage?.() || i.isMessageComponent?.() ? i.update(ui.edit(items)) : i.reply(ui.message(items, { ephemeral: true })));

  try {
    switch (action) {
      case 'v': return show(route(guild, arg.join(':')));
      case 'pick': return show(moduleView(guild, i.values[0], Number(arg[0]) || 0));
      case 'tog': {
        const key = arg[0]; const page = Number(arg[1]) || 0;
        const c = repo.getModule(guild.id, key, MODULES);
        if (!MODULES[key]) return show(protection(guild, page));
        repo.saveModule(guild.id, key, { ...c, enabled: !c.enabled });
        await audit(guild, i, `${MODULES[key].name}: ${c.enabled ? 'disabled' : 'enabled'}`);
        return show(moduleView(guild, key, page));
      }
      case 'pun': {
        const key = arg[0]; const page = Number(arg[1]) || 0; const p = i.values[0];
        if (!MODULES[key] || !PUNISHMENTS.includes(p)) return show(protection(guild, page));
        const c = repo.getModule(guild.id, key, MODULES);
        repo.saveModule(guild.id, key, { ...c, punishment: p });
        await audit(guild, i, `${MODULES[key].name}: punishment set to ${PUNISHMENT_LABEL[p]}`);
        return show(moduleView(guild, key, page));
      }
      case 'thr': {
        const key = arg[0]; const page = Number(arg[1]) || 0;
        const c = repo.getModule(guild.id, key, MODULES);
        return i.showModal(modal(`ks:thrm:${key}:${page}`, `${MODULES[key].name}`.slice(0, 45),
          input('threshold', 'Threshold (1-100)', c.threshold), input('window', 'Window in seconds (1-300)', c.window_sec)));
      }
      case 'thrm': {
        const key = arg[0]; const page = Number(arg[1]) || 0; const t = intIn(i, 'threshold', 1, 100); const w = intIn(i, 'window', 1, 300);
        if (!MODULES[key] || t === null || w === null) return i.reply(ui.error('Threshold must be 1-100 and the window 1-300 seconds.'));
        repo.saveModule(guild.id, key, { ...repo.getModule(guild.id, key, MODULES), threshold: t, window_sec: w });
        await audit(guild, i, `${MODULES[key].name}: ${t} within ${w}s`);
        return show(moduleView(guild, key, page));
      }
      case 'wlvl': return show(whitelistView(guild, i.values[0], parseMask(arg[0])));
      case 'wlsc': {
        const level = arg[0] || 'trusted_mod';
        const current = parseMask(arg[1]);
        const chunk = Number(arg[2]) || 0;
        const values = i.values;
        const picked = values.filter((v) => KEYS.includes(v));
        if (values.includes('all')) return show(whitelistView(guild, level, ALL_MASK));
        if (!picked.length) return show(whitelistView(guild, level, 0n)); // "Level default"

        // Scope options are split across two selects (25 options each). Replace
        // only this chunk so choices made in the other select are preserved.
        const all = scopeOptions();
        const chunkKeys = all.slice(chunk * 25, (chunk + 1) * 25).map((o) => o.value).filter((v) => v !== 'default' && v !== 'all');
        let mask = current;
        for (const key of chunkKeys) {
          const idx = KEYS.indexOf(key);
          if (idx !== -1) mask &= ~(1n << BigInt(idx));
        }
        for (const value of picked) {
          const idx = KEYS.indexOf(value);
          if (idx !== -1) mask |= 1n << BigInt(idx);
        }
        return show(whitelistView(guild, level, mask));
      }
      case 'wladd': {
        const user = i.users.first();
        const mask = parseMask(arg[1]);
        const r = await whitelist.addEntry(guild, i.member, user, arg[0], { targetType: 'user', scopes: scopesForMask(mask) });
        return show(withFeedback(whitelistView(guild, arg[0], mask), r));
      }
      case 'wladdr': {
        const role = i.roles.first();
        const mask = parseMask(arg[1]);
        const r = await whitelist.addEntry(guild, i.member, role, arg[0], { targetType: 'role', scopes: scopesForMask(mask) });
        return show(withFeedback(whitelistView(guild, arg[0], mask), r));
      }
      case 'wlrm': {
        const user = i.users.first();
        const mask = parseMask(arg[1]);
        const r = await whitelist.removeEntry(guild, i.member, user);
        return show(withFeedback(whitelistView(guild, arg[0] || 'trusted_mod', mask), r));
      }
      case 'wlrmr': {
        const role = i.roles.first();
        const mask = parseMask(arg[1]);
        const r = await whitelist.removeEntry(guild, i.member, role);
        return show(withFeedback(whitelistView(guild, arg[0] || 'trusted_mod', mask), r));
      }
      case 'master': {
        const col = arg[0] === 'raid' ? 'raid_enabled' : 'antinuke_enabled';
        const cur = repo.getGuild(guild.id)[col];
        // Turning protection off is a sensitive action: a compromised Trusted
        // Administrator must not be able to blind the server in one click.
        if (cur && !perms.isOwnerClass(guild, i.user.id)) {
          return show(withFeedback(settings(guild), { ok: false, message: 'Only the server owner or a bot owner can disable protection.' }));
        }
        repo.setGuild(guild.id, col, cur ? 0 : 1);
        await audit(guild, i, `${arg[0] === 'raid' ? 'Raid protection' : 'Antinuke'}: ${cur ? 'disabled' : 'enabled'}`);
        return show(settings(guild));
      }
      case 'lt': return show(settings(guild, i.values[0]));
      case 'lc': {
        const ch = i.channels.first();
        if (!LOG_TYPES[arg[0]]) return show(settings(guild));
        const full = guild.channels.cache.get(ch.id);
        const me = guild.members.me;
        if (!full?.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) return i.reply(ui.error('I cannot send messages in that channel.'));
        repo.setLogChannel(guild.id, arg[0], ch.id);
        await audit(guild, i, `${LOG_TYPES[arg[0]]} logs: <#${ch.id}>`);
        return show(settings(guild, arg[0]));
      }
      case 'lclr': repo.setLogChannel(guild.id, arg[0], null); return show(settings(guild, arg[0]));
      case 'esc': return i.showModal(modal('ks:escm', 'Escalation', input('n', 'Incidents in 24h before auto-ban (0 = off)', repo.getGuild(guild.id).escalation_threshold)));
      case 'escm': {
        const n = intIn(i, 'n', 0, 20);
        if (n === null) return i.reply(ui.error('Enter a number from 0 to 20.'));
        repo.setGuild(guild.id, 'escalation_threshold', n);
        await audit(guild, i, `Escalation: ${n || 'off'}`);
        return show(settings(guild));
      }
      case 'rth': {
        const c = repo.getRaid(guild.id);
        return i.showModal(modal('ks:rthm', 'Raid thresholds', input('window', 'Window in seconds (3-120)', c.window_sec), input('elevated', 'Elevated joins', c.elevated_joins),
          input('high', 'High joins', c.high_joins), input('lockdown', 'Lockdown joins', c.lockdown_joins)));
      }
      case 'rthm': {
        const w = intIn(i, 'window', 3, 120); const e = intIn(i, 'elevated', 2, 500); const h = intIn(i, 'high', 2, 500); const l = intIn(i, 'lockdown', 2, 1000);
        if ([w, e, h, l].includes(null) || !(e < h && h < l)) return i.reply(ui.error('Values must be valid and increasing: elevated < high < lockdown.'));
        repo.setRaid(guild.id, { window_sec: w, elevated_joins: e, high_joins: h, lockdown_joins: l });
        await audit(guild, i, `Raid thresholds: ${e}/${h}/${l} joins in ${w}s`);
        return show(raidView(guild));
      }
      case 'rop': {
        const c = repo.getRaid(guild.id);
        return i.showModal(modal('ks:ropm', 'Raid options', input('age', 'New account age in days (0-365)', c.min_account_age_days), input('mins', 'Lockdown minutes (1-1440)', c.lockdown_minutes),
          input('auto', 'Automatic lockdown (yes/no)', c.auto_lockdown ? 'yes' : 'no'), input('kick', 'Kick new accounts in lockdown (yes/no)', c.kick_suspicious ? 'yes' : 'no')));
      }
      case 'ropm': {
        const a = intIn(i, 'age', 0, 365); const m = intIn(i, 'mins', 1, 1440); const au = yn(i, 'auto'); const k = yn(i, 'kick');
        if ([a, m, au, k].includes(null)) return i.reply(ui.error('Check the values: numbers in range and yes/no answers.'));
        repo.setRaid(guild.id, { min_account_age_days: a, lockdown_minutes: m, auto_lockdown: au, kick_suspicious: k });
        await audit(guild, i, `Raid options updated`);
        return show(raidView(guild));
      }
      case 'rlk': {
        await i.deferUpdate();
        const r = arg[0] === 'on' ? await raid.lockdown(guild, repo.getRaid(guild.id).lockdown_minutes, i.user.id) : await raid.unlock(guild, i.user.id);
        const items = raidView(guild);
        if (!r.ok) items.splice(1, 0, `-# ${E.redDot} ${r.error}`);
        return i.editReply(ui.edit(items));
      }
      case 'rvf': {
        await i.deferUpdate();
        const ok = await raid.setManualVerification(guild, arg[0] === 'on');
        const items = raidView(guild);
        if (!ok) items.splice(1, 0, `-# ${E.redDot} Could not change the verification level.`);
        return i.editReply(ui.edit(items));
      }
      default: return show(main(guild));
    }
  } catch (err) {
    const msg = describeError(err);
    if (i.deferred || i.replied) return i.editReply(ui.edit([`${E.redDot} ${msg}`])).catch(() => {});
    return i.reply(ui.error(msg)).catch(() => {});
  }
}

module.exports = { main, route, handle, protection, moduleView, whitelistView, logsView, settings, raidView };
