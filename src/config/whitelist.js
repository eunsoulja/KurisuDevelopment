'use strict';
const { MODULES, KEYS } = require('../engines/antinuke/modules');
const { clip } = require('../utils/helpers');

/** Friendly names for every protection module, used by the whitelist scope picker. */
const SCOPE_LABELS = {
  channelCreate: 'Channel create',
  channelDelete: 'Channel delete',
  channelUpdate: 'Channel rename/edit',
  roleCreate: 'Role create',
  roleDelete: 'Role delete',
  roleUpdate: 'Role edit',
  massBan: 'Mass ban',
  massKick: 'Mass kick',
  massUnban: 'Mass unban',
  prune: 'Member prune',
  webhookCreate: 'Webhook create',
  webhookDelete: 'Webhook delete',
  webhookUpdate: 'Webhook edit',
  botAdd: 'Bot add',
  guildUpdate: 'Server settings',
  everyoneMention: 'Everyone/here ping',
  massMention: 'Mass mention',
  permEscalation: 'Permission escalation',
  integration: 'Integration changes',
  inviteSpam: 'Invite spam',
  massDelete: 'Mass message delete',
  emojiDelete: 'Emoji delete',
  stickerDelete: 'Sticker delete',
  threadDelete: 'Thread delete',
  assetCreate: 'Emoji/sticker/soundboard spam',
  automodRule: 'Automod tampering',
  vanityChange: 'Vanity URL change',
  nukeGuard: 'Nuke Guard',
};

/** Presets for the slash command. `keys: null` means the level's default behaviour. */
const SCOPE_PRESETS = {
  all: { name: 'All protection modules', keys: ['*'] },
  default: { name: 'Level default', keys: null },
  pings: { name: 'Pings & mentions', keys: ['everyoneMention', 'massMention'] },
  mentions: { name: 'Pings & mentions', keys: ['everyoneMention', 'massMention'] },
  channels: { name: 'Channel create/delete/rename', keys: ['channelCreate', 'channelDelete', 'channelUpdate'] },
  'channel-create': { name: 'Channel create', keys: ['channelCreate'] },
  'channel-rename': { name: 'Channel rename/edit', keys: ['channelUpdate'] },
  'channel-delete': { name: 'Channel delete', keys: ['channelDelete'] },
  roles: { name: 'Role create/delete/edit', keys: ['roleCreate', 'roleDelete', 'roleUpdate'] },
  members: { name: 'Bans, kicks, unbans & prunes', keys: ['massBan', 'massKick', 'massUnban', 'prune'] },
  webhooks: { name: 'Webhooks', keys: ['webhookCreate', 'webhookDelete', 'webhookUpdate'] },
  server: { name: 'Server settings & vanity', keys: ['guildUpdate', 'vanityChange', 'integration'] },
  invites: { name: 'Invite spam', keys: ['inviteSpam'] },
  messages: { name: 'Message deletion', keys: ['massDelete'] },
  emojis: { name: 'Emoji & sticker deletion', keys: ['emojiDelete', 'stickerDelete'] },
  assets: { name: 'Emoji, sticker & soundboard spam', keys: ['emojiDelete', 'stickerDelete', 'assetCreate'] },
  threads: { name: 'Thread deletion', keys: ['threadDelete'] },
  automod: { name: 'Automod tampering', keys: ['automodRule'] },
  bots: { name: 'Bot additions', keys: ['botAdd'] },
  permissions: { name: 'Permission escalation', keys: ['permEscalation'] },
  nuke: { name: 'Nuke Guard (destructive bursts)', keys: ['nukeGuard'] },
};

/** JSON stored in the DB -> array of module keys, ['*'] for everything, or null for the level default. */
function storedScopes(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.length ? value : null;
  } catch { return null; }
}

/** Parse a slash-command value (comma separated keys/presets) into a stored scope array. */
function parseScopes(input) {
  if (input === null || input === undefined) return { ok: true, scopes: null };
  const set = new Set();
  for (const token of String(input).split(',')) {
    const value = token.trim().toLowerCase();
    if (!value) continue;
    if (value === 'default' || value === 'level-default') return { ok: true, scopes: null };
    if (value === 'all' || value === '*') { set.add('*'); continue; }
    const preset = SCOPE_PRESETS[value];
    if (preset) { preset.keys.forEach((k) => set.add(k)); continue; }
    const key = KEYS.find((k) => k.toLowerCase() === value);
    if (!key) {
      return { ok: false, error: `Unknown scope "${token.trim()}". Use module keys (${KEYS.slice(0, 4).join(', ')}, ...) or presets (pings, channels, roles, all).` };
    }
    set.add(key);
  }
  if (!set.size) return { ok: true, scopes: null };
  if (set.has('*')) return { ok: true, scopes: ['*'] };
  return { ok: true, scopes: [...set] };
}

function scopesLabel(scopes) {
  if (!scopes || !scopes.length) return 'Level default';
  if (scopes.includes('*')) return 'All modules';
  return clip(scopes.map((k) => SCOPE_LABELS[k] || k).join(', '), 160);
}

/**
 * Does this whitelist entry exempt `moduleKey`?
 *  - no scopes: trusted_mod keeps its old message-only behaviour, every other level is fully exempt
 *  - scopes: only the listed modules, or everything when the entry contains '*'
 *  - no module key (raid checks): only fully exempt entries count
 */
function entryAllows(entry, group = 'general', moduleKey = null) {
  const scopes = storedScopes(entry.scopes);
  if (scopes === null) {
    if (entry.level !== 'trusted_mod') return true;
    return group === 'message' && (!moduleKey || MODULES[moduleKey]?.group === 'message');
  }
  if (scopes.includes('*')) return true;
  if (!moduleKey) return false;
  return scopes.includes(moduleKey);
}

// ---- compact masks for the dashboard select menus (state travels in the customId) ----
const ALL_MASK = (1n << BigInt(KEYS.length)) - 1n;
function maskForScopes(scopes) {
  if (!scopes || !scopes.length) return 0n;
  if (scopes.includes('*')) return ALL_MASK;
  return scopes.reduce((mask, key) => {
    const i = KEYS.indexOf(key);
    return i === -1 ? mask : mask | (1n << BigInt(i));
  }, 0n);
}
function scopesForMask(mask) {
  if (!mask) return null;
  if (mask === ALL_MASK) return ['*'];
  return KEYS.filter((_, i) => mask & (1n << BigInt(i)));
}
const maskId = (mask) => (mask || 0n).toString(36);
const parseMask = (value) => {
  try { return BigInt(parseInt(String(value || '0'), 36) || 0); } catch { return 0n; }
};

/** Options for the dashboard multi-select: level default, all modules, then every module. */
function scopeOptions() {
  return [
    { label: 'Level default', value: 'default', description: 'Trusted Moderator: message modules only; other levels: everything' },
    { label: 'All protection modules', value: 'all', description: 'Exempt from every antinuke module' },
    ...KEYS.map((key) => ({ label: SCOPE_LABELS[key], value: key, description: MODULES[key].desc })),
  ];
}

module.exports = {
  SCOPE_LABELS, SCOPE_PRESETS, ALL_MASK,
  storedScopes, parseScopes, scopesLabel, entryAllows,
  maskForScopes, scopesForMask, maskId, parseMask, scopeOptions,
};
