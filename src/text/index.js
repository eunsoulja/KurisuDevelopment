'use strict';
const { ApplicationCommandOptionType: T, MessageFlags } = require('discord.js');
const repo = require('../database/repo');
const perms = require('../permissions');
const ui = require('../components/common/ui');
const log = require('../utils/logger');

// Discord snowflakes are 17-20 digits today. Mentions are accepted everywhere.
const USER_MENTION = /^<@!?(\d{17,20})>$/;
const ROLE_MENTION = /^<@&(\d{17,20})>$/;
const CHANNEL_MENTION = /^<#(\d{17,20})>$/;
const RAW_ID = /^\d{17,20}$/;
const NAMED = /^([a-zA-Z_][\w-]*)(?::|=)([\s\S]*)$/;

// Prefixes change rarely; avoid a DB round-trip on every message.
const prefixCache = new Map();
async function getPrefix(guildId) {
  if (!prefixCache.has(guildId)) {
    const g = await repo.getGuild(guildId);
    prefixCache.set(guildId, (g.prefix || '!').trim());
  }
  return prefixCache.get(guildId);
}
function clearPrefix(guildId) { prefixCache.delete(guildId); }

/**
 * Split a line into arguments. Quotes are removed, so both
 *   !ban @user reason:"spam and eggs"
 * and
 *   !ban @user "spam and eggs"
 * keep the reason together.
 */
