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

// In-memory toggle (global)
let notificationsEnabled = true;

// Slash commands with attractive descriptions
const commands = [
  new SlashCommandBuilder()
    .setName("vcstatus")
    .setDescription("🔍 Check whether voice join alerts are active or chillin'."),

  new SlashCommandBuilder()
    .setName("vcon")
    .setDescription("🔔 Turn ON voice channel join alerts — let the vibes roll!"),

  new SlashCommandBuilder()
    .setName("vcoff")
    .setDescription("🔕 Turn OFF voice channel join alerts — take a break from the noise.")
].map(cmd => cmd.toJSON());

// Register slash commands at startup
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

// Handle voice join events
client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!notificationsEnabled) return;
  if (!oldState.channel && newState.channel) {
    const user = newState.member?.user;
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

    const embed = new EmbedBuilder()
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

    try {
      const message = await textChannel.send({ embeds: [embed] });
      setTimeout(() => message.delete().catch(() => {}), 30_000);
    } catch (err) {
      console.error("❌ Failed to send voice join embed:", err);
    }
  }
});

// Handle slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  switch (commandName) {
    case "vcstatus":
      await interaction.reply({
        content: `🔔 Voice notifications are currently **${notificationsEnabled ? "ENABLED" : "DISABLED"}**.`,
        ephemeral: true
      });
      break;

    case "vcon":
      notificationsEnabled = true;
      await interaction.reply({
        content: "✅ Voice join notifications have been **ENABLED**. Let the party begin!",
        ephemeral: true
      });
      break;

    case "vcoff":
      notificationsEnabled = false;
      await interaction.reply({
        content: "🔕 Voice join notifications have been **DISABLED**. Silence mode on.",
        ephemeral: true
      });
      break;
  }
});

client.login(process.env.TOKEN).catch(err => {
  console.error("❌ Bot login failed:", err);
});
