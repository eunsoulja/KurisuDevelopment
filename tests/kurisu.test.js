'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditLogEvent, MessageFlags } = require('discord.js');
const { fakeGuild, walk } = require('./helpers');

process.env.OWNER_IDS = 'botowner';
const db = require('../src/database');
db.open(':memory:');
const repo = require('../src/database/repo');
const perms = require('../src/permissions');
const antinuke = require('../src/engines/antinuke');
const { MODULES, KEYS } = require('../src/engines/antinuke/modules');
const raid = require('../src/engines/raid');
const { EMOJIS, parseEmoji } = require('../src/config/emojis');
const { ALL_MASK, maskForScopes, maskId, parseScopes, scopesForMask } = require('../src/config/whitelist');
const helpers = require('../src/utils/helpers');
const ui = require('../src/components/common/ui');
const help = require('../src/components/help');
const dashboard = require('../src/components/dashboard');
const commands = require('../src/commands').load();
const text = require('../src/text');

test('database: migrations are idempotent and config survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-')), 'persist.db');
  const Database = require('better-sqlite3');
  // open the real module against a file, write, close, reopen
  db.close();
  db.open(file);
  repo.saveModule('gA', 'massBan', { enabled: false, threshold: 7, window_sec: 33, punishment: 'kick' });
  repo.addWhitelist('gA', 'u1', 'bypass', 'owner');
  repo.setRaid('gA', { high_joins: 42 });
  db.close();
  db.open(file);
  const m = repo.getModule('gA', 'massBan', MODULES);
  assert.equal(m.threshold, 7); assert.equal(m.enabled, 0); assert.equal(m.punishment, 'kick');
  assert.equal(repo.getWhitelist('gA', 'u1').level, 'bypass');
  assert.equal(repo.getRaid('gA').high_joins, 42);
  assert.equal(new Database(file).prepare('SELECT COUNT(*) c FROM schema_migrations').get().c, 5);
  db.close();
  db.open(':memory:');
});

test('database: guild data is isolated', () => {
  repo.addWarning('gX', 'u', 'm', 'a'); repo.addWarning('gY', 'u', 'm', 'b');
  assert.equal(repo.countWarnings('gX', 'u'), 1);
  assert.equal(repo.addCase('gX', { userId: 'u', moderatorId: 'm', action: 'ban' }).case_number, 1);
  assert.equal(repo.addCase('gY', { userId: 'u', moderatorId: 'm', action: 'ban' }).case_number, 1);
  assert.equal(repo.addCase('gX', { userId: 'u', moderatorId: 'm', action: 'kick' }).case_number, 2);
  repo.addNukeRecent('gX', 'u', 'e1', ['memberKick'], Date.now());
  assert.equal(repo.listNukeRecent('gX', 'u', 0).length, 1);
  assert.equal(repo.listNukeRecent('gY', 'u', 0).length, 0, 'burst state is guild-isolated');
  repo.clearNukeRecent('gX', 'u');
  assert.equal(repo.listNukeRecent('gX', 'u', 0).length, 0);
});

test('emoji registry: every entry has exact <:name:id> syntax', () => {
  for (const [k, v] of Object.entries(EMOJIS)) assert.ok(parseEmoji(v), `${k} malformed`);
  assert.ok(Object.keys(EMOJIS).length >= 30);
});

test('modules: 28 protection modules, each with defaults', () => {
  assert.equal(KEYS.length, 28);
  for (const k of KEYS) { const d = MODULES[k].defaults; assert.ok(d.threshold > 0 && d.windowSec > 0 && d.punishment, k); }
  for (const k of ['nukeGuard', 'massUnban', 'threadDelete', 'assetCreate', 'automodRule']) assert.ok(MODULES[k], `missing ${k}`);
});

test('permissions: exemption rules', () => {
  const { guild } = fakeGuild();
  assert.ok(perms.isExempt(guild, 'owner'));
  assert.ok(perms.isExempt(guild, 'botowner'));
  assert.ok(perms.isExempt(guild, 'kurisu'));
  assert.ok(!perms.isExempt(guild, 'randomadmin'), 'administrator alone grants no immunity');
  repo.addWhitelist('g1', 'tm', 'trusted_mod', 'owner');
  assert.ok(!perms.isExempt(guild, 'tm', 'general'));
  assert.ok(perms.isExempt(guild, 'tm', 'message'));
  assert.ok(!perms.isExempt(guild, 'tm', 'message', 'channelCreate'), 'trusted_mod defaults to message modules only');
  repo.addWhitelist('g1', 'byp', 'bypass', 'owner');
  assert.ok(perms.isExempt(guild, 'byp'));
});

