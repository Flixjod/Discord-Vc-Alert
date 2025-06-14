const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("✅ Bot is alive and vibing!"));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.User, Partials.GuildMember],
});

// Global toggle for alerts
let notificationsEnabled = true;

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("vcstatus")
    .setDescription("📡 Want the scoop? Check if voice notifications are ON or snoozin'."),

  new SlashCommandBuilder()
    .setName("vcon")
    .setDescription("🚀 Fire it up! Activate voice join alerts and welcome the crew in style."),

  new SlashCommandBuilder()
    .setName("vcoff")
    .setDescription("🛑 Power down! Silence the voice join alerts and keep things chill.")
].map(cmd => cmd.toJSON());

// Register slash commands
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

  try {
    console.log("📡 Registering slash commands...");
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
});

// Voice join/leave detection
client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!notificationsEnabled) return;

  const user = newState.member?.user || oldState.member?.user;
  if (!user || user.bot) return;

  const IGNORED_IDS = new Set(["684773505157431347", "1190991820637868042"]);
  if (IGNORED_IDS.has(user.id)) return;

  let textChannel;
  try {
    textChannel = await client.channels.fetch(process.env.TEXT_CHANNEL_ID);
  } catch {
    return;
  }

  if (!textChannel?.send) return;

  let embed;

  // Joined VC
  if (!oldState.channel && newState.channel) {
    embed = new EmbedBuilder()
      .setColor(0x00ffcc)
      .setAuthor({
        name: `${user.username} just popped in! 🔊`,
        iconURL: user.displayAvatarURL({ dynamic: true, size: 512 })
      })
      .setDescription(`🎧 **${user.username}** joined **${newState.channel.name}** — Let the vibes begin!`)
      .setFooter({
        text: "🎉 Welcome to the voice party!",
        iconURL: client.user.displayAvatarURL()
      })
      .setTimestamp();
  }

  // Left VC
  else if (oldState.channel && !newState.channel) {
    embed = new EmbedBuilder()
      .setColor(0xff5e5e)
      .setAuthor({
        name: `${user.username} dipped out! 🚪`,
        iconURL: user.displayAvatarURL({ dynamic: true, size: 512 })
      })
      .setDescription(`👋 **${user.username}** left **${oldState.channel.name}** — See ya next time!`)
      .setFooter({
        text: "💨 Gone but not forgotten.",
        iconURL: client.user.displayAvatarURL()
      })
      .setTimestamp();
  }

  if (embed) {
    try {
      const message = await textChannel.send({ embeds: [embed] });
      setTimeout(() => message.delete().catch(() => {}), 30_000);
    } catch (err) {
      console.error("❌ Failed to send embed:", err);
    }
  }
});

// Slash command logic
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  switch (commandName) {
    case "vcstatus":
      await interaction.reply({
        content: `📡 **VC Alert Status**\nVoice notifications are currently **${notificationsEnabled ? "🟢 ENABLED" : "🔴 DISABLED"}**.\n\nUse \`/vcon\` or \`/vcoff\` to toggle the vibe!`,
        ephemeral: true
      });
      break;

    case "vcon":
      notificationsEnabled = true;
      await interaction.reply({
        content: "✅ **VC Join Alerts ENABLED**\nLet the party begin! 🎉 Users joining voice channels will now be announced with style.",
        ephemeral: true
      });
      break;

    case "vcoff":
      notificationsEnabled = false;
      await interaction.reply({
        content: "🔕 **VC Join Alerts DISABLED**\nPeace and quiet restored. 🌙 No more join messages until you say so.",
        ephemeral: true
      });
      break;
  }
});

client.login(process.env.TOKEN).catch(err => {
  console.error("❌ Bot login failed:", err);
});
