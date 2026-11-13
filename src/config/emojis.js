'use strict';

// Central emoji registry. Static custom emojis, exact `<:name:id>` syntax.
const EMOJIS = {
  crown: '<:33379crownred:1570097536021037096>',
  verified: '<:8881shinyredverified:1570097528706441298>',
  shinyVerified: '<:8881shinyredverified:1570097528706441298>',
  administrator: '<:9279administrator:1570097531659092210>',
  shinyLink: '<:8747shinyredlink:1570097526965805177>',
  ping: '<a:ping:1570354510721843280>',
  banHammer: '<:8465banhammer:1570097524541493258>',
  moderatorShield: '<:7942redmodshield:1570097522402402404>',
  ownerShield: '<:7805ownershield:1570097519856197672>',
  partner: '<:7773shinyredpartner:1570097517704515675>',
  modernRaid: '<:7762modernraid:1570097515213365360>',
  modernVerify: '<:7490modernverify:1570097513019613316>',
  banHammerAlt: '<:6982banhammer:1570097510440112248>',
  // The original 6483staffred id no longer exists on Discord; use the modern staff badge.
  staff: '<:5906modernstaff:1570097504014573619>',
  earlyDeveloper: '<:6336shinyredearlydev:1570097506212122774>',
  modernStaff: '<:5906modernstaff:1570097504014573619>',
  ownerCrown: '<:5203discordownercrowndarkred:1570097501820944497>',
  modernRules: '<:5152modernrules:1570097499715272704>',

  admin: '<:4631adminred:1570097494560342176>',
  ownerBadge: '<:4396ownerbadgered:1570097491452366960>',
  modBadge: '<:4730modernmoderator:1570097497232117850>',
  verifiedDeveloper: '<:3963verifieddeveloperbadgered:1570097489044832377>',
  timeoutClock: '<:3769timeoutclock:1570097486595498036>',
  mod2: '<:3219mod2:1570097484448010342>',
  staffAlt: '<:2978staffred:1570097481985818695>',
  clearShield: '<:2959redclearshield:1570097479469240380>',

  // The original 2752adminred id no longer exists on Discord; use the administrator badge.
  adminAlt: '<:9279administrator:1570097531659092210>',
  shinyStaff: '<:2638shinyredstaff:1570097474335416440>',
  bugHunter: '<:2398shinyredbughunter:1570097472276275342>',
  discordStaff: '<:1918discordstaffblackred:1570097470049099927>',
  adminBadge: '<:1856adminbadge:1570097467079270551>',
  redDot: '<:1523reddot:1570097464365551629>',
  smallRedDot: '<:1476redsmalldot:1570097462151086323>',
};

const EMOJI_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;

/** "<:name:id>" -> { name, id, animated } (for select options / buttons). */
function parseEmoji(str) {
  const m = EMOJI_RE.exec(str || '');
  if (!m) return undefined;
  return { animated: m[1] === 'a', name: m[2], id: m[3] };
}

/**
 * Check every registry entry against what the client can actually see
 * (guild emojis of joined guilds + application emojis). Returns problems;
 * the caller logs them.
 */
async function validateEmojis(client) {
  const problems = [];
  const known = new Map();
  for (const e of client.emojis.cache.values()) known.set(e.id, e.name);
  try {
    const appEmojis = await client.application.emojis.fetch();
    for (const e of appEmojis.values()) known.set(e.id, e.name);
  } catch { /* application emojis unavailable */ }

  for (const [key, value] of Object.entries(EMOJIS)) {
    const parsed = parseEmoji(value);
    if (!parsed) { problems.push(`${key}: malformed syntax ${value}`); continue; }
    if (!known.has(parsed.id)) problems.push(`${key}: emoji ${parsed.id} not visible to the bot`);
    else if (known.get(parsed.id) !== parsed.name) {
      problems.push(`${key}: name mismatch (registry "${parsed.name}", Discord "${known.get(parsed.id)}")`);
    }
  }
  return problems;
}

module.exports = { EMOJIS, parseEmoji, validateEmojis };