test('whitelist: scope parsing and dashboard masks', () => {
  assert.deepEqual(parseScopes('pings').scopes, ['everyoneMention', 'massMention']);
  assert.deepEqual(parseScopes('channel-create,channel-rename').scopes, ['channelCreate', 'channelUpdate']);
  assert.deepEqual(parseScopes('channelUpdate').scopes, ['channelUpdate']);
  assert.deepEqual(parseScopes('all').scopes, ['*']);
  assert.equal(parseScopes('default').scopes, null);
  assert.ok(!parseScopes('not-a-scope').ok);
  assert.deepEqual(scopesForMask(maskForScopes(['channelCreate', 'everyoneMention'])), ['channelCreate', 'everyoneMention']);
  assert.equal(scopesForMask(0n), null);
});

test('permissions: role whitelist and specific scopes', () => {  const { guild, addMember } = fakeGuild();
  const role = { id: 'roleMods', name: 'Moderators' };
  addMember('scoped', { roles: [role] });
  addMember('pinger');

  repo.addWhitelist('g1', 'roleMods', 'trusted_mod', 'owner', {
    targetType: 'role', scopes: ['channelCreate', 'channelUpdate'],
  });
  assert.ok(perms.isExempt(guild, 'scoped', 'general', 'channelCreate'));
  assert.ok(perms.isExempt(guild, 'scoped', 'general', 'channelUpdate'));
  assert.ok(!perms.isExempt(guild, 'scoped', 'general', 'channelDelete'));
  assert.ok(!perms.isExempt(guild, 'scoped', 'general'), 'scoped entries are not fully exempt');

  repo.addWhitelist('g1', 'pinger', 'trusted_mod', 'owner', { scopes: ['everyoneMention', 'massMention'] });
  assert.ok(perms.isExempt(guild, 'pinger', 'message', 'everyoneMention'));
  assert.ok(perms.isExempt(guild, 'pinger', 'message', 'massMention'));
  assert.ok(!perms.isExempt(guild, 'pinger', 'message', 'massDelete'));
  assert.ok(!perms.isExempt(guild, 'pinger', 'general', 'channelCreate'));

  repo.addWhitelist('g1', 'allmods', 'trusted_mod', 'owner', { scopes: ['*'] });
  assert.ok(perms.isExempt(guild, 'allmods', 'general', 'channelDelete'));
  assert.ok(perms.isExempt(guild, 'allmods', 'general'), 'explicit all-modules entry is fully exempt');
});

test('permissions: whitelist authority and owner protection', () => {  const { guild, addMember } = fakeGuild();
  const admin = addMember('ta'); admin.permissions = new (require('discord.js').PermissionsBitField)(8n);
  repo.addWhitelist('g1', 'ta', 'trusted_admin', 'owner');
  const plain = addMember('plain');
  assert.ok(perms.canGrantLevel(guild, { id: 'owner' }, 'bypass').ok);
  assert.ok(!perms.canGrantLevel(guild, admin, 'bypass').ok, 'trusted admin cannot grant bypass');
  assert.ok(!perms.canGrantLevel(guild, admin, 'trusted_admin').ok);
  assert.ok(perms.canGrantLevel(guild, admin, 'trusted_mod').ok);
  assert.ok(!perms.canGrantLevel(guild, plain, 'trusted_mod').ok, 'ordinary member cannot edit whitelist');
  assert.ok(!perms.canRemoveEntry(guild, { id: 'owner' }, 'owner').ok, 'owner protection cannot be removed');
  assert.ok(!perms.canManageSecurity(guild, plain));
  assert.ok(perms.canManageSecurity(guild, admin));
});

test('permissions: moderation hierarchy', () => {
  const { guild, addMember } = fakeGuild();
  const mod = addMember('mod', { position: 5 });
  const high = addMember('high', { position: 9 });
  const low = addMember('low', { position: 2 });
  const check = (t) => perms.checkTarget({ guild, moderator: mod, targetId: t.id, targetMember: t, verb: 'ban' });
  assert.match(check(high), /equal or higher/);
  assert.equal(check(low), null);
  assert.match(perms.checkTarget({ guild, moderator: mod, targetId: 'owner', targetMember: null, verb: 'ban' }), /owner/);
  assert.match(perms.checkTarget({ guild, moderator: mod, targetId: 'mod', targetMember: mod, verb: 'ban' }), /yourself/);
  assert.match(perms.checkTarget({ guild, moderator: mod, targetId: 'kurisu', targetMember: null, verb: 'ban' }), /myself/);
});

const entry = (id, action, executorId, extra = {}) => ({ id, action, executorId, targetId: `t${id}`, changes: [], ...extra });

