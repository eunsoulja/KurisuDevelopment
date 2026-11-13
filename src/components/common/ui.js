'use strict';
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, SectionBuilder, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, ChannelType,
} = require('discord.js');
const { EMOJIS, parseEmoji } = require('../../config/emojis');

const E = EMOJIS;
const text = (s) => new TextDisplayBuilder().setContent(String(s).slice(0, 3800));
const sep = (divider = true) => new SeparatorBuilder().setDivider(divider).setSpacing(SeparatorSpacingSize.Small);

/** Resolve a registry key to a button/select emoji object, or undefined to omit it. Never returns a raw emoji string. */
function btnEmoji(key) {
  const value = EMOJIS[key];
  if (!value) {
    console.warn(`[ui] missing emoji registry key: ${key}`);
    return undefined;
  }
  const parsed = parseEmoji(value);
  if (!parsed) {
    console.warn(`[ui] malformed emoji registry value for ${key}: ${value}`);
    return undefined;
  }
  return parsed;
}

/** Secondary (grey) button only. Never any other style. Use `emoji` (registry key) for the icon; labels stay plain text. */
function btn(customId, label, { disabled = false, emoji } = {}) {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(String(label)).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const em = typeof emoji === 'string' ? btnEmoji(emoji) : emoji;
  if (em) b.setEmoji(em);
  return b;
}
/** Secondary (grey) button whose face is a custom emoji instead of text. Pass a registry value or an emoji object; never falls back to printing a raw emoji string. */
function emojiBtn(customId, emoji, { disabled = false } = {}) {
  const parsed = typeof emoji === 'string' ? parseEmoji(emoji) : emoji;
  const b = new ButtonBuilder().setCustomId(customId).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  if (parsed && parsed.id && parsed.name) b.setEmoji(parsed);
  else if (typeof emoji === 'string') console.warn(`[ui] emojiBtn: unrenderable emoji value omitted: ${emoji}`);
  return b;
}
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const buttons = (...bs) => row(...bs);

function select(customId, placeholder, options, { min = 1, max = 1, disabled = false } = {}) {
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(min).setMaxValues(max).setDisabled(disabled);
  menu.addOptions(options.map((o) => {
    const opt = { label: String(o.label).slice(0, 100), value: o.value, default: !!o.default };
    if (o.description) opt.description = String(o.description).slice(0, 100);
    const em = typeof o.emoji === 'string' ? (EMOJIS[o.emoji] ? btnEmoji(o.emoji) : parseEmoji(o.emoji)) : o.emoji;
    if (em && em.id && em.name) opt.emoji = em;
    return opt;
  }));
  return row(menu);
}
function userSelect(customId, placeholder, { max = 1 } = {}) {
  return row(new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(max));
}
function roleSelect(customId, placeholder, { max = 1 } = {}) {
  return row(new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(max));
}
function channelSelect(customId, placeholder) {
  return row(new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1));
}

/**
 * Build a single Container from items:
 *   string               -> TextDisplay
 *   'sep' | 'sep:blank'  -> Separator (divider / spacing only)
 *   ActionRowBuilder     -> action row
 *   { section: text, thumbnail: url } | { section: text, button: ButtonBuilder }
 *   { media: url }       -> media gallery (images and animated GIFs)
 * No accent colour is ever set.
 */
function container(items) {
  const c = new ContainerBuilder();
  for (const it of items.filter(Boolean)) {
    if (typeof it === 'string') {
      if (it === 'sep') c.addSeparatorComponents(sep(true));
      else if (it === 'sep:blank') c.addSeparatorComponents(sep(false));
      else c.addTextDisplayComponents(text(it));
    } else if (it instanceof ActionRowBuilder) c.addActionRowComponents(it);
    else if (it.section) {
      const s = new SectionBuilder().addTextDisplayComponents(text(it.section));
      if (it.thumbnail) s.setThumbnailAccessory(new ThumbnailBuilder().setURL(it.thumbnail));
      else if (it.button) s.setButtonAccessory(it.button);
      c.addSectionComponents(s);
    } else if (it.media) {
      c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(it.media)));
    }
  }
  return c;
}

const V2 = MessageFlags.IsComponentsV2;
/** Payload for a new reply / followUp / send. */
const message = (items, { ephemeral = false } = {}) => ({
  components: [container(items)],
  flags: ephemeral ? V2 | MessageFlags.Ephemeral : V2,
  allowedMentions: { parse: [], repliedUser: false },
});
/** Payload for update() / editReply() (ephemeral flag cannot be changed on edit). */
const edit = (items) => ({ components: [container(items)], flags: V2, allowedMentions: { parse: [], repliedUser: false } });

/** One-line compact notice, used for command feedback and errors. */
const notice = (emoji, line, opts) => message([`${emoji} ${line}`], opts);
const error = (line) => message([`${E.redDot} ${line}`], { ephemeral: true });

async function respond(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    const { flags, ...rest } = payload;
    return interaction.editReply({ ...rest, flags: V2 });
  }
  return interaction.reply(payload);
}

module.exports = { E, text, sep, btn, btnEmoji, emojiBtn, row, buttons, select, userSelect, roleSelect, channelSelect, container, message, edit, notice, error, respond, V2 };
