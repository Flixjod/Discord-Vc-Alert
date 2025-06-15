const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType
} = require("discord.js");
const mongoose = require("mongoose");
require("dotenv").config();

// Web server for uptime
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.status(200).json({ status: "✅ Bot is alive and vibing!" }));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// MongoDB connection
const guildSettingsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  alertsEnabled: { type: Boolean, default: false },
  textChannelId: { type: String, default: null }
});
const GuildSettings = mongoose.model("guildsettings", guildSettingsSchema);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });


// Create client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.User, Partials.GuildMember]
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("vcstatus")
    .setDescription("📡 Check if voice notifications are ON or OFF."),

  new SlashCommandBuilder()
    .setName("vcon")
    .setDescription("🚀 Enable voice join/leave alerts.")
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel for VC alerts")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("vcoff")
    .setDescription("🛑 Disable voice join/leave alerts.")
].map(cmd => cmd.toJSON());

// Register slash commands
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
});

// Helper: Embed builder
const buildEmbedReply = (title, description, color) => {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "🔧 VC Alert Control Panel", iconURL: client.user.displayAvatarURL() })
    .setTimestamp();
};

// Slash command handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, channelId, options } = interaction;

  switch (commandName) {
    case "vcstatus": {
      const settings = await GuildSettings.findOne({ guildId }) || {};
      const enabled = settings.enabled ?? false;
      await interaction.reply({
        embeds: [
          buildEmbedReply(
            "📡 VC Alert Status",
            `Voice notifications are currently **${enabled ? "🟢 ENABLED" : "🔴 DISABLED"}**.\n\nUse \`/vcon\` or \`/vcoff\` to control the vibe.`,
            enabled ? 0x00ff88 : 0xff4444
          )
        ],
        ephemeral: true
      });
      break;
    }

    case "vcon": {
      const mentionedChannel = options.getChannel("channel");
      let settings = await GuildSettings.findOne({ guildId });

      if (!settings) {
        settings = new GuildSettings({ guildId });
      }

      // Use provided channel, or fallback to saved one, or use current channel
      const targetChannelId = mentionedChannel?.id || settings.textChannelId || channelId;

      // Already enabled and same channel
      if (settings.alertsEnabled && settings.textChannelId === targetChannelId) {
        return interaction.reply({
          embeds: [
            buildEmbedReply(
              "⚠️ Already Enabled",
              `Voice alerts are already active in <#${targetChannelId}>! 🎧`,
              0xffcc00
            )
          ],
          ephemeral: true
        });
      }

      // Update settings
      settings.alertsEnabled = true;
      settings.textChannelId = targetChannelId;
      await settings.save();

      await interaction.reply({
        embeds: [
          buildEmbedReply(
            "✅ VC Join/Leave Alerts ENABLED",
            `Users joining or leaving voice channels will now be announced in <#${targetChannelId}>. 🎉`,
            0x00ff88
          )
        ],
        ephemeral: true
      });
      break;
    }


    case "vcoff": {
      const settings = await GuildSettings.findOne({ guildId });
      if (!settings || !settings.alertsEnabled) {
        return interaction.reply({
          embeds: [
            buildEmbedReply(
              "⚠️ Already Disabled",
              "VC alerts are already turned off. 🌙",
              0xffcc00
            )
          ],
          ephemeral: true
        });
      }

      settings.alertsEnabled = false;
      await settings.save();

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4444)
            .setAuthor({
              name: "VC Alerts Powered Down 🔕",
              iconURL: interaction.client.user.displayAvatarURL()
            })
            .setDescription("🚫 Voice alerts have been turned off!\n\nNo more **join** or **leave** messages — pure peace and quiet. 🌙\n\nUse `/vcon` to fire them back up anytime!")
            .setFooter({ text: "🔧 VC Alert Control Panel", iconURL: client.user.displayAvatarURL() })
            .setTimestamp()
        ],
        ephemeral: true
      });
      break;
    }
  }
});

// VC join/leave tracking
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;

  const settings = await GuildSettings.findOne({ guildId });
  if (!settings?.enabled || !settings.channelId) return;

  const user = newState.member?.user || oldState.member?.user;
  if (!user || user.bot) return;

  const IGNORED_IDS = new Set(["684773505157431347", "1190991820637868042"]);
  if (IGNORED_IDS.has(user.id)) return;

  let textChannel;
  try {
    textChannel = await client.channels.fetch(settings.channelId);
  } catch {
    return;
  }
  if (!textChannel?.send) return;

  let embed;

  if (!oldState.channel && newState.channel) {
    embed = new EmbedBuilder()
      .setColor(0x00ffcc)
      .setAuthor({
        name: `${user.username} just popped in! 🔊`,
        iconURL: user.displayAvatarURL({ dynamic: true, size: 512 })
      })
      .setDescription(`🎧 **${user.username}** joined **${newState.channel.name}** — Let the vibes begin!`)
      .setFooter({ text: "🎉 Welcome to the voice party!", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
  } else if (oldState.channel && !newState.channel) {
    embed = new EmbedBuilder()
      .setColor(0xff5e5e)
      .setAuthor({
        name: `${user.username} dipped out! 🚪`,
        iconURL: user.displayAvatarURL({ dynamic: true, size: 512 })
      })
      .setDescription(`👋 **${user.username}** left **${oldState.channel.name}** — See ya next time!`)
      .setFooter({ text: "💨 Gone but not forgotten.", iconURL: client.user.displayAvatarURL() })
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

client.login(process.env.TOKEN).catch(err => {
  console.error("❌ Bot login failed:", err);
});