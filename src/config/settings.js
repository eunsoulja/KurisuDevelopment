'use strict';
const { PermissionFlagsBits: P } = require('discord.js');

// Permissions that make a role "dangerous" for antinuke purposes.
const DANGEROUS_PERMISSIONS = [
  P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers,
  P.KickMembers, P.ManageWebhooks, P.MentionEveryone, P.ManageGuildExpressions,
  P.ModerateMembers, P.ManageMessages,
];
const DANGEROUS_BITS = DANGEROUS_PERMISSIONS.reduce((a, b) => a | b, 0n);

const PUNISHMENTS = ['strip', 'quarantine', 'timeout', 'kick', 'ban'];
const PUNISHMENT_LABEL = {
  strip: 'Strip Permissions', quarantine: 'Quarantine', timeout: 'Timeout', kick: 'Kick', ban: 'Ban',
};
const PUNISHED_LABEL = {
  strip: 'Permissions stripped', quarantine: 'Quarantined', timeout: 'Timed out', kick: 'Kicked', ban: 'Banned',
};

const WHITELIST_LEVELS = {
  trusted_admin: 'Trusted Administrator',
  trusted_mod: 'Trusted Moderator',
  bypass: 'Security Bypass',
  bot: 'Trusted Bot',
};

const LOG_TYPES = {
  antinuke: 'Antinuke', raid: 'Raid', moderation: 'Moderation', member: 'Member',
  message: 'Message', channel: 'Channel', role: 'Role', voice: 'Voice', config: 'Configuration',
};

const LIMITS = {
  massBanMax: 25,
  massKickMax: 25,
  purgeMax: 100,
  timeoutMaxSec: 28 * 24 * 3600,
  warningsPerPage: 5,
  incidentsPerPage: 5,
  bansPerPage: 10,
  guildsPerPage: 8,
};

module.exports = {
  DANGEROUS_PERMISSIONS, DANGEROUS_BITS, PUNISHMENTS, PUNISHMENT_LABEL, PUNISHED_LABEL,
  WHITELIST_LEVELS, LOG_TYPES, LIMITS,
};
