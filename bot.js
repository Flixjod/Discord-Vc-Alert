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
  alertsEnabled: { type: Boolean, default: false },
  textChannelId: { type: String, default: null },
  joinAlerts: { type: Boolean, default: true },
  leaveAlerts: { type: Boolean, default: true },
  onlineAlerts: { type: Boolean, default: true },
  autoDelete: { type: Boolean, default: true }
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
  
  client.user.setActivity("the VC vibes unfold 🎧✨", { type: "WATCHING" });
  
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
      `> 📢 **Alerts Channel:** ${settings.textChannelId ? `<#${settings.textChannelId}>` : "Not set"}\n` +
      `> 🔔 **Alerts Status:** ${settings.alertsEnabled ? "🟢 Enabled" : "🔴 Disabled"}\n` +
      `> 👋 **Join Alerts:** ${settings.joinAlerts ? "✅ On" : "❌ Off"}\n` +
      `> 🏃‍♂️ **Leave Alerts:** ${settings.leaveAlerts ? "✅ On" : "❌ Off"}\n` +
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
      .setCustomId('toggleJoinAlerts')
      .setLabel('👋 Join')
      .setStyle(settings.joinAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('toggleLeaveAlerts')
      .setLabel('🏃‍♂️ Leave')
      .setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('toggleOnlineAlerts')
      .setLabel('🟢 Online')
      .setStyle(settings.onlineAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('toggleAutoDelete')
      .setLabel('🧹 Auto-Delete')
      .setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('resetSettings')
      .setLabel('♻️ Reset Settings')
      .setStyle(ButtonStyle.Danger)
  );

  return { embed, components: [row1, row2] };
};

function buildEmbedReply(title, description, color, guild) {
  return new EmbedBuilder()
    .setColor(color || 0x5865f2)
    .setAuthor({ name: title, iconURL: client.user?.displayAvatarURL() || "" })
    .setDescription(description)
    .setFooter({
      text: "VC Alert Control Panel",
      iconURL: guild.iconURL({ dynamic: true }) || client.user.displayAvatarURL()})
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
      const { embed, components } = buildControlPanel(settings, guild);
      interaction.reply({ embeds: [embed], components, ephemeral: true });
    }

    if (interaction.commandName === "vcon") {
      const selectedChannel = interaction.options.getChannel("channel");
      const savedChannel = settings.textChannelId
        ? await interaction.guild.channels.fetch(settings.textChannelId).catch(() => null)
        : null;

      const channel = selectedChannel || savedChannel || interaction.channel;

      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({
          embeds: [buildEmbedReply(
            "❌ Channel Missing",
            `Hmm... I couldn't find a valid text channel to send alerts to.\n\nTry using:</br>• \`/vcon #your-channel\` to specify one\n• Or make sure the saved one still exists.`,
            0xff4444,
            guild
          )],
          ephemeral: true
        });
      }

      const permissions = channel.permissionsFor(client.user);
      if (!permissions?.has("ViewChannel") || !permissions.has("SendMessages")) {
        return interaction.reply({
          embeds: [buildEmbedReply(
            "🚫 No Permission",
            `I can’t post in <#${channel.id}>. Please make sure I have **View Channel** and **Send Messages** permission there.`,
            0xff4444,
            guild
          )],
          ephemeral: true
        });
      }

      if (settings.alertsEnabled && settings.textChannelId === channel.id) {
        return interaction.reply({
          embeds: [buildEmbedReply(
            "⚠️ Already On",
            `VC alerts are **already active** in <#${channel.id}> 🔊\n\nUse \`/vcstatus\` to manage join, leave, and online alerts. Or change the channel with \`/vcon #new-channel\`.`,
            0xffcc00,
            guild
          )],
          ephemeral: true
        });
      }

      settings.alertsEnabled = true;
      settings.textChannelId = channel.id;
      await settings.save();

      return interaction.reply({
        embeds: [buildEmbedReply(
          "✅ VC Alerts Enabled",
          `You're all set! I’ll now post voice activity in <#${channel.id}> 🎙️\n\nUse \`/vcstatus\` anytime to tweak the vibe — join, leave, and online alerts are all customizable. ✨`,
          0x00ff88,
          guild
        )],
        ephemeral: true
      });
    }

    if (interaction.commandName === "vcoff") {
      if (!settings.alertsEnabled) {
        return interaction.reply({
          embeds: [buildEmbedReply("⚠️ Already Disabled", "VC alerts are already turned off. 🌙", 0xffcc00, guild)],
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
      case "toggleLeaveAlerts":
        settings.leaveAlerts = !settings.leaveAlerts;
        break;
      case "toggleJoinAlerts":
        settings.joinAlerts = !settings.joinAlerts;
        break;
      case "toggleOnlineAlerts":
        settings.onlineAlerts = !settings.onlineAlerts;
        break;
      case "toggleAutoDelete":
        settings.autoDelete = !settings.autoDelete;
        break;
      case "resetSettings":
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirmReset").setLabel("✅ Confirm Reset").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("cancelReset").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );

        return interaction.update({
          embeds: [buildEmbedReply("⚠️ Confirm Settings Reset", "Are you sure you want to reset all VC alert settings to default?", 0xffcc00, interaction.guild)],
          components: [confirmRow]
        });

      case "confirmReset":
        await GuildSettings.deleteOne({ guildId });
        settings = new GuildSettings({ guildId });
        await settings.save(); // ✅ Save the reset settings

        const resetEmbed = buildEmbedReply(
          "✅ Settings Reset",
          "All settings have been restored to default. 🎯",
          0x00ccff,
          interaction.guild
        );
        const resetPanel = buildControlPanel(settings, interaction.guild);
        return interaction.update({
          embeds: [resetEmbed, resetPanel.embed],
          components: resetPanel.components
        });

      case "cancelReset":
        const cancelPanel = buildControlPanel(settings, interaction.guild);
        return interaction.update({
          embeds: [cancelPanel.embed],
          components: cancelPanel.components
        });
    }

    await settings.save();
    const { embed, components } = buildControlPanel(settings, guild);
    interaction.reply({ embeds: [embed], components, ephemeral: true });
  }
});

// VC join/leave alert
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild.id;
  const user = newState.member?.user || oldState.member?.user;
  const displayName = newState.member?.displayName || oldState.member?.displayName || user.username;
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
      .setAuthor({ name: `${user.username} dipped out! 🏃‍♂️`, iconURL: user.displayAvatarURL({ dynamic: true }) })
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

  if (newPresence.status !== "online") return;

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