test('antinuke: threshold, fast kick, incident record, dedupe', async () => {
  const { guild, kicked, addMember } = fakeGuild();
  addMember('attacker', { position: 3 });
  repo.ensureGuild('g1');
  await antinuke.handleAuditEntry(entry('e1', AuditLogEvent.ChannelDelete, 'attacker'), guild);
  assert.equal(kicked.length, 0, 'below threshold: no punishment');
  await antinuke.handleAuditEntry(entry('e1', AuditLogEvent.ChannelDelete, 'attacker'), guild); // duplicate id
  assert.equal(kicked.length, 0, 'duplicate event ignored');
  await antinuke.handleAuditEntry(entry('e2', AuditLogEvent.ChannelDelete, 'attacker'), guild);
  assert.deepEqual(kicked, ['attacker']);
  const inc = repo.lastIncident('g1');
  assert.equal(inc.module, 'channelDelete'); assert.equal(inc.count, 2); assert.equal(inc.threshold, 2); assert.equal(inc.response, 'Kicked');
  await antinuke.handleAuditEntry(entry('e3', AuditLogEvent.ChannelDelete, 'attacker'), guild);
  assert.equal(kicked.length, 1, 'no repeat punishment inside the lock window');
  assert.equal(repo.countIncidents('g1'), 1);
});

test('antinuke: never punishes owner, bot, whitelisted users or unattributed actions', async () => {
  const { guild, banned } = fakeGuild();
  repo.addWhitelist('g1', 'friend', 'trusted_admin', 'owner');
  for (let n = 0; n < 6; n++) {
    await antinuke.handleAuditEntry(entry(`o${n}`, AuditLogEvent.ChannelDelete, 'owner'), guild);
    await antinuke.handleAuditEntry(entry(`k${n}`, AuditLogEvent.ChannelDelete, 'kurisu'), guild);
    await antinuke.handleAuditEntry(entry(`f${n}`, AuditLogEvent.ChannelDelete, 'friend'), guild);
    await antinuke.handleAuditEntry(entry(`u${n}`, AuditLogEvent.ChannelDelete, null), guild);
  }
  assert.equal(banned.length, 0);
});

test('antinuke: disabled modules do nothing', async () => {
  const { guild, banned } = fakeGuild();
  repo.saveModule('g1', 'massKick', { ...repo.getModule('g1', 'massKick', MODULES), enabled: false });
  for (let n = 0; n < 5; n++) await antinuke.handleAuditEntry(entry(`mk${n}`, AuditLogEvent.MemberKick, 'someone'), guild);
  assert.equal(banned.length, 0);
});

test('antinuke: nuke guard kicks a mixed burst and bans on rejoin', async () => {
  const { guild, kicked, banned, addMember } = fakeGuild({ id: 'gnuke' });
  addMember('nuker', { position: 3 });
  repo.ensureGuild('gnuke');

  await antinuke.handleAuditEntry(entry('n1', AuditLogEvent.MemberKick, 'nuker'), guild);
  await antinuke.handleAuditEntry(entry('n2', AuditLogEvent.MemberBanAdd, 'nuker'), guild);
  assert.equal(kicked.length, 0, 'two actions stay below the guard');
  await antinuke.handleAuditEntry(entry('n3', AuditLogEvent.MemberBanRemove, 'nuker'), guild);
  assert.deepEqual(kicked, ['nuker'], 'third destructive action triggers an immediate kick');

  const inc = repo.lastIncident('gnuke');
  assert.equal(inc.module, 'nukeGuard');
  assert.equal(inc.response, 'Kicked');
  assert.equal(inc.count, 3);
  assert.ok(repo.getNukeWatch('gnuke', 'nuker'), 'kicked nuke executor is watched');

  const rejoined = addMember('nuker');
  rejoined.guild = guild;
  assert.equal(await antinuke.handleJoin(rejoined), true);
  assert.ok(banned.includes('nuker'), 'watched executor is banned on rejoin');
  assert.equal(repo.getNukeWatch('gnuke', 'nuker'), null);
});

test('antinuke: nuke guard burst survives an in-memory restart', async () => {
  const { guild, kicked, addMember } = fakeGuild({ id: 'gnuke2' });
  addMember('nuker2', { position: 3 });
  repo.ensureGuild('gnuke2');

  await antinuke.handleAuditEntry(entry('p1', AuditLogEvent.MemberKick, 'nuker2'), guild);
  await antinuke.handleAuditEntry(entry('p2', AuditLogEvent.MemberBanAdd, 'nuker2'), guild);
  assert.equal(kicked.length, 0, 'two actions stay below the guard');

  antinuke._state.recent.clear(); // simulate a process restart losing memory
  await antinuke.handleAuditEntry(entry('p3', AuditLogEvent.MemberBanRemove, 'nuker2'), guild);

  assert.deepEqual(kicked, ['nuker2'], 'persisted burst still reaches the guard threshold');
  assert.equal(repo.lastIncident('gnuke2').count, 3);
  assert.equal(repo.listNukeRecent('gnuke2', 'nuker2', 0).length, 0, 'burst state clears after response');
});

test('antinuke: sliding window drops old actions', () => {
  const t0 = 1_000_000;
  assert.equal(antinuke.slide('w', 10_000, 1, null, t0).total, 1);
  assert.equal(antinuke.slide('w', 10_000, 1, null, t0 + 5_000).total, 2);
  assert.equal(antinuke.slide('w', 10_000, 1, null, t0 + 20_000).total, 1);
});

