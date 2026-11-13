'use strict';
const repo = require('../../database/repo');
const logging = require('../logging');
const { E } = require('../../components/common/ui');
const { formatDuration, clip } = require('../../utils/helpers');

const ACTION_EMOJI = {
  ban: E.banHammer, unban: E.banHammer, softban: E.banHammer, massban: E.banHammer, kick: E.moderatorShield,
  masskick: E.moderatorShield,
  timeout: E.timeoutClock, untimeout: E.timeoutClock, warn: E.modernRules, lock: E.modernRules, unlock: E.modernRules,
  purge: E.moderatorShield, nickname: E.modernStaff, role: E.modernStaff, quarantine: E.clearShield,
};

/** Persist a case and post it to the moderation log. Returns the case row. */
async function record(guild, { userId, moderatorId, action, reason, durationSec }) {
  const row = repo.addCase(guild.id, { userId, moderatorId, action, reason, durationSec });
  await logging.send(guild, 'moderation', `${ACTION_EMOJI[action] || E.redDot} ${action.toUpperCase()}  ·  Case #${row.case_number}`, [
    `User: <@${userId}>`,
    `Moderator: <@${moderatorId}>`,
    ...(durationSec ? [`Duration: ${formatDuration(durationSec)}`] : []),
    `Reason: ${clip(reason, 300) || 'No reason provided'}`,
  ]);
  return row;
}

module.exports = { record, ACTION_EMOJI };
