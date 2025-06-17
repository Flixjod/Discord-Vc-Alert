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
  ButtonStyle,
  Events
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
  alertsEnabled: { type: Boolean, default: true },
  textChannelId: { type: String, default: null },
  autoDelete: { type: Boolean, default: true },
  leaveAlerts: { type: Boolean, default: true },
  joinAlerts: { type: Boolean, default: true },
  onlineAlerts: { type: Boolean, default: true },
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.User, Partials.GuildMember]
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("vcstatus")
    .setDescription("📡 View and control VC/online alerts."),
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
    .setDescription("🛑 Disable all alerts.")
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

const buildControlPanel = (settings, guild) => {
  const embed = new EmbedBuilder()
    .setColor(settings.alertsEnabled ? 0x1abc9c : 0xe74c3c)
    .setAuthor({
      name: "🎛️ VC Alert Control Panel",
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription(
      `> 📢 **Alert Channel:** ${settings.textChannelId ? `<#${settings.textChannelId}>` : "Not set"}\n` +
      `> 🔔 **Alerts Status:** ${settings.alertsEnabled ? "🟢 Enabled" : "🔴 Disabled"}\n` +
      `> 👋 **Join Alerts:** ${settings.joinAlerts ? "✅ On" : "❌ Off"}\n` +
      `> 🚪 **Leave Alerts:** ${settings.leaveAlerts ? "✅ On" : "❌ Off"}\n` +
      `> 🟢 **Online Alerts:** ${settings.onlineAlerts ? "✅ On" : "❌ Off"}\n` +
      `> 🧹 **Auto-Delete:** ${settings.autoDelete ? "✅ On (30s)" : "❌ Off"}\n\n` +
      `Use the buttons below to customize your settings on the fly! ⚙️`
    )
    .setFooter({
      text: guild?.name || `Server ID: ${settings.guildId}`,
      iconURL: guild?.iconURL({ dynamic: true }) || client.user.displayAvatarURL()
    })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("toggle_joinalerts")
      .setEmoji("👋")
      .setLabel(`Join Alerts: ${settings.joinAlerts ? "ON" : "OFF"}`)
      .setStyle(settings.joinAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("toggle_leavealerts")
      .setEmoji("🚪")
      .setLabel(`Leave Alerts: ${settings.leaveAlerts ? "ON" : "OFF"}`)
      .setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("toggle_onlinealerts")
      .setEmoji("🟢")
      .setLabel(`Online Alerts: ${settings.onlineAlerts ? "ON" : "OFF"}`)
      .setStyle(settings.onlineAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("toggle_autodelete")
      .setEmoji("🧹")
      .setLabel(`Auto-Delete: ${settings.autoDelete ? "ON" : "OFF"}`)
      .setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("open_reset_confirm")
      .setEmoji("♻️")
      .setLabel("Reset Settings")
      .setStyle(ButtonStyle.Danger)
  );

  return { embed, rows: [row1, row2] };
};

function buildEmbedReply(title, description, color) {
  return new EmbedBuilder()
    .setColor(color || 0x5865f2)
    .setAuthor({ name: title, iconURL: client.user?.displayAvatarURL() || "" })
    .setDescription(description)
    .setFooter({ text: "🔧 VC Alert Control Panel", iconURL: client.user?.displayAvatarURL() || "" })
    .setTimestamp();
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.inGuild()) return;

  const guild = interaction.guild;
  const guildId = guild.id;

  let settings = await GuildSettings.findOne({ guildId });
  if (!settings) {
    settings = new GuildSettings({ guildId });
    await settings.save();
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "vcstatus") {
      const { embed, rows } = buildControlPanel(settings, guild);
      return interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
    }

    if (interaction.commandName === "vcon") {
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const targetChannelId = channel.id;

      const permissions = channel.permissionsFor(client.user);
      if (!permissions?.has("ViewChannel") || !permissions.has("SendMessages")) {
        return interaction.reply({
          embeds: [buildEmbedReply("🚫 Permission Error", "I can't send messages in that channel.", 0xff4444)],
          ephemeral: true
        });
      }

      if (settings.alertsEnabled && settings.textChannelId === targetChannelId) {
        return interaction.reply({
          embeds: [buildEmbedReply("⚠️ Already Enabled", `Alerts are already active in <#${targetChannelId}>!`, 0xffcc00)],
          ephemeral: true
        });
      }

      settings.alertsEnabled = true;
      settings.textChannelId = targetChannelId;
      await settings.save();

      return interaction.reply({
        embeds: [buildEmbedReply("✅ Alerts ENABLED", `VC alerts will be sent to <#${targetChannelId}> 🎉`, 0x00ff88)],
        ephemeral: true
      });
    }

    if (interaction.commandName === "vcoff") {
      if (!settings.alertsEnabled) {
        return interaction.reply({
          embeds: [buildEmbedReply("⚠️ Already Disabled", "VC alerts are already turned off. 🌙", 0xffcc00)],
          ephemeral: true
        });
      }

      settings.alertsEnabled = false;
      await settings.save();

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4444)
            .setAuthor({ name: "VC Alerts Powered Down 🔕", iconURL: client.user.displayAvatarURL() })
            .setDescription("🚫 No more **join**, **leave**, or **online** alerts.\nUse `/vcon` to re-enable anytime!")
            .setFooter({ text: "🔧 VC Alert Control Panel", iconURL: client.user.displayAvatarURL() })
            .setTimestamp()
        ],
        ephemeral: true
      });
    }
  }

  // Button interactions
  if (interaction.isButton()) {
    switch (interaction.customId) {
      case "toggle_autodelete":
        settings.autoDelete = !settings.autoDelete;
        break;
      case "toggle_leavealerts":
        settings.leaveAlerts = !settings.leaveAlerts;
        break;
      case "toggle_joinalerts":
        settings.joinAlerts = !settings.joinAlerts;
        break;
      case "toggle_onlinealerts":
        settings.onlineAlerts = !settings.onlineAlerts;
        break;

      case "open_reset_confirm":
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_reset").setLabel("✅ Confirm Reset").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("cancel_reset").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );

        return interaction.update({
          embeds: [buildEmbedReply("⚠️ Confirm Settings Reset", "Are you sure you want to reset all VC alert settings to default?", 0xffcc00)],
          components: [confirmRow]
        });

      case "confirm_reset":
        settings.alertsEnabled = true;
        settings.textChannelId = null;
        settings.autoDelete = true;
        settings.leaveAlerts = true;
        settings.joinAlerts = true;
        settings.onlineAlerts = true;
        await settings.save();

        const resetEmbed = buildEmbedReply("✅ Settings Reset", "All settings have been restored to default. 🎯", 0x00ccff);
        const resetPanel = buildControlPanel(settings, interaction.guild);
        return interaction.update({ embeds: [resetEmbed, resetPanel.embed], components: resetPanel.rows });

      case "cancel_reset":
        const cancelPanel = buildControlPanel(settings, interaction.guild);
        return interaction.update({ embeds: [cancelPanel.embed], components: cancelPanel.rows });
    }

    await settings.save();
    const updated = buildControlPanel(settings, interaction.guild);
    return interaction.update({ embeds: [updated.embed], components: updated.rows });
  }
});

