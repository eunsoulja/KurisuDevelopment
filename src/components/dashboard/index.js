'use strict';
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const ui = require('../common/ui');
const repo = require('../../database/repo');
const perms = require('../../permissions');
const raid = require('../../engines/raid');
const logging = require('../../engines/logging');
const { MODULES, KEYS } = require('../../engines/antinuke/modules');
const { PUNISHMENTS, PUNISHMENT_LABEL, WHITELIST_LEVELS, LOG_TYPES } = require('../../config/settings');
const { SCOPE_LABELS, SCOPE_PRESETS, storedScopes, scopesLabel, scopesForMask, maskForScopes, maskId, parseMask, ALL_MASK, presetForMask, moduleOptions } = require('../../config/whitelist');
const whitelist = require('../../commands/whitelist/whitelist');
const diagnostics = require('./diagnostics');
const { SECURITY_BANNER } = require('../../config/branding');
const { clip, describeError } = require('../../utils/helpers');

const { E } = ui;
const PAGE = 6;
const WL_MODULE_PAGE = 10;
const on = (b) => (b ? 'Enabled' : 'Disabled');

/**
 * Whitelist grant state, carried in customIds as `<level>:<mask>[:<page>]`.
 *   mask    -1 : preset still pending (nothing chosen yet)
 *            0 : level default
 *           >0 : module mask (ALL_MASK = every module)
 *   page    0 (or absent) = grant page, 1+ = custom scope page (items (page-1)*10 ...)
 * Custom-page select/Save ids carry `-(page+1)` instead of a mask when the whole
 * set is selected: the page then shows every module ticked, and an empty
 * submission is still unambiguous (Discord sends the same payload whether the
 * user cleared a full page or never opened the menu).
 * Old links in existing messages (level + mask only) still resolve to page 0.
 */
