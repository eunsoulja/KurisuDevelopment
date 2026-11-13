'use strict';
const { PermissionsBitField: PB } = require('discord.js');
const ui = require('../common/ui');
const repo = require('../../database/repo');
const db = require('../../database');
const perms = require('../../permissions');
const { EMOJIS, parseEmoji } = require('../../config/emojis');
const { LOG_TYPES } = require('../../config/settings');
const { MODULES, KEYS } = require('../../engines/antinuke/modules');
const { clip } = require('../../utils/helpers');

const { E } = ui;
const ok = (label, value) => ({ level: 'ok', label, value });
const warn = (label, value) => ({ level: 'warn', label, value });
const bad = (label, value) => ({ level: 'bad', label, value });
const dot = { ok: E.shinyVerified, warn: E.timeoutClock, bad: E.redDot };
const ALL = BigInt(PB.All);

const REQUIRED = [
  ['BanMembers', 'Ban'], ['KickMembers', 'Kick'], ['ModerateMembers', 'Timeout'],
  ['ManageMessages', 'Message moderation'], ['ManageRoles', 'Roles & strips'],
  ['ManageChannels', 'Channel moderation & lockdown'], ['ManageGuild', 'Server protection'],
  ['ManageWebhooks', 'Webhook cleanup'], ['ManageNicknames', 'Nicknames'],
  ['ViewAuditLog', 'Antinuke detection'], ['ManageGuildExpressions', 'Emoji cleanup'],
  ['MentionEveryone', 'Ping detection'], ['CreateInstantInvite', 'Invite cleanup'], ['ViewChannel', 'Read servers'],
];

async function probe(guild) {
  if (typeof guild?.fetchAuditLogs !== 'function') return null;
  if (!guild.members?.me?.permissions?.has(PB.Flags.ViewAuditLog)) return false;
  try {
    await guild.fetchAuditLogs({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every setup problem an operator can fix, in one card.
 * `audit` (true/false) from a live probe reports real audit-log access.
 */
async function checks(guild, { client = guild.client, audit = null } = {}) {
  const g = await repo.getGuild(guild.id);
  const me = guild.members?.me || null;
  const out = [];

  // Database, deploy mode and the emoji registry
  let dbState = 'Unavailable';
  let dbRes = null;
  try { dbRes = await db.ping(); } catch { dbRes = { ok: false, error: 'unreachable' }; }
  const dbOk = !!dbRes?.ok;
  if (dbOk) dbState = `MongoDB${dbRes.db ? `  -  ${dbRes.db}` : ''}`;
  else if (dbRes?.error) dbState = `MongoDB  -  ${dbRes.error}`;
  out.push(dbOk && g ? ok('Database', dbState) : bad('Database', dbState));
  out.push(process.env.AUTO_DEPLOY === 'true' ? ok('Deploy Mode', 'Auto deploy') : warn('Deploy Mode', 'Manual (npm run deploy)'));
  const broken = Object.entries(EMOJIS).filter(([, v]) => !parseEmoji(v)).length;
  out.push(broken ? bad('Emoji Registry', `${broken} malformed`) : ok('Emoji Registry', `${Object.keys(EMOJIS).length} registered`));

  // Bot identity, permissions and hierarchy
  if (!me?.permissions) {
    out.push(warn('Bot Permissions', 'Not resolved in this server'));
  } else {
    const missing = REQUIRED.filter(([bit]) => !me.permissions.has(PB.Flags[bit])).map(([, label]) => label);
    out.push(missing.length ? bad('Bot Permissions', clip(`Missing: ${missing.join(', ')}`, 220)) : ok('Bot Permissions', 'All required permissions'));
  }
  const rp = me ? perms.rolePosition(guild, me) : null;
  if (!rp) out.push(warn('Role Position', 'Role cache incomplete'));
  else if (rp.position === 0) out.push(bad('Role Position', 'Below all roles'));
  else if (!rp.above) out.push(warn('Role Position', `Below ${rp.highest - rp.position} role(s)`));
  else out.push(ok('Role Position', 'Highest role'));
  out.push(audit === true ? ok('Audit Log Access', 'Readable')
    : audit === false ? bad('Audit Log Access', 'Not readable')
      : warn('Audit Log Access', 'Not verified'));

  // Protection state
  const enabled = (await repo.getAllModules(guild.id, MODULES)).filter((m) => m.enabled).length;
  out.push(g?.antinuke_enabled ? ok('Antinuke', `Enabled - ${enabled}/${KEYS.length} modules`) : bad('Antinuke', 'Disabled'));
  const totalLogs = Object.keys(LOG_TYPES).length;
  const setLogs = Object.keys(await repo.allLogChannels(guild.id)).length;
  out.push(setLogs ? ok('Log Channels', `${setLogs}/${totalLogs} configured`) : warn('Log Channels', `0/${totalLogs} configured`));
  const raidCfg = await repo.getRaid(guild.id);
  out.push(g?.raid_enabled ? ok('Raid Protection', `Level ${raidCfg.level}`) : warn('Raid Protection', 'Disabled'));
  out.push(raidCfg.lockdown_active ? warn('Lockdown', 'Active now') : ok('Lockdown', 'Off'));

  // Whitelist authority
  const wl = await repo.listWhitelist(guild.id);
  const trustedAdmins = wl.filter((r) => r.target_type !== 'role' && r.level === 'trusted_admin').length;
  out.push(ok('Whitelist', `${wl.length} ${wl.length === 1 ? 'entry' : 'entries'}${trustedAdmins ? ` - ${trustedAdmins} trusted admin` : ''}`));

  out.push(process.env.OWNER_IDS ? ok('Bot Owners', 'Configured') : warn('Bot Owners', 'OWNER_IDS not set'));
  const botId = client?.user?.id || 'kurisu';
  if (perms.isBotOwner(botId)) out.push(ok('Bot Owner Check', 'Active'));

  const flags = client?.application?.flags;
  if (typeof flags?.has === 'function') {
    const flag = (name) => {
      try { return flags.has(name); } catch { return null; }
    };
    const members = flag('GatewayGuildMembers');
    const content = flag('GatewayMessageContent');
    if (members !== null) out.push(members ? ok('Members Intent', 'Granted') : bad('Members Intent', 'Missing - join & hierarchy checks fail'));
    if (content !== null) out.push(content ? ok('Message Intent', 'Granted') : bad('Message Intent', 'Missing - text commands fail'));
  }
  return out.map((c) => ({ ...c, icon: dot[c.level] }));
}

async function view(guild, opts = {}) {
  const rows = await checks(guild, opts);
  const issues = rows.filter((r) => r.level !== 'ok').length;
  return [
    `### ${E.clearShield} DIAGNOSTICS`,
    `-# ${rows.length - issues} of ${rows.length} checks passing${issues ? `  -  ${issues} need attention` : '  -  all clear'}`,
    'sep',
    rows.map((r) => `${r.icon} **${r.label}**  -  ${r.value}`).join('\n'),
    'sep',
    ui.buttons(ui.btn('ks:v:diag', 'Re-check'), ui.btn('ks:v:set', 'Settings'), ui.btn('ks:v:main', 'Back', { emoji: 'redDot' })),
  ];
}

module.exports = { checks, probe, view };
