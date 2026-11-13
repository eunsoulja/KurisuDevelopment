'use strict';
const { Events, ActivityType } = require('discord.js');
const repo = require('../database/repo');
const raid = require('../engines/raid');
const recovery = require('../engines/recovery');
const antinuke = require('../engines/antinuke');
const { validateEmojis } = require('../config/emojis');
const ui = require('../components/common/ui');
const help = require('../components/help');
const dashboard = require('../components/dashboard');
const confirm = require('../components/common/confirm');
const invite = require('../components/common/invite');
const warnings = require('../commands/moderation/warnings');
const incidents = require('../commands/security/incidents');
const banlist = require('../commands/moderation/banlist');
const guilds = require('../commands/utility/guilds');
const mentions = require('./mentions');
const text = require('../text');
const { deployCommands } = require('../utils/deploy');
const { describeError, presenceName } = require('../utils/helpers');
const log = require('../utils/logger');

const SNAPSHOT_EVERY = 10 * 60 * 1000;
const PRESENCE_EVERY = 2 * 60 * 1000;

/** A REST request that hit the client timeout (network hiccup, brief disconnect). */
const isTimeout = (err) => err?.name === 'AbortError' || err?.code === 20;

function totalUsers(client) {
  return client.guilds.cache.reduce((sum, guild) => sum + (guild.memberCount || 0), 0);
}

let presenceAt = 0;
/** Refresh at most once a minute, so join/leave bursts cannot spam the gateway. */
function queuePresence(client) {
  if (Date.now() - presenceAt < 60_000) return;
  refreshPresence(client);
}

/** "Watching <n> users" - refreshed periodically so it always reflects the real audience. */
function refreshPresence(client) {
  presenceAt = Date.now();
  if (!client.user) return;
  try {
    client.user.setPresence({
      status: 'online',
      activities: [{ name: presenceName(totalUsers(client)), type: ActivityType.Watching }],
    });
  } catch (err) { log.debug('presence update failed', err); }
}

function snapshotAll(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      // Do not capture state while an incident is fresh: it may be the attacker's state.
      if (repo.recentIncidentSince(guild.id, Date.now() - 15 * 60 * 1000)) continue;
      recovery.snapshotGuild(guild);
    } catch (err) { log.warn(`snapshot failed for ${guild.id}`, err); }
  }
}

async function safeReply(interaction, line) {
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(ui.edit([`${ui.E.redDot} ${line}`]));
    else await interaction.reply(ui.error(line));
  } catch (err) {
    // 10062/40060: interaction expired or already acknowledged. Aborts: the token is
    // still valid, but the network is not; a second failure has nothing left to report.
    if (![10062, 40060].includes(err.code) && !isTimeout(err)) log.warn('could not deliver error reply', err);
  }
}

const ROUTES = {
  kh: help.handle, ks: dashboard.handle, kc: confirm.handle, kw: warnings.component,
  ki: invite.handle, kn: incidents.component, kb: banlist.component, kg: guilds.component,
};

module.exports = [
  {
    name: Events.ClientReady, once: true,
    async execute(client) {
      log.info(`logged in as ${client.user.tag} in ${client.guilds.cache.size} guild(s)`);
      for (const g of client.guilds.cache.values()) repo.ensureGuild(g.id);
      const problems = await validateEmojis(client).catch((e) => [`validation failed: ${e.message}`]);
      if (problems.length) log.warn(`emoji registry problems (${problems.length})`, problems);
      else log.info('emoji registry validated');
      if (process.env.AUTO_DEPLOY === 'true') await deployCommands(client.commands).catch((e) => log.error('command deploy failed', e));
      refreshPresence(client);
      snapshotAll(client);
      client.timers = [
        setInterval(() => raid.tick(client).catch((e) => log.error('raid tick failed', e)), 30_000),
        setInterval(() => snapshotAll(client), SNAPSHOT_EVERY),
        setInterval(() => refreshPresence(client), PRESENCE_EVERY),
      ];
      await raid.tick(client).catch(() => {}); // resolves lockdowns that expired while offline
    },
  },
  { name: Events.GuildCreate, async execute(guild, client) { repo.ensureGuild(guild.id); try { recovery.snapshotGuild(guild); } catch (e) { log.warn('snapshot failed', e); } refreshPresence(client); } },
  { name: Events.GuildDelete, async execute(guild, client) { refreshPresence(client); } },
  {
    name: Events.InteractionCreate,
    async execute(interaction) {
      try {
        if (interaction.isChatInputCommand()) {
          const cmd = interaction.client.commands.get(interaction.commandName);
          if (!cmd) return safeReply(interaction, 'Unknown command.');
          return await cmd.execute(interaction);
        }
        if (interaction.isAutocomplete()) {
          const cmd = interaction.client.commands.get(interaction.commandName);
          return cmd?.autocomplete?.(interaction);
        }
        if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
          const handler = ROUTES[interaction.customId.split(':')[0]];
          if (handler) return await handler(interaction);
        }
      } catch (err) {
        if ([10062, 40060].includes(err.code)) return undefined; // expired / already acknowledged
        // REST aborts are transient network stalls, not bugs in the command. Log them
        // as a warning and tell the user to retry instead of dumping a stack trace.
        if (isTimeout(err)) {
          log.warn(`interaction timed out (${interaction.commandName || interaction.customId})`);
          return safeReply(interaction, 'Discord did not respond in time. Please try again.');
        }
        log.error(`interaction error (${interaction.commandName || interaction.customId})`, err);
        return safeReply(interaction, describeError(err));
      }
      return undefined;
    },
  },
  { name: Events.GuildAuditLogEntryCreate, async execute(entry, guild) { await antinuke.handleAuditEntry(entry, guild); } },
  {
    name: Events.MessageCreate,
    async execute(message) {
      await antinuke.handleMessage(message);
      const handled = await text.handle(message, message.client);
      if (!handled) await mentions.handle(message);
    },
  },
  { name: Events.GuildMemberAdd, async execute(member, client) {
    queuePresence(client);
    const banned = await antinuke.handleJoin(member);
    if (!banned) await raid.onJoin(member);
  } },
  { name: Events.GuildMemberRemove, async execute(member, client) { queuePresence(client); } },
  { name: Events.ChannelDelete, async execute(channel) { if (channel.guild) recovery.noteDeletedChannel(channel); } },
  { name: Events.GuildRoleDelete, async execute(role) { recovery.noteDeletedRole(role); } },
  { name: Events.Error, async execute(err) { log.error('client error', err); } },
  { name: Events.ShardDisconnect, async execute(ev, id) { log.warn(`shard ${id} disconnected`, { code: ev?.code }); } },
  { name: Events.ShardReconnecting, async execute(id) { log.info(`shard ${id} reconnecting`); } },
  { name: Events.ShardResume, async execute(id, replayed) { log.info(`shard ${id} resumed`, { replayed }); } },
];