test('antinuke: classification of guild update, vanity and permission escalation', () => {
  const { guild } = fakeGuild();
  const keys = (e) => antinuke.classify(e, guild).map((x) => x.key);
  assert.deepEqual(keys({ action: AuditLogEvent.GuildUpdate, changes: [{ key: 'name' }] }), ['guildUpdate']);
  assert.deepEqual(keys({ action: AuditLogEvent.GuildUpdate, changes: [{ key: 'vanity_url_code' }] }), ['vanityChange']);
  assert.deepEqual(keys({ action: AuditLogEvent.RoleUpdate, changes: [{ key: 'name' }] }), ['roleUpdate']);
  assert.deepEqual(keys({ action: AuditLogEvent.RoleUpdate, changes: [{ key: 'permissions', old: '0', new: '8' }] }).sort(), ['permEscalation', 'roleUpdate']);
  assert.deepEqual(keys({ action: AuditLogEvent.RoleUpdate, changes: [{ key: 'permissions', old: '8', new: '0' }] }), ['roleUpdate']);
  assert.deepEqual(keys({ action: AuditLogEvent.MessageBulkDelete, extra: { count: 40 } }), ['massDelete']);
});

test('raid: level thresholds', () => {
  const cfg = { elevated_joins: 5, high_joins: 10, lockdown_joins: 20 };
  assert.equal(raid.levelFor(cfg, 4), 'NORMAL');
  assert.equal(raid.levelFor(cfg, 5), 'ELEVATED');
  assert.equal(raid.levelFor(cfg, 10), 'HIGH');
  assert.equal(raid.levelFor(cfg, 25), 'LOCKDOWN');
});

test('raid: join history and detection counters persist', () => {
  repo.addJoin('gr', 'a', Date.now(), 0, true); repo.addJoin('gr', 'b', Date.now(), 0, false);
  const c = repo.countJoins('gr', Date.now() - 10_000);
  assert.equal(c.c, 2); assert.equal(c.s, 1);
});

test('helpers: duration parsing', () => {
  assert.equal(helpers.parseDuration('10m'), 600);
  assert.equal(helpers.parseDuration('1h30m'), 5400);
  assert.equal(helpers.parseDuration('2d'), 172800);
  assert.equal(helpers.parseDuration('abc'), null);
  assert.equal(helpers.parseDuration('10x'), null);
  assert.equal(helpers.formatDuration(5400), '1h 30m');
  assert.deepEqual(helpers.parseIds('1234567890123456789, 1234567890123456789 22345678901234567'), ['1234567890123456789', '22345678901234567']);
});

test('helpers: watching presence text', () => {
  assert.equal(helpers.presenceName(0), '0 users');
  assert.equal(helpers.presenceName(1), '1 user');
  assert.equal(helpers.presenceName(1234), '1,234 users');
});

test('prefix: per-guild setting with a default', () => {
  assert.equal(repo.getGuild('gp').prefix, '!');
  repo.setGuild('gp', 'prefix', '?');
  assert.equal(repo.getGuild('gp').prefix, '?');
  assert.equal(repo.getGuild('gq').prefix, '!', 'other guilds keep the default');
});

const defsOf = (name, sub) => {
  const json = commands.get(name).data.toJSON();
  return sub ? json.options.find((o) => o.name === sub).options : json.options;
};

const textGuild = {
  id: 'gtext',
  ownerId: 'owner',
  members: {
    cache: new Map([['111111111111111111', {
      id: '111111111111111111',
      user: { id: '111111111111111111', bot: false, tag: 'user#0001', username: 'user' },
      displayName: 'user', roles: { cache: new Map() },
    }]]),
    fetch: async (id) => textGuild.members.cache.get(id) || null,
  },
  roles: { cache: new Map([['222222222222222222', { id: '222222222222222222', name: 'Moderators' }]]), fetch: async () => null },
  channels: { cache: new Map([['333333333333333333', { id: '333333333333333333', name: 'logs' }]]), fetch: async () => null },
};
const textMessage = { guild: textGuild, client: { users: { cache: new Map(), fetch: async () => null } } };