const PRESET_MASK = -1n;
const pageMarker = (mask, page) => (mask === ALL_MASK ? -1n - BigInt(page) : mask);
/** Recover the mask from a page marker written by pageMarker(). */
const unmarkMask = (value, page) => (value < 0n && value !== PRESET_MASK && -value - 1n === BigInt(page) ? ALL_MASK : wlApplied(value));
const wlTargets = (mask) => scopesForMask(mask > 0n ? mask : 0n);
// Page 0 (grant page) keeps the historical two-argument form so older messages and
// ids stay byte-identical; the custom page appends its page number.
const wlArgs = (level, mask, page = 0) => `${level}:${maskId(mask)}${Number(page) ? `:${Number(page)}` : ''}`;
// A pending preset keeps whatever was applied before; it never silently means "level default".
const wlApplied = (mask, previous = 0n) => (mask === PRESET_MASK ? previous : mask);
const wlMask = (mask) => (mask === PRESET_MASK ? 0n : mask);
/** Page part of a wl mask arg: "abc.2" -> 2; a bare mask or nothing -> 0. */
const parsePage = (value) => {
  const n = Number(String(value ?? '').split('.')[1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
};
const reBit = (mask, idx) => mask | (1n << BigInt(idx));
/**
 * Fold a select submission into a stored mask.
 *   page     { keys, values } for the select that was submitted: the page's new
 *            state is exactly `values`, every other page is untouched
 *   keep     keys owned by another select; left untouched
 *   'default' clears everything, 'all' sets everything, module keys are set
 *
 * `current` supplies only the pages that are NOT part of this submission. It is
 * never used for the submitted page, because Discord omits unselected options:
 * rebuilding from `current` would silently drop modules the user never touched.
 */
function scopeMask(current, { keys: pageKeys, values: values = [] }, keep = new Set()) {
  const picked = values.filter((v) => KEYS.includes(v));
  // "Default" wins only when nothing concrete was picked in the same submission.
  if (values.includes('default') && !picked.length) return 0n;
  if (values.includes('all')) return ALL_MASK;
  let mask = values.includes('default') ? 0n : current;
  // Clear the whole submitted page, then set exactly what was returned.
  for (const key of pageKeys) {
    if (keep.has(key)) continue;
    const idx = KEYS.indexOf(key);
    if (idx !== -1) mask &= ~(1n << BigInt(idx));
  }
  for (const value of picked) {
    const idx = KEYS.indexOf(value);
    if (idx !== -1) mask = reBit(mask, idx);
  }
  return mask;
}
const FW_LIMIT = 6;
/** Entries on the grant page; the custom page keeps it compact to stay inside the text budget. */
function entryList(guild, limit) {
  const rows = repo.listWhitelist(guild.id);
  if (!rows.length) return { rows, list: 'No entries. Owners are always exempt.' };
  const line = (r) => {
    const targetType = r.target_type === 'role' ? 'role' : 'user';
    const target = targetType === 'role' ? `<@&${r.user_id}>` : `<@${r.user_id}>`;
    return `${target}  ·  ${WHITELIST_LEVELS[r.level]}  ·  ${scopesLabel(storedScopes(r.scopes))}`;
  };
  const shown = rows.slice(0, limit);
  return { rows, list: shown.map(line).join('\n') + (rows.length > shown.length ? `\n-# +${rows.length - shown.length} more` : '') };
}

// ---------------------------------------------------------------- views
const PROT_PAGE = 10;

/**
 * Security Center main card.
 *
 *   [banner]  KURISU SECURITY CENTER        <- title section, portrait accessory
 *             server name  ·  verdict
 *   ---------
 *   Antinuke  Raid                       <- 2-column state grid, one fact each
 *   Whitelist Incidents
 *   ---------
 *   Nuke Guard ................ armed    <- safeguards, status pushed right
 *   Nuke Watch ................ 0
 *   Last Incident ............. None
 *   ---------
 *   [Protection] [Whitelist]
 *   [Logs]       [Settings]
 *   [Diagnostics]
 *
 * Every line carries a different fact - no repeated "Active" filler - and every
 * module group has its own emoji so the card scans by icon, not by reading.
 */
function main(guild) {
  const g = repo.getGuild(guild.id);
  const r = repo.getRaid(guild.id);
  const mods = repo.getAllModules(guild.id, MODULES);
  const enabled = mods.filter((m) => m.enabled).length;
  const guard = repo.getModule(guild.id, 'nukeGuard', MODULES);
  const last = repo.lastIncident(guild.id);
  const watchers = repo.countNukeWatch(guild.id);
  const incidents = repo.countIncidents(guild.id);
  const whitelisted = repo.countWhitelist(guild.id);
  const off = mods.filter((m) => !m.enabled).length;

  // One verdict instead of three identical "Active" lines. Antinuke being off is
  // the only state that makes the whole card insecure; anything else is a warning.
  const verdict = !g.antinuke_enabled
    ? { icon: E.redDot, line: '**Antinuke is off** - this server is unprotected' }
    : r.lockdown_active
      ? { icon: E.timeoutClock, line: '**Lockdown active** - channels are restricted' }
      : off
        ? { icon: E.timeoutClock, line: `${enabled} of ${KEYS.length} modules armed  ·  ${off} off` }
        : { icon: E.verified, line: `All ${KEYS.length} modules armed` };

  // Raid always shows its real state; "On" alone would hide an active lockdown.
  const raidState = !g.raid_enabled ? 'Off' : r.lockdown_active ? 'Lockdown' : r.level === 'NORMAL' ? 'Normal' : r.level;
  const raidIcon = r.lockdown_active ? E.timeoutClock : E.modernRaid;
  const watcherText = `${watchers} ${watchers === 1 ? 'executor' : 'executors'}`;
  const lastText = last ? `<t:${Math.floor(last.created_at / 1000)}:R>` : 'None yet';
  // Discord text is proportional, so a dot leader cannot align. Keeping the
  // right-hand values the same width (see below) is what actually lines up.
  const armed = guard.enabled ? 'Armed' : 'Off';

  return [
    // Banner + title share one section so the portrait sits beside the heading
    // instead of taking a full-width media row above it.
    { section: `### ${E.clearShield} KURISU SECURITY CENTER\n-# ${clip(guild.name, 60)}  ·  ${verdict.line}`, thumbnail: SECURITY_BANNER },

    // Two columns: the eye compares state across the row, not down a list.
    `${E.clearShield} **Antinuke**\n-# ${g.antinuke_enabled ? verdict.icon : E.smallRedDot} ${g.antinuke_enabled ? 'On' : 'Off'}`,
    `${raidIcon} **Raid**\n-# ${raidState}`,
    // verifiedDeveloper marks trusted entries; bugHunter marks detections, so the
    // two ban-hammers stay available for the punishment-oriented safeguards.
    `${E.verifiedDeveloper} **Whitelist**\n-# ${whitelisted} ${whitelisted === 1 ? 'entry' : 'entries'}`,
    `${E.bugHunter} **Incidents**\n-# ${incidents} logged`,
    'sep:blank',
    // Safeguards: label, then a short status. One line each, no fake alignment.
    `${E.modernRules} **Nuke Guard**  ·  ${armed}\n` +
    `-# ${guard.enabled ? `${PUNISHMENT_LABEL[guard.punishment]} on ${guard.threshold} actions / ${guard.window_sec}s` : 'Cross-module bursts are not watched'}`,
    `${E.banHammer} **Nuke Watch**  ·  ${watcherText}\n` +
    `${E.banHammerAlt} **Last Incident**  ·  ${lastText}`,
    'sep',
    ui.buttons(ui.btn('ks:v:prot:0', 'Protection', { emoji: 'clearShield' }), ui.btn('ks:v:wl:trusted_mod', 'Whitelist', { emoji: 'verifiedDeveloper' })),
    ui.buttons(ui.btn('ks:v:logs:0', 'Logs', { emoji: 'bugHunter' }), ui.btn('ks:v:set', 'Settings', { emoji: 'modernRules' })),
    ui.buttons(ui.btn('ks:v:diag', 'Diagnostics', { emoji: 'modernVerify' })),
  ];
}

function protection(guild, page = 0) {
  const mods = repo.getAllModules(guild.id, MODULES);
  const enabled = mods.filter((m) => m.enabled).length;
  const pages = Math.max(1, Math.ceil(mods.length / PROT_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = mods.slice(p * PROT_PAGE, (p + 1) * PROT_PAGE);
  // name -> punishment, dot = armed. Disabled modules drop to a muted dot so a
  // wall of red does not read as "everything active".
  const lines = slice.map((m) => `${m.enabled ? E.redDot : E.smallRedDot} ${MODULES[m.module].name}  ·  \`${PUNISHMENT_LABEL[m.punishment]}\``);
  const options = slice.map((m) => ({
    label: MODULES[m.module].name,
    value: m.module,
    description: `${on(m.enabled)} · ${m.threshold} in ${m.window_sec}s`,
    emoji: E.clearShield,
  }));
  const nav = pages > 1 ? [
    ui.btn(`ks:v:prot:${p - 1}`, 'Previous', { disabled: p === 0, emoji: 'smallRedDot' }),
    ui.btn(`ks:v:prot:${p + 1}`, 'Next', { disabled: p >= pages - 1, emoji: 'smallRedDot' }),
  ] : [];
  return [
    `### ${E.clearShield} PROTECTION MODULES`,
    `-# **${enabled}** armed  ·  **${KEYS.length - enabled}** off  ·  page ${p + 1}/${pages}`,
    'sep',
    lines.length ? lines.join('\n') : 'No protection modules.',
    'sep',
    ui.select(`ks:pick:${p}`, 'Configure a module on this page', options),
    ui.buttons(...nav, ui.btn('ks:v:main', 'Back', { emoji: 'redDot' })),
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

function whitelistView(guild, level = 'trusted_mod', mask = 0n, page = 0) {
  if (!WHITELIST_LEVELS[level]) level = 'trusted_mod';
  const isCustom = page > 0;
  const { rows, list } = entryList(guild, isCustom ? FW_LIMIT : 10);
  // Grant page and custom page share the same project: never label a module set
  // with a preset name while that module set is still exactly what will be saved.
  const applied = wlApplied(mask);
  const custom = applied !== 0n && applied !== ALL_MASK && presetForMask(applied) === null;
  const scopeLine = mask === PRESET_MASK ? 'Choose a preset below'
    : applied === 0n ? 'Level default'
      : applied === ALL_MASK ? 'All protection modules'
        : custom ? scopesLabel(wlTargets(applied)) : SCOPE_PRESETS[presetForMask(applied)].name;

  if (page > 0) return whitelistScopeView(guild, level, mask, page, { rows, list, scopeLine });

  // Presets are the fast path. "Custom modules" only changes the selection, so
  // the choice is visible below before the Add/Remove pickers.
  const presets = Object.entries(SCOPE_PRESETS).map(([name, preset]) => ({
    label: preset.name,
    value: name,
    description: preset.keys?.includes('*') ? 'Exempt from every antinuke module'
      : preset.keys ? preset.keys.length > 6 ? `${preset.keys.length} modules` : preset.keys.map((k) => SCOPE_LABELS[k] || k).join(', ')
        : 'Trusted Moderator: message modules only; other levels: everything',
    default: name === presetForMask(applied),
  }));
  presets.push({ label: 'Custom modules…', value: 'custom', description: 'Pick individual modules on a separate page', default: custom });

  return [
    `### ${E.modernStaff} WHITELIST`,
    `-# ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}  ·  owners are always exempt`,
    'sep',
    list,
    'sep',
    '**Grant level**',
    ui.select(`ks:wlvl:${wlArgs(level, mask, 0)}`, 'Choose level',
      Object.entries(WHITELIST_LEVELS).map(([value, label]) => ({ label, value, default: value === level }))),
    `**Scope**  ·  ${scopeLine}${custom ? '  ·  custom' : ''}`,
    ui.select(`ks:wsp:${wlArgs(level, mask, 0)}`, 'Choose a scope preset', presets),
    'sep',
    '**Add or update**  ·  saves this level and scope',
    ui.userSelect(`ks:wladd:${wlArgs(level, mask, 0)}`, 'Add or update a user'),
    ui.roleSelect(`ks:wladdr:${wlArgs(level, mask, 0)}`, 'Add or update a role'),
    'sep',
    ui.buttons(ui.btn(`ks:wsc:${wlArgs(level, mask, 1)}`, 'Custom Modules', { emoji: 'modernRules' }), ui.btn('ks:v:main', 'Back', { emoji: 'redDot' })),
    'sep',
    '**Remove**',
    ui.userSelect(`ks:wlrm:${wlArgs(level, mask, 0)}`, 'Remove a user'),
    ui.roleSelect(`ks:wlrmr:${wlArgs(level, mask, 0)}`, 'Remove a role'),
  ];
}

/** Custom scope subpage: one select for 10 modules at a time, explicit Save / Back. */
function whitelistScopeView(guild, level, mask, page, { rows, list, scopeLine }) {
  const modules = moduleOptions();
  const pages = Math.max(1, Math.ceil(modules.length / WL_MODULE_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = modules.slice((p - 1) * WL_MODULE_PAGE, p * WL_MODULE_PAGE);
  const current = wlApplied(mask);
  const isModule = (v) => current !== 0n && current !== ALL_MASK && (current & (1n << BigInt(KEYS.indexOf(v)))) !== 0n;

  const nav = [
    ui.btn(`ks:wsc:${wlArgs(level, mask, p - 1)}`, 'Previous', { disabled: p <= 1 }),
    ui.btn(`ks:wsc:${wlArgs(level, mask, p + 1)}`, 'Next', { disabled: p >= pages }),
  ];
  return [
    `### ${E.modernStaff} CUSTOM SCOPES`,
    `-# Page ${p}/${pages}  ·  select modules, then Save  ·  ${WHITELIST_LEVELS[level]}`,
    'sep',
    list,
    'sep',
    `**Current scope**  ·  ${scopeLine}`,
    // Deselect everything in the picker = clear this page's modules. "Level default"
    // drops custom modules entirely. "All" selects everything; narrow it afterwards.
    ui.select(`ks:scl:${wlArgs(level, pageMarker(mask, p), p)}`, 'Select or deselect modules on this page', [
      { label: 'Level default', value: 'default', description: 'Use the level default instead of custom modules', default: mask === PRESET_MASK || current === 0n },
      { label: 'All protection modules', value: 'all', description: 'Exempt from every antinuke module', default: current === ALL_MASK },
      ...slice.map((o) => ({ ...o, default: isModule(o.value) })),
    ], { min: 0, max: 11 }),
    'sep',
    ui.buttons(ui.btn(`ks:wsa:${wlArgs(level, mask, page)}`, 'Save'), ui.btn(`ks:wsc:${wlArgs(level, mask, 0)}`, 'Cancel'), ...nav),
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
    ui.buttons(...nav, ui.btn('ks:v:main', 'Back', { emoji: 'redDot' })),
  ];
}

function settings(guild, logType) {
  const g = repo.getGuild(guild.id);
  const chans = repo.allLogChannels(guild.id);
  const entries = Object.entries(LOG_TYPES);
  const set = entries.filter(([k]) => chans[k]);
  const unset = entries.filter(([k]) => !chans[k]).map(([, label]) => label);
  const lines = set.length
    ? set.map(([k, label]) => `${E.redDot} ${label}  ·  <#${chans[k]}>`).join('\n')
    : 'No log channels configured.';
  const unsetLine = unset.length ? `\n-# Not set: ${unset.join(', ')}` : '';
  const items = [
    `### ${E.modernRules} SETTINGS`,
    '-# Protection, escalation and logging',
    'sep',
    // Each section carries its own heading so the card reads as three groups.
    { section: `${E.clearShield} **Antinuke**\n-# ${on(g.antinuke_enabled)}`, button: ui.btn('ks:master:antinuke', g.antinuke_enabled ? 'Disable' : 'Enable', { emoji: g.antinuke_enabled ? 'smallRedDot' : 'verified' }) },
    { section: `${E.modernRaid} **Raid Protection**\n-# ${on(g.raid_enabled)}`, button: ui.btn('ks:master:raid', g.raid_enabled ? 'Disable' : 'Enable', { emoji: g.raid_enabled ? 'smallRedDot' : 'verified' }) },
    'sep',
    `**Escalation**  ·  ${g.escalation_threshold ? `auto-ban after **${g.escalation_threshold}** incidents in 24h` : 'Off'}\n**Prefix**  ·  \`${g.prefix || '!'}\``,
    'sep',
    `**Log Channels**  ·  **${set.length}/${entries.length}** configured\n${lines}${unsetLine}`,
    'sep',
    ui.select('ks:lt', 'Choose a log type', Object.entries(LOG_TYPES).map(([value, label]) => ({ label, value, default: value === logType }))),
  ];
  // A selected type gets one channel picker; "Clear" joins the footer row instead
  // of sitting alone, which used to add two extra rows to this card.
  const hasType = logType && LOG_TYPES[logType];
  if (hasType) items.push(ui.channelSelect(`ks:lc:${logType}`, `Channel for ${LOG_TYPES[logType]} logs`));
  // "Back" always closes the card, so it never shares a row with a setting. The
  // optional Clear Channel goes with the type picker; the rest split 2 + 2.
  const footer = [
    ...(hasType ? [ui.btn(`ks:lclr:${logType}`, 'Clear Channel', { emoji: 'smallRedDot' })] : []),
    ui.btn('ks:esc', 'Escalation', { emoji: 'timeoutClock' }), ui.btn('ks:v:raid', 'Raid', { emoji: 'modernRaid' }),
    ui.btn('ks:v:diag', 'Diagnostics', { emoji: 'modernVerify' }),
  ];
  const perRow = Math.ceil(footer.length / 2);
  items.push(ui.buttons(...footer.slice(0, hasType ? 2 : perRow)));
  items.push(ui.buttons(...footer.slice(hasType ? 2 : perRow), ui.btn('ks:v:main', 'Back', { emoji: 'redDot' })));
  return items;
}

function raidView(guild) {
  const c = repo.getRaid(guild.id);
  const level = { NORMAL: 'Normal', ELEVATED: 'Elevated', HIGH: 'High', LOCKDOWN: 'Lockdown' }[c.level] || c.level;
  return [
    `### ${E.modernRaid} RAID PROTECTION`,
    `${c.lockdown_active ? E.timeoutClock : E.verified} ${c.lockdown_active ? '**Lockdown active**' : `Level **${level}**`}  ·  verification **${c.verification_active ? 'on' : 'off'}**`,
    'sep',
    // Thresholds read as a ladder: the number is what you tune, the text is the effect.
    `**Join Thresholds**  ·  ${c.window_sec}s window\n` +
    `-# Elevated  **${c.elevated_joins}**   ·   High  **${c.high_joins}**   ·   Lockdown  **${c.lockdown_joins}**\n` +
    `-# High raises verification. Lockdown is ${c.auto_lockdown ? `automatic for ${c.lockdown_minutes}m` : 'manual only'}.`,
    'sep',
    `**Accounts**  ·  minimum age **${c.min_account_age_days ? `${c.min_account_age_days} days` : 'none'}**  ·  kick in lockdown **${c.kick_suspicious ? 'yes' : 'no'}**`,
    'sep',
    // These two are the only immediate actions on this card, so they get their own row.
    ui.buttons(ui.btn(c.lockdown_active ? 'ks:rlk:off' : 'ks:rlk:on', c.lockdown_active ? 'Unlock Server' : 'Lock Server'),
      ui.btn(c.verification_active ? 'ks:rvf:off' : 'ks:rvf:on', c.verification_active ? 'Verification Off' : 'Verification On')),
    ui.buttons(ui.btn('ks:rth', 'Thresholds', { emoji: 'modernRules' }), ui.btn('ks:rop', 'Options', { emoji: 'clearShield' }), ui.btn('ks:v:set', 'Back', { emoji: 'redDot' })),
  ];
}

// Only the diagnostics view needs a REST probe, so routing stays synchronous.
function route(guild, r) {
  const [view, arg, extra] = r.split(':');
  switch (view) {
    case 'prot': return protection(guild, Number(arg) || 0);
    case 'mod': return moduleView(guild, arg, Number(extra) || 0);
    // wl:<level>[:<maskId>[.<page>]]; parsePage() reads the page, 0 if absent, so a
    // refreshed or linked page can never land on the wrong picker.
    case 'wl': return whitelistView(guild, arg, extra === undefined ? 0n : parseMask(extra), parsePage(extra));
    case 'logs': return logsView(guild, Number(arg) || 0);
    case 'set': return settings(guild, arg);
    case 'raid': return raidView(guild);
    case 'diag': return diagnostics.view(guild);
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
      case 'v':
        // Diagnostics probes audit-log access over REST before rendering.
        if (arg[0] === 'diag') return show(diagnostics.view(guild, { audit: await diagnostics.probe(guild) }));
        return show(route(guild, arg.join(':')));
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
      // Legacy customId: ks:wlvl:<mask> (level-only link from older messages).
      case 'wlvl': return show(whitelistView(guild, i.values[0], parseMask(arg[0])));
      case 'wsp': {
        // Preset pick: remember the level, then stage the preset until Add/Remove.
        const level = arg[0] || 'trusted_mod';
        const value = i.values[0];
        if (value === 'custom') return show(whitelistView(guild, level, PRESET_MASK, 1));
        const preset = SCOPE_PRESETS[value];
        if (!preset) return show(whitelistView(guild, level, PRESET_MASK));
        return show(whitelistView(guild, level, preset.keys ? maskForScopes(preset.keys) : 0n));
      }
      // Legacy customId: ks:wlsc:<level>:<mask>:<chunk>. Old messages submitted one
      // of two 25-option selects before the redesign; accept it gracefully.
      case 'wlsc': {
        const level = arg[0] || 'trusted_mod';
        const current = parseMask(arg[1]);
        const crafted = ['default', 'all', ...KEYS].slice((Number(arg[2]) || 0) * 25, (Number(arg[2]) || 0) * 25 + 25);
        const chunkKeys = crafted.filter((v) => v !== 'default' && v !== 'all');
        const next = scopeMask(current, { keys: chunkKeys, values: i.values });
        return show(whitelistView(guild, level, next === 0n ? PRESET_MASK : next));
      }
      // Custom scope page 1: apply this page's selection to the staged mask.
      case 'scl': {
        const level = arg[0] || 'trusted_mod';
        const page = Number(arg[2]) || 1;
        const carried = parseMask(arg[1]);
        const base = unmarkMask(carried, page);
        const slice = KEYS.slice((page - 1) * WL_MODULE_PAGE, page * WL_MODULE_PAGE);
        const next = scopeMask(base, { keys: slice, values: i.values });
        return show(whitelistView(guild, level, next, page));
      }
      // Save: resolve the page marker back to a real mask and return to the grant page.
      case 'wsa': return show(whitelistView(guild, arg[0] || 'trusted_mod', unmarkMask(parseMask(arg[1]), Number(arg[2]) || 1), 0));
      // arg[2] (page) is new in the redesigned flow; older messages omit it and mean page 0.
      case 'wladd': {
        const user = i.users.first();
        const mask = wlApplied(parseMask(arg[1]));
        const r = await whitelist.addEntry(guild, i.member, user, arg[0], { targetType: 'user', scopes: scopesForMask(mask) });
        return show(withFeedback(whitelistView(guild, arg[0], mask), r));
      }
      case 'wladdr': {
        const role = i.roles.first();
        const mask = wlApplied(parseMask(arg[1]));
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

module.exports = { main, route, handle, protection, moduleView, whitelistView, whitelistScopeView, logsView, settings, raidView, diagnostics };
