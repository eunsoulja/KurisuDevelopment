'use strict';
const { AuditLogEvent: A } = require('discord.js');

/**
 * The protection modules.
 *  - actions: audit log events that feed the module
 *  - group:   'message' modules are also bypassed by Trusted Moderators
 *  - source:  'audit' (guildAuditLogEntryCreate), 'message' (messageCreate) or 'meta'
 *  - nuke:    destructive actions that count towards the cross-module Nuke Guard
 *  - defaults.threshold: number of actions inside defaults.windowSec that triggers the response
 *
 * Critical modules respond on the first or second hit and default to a kick, so a
 * nuke attempt is stopped before it can cascade. Nuke Guard catches mixed bursts
 * (delete channel + delete role + ban wave) that stay below each module threshold.
 */
const MODULES = {
  channelCreate:   { name: 'Anti-Channel Create',     desc: 'Mass channel creation', actions: [A.ChannelCreate], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 10, punishment: 'quarantine' } },
  channelDelete:   { name: 'Anti-Channel Delete',     desc: 'Channel deletion',      actions: [A.ChannelDelete], nuke: true, defaults: { enabled: true, threshold: 2, windowSec: 10, punishment: 'kick' } },
  channelUpdate:   { name: 'Anti-Channel Update',     desc: 'Channel and overwrite edits', actions: [A.ChannelUpdate, A.ChannelOverwriteCreate, A.ChannelOverwriteUpdate, A.ChannelOverwriteDelete], defaults: { enabled: true, threshold: 4, windowSec: 10, punishment: 'quarantine' } },
  roleCreate:      { name: 'Anti-Role Create',        desc: 'Mass role creation',    actions: [A.RoleCreate], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 10, punishment: 'quarantine' } },
  roleDelete:      { name: 'Anti-Role Delete',        desc: 'Role deletion',         actions: [A.RoleDelete], nuke: true, defaults: { enabled: true, threshold: 2, windowSec: 10, punishment: 'kick' } },
  roleUpdate:      { name: 'Anti-Role Update',        desc: 'Role edits',            actions: [A.RoleUpdate], defaults: { enabled: true, threshold: 4, windowSec: 10, punishment: 'quarantine' } },
  massBan:         { name: 'Anti-Mass Ban',           desc: 'Members banned in bulk', actions: [A.MemberBanAdd], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 15, punishment: 'ban' } },
  massKick:        { name: 'Anti-Mass Kick',          desc: 'Members kicked in bulk', actions: [A.MemberKick], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 15, punishment: 'ban' } },
  massUnban:       { name: 'Anti-Mass Unban',         desc: 'Members unbanned in bulk', actions: [A.MemberBanRemove], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 15, punishment: 'kick' } },
  prune:           { name: 'Anti-Prune',              desc: 'Member prune',          actions: [A.MemberPrune], nuke: true, defaults: { enabled: true, threshold: 1, windowSec: 60, punishment: 'kick' } },
  webhookCreate:   { name: 'Anti-Webhook Create',     desc: 'Webhook creation',      actions: [A.WebhookCreate], nuke: true, defaults: { enabled: true, threshold: 2, windowSec: 20, punishment: 'quarantine' } },
  webhookDelete:   { name: 'Anti-Webhook Delete',     desc: 'Webhook deletion',      actions: [A.WebhookDelete], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 20, punishment: 'strip' } },
  webhookUpdate:   { name: 'Anti-Webhook Update',     desc: 'Webhook edits',         actions: [A.WebhookUpdate], defaults: { enabled: true, threshold: 3, windowSec: 20, punishment: 'strip' } },
  botAdd:          { name: 'Anti-Bot Add',            desc: 'Unapproved bots added', actions: [A.BotAdd], nuke: true, defaults: { enabled: true, threshold: 1, windowSec: 60, punishment: 'kick' } },
  guildUpdate:     { name: 'Anti-Guild Update',       desc: 'Server settings changes', actions: [A.GuildUpdate], nuke: true, defaults: { enabled: true, threshold: 2, windowSec: 30, punishment: 'quarantine' } },
  everyoneMention: { name: 'Anti-Everyone Mention',   desc: '@everyone and @here abuse', source: 'message', group: 'message', defaults: { enabled: true, threshold: 2, windowSec: 30, punishment: 'timeout' } },
  massMention:     { name: 'Anti-Mass Mention',       desc: 'Many users or roles pinged', source: 'message', group: 'message', defaults: { enabled: true, threshold: 10, windowSec: 10, punishment: 'timeout' } },
  permEscalation:  { name: 'Anti-Permission Escalation', desc: 'Dangerous permissions granted', actions: [A.RoleUpdate, A.MemberRoleUpdate], nuke: true, defaults: { enabled: true, threshold: 1, windowSec: 60, punishment: 'kick' } },
  integration:     { name: 'Anti-Integration Changes', desc: 'Integrations added or removed', actions: [A.IntegrationCreate, A.IntegrationUpdate, A.IntegrationDelete], nuke: true, defaults: { enabled: true, threshold: 2, windowSec: 30, punishment: 'quarantine' } },
  inviteSpam:      { name: 'Anti-Invite Spam',        desc: 'Mass invite creation',  actions: [A.InviteCreate], group: 'message', defaults: { enabled: true, threshold: 3, windowSec: 30, punishment: 'timeout' } },
  massDelete:      { name: 'Anti-Mass Message Deletion', desc: 'Bulk message deletion', actions: [A.MessageBulkDelete, A.MessageDelete], group: 'message', defaults: { enabled: true, threshold: 20, windowSec: 20, punishment: 'quarantine' } },
  emojiDelete:     { name: 'Anti-Emoji Deletion',     desc: 'Emoji deletion',        actions: [A.EmojiDelete], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 20, punishment: 'quarantine' } },
  stickerDelete:   { name: 'Anti-Sticker Deletion',   desc: 'Sticker deletion',      actions: [A.StickerDelete], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 20, punishment: 'quarantine' } },
  threadDelete:    { name: 'Anti-Thread Delete',      desc: 'Thread deletion',       actions: [A.ThreadDelete], nuke: true, defaults: { enabled: true, threshold: 3, windowSec: 20, punishment: 'quarantine' } },
  assetCreate:     { name: 'Anti-Asset Spam',         desc: 'Mass emoji, sticker or soundboard creation', actions: [A.EmojiCreate, A.StickerCreate, A.SoundboardSoundCreate], defaults: { enabled: true, threshold: 5, windowSec: 20, punishment: 'strip' } },
  automodRule:     { name: 'Anti-Automod Tamper',     desc: 'Automod rules changed or removed', actions: [A.AutoModerationRuleCreate, A.AutoModerationRuleUpdate, A.AutoModerationRuleDelete], nuke: true, defaults: { enabled: true, threshold: 1, windowSec: 30, punishment: 'kick' } },
  vanityChange:    { name: 'Anti-Vanity URL Change',  desc: 'Vanity URL changes (where supported)', actions: [A.GuildUpdate], nuke: true, defaults: { enabled: true, threshold: 1, windowSec: 60, punishment: 'kick' } },
  nukeGuard:       { name: 'Nuke Guard',              desc: 'Cross-module destructive burst', source: 'meta', defaults: { enabled: true, threshold: 3, windowSec: 10, punishment: 'kick' } },
};

const KEYS = Object.keys(MODULES);
const byAction = new Map();
for (const [key, m] of Object.entries(MODULES)) {
  for (const a of m.actions || []) {
    if (!byAction.has(a)) byAction.set(a, []);
    byAction.get(a).push(key);
  }
}

const NUKE_KEYS = KEYS.filter((key) => MODULES[key].nuke);

module.exports = { MODULES, KEYS, NUKE_KEYS, byAction };