test('text commands: tokenizer and typed positional options', async () => {
  assert.deepEqual(text.tokenize('@user reason:"spam and eggs"'), ['@user', 'reason:spam and eggs']);

  const ban = await text.parseOptions(textMessage, defsOf('ban'), text.tokenize('<@111111111111111111> spam and eggs 7'));
  assert.equal(ban.values.user.user.id, '111111111111111111');
  assert.equal(ban.values.reason, 'spam and eggs');
  assert.equal(ban.values.delete_days, 7);

  const banName = await text.parseOptions(textMessage, defsOf('ban'), text.tokenize('user spam'));
  assert.equal(banName.values.user.user.id, '111111111111111111', 'required user option accepts a plain name');
  assert.equal(banName.values.reason, 'spam');

  const roleName = await text.parseOptions(textMessage, defsOf('role', 'add'), text.tokenize('user Moderators'));
  assert.equal(roleName.values.user.user.id, '111111111111111111');
  assert.equal(roleName.values.role.role.id, '222222222222222222');

  const logsName = await text.parseOptions(textMessage, defsOf('logs', 'set'), text.tokenize('antinuke logs'));
  assert.equal(logsName.values.type, 'antinuke');
  assert.equal(logsName.values.channel.channel.id, '333333333333333333');

  const help = await text.parseOptions(textMessage, defsOf('help'), text.tokenize('ban'));
  assert.equal(help.values.command, 'ban', 'non-choice command falls through from category');
  const helpCat = await text.parseOptions(textMessage, defsOf('help'), text.tokenize('moderation'));
  assert.equal(helpCat.values.category, 'moderation');

  const wl = await text.parseOptions(textMessage, defsOf('whitelist', 'add'), text.tokenize('<@111111111111111111> trusted_mod pings, channel-create'));
  assert.equal(wl.values.user.user.id, '111111111111111111');
  assert.equal(wl.values.level, 'trusted_mod');
  assert.equal(wl.values.scopes, 'pings, channel-create');

  const role = await text.parseOptions(textMessage, defsOf('role', 'add'), text.tokenize('<@111111111111111111> <@&222222222222222222> promod'));
  assert.equal(role.values.user.user.id, '111111111111111111');
  assert.equal(role.values.role.role.id, '222222222222222222');
  assert.equal(role.values.reason, 'promod');

  const logs = await text.parseOptions(textMessage, defsOf('logs', 'set'), text.tokenize('antinuke <#333333333333333333>'));
  assert.equal(logs.values.type, 'antinuke');
  assert.equal(logs.values.channel.channel.id, '333333333333333333');

  const unban = await text.parseOptions(textMessage, defsOf('unban'), text.tokenize('<@111111111111111111> appeal'));
  assert.equal(unban.values.user_id, '111111111111111111');
  assert.equal(unban.values.reason, 'appeal');

  const mass = await text.parseOptions(textMessage, defsOf('massban'), text.tokenize('<@111111111111111111> 222222222222222222 spam and eggs'));
  assert.equal(mass.values.ids, '111111111111111111 222222222222222222');
  assert.equal(mass.values.reason, 'spam and eggs');

  assert.equal(text.usage('k', 'ban', null, defsOf('ban')), 'kban <user> [reason] [delete_days]');
});

test('text commands: khelp and kping reply publicly with V2 payloads', async () => {
  const { guild, addMember } = fakeGuild({ id: 'gtextcmd', ownerId: 'owner' });
  const member = addMember('owner');
  member.permissions = { has: () => true };
  const client = {
    commands,
    users: { cache: new Map(), fetch: async () => null },
    ws: { ping: 42, shards: { size: 1 } },
    user: { id: 'kurisu', displayAvatarURL: () => 'https://example.com/a.png' },
    guilds: { cache: new Map([[guild.id, guild]]) },
  };
  guild.client = client;
  const sent = [];
  const message = {
    guild, member, client, content: 'khelp',
    author: { id: 'owner', bot: false, tag: 'owner#0001', username: 'owner' },
    channel: { id: 'c1', name: 'general', permissionsFor: () => ({ has: () => true }) },
    reply: async (payload) => { sent.push(payload); return { edit: async () => {} }; },
  };
  repo.setGuild(guild.id, 'prefix', 'k');
  text.clearPrefix(guild.id);

  assert.equal(await text.handle(message, client), true);
  assert.equal(sent.length, 1);
  assert.ok(Number(sent[0].flags) & MessageFlags.IsComponentsV2);
  assert.equal(Number(sent[0].flags) & MessageFlags.Ephemeral, 0, 'text replies cannot be ephemeral');

  sent.length = 0; message.content = 'kping';
  assert.equal(await text.handle(message, client), true);
  assert.equal(sent.length, 1);
  assert.ok(Number(sent[0].flags) & MessageFlags.IsComponentsV2);

  sent.length = 0; message.content = 'kinda';
  assert.equal(await text.handle(message, client), false, 'unknown words starting with the prefix are ignored');
  assert.equal(sent.length, 0);

  sent.length = 0; message.content = 'kprefix';
  assert.equal(await text.handle(message, client), true);
  assert.equal(sent.length, 1);

  repo.setGuild(guild.id, 'prefix', '!');
  text.clearPrefix(guild.id);
});

