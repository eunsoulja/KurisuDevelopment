'use strict';
const { Events } = require('discord.js');
const logging = require('../engines/logging');
const { E } = require('../components/common/ui');

const t = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

// Log delivery is async (Mongo-backed channel config); handlers await logging.send.
module.exports = [
  { name: Events.GuildMemberAdd, async execute(m) {
    await logging.send(m.guild, 'member', `${E.redDot} MEMBER JOINED`, [`User: <@${m.id}>`, `Account created: ${t(m.user.createdTimestamp)}`]);
  } },
  { name: Events.GuildMemberRemove, async execute(m) {
    await logging.send(m.guild, 'member', `${E.smallRedDot} MEMBER LEFT`, [`User: <@${m.id}>`, `Joined: ${m.joinedTimestamp ? t(m.joinedTimestamp) : 'unknown'}`]);
  } },
  { name: Events.MessageDelete, async execute(msg) {
    if (!msg.guild || msg.author?.bot) return;
    await logging.send(msg.guild, 'message', `${E.smallRedDot} MESSAGE DELETED`, [`Author: ${msg.author ? `<@${msg.author.id}>` : 'unknown'}`, `Channel: <#${msg.channelId}>`, `Attachments: ${msg.attachments?.size || 0}`]);
  } },
  { name: Events.MessageUpdate, async execute(oldMsg, newMsg) {
    if (!newMsg.guild || newMsg.author?.bot || oldMsg.content === newMsg.content) return;
    await logging.send(newMsg.guild, 'message', `${E.smallRedDot} MESSAGE EDITED`, [`Author: <@${newMsg.author?.id}>`, `Channel: <#${newMsg.channelId}>`, `[Jump to message](${newMsg.url})`]);
  } },
  { name: Events.ChannelCreate, async execute(ch) {
    if (ch.guild) await logging.send(ch.guild, 'channel', `${E.redDot} CHANNEL CREATED`, [`Channel: <#${ch.id}> (${ch.name})`]);
  } },
  { name: Events.ChannelDelete, async execute(ch) {
    if (ch.guild) await logging.send(ch.guild, 'channel', `${E.redDot} CHANNEL DELETED`, [`Name: ${ch.name}`]);
  } },
  { name: Events.ChannelUpdate, async execute(a, b) {
    if (b.guild && a.name !== b.name) await logging.send(b.guild, 'channel', `${E.redDot} CHANNEL RENAMED`, [`Channel: <#${b.id}>`, `Old: ${a.name}`, `New: ${b.name}`]);
  } },
  { name: Events.GuildRoleCreate, async execute(r) { await logging.send(r.guild, 'role', `${E.modernStaff} ROLE CREATED`, [`Role: ${r.name}`]); } },
  { name: Events.GuildRoleDelete, async execute(r) { await logging.send(r.guild, 'role', `${E.modernStaff} ROLE DELETED`, [`Role: ${r.name}`]); } },
  { name: Events.GuildRoleUpdate, async execute(a, b) {
    if (a.name !== b.name || !a.permissions.equals(b.permissions)) await logging.send(b.guild, 'role', `${E.modernStaff} ROLE UPDATED`, [`Role: <@&${b.id}>`, a.name !== b.name ? `Name: ${a.name} → ${b.name}` : 'Permissions changed']);
  } },
  { name: Events.VoiceStateUpdate, async execute(a, b) {
    if (a.channelId === b.channelId || !b.guild) return;
    const what = !a.channelId ? `joined <#${b.channelId}>` : !b.channelId ? `left <#${a.channelId}>` : `moved <#${a.channelId}> → <#${b.channelId}>`;
    await logging.send(b.guild, 'voice', `${E.smallRedDot} VOICE`, [`<@${b.id}> ${what}`]);
  } },
];