function tokenize(input) {
  const out = [];
  let current = '';
  let quote = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { out.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

const intValue = (token) => (/^-?\d+$/.test(token) ? Number(token) : null);
const numberValue = (token) => (/^-?\d+(?:\.\d+)?$/.test(token) ? Number(token) : null);
function boolValue(token) {
  const t = token.toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(t)) return true;
  if (['false', 'no', 'off', '0'].includes(t)) return false;
  return null;
}

function choiceFor(option, token) {
  if (!Array.isArray(option.choices)) return null;
  const t = token.toLowerCase();
  return option.choices.find((c) => String(c.value).toLowerCase() === t || String(c.name).toLowerCase() === t) || null;
}

/** discord.js caches are Collections; plain Maps in tests still need to work. */
function findIn(cache, predicate) {
  if (typeof cache?.find === 'function') return cache.find(predicate);
  for (const value of cache?.values?.() || []) if (predicate(value)) return value;
  return undefined;
}

/** Resolve a user mention, raw ID, @name or plain name. */
async function resolveUser(token, message) {
  const guild = message.guild;
  const mention = USER_MENTION.exec(token);
  const id = mention ? mention[1] : (RAW_ID.test(token) ? token : null);

  if (id) {
    let member = guild.members.cache.get(id);
    if (!member) member = await guild.members.fetch(id).catch(() => null);
    let user = member?.user || message.client.users.cache.get(id);
    if (!user) user = await message.client.users.fetch(id).catch(() => null);
    // A user who has left can still be unbanned by ID.
    if (!user) user = { id, tag: id, username: id, bot: false };
    return { type: 'user', user, member: member || null };
  }

  const name = token.replace(/^@/, '').toLowerCase();
  if (!name) return null;
  const matches = (m) => m.user.username?.toLowerCase() === name
    || m.user.tag?.toLowerCase() === name
    || m.displayName?.toLowerCase() === name;
  let member = findIn(guild.members.cache, matches);
  if (!member) {
    const found = await guild.members.fetch({ query: name, limit: 5 }).catch(() => null);
    member = findIn(found, matches) || null;
  }
  if (!member) return null;
  return { type: 'user', user: member.user, member };
}

/** Resolve a role mention, raw ID, @name or plain name. */
async function resolveRole(token, message) {
  const guild = message.guild;
  const mention = ROLE_MENTION.exec(token);
  const id = mention ? mention[1] : (RAW_ID.test(token) ? token : null);
  if (id) {
    let role = guild.roles.cache.get(id);
    if (!role) role = await guild.roles.fetch(id).catch(() => null);
    return role ? { type: 'role', role } : null;
  }
  const name = token.replace(/^@&?/, '').toLowerCase();
  if (!name) return null;
  const role = findIn(guild.roles.cache, (r) => r.name?.toLowerCase() === name);
  return role ? { type: 'role', role } : null;
}

/** Resolve a channel mention, raw ID, #name or plain name. */
async function resolveChannel(token, message) {
  const guild = message.guild;
  const mention = CHANNEL_MENTION.exec(token);
  const id = mention ? mention[1] : (RAW_ID.test(token) ? token : null);
  if (id) {
    let channel = guild.channels.cache.get(id);
    if (!channel) channel = await guild.channels.fetch(id).catch(() => null);
    return channel ? { type: 'channel', channel } : null;
  }
  const name = token.replace(/^#/, '').toLowerCase();
  if (!name) return null;
  const channel = findIn(guild.channels.cache, (c) => c.name?.toLowerCase() === name);
  return channel ? { type: 'channel', channel } : null;
}

/** Convert one token to the type declared by an option definition. */
async function parseValue(option, token, message) {
  switch (option.type) {
    case T.String: {
      if (Array.isArray(option.choices)) {
        const choice = choiceFor(option, token);
        if (!choice) return { error: `\`${option.name}\` must be one of: ${option.choices.map((c) => c.name).join(', ')}.` };
        return { value: choice.value };
      }
      if (option.min_length !== undefined && token.length < option.min_length) return { error: `\`${option.name}\` is too short.` };
      if (option.max_length !== undefined && token.length > option.max_length) return { error: `\`${option.name}\` is too long.` };
      return { value: token };
    }
    case T.Integer: {
      const n = intValue(token);
      if (n === null) return { error: `\`${option.name}\` must be a whole number.` };
      if (option.min_value !== undefined && n < option.min_value) return { error: `\`${option.name}\` must be at least ${option.min_value}.` };
      if (option.max_value !== undefined && n > option.max_value) return { error: `\`${option.name}\` must be at most ${option.max_value}.` };
      return { value: n };
    }
    case T.Number: {
      const n = numberValue(token);
      if (n === null) return { error: `\`${option.name}\` must be a number.` };
      if (option.min_value !== undefined && n < option.min_value) return { error: `\`${option.name}\` must be at least ${option.min_value}.` };
      if (option.max_value !== undefined && n > option.max_value) return { error: `\`${option.name}\` must be at most ${option.max_value}.` };
      return { value: n };
    }
    case T.Boolean: {
      const b = boolValue(token);
      if (b === null) return { error: `\`${option.name}\` must be true or false.` };
      return { value: b };
    }
    case T.User: {
      const v = await resolveUser(token, message);
      return v ? { value: v } : { error: `\`${option.name}\` must be a user mention, ID or name.` };
    }
    case T.Role: {
      const v = await resolveRole(token, message);
      return v ? { value: v } : { error: `Could not find a role matching \`${token}\`.` };
    }
    case T.Channel: {
      const v = await resolveChannel(token, message);
      return v ? { value: v } : { error: `Could not find a channel matching \`${token}\`.` };
    }
    case T.Mentionable: {
      if (USER_MENTION.test(token) || RAW_ID.test(token)) {
        const v = await resolveUser(token, message);
        if (v) return { value: v };
      }
      const r = await resolveRole(token, message);
      return r ? { value: r } : { error: `\`${option.name}\` must be a user or role mention.` };
    }
    default:
      return { value: token };
  }
}

/** Attach a positional token to the first option whose type makes sense. */
async function assignToken(token, defs, values, message) {
  const open = defs.filter((o) => values[o.name] === undefined);

  // /massban takes a whitespace/comma separated string of IDs. Accept mentions
  // and raw IDs in any position so "kmassban @a @b spam" works.
  const idsOpt = defs.find((o) => o.type === T.String && o.name.toLowerCase() === 'ids');
  if (idsOpt) {
    const mention = USER_MENTION.exec(token);
    if (mention) {
      values[idsOpt.name] = values[idsOpt.name] ? `${values[idsOpt.name]} ${mention[1]}` : mention[1];
      return true;
    }
    if (RAW_ID.test(token) || /^\d{17,20}(?:,\d{17,20})+$/.test(token)) {
      values[idsOpt.name] = values[idsOpt.name] ? `${values[idsOpt.name]} ${token}` : token;
      return true;
    }
  }

  if (USER_MENTION.test(token)) {
    const opt = open.find((o) => o.type === T.User || o.type === T.Mentionable);
    if (opt) {
      const v = await resolveUser(token, message);
      if (v) { values[opt.name] = v; return true; }
    }
    // /unban takes a user_id string rather than a user option.
    const idOpt = open.find((o) => o.type === T.String && /^(user_?id|id)$/i.test(o.name));
    if (idOpt) { values[idOpt.name] = USER_MENTION.exec(token)[1]; return true; }
  }

  if (ROLE_MENTION.test(token)) {
    const opt = open.find((o) => o.type === T.Role || o.type === T.Mentionable);
    if (opt) {
      const v = await resolveRole(token, message);
      if (v) { values[opt.name] = v; return true; }
    }
  }

  if (CHANNEL_MENTION.test(token)) {
    const opt = open.find((o) => o.type === T.Channel);
    if (opt) {
      const v = await resolveChannel(token, message);
      if (v) { values[opt.name] = v; return true; }
    }
  }

  const choiceOpt = open.find((o) => Array.isArray(o.choices) && choiceFor(o, token));
  if (choiceOpt) {
    values[choiceOpt.name] = choiceFor(choiceOpt, token).value;
    return true;
  }

  if (intValue(token) !== null) {
    const opt = open.find((o) => o.type === T.Integer);
    if (opt) {
      const r = await parseValue(opt, token, message);
      if (r.error) return r;
      values[opt.name] = r.value;
      return true;
    }
  }

  if (numberValue(token) !== null) {
    const opt = open.find((o) => o.type === T.Number);
    if (opt) {
      const r = await parseValue(opt, token, message);
      if (r.error) return r;
      values[opt.name] = r.value;
      return true;
    }
  }

  if (boolValue(token) !== null) {
    const opt = open.find((o) => o.type === T.Boolean);
    if (opt) { values[opt.name] = boolValue(token); return true; }
  }

  if (RAW_ID.test(token)) {
    const userOpt = open.find((o) => o.type === T.User || o.type === T.Mentionable);
    if (userOpt) {
      const v = await resolveUser(token, message);
      if (v) { values[userOpt.name] = v; return true; }
    }
    const roleOpt = open.find((o) => o.type === T.Role || o.type === T.Mentionable);
    if (roleOpt) {
      const v = await resolveRole(token, message);
      if (v) { values[roleOpt.name] = v; return true; }
    }
    const channelOpt = open.find((o) => o.type === T.Channel);
    if (channelOpt) {
      const v = await resolveChannel(token, message);
      if (v) { values[channelOpt.name] = v; return true; }
    }
  }

  // Required user/role/channel options accept a plain name too, e.g.
  // "!ban user spam" or "!logs set antinuke security-logs". Optional options
  // still need a mention/ID so free text is not mistaken for a member name.
  const requiredUser = open.find((o) => (o.type === T.User || o.type === T.Mentionable) && o.required);
  if (requiredUser) {
    const v = await resolveUser(token, message);
    if (v) { values[requiredUser.name] = v; return true; }
  }
  const requiredRole = open.find((o) => (o.type === T.Role || o.type === T.Mentionable) && o.required);
  if (requiredRole) {
    const v = await resolveRole(token, message);
    if (v) { values[requiredRole.name] = v; return true; }
  }
  const requiredChannel = open.find((o) => o.type === T.Channel && o.required);
  if (requiredChannel) {
    const v = await resolveChannel(token, message);
    if (v) { values[requiredChannel.name] = v; return true; }
  }

  // A non-choice string option is the natural target for free text. Skipping
  // choice options here is what makes "!help ban" target `command` instead of
  // the `category` choice.
  const stringOpts = open.filter((o) => o.type === T.String);
  const stringOpt = stringOpts.find((o) => !Array.isArray(o.choices)) || stringOpts[0];
  if (stringOpt) {
    const r = await parseValue(stringOpt, token, message);
    if (!r.error) { values[stringOpt.name] = r.value; return true; }
    // If a later free-text option exists (e.g. /help's `command`), let it
    // absorb the word instead of rejecting it as an invalid choice.
    if (Array.isArray(stringOpt.choices) && defs.some((o) => o.type === T.String && !Array.isArray(o.choices))) return false;
    return r;
  }

  return false;
}

/** The last free-text option absorbs leftover words, so reasons can contain spaces. */
function appendToLastString(defs, values, token) {
  const opt = [...defs].reverse().find((o) => o.type === T.String && !Array.isArray(o.choices));
  if (!opt) return false;
  values[opt.name] = values[opt.name] === undefined ? token : `${values[opt.name]} ${token}`;
  return true;
}

function validateValues(defs, values) {
  for (const o of defs) {
    const v = values[o.name];
    if (o.required && v === undefined) return `Missing required option \`${o.name}\`.`;
    if (v === undefined || o.type !== T.String) continue;
    if (Array.isArray(o.choices) && !o.choices.some((c) => c.value === v)) return `\`${o.name}\` must be one of: ${o.choices.map((c) => c.name).join(', ')}.`;
    if (o.min_length !== undefined && v.length < o.min_length) return `\`${o.name}\` is too short.`;
    if (o.max_length !== undefined && v.length > o.max_length) return `\`${o.name}\` is too long.`;
  }
  return null;
}

async function parseOptions(message, defs, tokens) {
  const values = {};
  for (let idx = 0; idx < tokens.length; idx++) {
    const token = tokens[idx];
    const named = NAMED.exec(token);
    if (named) {
      const opt = defs.find((o) => o.name.toLowerCase() === named[1].toLowerCase());
      if (opt) {
        let raw = named[2];
        if (opt.type === T.String && raw === '' && idx + 1 < tokens.length) raw = tokens[++idx];
        const r = await parseValue(opt, raw, message);
        if (r.error) return { error: r.error };
        values[opt.name] = r.value;
        continue;
      }
    }
    const assigned = await assignToken(token, defs, values, message);
    if (assigned && assigned.error) return { error: assigned.error };
    if (!assigned) appendToLastString(defs, values, token);
  }
  const invalid = validateValues(defs, values);
  return invalid ? { error: invalid } : { values };
}

function usage(prefix, name, sub, defs) {
  const parts = [`${prefix}${name}`];
  if (sub) parts.push(sub.name);
  for (const o of defs) parts.push(o.required ? `<${o.name}>` : `[${o.name}]`);
  return parts.join(' ');
}

/** Remove the ephemeral flag: normal messages cannot be ephemeral. */
function cleanPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (out.flags !== undefined) {
    const flags = Number(out.flags) & ~MessageFlags.Ephemeral;
    if (flags) out.flags = flags; else delete out.flags;
  }
  delete out.ephemeral;
  return out;
}

async function sendReply(message, payload) {
  try { return await message.reply(cleanPayload(payload)); }
  catch (err) {
    log.debug('text command reply failed', err);
    return null;
  }
}

function createInteraction(message, client, command, sub, values, member = message.member) {
  const fake = {
    client,
    guild: message.guild,
    guildId: message.guild.id,
    channel: message.channel,
    channelId: message.channel.id,
    member,
    user: message.author,
    memberPermissions: member?.permissions,
    createdTimestamp: Date.now(),
    commandName: command.data.name,
    deferred: false,
    replied: false,
    _replyMessage: null,
    inGuild: () => true,
    inCachedGuild: () => true,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => sub?.name || null,
      getSubcommandGroup: () => null,
      getString: (name) => {
        const v = values[name];
        return v === undefined || v === null || typeof v === 'object' ? null : String(v);
      },
      getInteger: (name) => (typeof values[name] === 'number' ? Math.trunc(values[name]) : null),
      getNumber: (name) => (typeof values[name] === 'number' ? values[name] : null),
      getBoolean: (name) => (typeof values[name] === 'boolean' ? values[name] : null),
      getUser: (name) => values[name]?.user || null,
      getMember: (name) => (values[name] && 'member' in values[name] ? values[name].member : null),
      getRole: (name) => values[name]?.role || null,
      getChannel: (name) => values[name]?.channel || null,
      getMentionable: (name) => values[name]?.user || values[name]?.role || null,
      getAttachment: () => null,
      getFocused: () => '',
    },
    async reply(payload) {
      this.replied = true;
      this._replyMessage = await sendReply(message, payload);
      return this._replyMessage;
    },
    async deferReply() { this.deferred = true; },
    async editReply(payload) {
      const clean = cleanPayload(payload);
      if (this._replyMessage) {
        try { return await this._replyMessage.edit(clean); }
        catch { return sendReply(message, payload); }
      }
      this._replyMessage = await sendReply(message, payload);
      return this._replyMessage;
    },
    async followUp(payload) { return sendReply(message, payload); },
    async update(payload) { return this.editReply(payload); },
    async deleteReply() { return this._replyMessage?.delete().catch(() => {}); },
  };
  return fake;
}

