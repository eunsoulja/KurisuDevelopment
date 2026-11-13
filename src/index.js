'use strict';
require('dotenv').config();

function scrubSecrets(text) {
  return String(text || '')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'")]+/gi, '[redacted-database-url]')
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, '$1[redacted]@');
}

// Report the cause in plain text. Hosting panels (Pterodactyl, Bot-Hosting, ...) run
// `node index.js` and show stderr, so a thrown error is the only visible diagnosis.
function fatal(message, err) {
  console.error(`[kurisu] startup failed: ${scrubSecrets(message)}`);
  if (err) console.error(scrubSecrets(err.stack || err.message || err));
  console.error('[kurisu] compare your panel settings with the requirements; nothing else was changed.');
  process.exit(1);
}

let Client; let GatewayIntentBits; let Collection;
let db; let log; let load; let events; let guildLogs;
try {
  ({ Client, GatewayIntentBits, Collection } = require('discord.js'));
  db = require('./database');
  log = require('./utils/logger');
  ({ load } = require('./commands'));
  events = require('./events/core');
  guildLogs = require('./events/guildlogs');
} catch (err) {
  fatal(err?.code === 'MODULE_NOT_FOUND' && /mongodb/.test(err.message)
    ? 'a dependency failed to load - run `npm install` first'
    : 'a dependency failed to load - run `npm install` first', err);
}

// Hosting panels use their own environment variables; accept the common aliases.
if (!process.env.DISCORD_TOKEN) process.env.DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || '';
if (!process.env.CLIENT_ID) process.env.CLIENT_ID = process.env.APPLICATION_ID || process.env.APP_ID || '';

if (!process.env.DISCORD_TOKEN) {
  fatal('DISCORD_TOKEN is not set. Add it to the environment variables (or .env) of the hosting panel.');
}

async function main() {
  try {
    await db.open();
  } catch (err) {
    fatal('could not connect to the database. Check DATABASE_URL and that the MongoDB Atlas IP allowlist permits this host.', err);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
    allowedMentions: { parse: [] },
    rest: { timeout: 30_000, retries: 3 },
  });
  try {
    client.commands = new Collection([...load()]);
  } catch (err) {
    fatal('a command module failed to load', err);
  }

  for (const ev of [...events, ...guildLogs]) {
    const run = (...args) => Promise.resolve(ev.execute(...args, client)).catch((err) => log.error(`event ${ev.name} failed`, err));
    if (ev.once) client.once(ev.name, (...a) => run(...a)); else client.on(ev.name, run);
  }

  let closing = false;
  async function shutdown(signal) {
    if (closing) return; closing = true;
    log.info(`${signal} received, shutting down`);
    for (const t of client.timers || []) clearInterval(t);
    try { await client.destroy(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
  process.on('uncaughtException', (err) => log.error('uncaught exception', err));

  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    const hint = err?.code === 'TokenInvalid' || err?.message?.includes('token')
      ? 'The token is invalid or was reset - copy a fresh one from the Developer Portal.'
      : err?.code === 'UsedDisallowedIntents'
        ? 'Enable Server Members Intent and Message Content Intent in the Developer Portal.'
        : 'Could not log in to Discord.';
    fatal(hint, err);
  });
}

main().catch((err) => fatal('unexpected startup error', err));