test('commands: all required slash commands exist', () => {
  const required = ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'warnings', 'purge', 'clear', 'slowmode', 'lock', 'unlock', 'hide', 'unhide', 'nickname', 'role', 'softban', 'massban', 'masskick', 'case', 'banlist', 'whitelist', 'security', 'antinuke', 'incidents', 'watchlist', 'guilds', 'prefix', 'help', 'ping', 'serverinfo', 'userinfo'];
  for (const r of required) assert.ok(commands.has(r), `missing /${r}`);
  const wl = commands.get('whitelist').data.toJSON().options.map((o) => o.name).sort();
  assert.deepEqual(wl, ['add', 'check', 'list', 'remove']);
  const role = commands.get('role').data.toJSON().options.map((o) => o.name).sort();
  assert.deepEqual(role, ['add', 'remove']);
  const antinukeSubs = commands.get('antinuke').data.toJSON().options.map((o) => o.name).sort();
  assert.deepEqual(antinukeSubs, ['disable', 'enable', 'status']);
  const caseSubs = commands.get('case').data.toJSON().options.map((o) => o.name).sort();
  assert.deepEqual(caseSubs, ['user', 'view']);
  const watchSubs = commands.get('watchlist').data.toJSON().options.map((o) => o.name).sort();
  assert.deepEqual(watchSubs, ['add', 'list', 'remove']);
});

test('guilds: owner-only network overview with totals and per-server counts', async () => {
  const cmd = commands.get('guilds');
  const rows = [
    { id: '111111111111111111', name: 'Alpha', members: 1200, active: 80 },
    { id: '222222222222222222', name: 'Beta', members: 300, active: 12 },
  ];
  const text = cmd.render({ at: Date.now(), rows, totals: { servers: 2, members: 1500, active: 92 } }, 0, 'botowner')
    .filter((x) => typeof x === 'string').join('\n');
  assert.match(text, /KURISU NETWORK/);
  assert.match(text, /Servers\s+\*\*2\*\*/);
  assert.match(text, /Active Users\s+\*\*92\*\*/);
  assert.match(text, /Total Members\s+\*\*1,500\*\*/);
  assert.match(text, /Alpha/);
  assert.match(text, /1,200 members/);

  assert.match(JSON.stringify(cmd.render({ at: Date.now(), rows, totals: { servers: 2, members: 1500, active: 92 } }, 0, 'botowner')), /kg:botowner:r:0/);

  const denied = fakeInteraction({ customId: 'guilds', user: { id: 'rando' } });
  await cmd.execute(denied);
  assert.ok(denied.calls.replied);
  assert.ok(JSON.stringify(denied.calls.replied).includes('Only the bot owner'));
});

test('guilds: component acknowledges before refreshing and keeps its page', async () => {
  const cmd = commands.get('guilds');
  const calls = { deferred: false, edited: null };
  const interaction = {
    customId: 'kg:botowner:r:0',
    user: { id: 'botowner' },
    client: { guilds: { cache: new Map() } },
    deferUpdate: async () => { calls.deferred = true; },
    editReply: async (payload) => { calls.edited = payload; },
    reply: async (payload) => { calls.edited = payload; },
  };
  await cmd.component(interaction);
  assert.equal(calls.deferred, true, 'component ACK happens before the network fetch');
  assert.match(JSON.stringify(calls.edited), /KURISU NETWORK/);
  assert.match(JSON.stringify(calls.edited), /kg:botowner:r:0/);
});

test('help: generated from real command definitions, covers every command', () => {
  const entries = help.collect(commands);
  for (const [name, cmd] of commands) {
    const subs = cmd.data.toJSON().options.filter((o) => o.type === 1);
    if (subs.length) for (const s of subs) assert.ok(entries.some((e) => e.key === `${name}.${s.name}`), `${name} ${s.name} missing from help`);
    else assert.ok(entries.some((e) => e.key === name), `${name} missing from help`);
  }
  for (const e of entries) assert.ok(help.CATEGORIES[e.category], `${e.key} has unknown category ${e.category}`);
  const ban = entries.find((e) => e.key === 'ban');
  assert.match(help.detailView('1', entries, 'ban', 'moderation', 0).join('\n'), /USAGE[\s\S]*\/ban user:<member> reason:<text>/);

  const custom = help.collect(commands, '?');
  const customBan = custom.find((e) => e.key === 'ban');
  assert.equal(customBan.textExample, '?ban user:@member reason:Spam');
  assert.match(help.detailView('1', custom, 'ban', 'moderation', 0, '?').join('\n'), /TEXT EXAMPLE[\s\S]*\?ban/);
  assert.match(help.mainView('1', '?').join('\n'), /Text prefix: `\?`/);
});

test('UI: Components V2, grey buttons only, no accent colour, valid payloads', () => {
  const entries = help.collect(commands);
  const g = { id: 'g1', ownerId: 'owner', client: { user: { id: 'kurisu' } } };
  const views = [help.mainView('1'), ...Object.keys(help.CATEGORIES).map((c) => help.categoryView('1', entries, c, 0)),
    ...entries.map((e) => help.detailView('1', entries, e.key, e.category, 0)),
    ...['main', 'prot', 'wl:bypass', 'logs:0', 'set', 'set:antinuke', 'raid', ...KEYS.map((k) => `mod:${k}`)].map((r) => dashboard.route(g, r))];
  for (const v of views) {
    const payload = ui.edit(v);
    const json = payload.components[0].toJSON();
    assert.equal(json.type, 17);
    assert.equal(json.accent_color, undefined, 'no accent colour');
    for (const node of walk(json)) {
      if (node.type === 2) assert.equal(node.style, 2, 'only secondary buttons');
      if (node.type === 3) assert.ok(node.options.length <= 25);
    }
    assert.ok(Number(payload.flags) & (1 << 15), 'IsComponentsV2 flag');
  }
});