// VC join/leave alert
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild.id;
  const user = newState.member?.user || oldState.member?.user;
  if (!guildId || !user || user.bot) return;

  const settings = await GuildSettings.findOne({ guildId });
  if (!settings?.alertsEnabled || !settings.textChannelId) return;

  const channel = await client.channels.fetch(settings.textChannelId).catch(() => null);
  if (!channel?.send) return;

  let embed = null;
  if (!oldState.channel && newState.channel && settings.joinAlerts) {
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
    const msg = await channel.send({ embeds: [embed] }).catch(() => null);
    if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000);
  }
});

// Online alert
client.on("presenceUpdate", async (oldPresence, newPresence) => {
  const member = newPresence.member;
  if (!member || member.user.bot) return;

  const wasOffline = oldPresence?.status === "offline";
  const isNowOnline = newPresence.status === "online";

  if (!wasOffline || !isNowOnline) return;

  const settings = await GuildSettings.findOne({ guildId: member.guild.id });
  if (!settings?.alertsEnabled || !settings.onlineAlerts || !settings.textChannelId) return;

  const channel = await client.channels.fetch(settings.textChannelId).catch(() => null);
  if (!channel?.send) return;

  const embed = new EmbedBuilder()
    .setColor(0x55ff55)
    .setAuthor({ name: `${member.user.username} just came online! 🟢`, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
    .setDescription(`👀 **${member.user.username}** is now online — something's cooking!`)
    .setFooter({ text: "✨ Ready to vibe!", iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000);
});

client.login(process.env.TOKEN).catch(err => console.error("❌ Login failed:", err));