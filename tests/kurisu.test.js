'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AuditLogEvent, MessageFlags, PermissionsBitField, ChannelType, GuildVerificationLevel, Collection,
} = require('discord.js');
const { fakeGuild, walk } = require('./helpers');

process.env.OWNER_IDS = 'botowner';
const db = require('../src/database');
db.open(':memory:');
const repo = require('../src/database/repo');
const perms = require('../src/permissions');
const antinuke = require('../src/engines/antinuke');
const { MODULES, KEYS } = require('../src/engines/antinuke/modules');
const raid = require('../src/engines/raid');
const recovery = require('../src/engines/recovery');
const { DANGEROUS_BITS } = require('../src/config/settings');
const { EMOJIS, parseEmoji } = require('../src/config/emojis');
const { ALL_MASK, SCOPE_PRESETS, maskForScopes, maskId, parseMask, parseScopes, scopesForMask } = require('../src/config/whitelist');
const helpers = require('../src/utils/helpers');
const ui = require('../src/components/common/ui');
const help = require('../src/components/help');
const dashboard = require('../src/components/dashboard');
const commands = require('../src/commands').load();
const text = require('../src/text');

// ---------------------------------------------------------------------------
// Shared mock helpers. Declared before any test so no test callback hits the
// temporal dead zone of a `const` helper defined further down the file.
// ---------------------------------------------------------------------------
/** Dashboard interaction: a random member unless overridden. */
const dashInteraction = (over = {}) => {
  const calls = { updated: null, replied: null };
  return {
    calls,
    customId: 'ks:v:main',
    guild: { id: 'gi', ownerId: 'owner', client: { user: { id: 'kurisu' } }, channels: { cache: new Map() } },
    member: { id: 'rando', permissions: { has: () => true } }, user: { id: 'rando' }, values: [],
    isFromMessage: () => false, isMessageComponent: () => true,
    update: async (p) => { calls.updated = p; }, reply: async (p) => { calls.replied = p; },
    ...over,
  };
};
const plainText = (payload) => JSON.stringify(payload ?? '');
/** Scopes staged in every ks:wladd / ks:wladdr id of a rendered payload. */
const stagedScopes = (payload) => walk(payload.components[0].toJSON())
  .flatMap((n) => (n.custom_id ? [n.custom_id] : []))
  .filter((id) => id.startsWith('ks:wladd:') || id.startsWith('ks:wladdr:'))
  // ks:wladd:<level>:<mask>[:<page>] and ks:wladdr:<level>:<mask>[:<page>]
  .map((id) => scopesForMask(parseMask(id.split(':')[3])) || [])
  .flat();
function fakeMember(perms = 0n, over = {}) {
  const bits = BigInt(perms); // never hand a PermissionsBitField constant to the constructor
  return {
    id: 'mod', permissions: new PermissionsBitField(bits), memberPermissions: new PermissionsBitField(bits),
    roles: { highest: { position: 9, id: 'rmod' }, cache: new Map() },
    guild: over.guild, kick: async () => {}, timeout: async () => {},
    ...over,
  };
}
const chatInput = (over = {}) => ({
  inGuild: () => true, guild: over.guild, user: { id: 'mod', tag: 'mod#0001' }, member: over.member,
  deferred: false, replied: false,
  reply: async (p) => { over.sink.replied = p; }, deferReply: async () => { over.deferred = true; },
  editReply: async (p) => { over.sink.edited = p; },
  ...over,
});

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
  assert.match(text, /27 of 28 modules armed\s+·\s+1 off/);
  assert.match(text, /Whitelist\s+·\s+\*\*2\*\*/);
  assert.match(text, /Incidents\s+·\s+\*\*1\*\*/);
});

const mainText = (id) => dashboard.main({ id, ownerId: 'owner', client: { user: { id: 'kurisu' } } })
  .filter((x) => typeof x === 'string').join('\n');

