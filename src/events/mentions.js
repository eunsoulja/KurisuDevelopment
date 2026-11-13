'use strict';
const ui = require('../components/common/ui');
const { BRANDING_GIF } = require('../config/branding');
const { formatDuration } = require('../utils/helpers');
const text = require('../text');
const { version } = require('../../package.json');

const { E } = ui;
const COOLDOWN_MS = 15_000;
const MAX_TRACKED = 5000;
const cooldown = new Map();

function totalUsers(client) {
  return client.guilds.cache.reduce((sum, guild) => sum + (guild.memberCount || 0), 0);
}

/**
 * Reply with the Kurisu card whenever the bot is mentioned.
 * No Message Content intent is needed: Discord still populates message.mentions.
 */
async function handle(message) {
  const client = message.client;
  if (!message.guild || message.author.bot || message.webhookId || message.system) return;
  if (!message.mentions.users.has(client.user.id)) return;

  const now = Date.now();
  if (now - (cooldown.get(message.author.id) || 0) < COOLDOWN_MS) return;
  if (cooldown.size >= MAX_TRACKED) cooldown.clear();
  cooldown.set(message.author.id, now);

  const items = [
    `### ${E.crown} KURISU`,
    '**Antinuke, Security & Moderation**\n-# Mention me any time, or run /help to browse every command.',
    { media: BRANDING_GIF },
    'sep',
    `Servers  **${client.guilds.cache.size.toLocaleString('en-US')}**\nUsers  **${totalUsers(client).toLocaleString('en-US')}**\nGateway  **${Math.round(client.ws.ping)}ms**\nUptime  **${formatDuration(Math.floor(process.uptime()))}**`,
    'sep',
    `-# Prefix \`${await text.getPrefix(message.guild.id)}\`  ·  Version ${version}`,
    ui.buttons(ui.emojiBtn('ki:invite', E.shinyLink)),
  ];
  try {
    await message.reply(ui.message(items));
  } catch { /* message deleted or no permission to reply */ }
}

module.exports = { handle };
