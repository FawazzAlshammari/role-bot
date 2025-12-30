require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const COMMAND_NAME = 'رولي'; // غيّرها إلى roles إذا تبي

const commands = [
  new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('لوحة رولك الشخصي (إنشاء/تعديل/تبديل رول لشخص)')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commands Registered');
  } catch (err) {
    console.error('❌ Deploy error:', err);
  }
})();