test('UI: dashboard shows real database values', () => {
  const g = { id: 'gd', ownerId: 'owner', client: { user: { id: 'kurisu' } } };
  repo.addWhitelist('gd', 'u1', 'bypass', 'owner'); repo.addWhitelist('gd', 'u2', 'bypass', 'owner');
  repo.addIncident('gd', { executorId: 'x', module: 'massBan', action: 'Member Ban Add', count: 3, threshold: 3, response: 'Banned', status: 'Neutralized' });
  repo.saveModule('gd', 'massBan', { enabled: false, threshold: 3, window_sec: 15, punishment: 'ban' });
  const text = dashboard.main(g).filter((x) => typeof x === 'string').join('\n');
  assert.match(text, /KURISU SECURITY CENTER/);
  assert.match(text, /Protection Modules\s+\*\*27 \/ 28\*\*/);
  assert.match(text, /Whitelist Entries\s+\*\*2\*\*/);
  assert.match(text, /Security Incidents\s+\*\*1\*\*/);
});

const fakeInteraction = (over = {}) => {
  const calls = { updated: null, replied: null };
  return {
    calls,
    customId: 'ks:v:main', guild: { id: 'gi', ownerId: 'owner', client: { user: { id: 'kurisu' } }, channels: { cache: new Map() } },
    member: { id: 'rando', permissions: { has: () => true } }, user: { id: 'rando' }, values: [],
    isFromMessage: () => false, isMessageComponent: () => true,
    update: async (p) => { calls.updated = p; }, reply: async (p) => { calls.replied = p; },
    ...over,
  };
};

test('dashboard: protection modules paginate and keep the page', async () => {
  const g = { id: 'gp', ownerId: 'owner', client: { user: { id: 'kurisu' } }, channels: { cache: new Map() } };
  const p2 = dashboard.protection(g, 1).filter((x) => typeof x === 'string').join('\n');
  assert.match(p2, /page 2\/3/);
  assert.ok(JSON.stringify(ui.edit(dashboard.protection(g, 1))).includes('ks:pick:1'));

  const owner = { id: 'owner', permissions: { has: () => true } };
  const pick = fakeInteraction({ customId: 'ks:pick:1', member: owner, user: owner, guild: g, values: [KEYS[10]] });
  await dashboard.handle(pick);
  assert.ok(pick.calls.updated);
  assert.ok(JSON.stringify(pick.calls.updated).includes('ks:v:prot:1'), 'module view keeps its page for Back');
});

test('antinuke: status view is grouped into clean sections', () => {
  repo.ensureGuild('ga');
  const text = commands.get('antinuke').statusView({ id: 'ga', ownerId: 'owner', client: { user: { id: 'kurisu' } } })
    .filter((x) => typeof x === 'string').join('\n');
  assert.match(text, /\*\*Status\*\*/);
  assert.match(text, /\*\*Modules\*\*/);
  assert.match(text, /\*\*Nuke Guard\*\*/);
  assert.match(text, /\*\*Nuke Watch\*\*/);
  assert.match(text, /\*\*Incidents \(24h\)\*\*/);
});

