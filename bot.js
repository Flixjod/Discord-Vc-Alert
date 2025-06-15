const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const mongoose = require("mongoose");
require("dotenv").config();

// Web server
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.status(200).json({ status: "✅ Bot is alive and vibing!" }));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// MongoDB schema
const guildSettingsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  alertsEnabled: { type: Boolean, default: false },
  textChannelId: { type: String, default: null },
  autoDelete: { type: Boolean, default: true },
  leaveAlerts: { type: Boolean, default: true }
});
const GuildSettings = mongoose.model("guildsettings", guildSettingsSchema);

// Connect MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => {
    console.error("❌ MongoDB error:", err.message);
    process.exit(1);
  });

// Discord client
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

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Command registration error:", err);
  }
});

const buildEmbedReply = (title, description, color) => {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "🔧 VC Alert Control Panel", iconURL: client.user.displayAvatarURL() })
    .setTimestamp();
};

// Interaction handler
client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName, guildId, channelId, options } = interaction;
    if (!guildId) return;

    let settings = await GuildSettings.findOne({ guildId });
    if (!settings) {
      settings = new GuildSettings({ guildId });
      await settings.save();
    }

    switch (commandName) {
      case "vcstatus": {
        const embed = new EmbedBuilder()
          .setColor(settings.alertsEnabled ? 0x1abc9c : 0xe74c3c)
          .setAuthor({
            name: "🎛️ VC Alert Control Panel",
            iconURL: client.user.displayAvatarURL()
          })
          .setDescription(
            `> 🔔 **Voice Alerts:** ${settings.alertsEnabled ? "🟢 Enabled" : "🔴 Disabled"}\n` +
            `> 🚪 **Leave Alerts:** ${settings.leaveAlerts ? "✅ On" : "❌ Off"}\n` +
            `> 🧹 **Auto-Delete:** ${settings.autoDelete ? "✅ On (30s)" : "❌ Off"}\n\n` +
            `Use the buttons below to customize your settings on the fly! ⚙️`
          )
          .setFooter({
            text: interaction.guild?.icon ? interaction.guild.name : `Server ID: ${interaction.guildId}`,
            iconURL: interaction.guild?.iconURL({ dynamic: true }) || client.user.displayAvatarURL()
          })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("toggle_autodelete")
            .setEmoji("🧹")
            .setLabel(settings.autoDelete ? "Auto-Delete: ON" : "Auto-Delete: OFF")
            .setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId("toggle_leavealerts")
            .setEmoji("🚪")
            .setLabel(settings.leaveAlerts ? "Leave Alerts: ON" : "Leave Alerts: OFF")
            .setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

        await interaction.reply({
          embeds: [embed],
          components: settings.alertsEnabled ? [row] : [],
          ephemeral: true
        });
        break;
      }

      case "vcon": {
        const mentionedChannel = options.getChannel("channel");
        const targetChannelId = mentionedChannel?.id || settings.textChannelId || channelId;

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
        if (!settings.alertsEnabled) {
          return interaction.reply({
            embeds: [
              buildEmbedReply("⚠️ Already Disabled", "VC alerts are already turned off. 🌙", 0xffcc00)
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
                iconURL: client.user.displayAvatarURL()
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
  }

  if (interaction.isButton()) {
    const { guildId, customId } = interaction;
    const settings = await GuildSettings.findOne({ guildId });
    if (!settings) return;

    if (customId === "toggle_autodelete") {
      settings.autoDelete = !settings.autoDelete;
    } else if (customId === "toggle_leavealerts") {
      settings.leaveAlerts = !settings.leaveAlerts;
    }
    await settings.save();

    const embed = new EmbedBuilder()
      .setColor(settings.alertsEnabled ? 0x1abc9c : 0xe74c3c)
      .setAuthor({
        name: "🎛️ VC Alert Control Panel",
        iconURL: client.user.displayAvatarURL()
      })
      .setDescription(
        `> 🔔 **Voice Alerts:** ${settings.alertsEnabled ? "🟢 Enabled" : "🔴 Disabled"}\n` +
        `> 🚪 **Leave Alerts:** ${settings.leaveAlerts ? "✅ On" : "❌ Off"}\n` +
        `> 🧹 **Auto-Delete:** ${settings.autoDelete ? "✅ On (30s)" : "❌ Off"}\n\n` +
        `Use the buttons below to customize your settings on the fly! ⚙️`
      )
      .setFooter({ text: `Server ID: ${guildId}`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("toggle_autodelete")
        .setEmoji("🧹")
        .setLabel(settings.autoDelete ? "Auto-Delete: ON" : "Auto-Delete: OFF")
        .setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("toggle_leavealerts")
        .setEmoji("🚪")
        .setLabel(settings.leaveAlerts ? "Leave Alerts: ON" : "Leave Alerts: OFF")
        .setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );

    await interaction.update({
      embeds: [embed],
      components: [row]
    });
  }
});

// Voice event
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  const user = newState.member?.user || oldState.member?.user;
  if (!guildId || !user || user.bot) return;

  const settings = await GuildSettings.findOne({ guildId });
  if (!settings?.alertsEnabled || !settings.textChannelId) return;

  if (new Set(["684773505157431347", "1190991820637868042"]).has(user.id)) return;

  const channel = await client.channels.fetch(settings.textChannelId).catch(() => null);
  if (!channel || !channel.send) return;

  let embed;
  if (!oldState.channel && newState.channel) {
    embed = new EmbedBuilder()
      .setColor(0x00ffcc)
      .setAuthor({ name: `${user.username} just popped in! 🔊`, iconURL: user.displayAvatarURL({ dynamic: true }) })
      .setDescription(`🎧 **${user.username}** joined **${newState.channel.name}** — Let the vibes begin!`)
      .setFooter({ text: "🎉 Welcome to the voice party!", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
  } else if (oldState.channel && !newState.channel && settings.leaveAlerts) {
    embed = new EmbedBuilder()
      .setColor(0xff5e5e)
      .setAuthor({ name: `${user.username} dipped out! 🚪`, iconURL: user.displayAvatarURL({ dynamic: true }) })
      .setDescription(`👋 **${user.username}** left **${oldState.channel.name}** — See ya next time!`)
      .setFooter({ text: "💨 Gone but not forgotten.", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
  }

  if (embed) {
    try {
      const msg = await channel.send({ embeds: [embed] });
      if (settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000);
    } catch (err) {
      console.error("❌ VC message error:", err);
    }
  }
});

client.login(process.env.TOKEN).catch(err => console.error("❌ Login failed:", err));