test('UI: security center leads with one verdict, not repeated status lines', () => {
  const healthy = mainText('gm1');
  assert.match(healthy, /All 28 modules armed/, 'all-on is a positive verdict');
  assert.equal((healthy.match(/\*\*On\*\*/g) || []).length, 1, 'antinuke is stated once');
  assert.ok(!/Security Rules/.test(healthy), 'the ambiguous "Security Rules" line is gone');
  assert.ok(!/28 \/ 28/.test(healthy), 'no padded x / x counters');
  assert.match(healthy, /\*\*Nuke Watch\*\*\s+·\s+\*\*0\*\* executors/);
  assert.match(healthy, /\*\*Last Incident\*\*\s+·\s+None yet/);

  repo.saveModule('gm1', 'massBan', { enabled: false, threshold: 3, window_sec: 15, punishment: 'ban' });
  assert.match(mainText('gm1'), /27 of 28 modules armed\s+·\s+1 off/, 'partial protection warns');

  repo.setGuild('gm1', 'antinuke_enabled', 0);
  assert.match(mainText('gm1'), /\*\*Antinuke is off\*\* - this server is unprotected/, 'off is the loudest state');
});

test('UI: security center navigation is a full grid with no lone button', () => {
  const rows = dashboard.main({ id: 'gm2', ownerId: 'owner', client: { user: { id: 'kurisu' } } })
    .filter((x) => x && typeof x.toJSON === 'function')
    .map((row) => row.toJSON())
    .filter((row) => row.components?.some((c) => c.type === 2));
  assert.equal(rows.length, 3, 'three action rows');
  const labels = rows.map((row) => row.components.map((c) => c.label).join('+'));
  assert.deepEqual(labels, ['Protection+Whitelist', 'Security Logs+Settings', 'Diagnostics']);
  for (const row of rows) for (const c of row.components) assert.equal(c.style, 2, 'grey buttons only');
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
  assert.match(view, /Log Channels\*\*\s+·\s+\*\*1\/9\*\* configured/);
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

// ---------------------------------------------------------------------------
// Mocked interaction and engine coverage (P2 item 11)
// ---------------------------------------------------------------------------

test('banlist: renders bans and refuses other viewers', async () => {
  const cmd = commands.get('banlist');
  const guild = { id: 'b1', bans: { fetch: async () => new Map([['9', { user: { id: '9', username: 'bad' }, reason: 'raid' }]]) } };
  const text = cmd.render(guild, [{ user: { id: '9', username: 'bad' }, reason: 'raid' }], 0, 'v1')
    .filter((x) => typeof x === 'string').join('\n');
  assert.match(text, /BAN LIST/);
  assert.match(text, /bad/);
  assert.match(text, /raid/);

  const theirs = { customId: 'kb:someoneelse:0', user: { id: 'v1' }, memberPermissions: new PermissionsBitField(PermissionsBitField.Flags.BanMembers), reply: async (p) => { theirs._p = p; } };
  await cmd.component(theirs);
  assert.match(plainText(theirs._p), /not yours/);

  const mine = {
    customId: 'kb:v1:0', user: { id: 'v1' }, guild, memberPermissions: new PermissionsBitField(PermissionsBitField.Flags.BanMembers),
    deferred: false, deferUpdate: async () => { mine.deferred = true; }, editReply: async (p) => { mine.edited = p; },
    reply: async (p) => { mine.refused = p; },
  };
  await cmd.component(mine);
  assert.equal(mine.deferred, true);
  assert.match(plainText(mine.edited), /BAN LIST/);

  const denied = { customId: 'kb:v1:0', user: { id: 'v1' }, guild, memberPermissions: new PermissionsBitField(0n), reply: async (p) => { denied.refused = p; } };
  await cmd.component(denied);
  assert.match(plainText(denied.refused), /You need Ban Members/);
});

test('incidents: paginates for managers and refuses other users', async () => {
  const cmd = commands.get('incidents');
  const gw = { id: 'inc1', ownerId: 'owner', client: { user: { id: 'kurisu' } } };
  repo.addIncident('inc1', { executorId: 'x1', module: 'massBan', action: 'Member Ban Add', count: 3, threshold: 3, response: 'Banned', status: 'Neutralized' });
  const text = cmd.render(gw, 0, 'owner').filter((x) => typeof x === 'string').join('\n');
  assert.match(text, /SECURITY INCIDENTS/);
  assert.match(text, /1 incident/);

  const owner = { id: 'owner' };
  const upd = { customId: 'kn:owner:0', guild: gw, member: owner, user: owner, update: async (p) => { upd.p = p; }, reply: async (p) => { upd.p = p; } };
  await cmd.component(upd);
  assert.match(plainText(upd.p), /SECURITY INCIDENTS/);

  const other = { customId: 'kn:owner:0', guild: gw, member: owner, user: { id: 'intruder' }, reply: async (p) => { other.p = p; } };
  await cmd.component(other);
  assert.match(plainText(other.p), /not yours/);

  const stranger = { customId: 'kn:other:0', guild: gw, member: { id: 'stranger', permissions: new PermissionsBitField(0n) }, user: { id: 'other' }, reply: async (p) => { stranger.p = p; } };
  await cmd.component(stranger);
  assert.match(plainText(stranger.p), /not authorised/);
});

test('raid: lockdown locks channels, writes state and unlock restores them', async () => {
  const edited = [];
  const ch = (id, state) => ({
    id, type: ChannelType.GuildText, manageable: true,
    permissionOverwrites: {
      cache: state === 'neutral' ? new Map() : new Map([['g1', state === 'deny'
        ? { deny: new PermissionsBitField(PermissionsBitField.Flags.SendMessages), allow: new PermissionsBitField(0n) }
        : { deny: new PermissionsBitField(0n), allow: new PermissionsBitField(PermissionsBitField.Flags.SendMessages) }]]),
      edit: async (_role, patch) => { edited.push([id, patch.SendMessages]); },
    },
  });
  const { guild } = fakeGuild({
    id: 'grl',
    roles: { everyone: { id: 'g1' }, cache: new Map() },
    channels: { cache: new Map([['c1', ch('c1', 'neutral')], ['c2', ch('c2', 'deny')], ['c3', ch('c3', 'allow')]]) },
    verificationLevel: 0, features: [],
    setVerificationLevel: async (lvl) => { guild.verificationLevel = lvl; },
    disableInvites: async () => {},
  });

  const lock = await raid.lockdown(guild, 30, 'owner-id');
  assert.equal(lock.ok, true);
  assert.equal(lock.locked, 2, 'already-denied channel is skipped');
  assert.equal(repo.getRaid('grl').lockdown_active, 1);
  assert.deepEqual(repo.getLockedChannels('grl').map((r) => r.channel_id).sort(), ['__invites__', 'c1', 'c3']);
  assert.deepEqual(edited, [['c1', false], ['c3', false]]);
  assert.equal(guild.verificationLevel, GuildVerificationLevel.VeryHigh);

  assert.equal((await raid.lockdown(guild, 30, 'owner-id')).ok, false, 'second lockdown refused');

  const unlock = await raid.unlock(guild, 'owner-id');
  assert.equal(unlock.ok, true);
  const restored = new Map(edited.slice(2));
  assert.equal(restored.get('c1'), null, 'neutral channel restored to neutral');
  assert.equal(restored.get('c3'), true, 'allowed channel restored to allowed');
  assert.equal(repo.getRaid('grl').lockdown_active, 0);
  assert.equal(repo.getLockedChannels('grl').length, 0);
  assert.equal((await raid.unlock(guild, 'owner-id')).ok, false, 'nothing left to unlock');
});

test('raid command: status, lockdown and unlock through the command', async () => {
  const cmd = commands.get('raid');
  const { guild } = fakeGuild({
    id: 'grc', roles: { everyone: { id: 'g1' }, cache: new Map() }, channels: { cache: new Map() },
    verificationLevel: 0, features: [], setVerificationLevel: async () => {}, disableInvites: async () => {},
  });
  const member = fakeMember(PermissionsBitField.Flags.Administrator, { guild });
  const sink = {};
  guild.ownerId = 'mod';
  const opts = { sub: 'status', minutes: 30 };
  const i = chatInput({
    guild, member, sink,
    options: { getSubcommand: () => opts.sub, getInteger: () => opts.minutes },
  });
  await cmd.execute(i);
  assert.match(plainText(sink.replied), /RAID PROTECTION/);
  assert.match(plainText(sink.replied), /NORMAL/);

  opts.sub = 'lockdown';
  await cmd.execute(i);
  assert.equal(repo.getRaid('grc').lockdown_active, 1);
  assert.match(plainText(sink.edited), /Lockdown enabled/);

  opts.sub = 'unlock';
  await cmd.execute(i);
  assert.equal(repo.getRaid('grc').lockdown_active, 0);
  assert.match(plainText(sink.edited), /Lockdown ended/);

  guild.ownerId = 'someone-else'; // not the caller, who is a plain moderator
  const denied = chatInput({ guild, member: fakeMember(0n, { guild }), sink: {}, options: { getSubcommand: () => 'status' } });
  await commands.get('raid').execute(denied);
  assert.match(plainText(denied.sink.replied), /Only the server owner/);
  guild.ownerId = 'mod';
});

test('verification command: enable, status and disable', async () => {
  const cmd = commands.get('verification');
  const { guild } = fakeGuild({
    id: 'gvf', roles: { everyone: { id: 'g1' }, cache: new Map() }, channels: { cache: new Map() },
    verificationLevel: 0, setVerificationLevel: async (lvl) => { guild.verificationLevel = lvl; },
  });
  guild.ownerId = 'mod';
  const member = fakeMember(PermissionsBitField.Flags.Administrator, { guild });
  const opts = { sub: 'enable' };
  const i = chatInput({ guild, member, sink: {}, options: { getSubcommand: () => opts.sub } });

  await cmd.execute(i);
  assert.equal(repo.getRaid('gvf').verification_active, 1);
  assert.equal(guild.verificationLevel, GuildVerificationLevel.High);

  opts.sub = 'status';
  await cmd.execute(i);
  assert.match(plainText(i.sink.replied), /Verification mode is \*\*on\*\*/);

  opts.sub = 'disable';
  await cmd.execute(i);
  assert.equal(repo.getRaid('gvf').verification_active, 0);
  assert.equal(guild.verificationLevel, 0, 'previous level restored');
});

test('recovery: deleted channels and roles are snapshotted and restored without dangerous permissions', async () => {
  const events = [];
  const overwrite = (id, allow, deny = 0n) => ({ id, type: 0, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
  const source = {
    id: 'c1', name: 'general', guild: { id: 'grec' }, isThread: () => false, type: ChannelType.GuildText,
    parentId: null, rawPosition: 2, topic: 'hello', nsfw: false, rateLimitPerUser: 0,
    permissionOverwrites: { cache: new Map([
      ['g1', overwrite('g1', PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Administrator)],
      ['ghost', overwrite('ghost', PermissionsBitField.Flags.SendMessages)],
    ]) },
  };
  const { guild } = fakeGuild({
    id: 'grec',
    roles: { everyone: { id: 'g1' }, cache: new Map([['g1', { id: 'g1', position: 0 }]]), create: async () => null },
    channels: {
      cache: new Map(), fetch: async () => null,
      create: async (opts) => {
        events.push(['channel', opts.name, opts.permissionOverwrites]);
        const created = { ...source, id: 'c2', guild };
        guild.channels.cache.set('c2', created);
        return created;
      },
    },
  });

  recovery.snapshotChannel(source);
  assert.equal(repo.getSnapshot('grec', 'channel', 'c1').data.name, 'general');
  assert.match(await recovery.restoreChannel(guild, 'c1'), /^restored/);
  assert.deepEqual(events[0].slice(0, 2), ['channel', 'general']);
  const own = events[0][2].find((o) => o.id === 'g1');
  assert.equal(own.allow & DANGEROUS_BITS, 0n, 'restored overwrites never regain dangerous permissions');
  assert.ok(!events[0][2].some((o) => o.id === 'ghost'), 'overwrites for missing roles are dropped');
  assert.equal(repo.getSnapshot('grec', 'channel', 'c1'), null, 'consumed snapshot is removed');
  assert.match(await recovery.restoreChannel(guild, 'missing'), /^skipped/);

  const roleSource = {
    id: 'r1', name: 'Moderators', guild, color: 0xED4245, hoist: false, mentionable: false, managed: false,
    position: 3, permissions: new PermissionsBitField(PermissionsBitField.Flags.BanMembers | PermissionsBitField.Flags.ManageChannels),
  };
  let createdRole = null;
  guild.roles.create = async (opts) => { createdRole = opts; return { id: 'r9', setPosition: async () => {} }; };
  recovery.snapshotRole(roleSource);
  assert.match(await recovery.restoreRole(guild, 'r1'), /^restored/);
  assert.equal(createdRole.name, 'Moderators');
  assert.equal(createdRole.permissions.bitfield & DANGEROUS_BITS, 0n, 'dangerous role permissions are withheld');

  const managed = { ...roleSource, id: 'r2', managed: true };
  recovery.snapshotRole(managed);
  assert.equal(repo.getSnapshot('grec', 'role', 'r2'), null, 'managed roles are never snapshotted');
});

test('recovery: webhooks, unapproved bots and invites are removed and recorded', async () => {
  const removed = { webhooks: 0, bots: 0, invites: 0 };
  const hook = { id: 'h1', delete: async () => { removed.webhooks++; } };
  const { guild } = fakeGuild({ id: 'gclean', members: { cache: new Map(), me: { id: 'kurisu' }, fetch: async () => null } });
  guild.fetchWebhooks = async () => new Map([['h1', hook], ['other', { delete: async () => { removed.webhooks += 10; } }]]);
  guild.members.fetch = async (id) => (id === 'bot1' ? { id, user: { id, bot: true }, kick: async () => { removed.bots++; } } : null);
  guild.invites = { fetch: async () => new Collection([
    ['i1', { inviterId: 'spammer', delete: async () => { removed.invites++; } }],
    ['i2', { inviterId: 'other', delete: async () => { removed.invites += 10; } }],
  ]) };

  assert.match(await recovery.deleteWebhook(guild, 'h1'), /^removed/);
  assert.match(await recovery.deleteWebhook(guild, 'gone'), /^skipped/);
  assert.match(await recovery.removeBot(guild, 'bot1'), /^removed/);
  assert.match(await recovery.deleteInvitesBy(guild, 'spammer'), /^removed/);
  assert.equal(removed.webhooks, 1, 'only the requested webhook is deleted');
  assert.equal(removed.bots, 1);
  assert.equal(removed.invites, 1, "only the spammer's invites are deleted");
});

// ---------------------------------------------------------------------------
// Whitelist scope redesign (P1 item 5)
// ---------------------------------------------------------------------------
// The dashboard's "preset pending" sentinel (mask -1).
const PRESET = -1n;
const wlGuild = { id: 'gwlz', ownerId: 'owner', client: { user: { id: 'kurisu' } }, channels: { cache: new Map() } };
const wlOwner = { id: 'owner', permissions: { has: () => true } };
const wlSelect = (customId, values = []) => dashInteraction({ customId, values, guild: wlGuild, member: wlOwner, user: wlOwner });

test('whitelist dashboard: presets stage a scope, custom scopes apply per page', async () => {
  const presets = wlSelect(`ks:wsp:trusted_mod:${maskId(PRESET)}`);
  await dashboard.handle(presets);
  const select = walk(presets.calls.updated.components[0].toJSON()).find((n) => n.type === 3 && n.custom_id?.startsWith('ks:wsp'));
  assert.ok(select, 'preset select is rendered');
  assert.equal(select.options.length, Object.keys(SCOPE_PRESETS).length + 1, 'every preset plus Custom modules');
  assert.ok(select.options.some((o) => o.label === 'Level default' && o.default), 'level default is the resting state');
  assert.ok(select.options.some((o) => o.value === 'custom'), 'custom modules entry exists');

  const channelCreate = KEYS.indexOf('channelCreate');
  const picked = wlSelect(`ks:wsp:trusted_mod:${maskId(maskForScopes(['channelCreate']))}`, ['channels']);
  await dashboard.handle(picked);
  assert.ok(plainText(picked.calls.updated).includes(`ks:wladd:trusted_mod:${maskId(maskForScopes(['channelCreate', 'channelDelete', 'channelUpdate']))}`),
    'picking a preset stages its modules for add/remove');

  // Custom page 1: select a module. It must survive a save and land on the add pickers.
  const custom = wlSelect(`ks:scl:trusted_mod:${maskId(PRESET)}:1`, ['channelCreate']);
  await dashboard.handle(custom);
  assert.ok(plainText(custom.calls.updated).includes(`ks:wsa:trusted_mod:${maskId(maskForScopes(['channelCreate']))}:1`), 'save button carries the selection');

  const saved = wlSelect(`ks:wsa:trusted_mod:${maskId(maskForScopes(['channelCreate']))}:1`);
  await dashboard.handle(saved);
  assert.ok(plainText(saved.calls.updated).includes(`ks:wladd:trusted_mod:${maskId(maskForScopes(['channelCreate']))}`), 'save returns to the grant page');
  assert.ok(channelCreate >= 0);

  // With a non-preset set staged, deselecting the whole of page 1 drops those
  // modules. Build the id from the rendered select so it uses the real encoding.
  const page1 = KEYS.slice(0, 10);
  // First 13 modules minus channelDelete: 12 modules, still matching no preset,
  // so the staged scope stays an explicit module set after page 1 is cleared.
  const start = maskForScopes(KEYS.slice(0, 13).filter((k) => k !== 'channelCreate'));
  // Use page 1's rendered picker (the page-2 default would select different modules).
  const sclId = walk(ui.edit(dashboard.route(wlGuild, `wl:trusted_mod:${maskId(start)}.1`)).components[0].toJSON())
    .find((n) => n.type === 3 && n.custom_id?.startsWith('ks:scl:')).custom_id;
  const cleared = wlSelect(sclId, []);
  await dashboard.handle(cleared);
  // The page's new state is exactly the submission, so page 2 must survive a
  // full deselect of page 1 (Discord omits unselected options from values).
  const saveId = walk(cleared.calls.updated.components[0].toJSON())
    .flatMap((n) => (n.custom_id ? [n.custom_id] : []))
    .find((id) => id.startsWith('ks:wsa:'));
  const staged = new Set(scopesForMask(parseMask(saveId.split(':')[3])) || []); // ks:wsa:<level>:<mask>:<page>
  for (const key of page1) assert.ok(!staged.has(key), `${key} was deselected`);
  assert.ok(staged.has(KEYS[10]) && staged.has(KEYS[11]), 'modules from later pages are kept');

  const all = wlSelect('ks:scl:trusted_mod:0:2', ['all']);
  await dashboard.handle(all);
  const saveAll = walk(all.calls.updated.components[0].toJSON())
    .flatMap((n) => (n.custom_id ? [n.custom_id] : []))
    .find((id) => id.startsWith('ks:wsa:'));
  assert.equal(parseMask(saveAll.split(':')[3]), ALL_MASK, '"all" saves every module');
});

test('whitelist dashboard: custom page keeps Save, navigation and a compact entry list', async () => {
  for (let n = 1; n <= 12; n++) repo.addWhitelist('gwlz', `entry${n}`, 'trusted_mod', 'owner');
  const view = dashboard.whitelistScopeView(wlGuild, 'trusted_mod', 0n, 1, { rows: [], list: '' });
  const text = view.filter((x) => typeof x === 'string').join('\n');
  assert.match(text, /CUSTOM SCOPES/);
  assert.match(text, /Page 1\/3/);
  const ids = walk(ui.edit(view).components[0].toJSON()).flatMap((n) => (n.custom_id ? [n.custom_id] : []));
  assert.ok(ids.includes('ks:wsa:trusted_mod:0:1'), 'Save');
  assert.ok(ids.includes('ks:wsc:trusted_mod:0'), 'Cancel');
  assert.ok(ids.includes('ks:scl:trusted_mod:0:1'), 'module picker');

  const grant = dashboard.whitelistView(wlGuild, 'trusted_mod', 0n, 0).filter((x) => typeof x === 'string').join('\n');
  assert.match(grant, /\+2 more/, 'grant page caps the visible entries');
  for (let n = 1; n <= 12; n++) repo.removeWhitelist('gwlz', `entry${n}`);
});

// ---------------------------------------------------------------------------
// Diagnostics view (P1 item 8)
// ---------------------------------------------------------------------------
const diagGuild = (over = {}) => {
  const { guild } = fakeGuild({
    id: 'gdiag',
    members: { cache: new Map(), fetch: async () => null, me: { id: 'kurisu', permissions: new PermissionsBitField(0n), roles: { highest: { position: 0 } } } },
    roles: { everyone: { id: 'gdiag' }, cache: new Map([['r1', { id: 'r1', position: 5 }]]) },
    ...over,
  });
  guild.client = { user: { id: 'kurisu' } };
  return guild;
};

test('diagnostics: missing permissions and a low role position are flagged', () => {
  const guild = diagGuild();
  const rows = dashboard.diagnostics.checks(guild);
  const by = (label) => rows.find((r) => r.label === label);
  assert.equal(by('Bot Permissions').level, 'bad');
  assert.match(by('Bot Permissions').value, /Ban/);
  assert.equal(by('Role Position').level, 'bad', 'position 1 is below other roles');
  assert.equal(by('Audit Log Access').level, 'warn', 'unverified by default');
  assert.match(dashboard.diagnostics.view(guild).filter((x) => typeof x === 'string').join('\n'), /DIAGNOSTICS/);
});

test('diagnostics: a setup bot passes, and audit-log access reflects the probe', async () => {
  const guild = diagGuild();
  guild.members.me = {
    id: 'kurisu',
    permissions: new PermissionsBitField(BigInt(PermissionsBitField.All)),
    roles: { highest: { position: 10 } },
  };
  guild.roles.cache.set('r2', { id: 'r2', position: 9 });
  const rows = dashboard.diagnostics.checks(guild, { audit: true });
  const by = (label) => rows.find((r) => r.label === label);
  assert.equal(by('Bot Permissions').level, 'ok');
  assert.equal(by('Role Position').level, 'ok');
  assert.equal(by('Audit Log Access').level, 'ok');
  assert.equal(by('Lockdown').level, 'ok');

  guild.fetchAuditLogs = async () => ({ entries: new Map() });
  assert.equal(await dashboard.diagnostics.probe(guild), true);
  guild.members.me.permissions = new PermissionsBitField(0n);
  assert.equal(await dashboard.diagnostics.probe(guild), false);
  guild.fetchAuditLogs = async () => { throw Object.assign(new Error('missing access'), { code: 50013 }); };
  guild.members.me.permissions = new PermissionsBitField(BigInt(PermissionsBitField.All));
  assert.equal(await dashboard.diagnostics.probe(guild), false);
});

test('authorization: diagnostics re-checks access on the interaction', async () => {
  const denied = dashInteraction({ customId: 'ks:v:diag' });
  await dashboard.handle(denied);
  assert.ok(denied.calls.replied);
  assert.equal(denied.calls.updated, null);

  const mine = dashInteraction({ customId: 'ks:v:diag', guild: diagGuild(), member: wlOwner, user: wlOwner });
  await dashboard.handle(mine);
  assert.match(plainText(mine.calls.updated), /DIAGNOSTICS/);
});
