'use strict';
const { SlashCommandBuilder } = require('discord.js');
const ui = require('../../components/common/ui');
const developers = require('../../config/developers');

const { E } = ui;

function render() {
  const ownerLines = developers.owner.map((id) => `${E.verified} <@${id}>`).join('\n');
  const modLines = developers.moderators.map((id) => `${E.verified} <@${id}>`).join('\n');
  return ui.message([
    `### ${E.ownerBadge} DEVELOPERS`,
    '-# Kurisu Security team',
    'sep',
    `${E.ownerBadge} **Owner**\n${ownerLines}`,
    'sep',
    `${E.modBadge} **Moderators**\n${modLines}`,
  ]);
}

module.exports = {
  category: 'utility',
  permission: 'None',
  examples: { '': '/dev' },
  data: new SlashCommandBuilder().setName('dev').setDescription('Show the Kurisu developer team.'),
  render,
  async execute(i) {
    return i.reply(render());
  },
};
