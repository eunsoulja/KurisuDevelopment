'use strict';
const repo = require('../database/repo');
const ui = require('../components/common/ui');
const log = require('../utils/logger');

const { E } = ui;
const TITLES = {
  antinuke: 'KURISU SECURITY', raid: 'KURISU SECURITY', moderation: 'KURISU MODERATION', member: 'KURISU LOGS',
  message: 'KURISU LOGS', channel: 'KURISU LOGS', role: 'KURISU LOGS', voice: 'KURISU LOGS', config: 'KURISU SECURITY',
};

/**
 * Send a short V2 log to the configured channel for `type`.
 * lines: array of strings. head: "<emoji> HEADLINE".
 */
async function send(guild, type, head, lines) {
  try {
    const id = repo.getLogChannel(guild.id, type);
    if (!id) return false;
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;
    await channel.send(ui.message([`-# ${TITLES[type]}`, `### ${head}`, lines.join('\n')]));
    return true;
  } catch (err) {
    log.warn(`log delivery failed (${type}) in ${guild.id}`, err);
    return false;
  }
}

const watchLog = (guild, i) => send(guild, 'antinuke', `${E.smallRedDot} SECURITY WATCH`, [
  `Executor: <@${i.executorId}>`,
  `Action: ${i.actionLabel}`,
  `Progress: ${i.count}/${i.threshold}`,
  `Status: Monitoring - below response threshold`,
  '',
  `Time: <t:${Math.floor(Date.now() / 1000)}:R>`,
]);

const incidentLog = (guild, i) => send(guild, 'antinuke', `${E.banHammer} SECURITY INCIDENT`, [
  `Executor: <@${i.executorId}>`,
  `Action: ${i.actionLabel}`,
  `Threshold: ${i.count}/${i.threshold}`,
  `Response: ${i.response}`,
  `Status: ${i.status}`,
  ...(i.details ? [`Note: ${i.details}`] : []),
  '',
  `Time: <t:${Math.floor(Date.now() / 1000)}:R>`,
]);

module.exports = { send, watchLog, incidentLog };