test('dashboard: settings lists only configured log channels and names the rest', () => {
  const g = { id: 'gset', ownerId: 'owner', client: { user: { id: 'kurisu' } } };
  repo.ensureGuild('gset');
  repo.setLogChannel('gset', 'antinuke', 'c1');
  const view = dashboard.settings(g).filter((x) => typeof x === 'string').join('\n');
  assert.match(view, /Log Channels\*\*\s+·\s+1 \/ 9 configured/);
  assert.match(view, /Antinuke\s+·\s+<#c1>/);
  assert.match(view, /Not set: Raid/);
  repo.setLogChannel('gset', 'antinuke', null);
});

test('authorization: dashboard rejects unauthorised users on every interaction type', async () => {
  for (const id of ['ks:v:main', 'ks:tog:massBan', 'ks:pun:massBan', 'ks:master:antinuke', 'ks:lclr:antinuke', 'ks:v:raid']) {
    const i = fakeInteraction({ customId: id, values: ['ban'] });
    await dashboard.handle(i);
    assert.ok(i.calls.replied, `${id} should be refused`);
    assert.equal(i.calls.updated, null, `${id} must not update`);
  }
  assert.equal(repo.getModule('gi', 'massBan', MODULES).enabled, 1, 'config unchanged');
});

test('authorization: owner can configure and changes persist', async () => {
  const owner = { id: 'owner', permissions: { has: () => true } };
  const i = fakeInteraction({ customId: 'ks:tog:massBan', member: owner, user: owner });
  await dashboard.handle(i);
  assert.ok(i.calls.updated);
  assert.equal(repo.getModule('gi', 'massBan', MODULES).enabled, 0);
  const p = fakeInteraction({ customId: 'ks:pun:massBan', member: owner, user: owner, values: ['kick'] });
  await dashboard.handle(p);
  assert.equal(repo.getModule('gi', 'massBan', MODULES).punishment, 'kick');
  const bad = fakeInteraction({ customId: 'ks:pun:massBan', member: owner, user: owner, values: ['nuke'] });
  await dashboard.handle(bad);
  assert.equal(repo.getModule('gi', 'massBan', MODULES).punishment, 'kick', 'invalid punishment rejected');
});

test('authorization: scoped role whitelist via dashboard', async () => {
  const owner = { id: 'owner', permissions: { has: () => true } };
  const role = { id: 'roleDash', name: 'Moderators' };
  const gw = { id: 'gw', ownerId: 'owner', client: { user: { id: 'kurisu' } }, channels: { cache: new Map() } };
  const mask = maskForScopes(['channelCreate']);
  const add = fakeInteraction({
    customId: `ks:wladdr:trusted_mod:${maskId(mask)}`, member: owner, user: owner, guild: gw,
    roles: { first: () => role },
  });
  await dashboard.handle(add);
  assert.ok(add.calls.updated, 'dashboard should update after adding a role');
  const entry = repo.getWhitelist('gw', 'roleDash');
  assert.equal(entry.target_type, 'role');
  assert.deepEqual(JSON.parse(entry.scopes), ['channelCreate']);

  const remove = fakeInteraction({
    customId: 'ks:wlrmr:trusted_mod:0', member: owner, user: owner, guild: gw,
    roles: { first: () => role },
  });
  await dashboard.handle(remove);
  assert.ok(remove.calls.updated, 'dashboard should update after removing a role');
  assert.equal(repo.getWhitelist('gw', 'roleDash'), undefined);
});

test('dashboard: whitelist scope chunks preserve the other chunk', async () => {
  const owner = { id: 'owner', permissions: { has: () => true } };
  const gw = { id: 'gw2', ownerId: 'owner', client: { user: { id: 'kurisu' } }, channels: { cache: new Map() } };
  const base = fakeInteraction({ member: owner, user: owner, guild: gw });

  // From "all modules", narrowing the second chunk must keep the first chunk selected.
  const kept = KEYS.slice(0, 23).concat('threadDelete');
  const narrowed = { ...base, customId: `ks:wlsc:trusted_mod:${maskId(ALL_MASK)}:1`, values: ['threadDelete'] };
  await dashboard.handle(narrowed);
  assert.ok(narrowed.calls.updated);
  assert.ok(JSON.stringify(narrowed.calls.updated).includes(`ks:wladd:trusted_mod:${maskId(maskForScopes(kept))}`));

  // A pre-selected "Level default" must not override module picks in the same submit.
  const withDefault = { ...base, customId: `ks:wlsc:trusted_mod:${maskId(0n)}:0`, values: ['default', 'channelCreate'] };
  await dashboard.handle(withDefault);
  assert.ok(JSON.stringify(withDefault.calls.updated).includes(`ks:wladd:trusted_mod:${maskId(maskForScopes(['channelCreate']))}`));
});

test('authorization: help menu belongs to the user who opened it', async () => {
  const client = { commands };
  const other = fakeInteraction({ customId: 'kh:111:main', user: { id: '222' }, client });
  await help.handle(other);
  assert.ok(other.calls.replied); assert.equal(other.calls.updated, null);
  const mine = fakeInteraction({ customId: 'kh:111:cat:moderation:0', user: { id: '111' }, client });
  await help.handle(mine);
  assert.ok(mine.calls.updated);
});

test('UI: every view fits Discord Components V2 limits', () => {
  const entries = help.collect(commands);
  const g = { id: 'gl', ownerId: 'owner', client: { user: { id: 'kurisu' } } };
  const guildRows = Array.from({ length: 10 }, (_, n) => ({ id: `${n}`.padStart(18, '0'), name: `Guild ${n}`, members: 1000 - n, active: n }));
  const views = [help.mainView('1'), ...Object.keys(help.CATEGORIES).flatMap((c) => [0, 1].map((p) => help.categoryView('1', entries, c, p))),
    ...['main', 'prot', 'wl:bypass', 'logs:0', 'set', 'set:antinuke', 'raid'].map((r) => dashboard.route(g, r)),
    commands.get('guilds').render({ at: Date.now(), rows: guildRows, totals: { servers: 10, members: 9955, active: 45 } }, 0, '1')];
  for (const v of views) {
    const nodes = walk(ui.edit(v).components[0].toJSON());
    assert.ok(nodes.filter((x) => typeof x.type === 'number' && x.type <= 20).length <= 40, 'max 40 components');
    assert.ok(nodes.filter((x) => x.type === 10).reduce((a, x) => a + x.content.length, 0) <= 4000, 'max 4000 text chars');
  }
});