async function handle(message, client) {
  if (!message.guild || !message.author || message.author.bot || message.webhookId || message.system) return false;
  if (!message.content) return false;

  const prefix = await getPrefix(message.guild.id);
  if (!prefix) return false;
  if (!message.content.toLowerCase().startsWith(prefix.toLowerCase())) return false;

  let rest = message.content.slice(prefix.length).trim();
  if (!rest) rest = 'help';
  const tokens = tokenize(rest);
  if (!tokens.length) return false;

  const cmdName = tokens.shift().toLowerCase();
  const command = client.commands.get(cmdName);
  // Unknown words that happen to start with the prefix are ordinary chat.
  if (!command) return false;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return false;

  const json = command.data.toJSON();
  if (json.default_member_permissions) {
    const required = BigInt(json.default_member_permissions);
    const allowed = message.guild.ownerId === message.author.id
      || perms.isBotOwner(message.author.id)
      || member.permissions?.has(required);
    if (!allowed) {
      await sendReply(message, ui.error('You do not have permission to use this command.'));
      return true;
    }
  }

  const subs = (json.options || []).filter((o) => o.type === T.SubCommand);
  let sub = null;
  let defs = json.options || [];
  if (subs.length) {
    if (!tokens.length) {
      await sendReply(message, ui.error(`Usage: \`${prefix}${cmdName} <${subs.map((s) => s.name).join('|')}>\``));
      return true;
    }
    const subName = tokens.shift().toLowerCase();
    sub = subs.find((s) => s.name.toLowerCase() === subName);
    if (!sub) {
      await sendReply(message, ui.error(`Usage: \`${prefix}${cmdName} <${subs.map((s) => s.name).join('|')}>\``));
      return true;
    }
    defs = sub.options || [];
  }

  const parsed = await parseOptions(message, defs, tokens);
  if (parsed.error) {
    await sendReply(message, ui.error(`${parsed.error}\nUsage: \`${usage(prefix, cmdName, sub, defs)}\``));
    return true;
  }

  const fake = createInteraction(message, client, command, sub, parsed.values, member);
  try {
    await command.execute(fake);
  } catch (err) {
    log.error(`text command ${cmdName} failed`, err);
    await fake.reply(ui.error('That command could not be completed. Check the arguments and my permissions.'));
  }
  return true;
}

module.exports = { handle, tokenize, parseOptions, usage, cleanPayload, getPrefix, clearPrefix };
