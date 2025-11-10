import express from "express";
import fs from "fs";
const fsp = fs.promises;
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  PermissionFlagsBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  AttachmentBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
  StreamType
} from "@discordjs/voice";
import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

// ---------- IMPORTANT: REQUIRED DEPENDENCIES ----------
try {
  await import('ffmpeg-static');
  await import('libsodium-wrappers');
  console.log("🔊 Soundboard dependencies (ffmpeg, libsodium) loaded.");
} catch (e) {
  console.warn("⚠️ Soundboard dependencies not found. Voice features will fail.");
  console.warn("Please run: npm install @discordjs/voice ffmpeg-static libsodium-wrappers");
}
// ----------------------------------------------------


// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const LOGS_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const MAX_SOUND_SIZE_MB = 5;

// ---------- Small-caps utility ----------
const SMALL_CAPS_MAP = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
  s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
  A: "ᴀ", B: "ʙ", C: "ᴄ", D: "ᴅ", E: "ᴇ", F: "ꜰ", G: "ɢ", H: "ʜ", I: "ɪ",
  J: "ᴊ", K: "ᴋ", L: "ʟ", M: "ᴍ", N: "ɴ", O: "ᴏ", P: "ᴘ", Q: "ǫ", R: "ʀ",
  S: "s", T: "ᴛ", U: "ᴜ", V: "ᴠ", W: "ᴡ", X: "x", Y: "ʏ", Z: "ᴢ",
  "0": "0","1": "1","2": "2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9",
  "!":"!","?":"?",".":".",",":",",":":":","'":"'",'"':'"','-':" - ", "_":"_",
  " ":" "
};
function toSmallCaps(text = "") {
  return String(text).split("").map(ch => SMALL_CAPS_MAP[ch] ?? ch).join("");
}

// ---------- Helper: pretty time / ago ----------
function toISTString(ts) {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).replace(",", "");
}
function fancyAgo(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (hr > 0) return `${hr}ʜ ${min % 60}ᴍ ᴀɢᴏ`;
  if (min > 0) return `${min}ᴍ ${sec % 60}ꜱ ᴀɢᴏ`;
  return `${sec}ꜱ ᴀɢᴏ`;
}

// ---------- Express health endpoint ----------
const app = express();
app.get("/", (_, res) => res.status(200).json({ status: "✅ ʙᴏᴛ ɪs ᴀʟɪᴠᴇ ᴀɴᴅ ᴠɪʙɪɴɢ" }));
app.listen(PORT, () => console.log(`🌐 ᴡᴇʙ sᴇʀᴠᴇʀ ʀᴜɴɴɪɴɢ ᴏɴ ᴘᴏʀt ${PORT}`));

// ---------- Mongoose Schema & Models ----------
const guildSettingsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  alertsEnabled: { type: Boolean, default: false },
  textChannelId: { type: String, default: null },
  joinAlerts: { type: Boolean, default: true },
  leaveAlerts: { type: Boolean, default: true },
  onlineAlerts: { type: Boolean, default: true },
  privateThreadAlerts: { type: Boolean, default: true },
  autoDelete: { type: Boolean, default: true },
  ignoredRoleId: { type: String, default: null },
  ignoreRoleEnabled: { type: Boolean, default: false }
}, { timestamps: true });

const GuildSettings = mongoose.model("GuildSettings", guildSettingsSchema);

const logSchema = new mongoose.Schema({
  guildId: String,
  guildName: String,
  user: String,
  channel: String,
  type: String,
  time: { type: Date, default: Date.now }
});
logSchema.index({ time: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }); // auto-delete 30 days
logSchema.index({ guildId: 1, time: -1 });
const GuildLog = mongoose.model("GuildLog", logSchema);

// --- Soundboard Schema ---
const soundboardSoundSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true }, // GridFS file ID
  uploaderId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
soundboardSoundSchema.index({ guildId: 1, name: 1 }, { unique: true }); // One sound per name per guild
const SoundboardSound = mongoose.model("SoundboardSound", soundboardSoundSchema);

// ---------- In-memory caches & debounced writer ----------
const guildSettingsCache = new Map();
const pendingSaveQueue = new Map();
let pendingSaveTimer = null;
function schedulePendingSaves() {
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(async () => {
    const entries = Array.from(pendingSaveQueue.entries());
    pendingSaveQueue.clear();
    pendingSaveTimer = null;
    await Promise.all(entries.map(async ([guildId, settings]) => {
      try {
        await GuildSettings.findOneAndUpdate(
          { guildId },
          settings,
          { upsert: true, setDefaultsOnInsert: true }
        ).exec();
      } catch (e) {
        console.error(`[DB SAVE] Failed to save settings for ${guildId}:`, e?.message ?? e);
      }
    }));
  }, 700);
}
async function updateGuildSettings(settings) {
  if (!settings || !settings.guildId) return;
  guildSettingsCache.set(settings.guildId, settings);
  pendingSaveQueue.set(settings.guildId, settings);
  schedulePendingSaves();
}
async function getGuildSettings(guildId) {
  const cached = guildSettingsCache.get(guildId);
  if (cached) return cached;
  let settings = await GuildSettings.findOne({ guildId }).lean().catch(() => null);
  if (!settings) {
    settings = {
      guildId,
      alertsEnabled: false,
      textChannelId: null,
      joinAlerts: true,
      leaveAlerts: true,
      onlineAlerts: true,
      privateThreadAlerts: true,
      autoDelete: true,
      ignoredRoleId: null,
      ignoreRoleEnabled: false
    };
    try {
      await new GuildSettings(settings).save();
    } catch (e) {
      if (e.code !== 11000) console.error(`[DB] Failed to save default for ${guildId}:`, e?.message ?? e);
    }
  }
  guildSettingsCache.set(guildId, settings);
  return settings;
}

// ---------- Helper: log creation ----------
async function addLog(type, user, channel, guild) {
  try {
    await GuildLog.create({
      guildId: guild.id ?? guild,
      guildName: guild.name ?? guild,
      user,
      channel,
      type,
      time: Date.now()
    });
  } catch (err) {
    console.error(`[MongoDB Log Error] ${err?.message ?? err}`);
  }
}

// ---------- Helper: generate activity file ----------
async function generateActivityFile(guild, logs) {
  const filePath = path.join(LOGS_DIR, `${guild.id}_activity.txt`);
  const header =
`╔══════════════════════════════════════════════╗
║       🌌 ${toSmallCaps(guild.name)} ᴀᴄᴛɪᴠɪᴛʏ ʟᴏɢꜱ       ║
║       🗓️ ɢᴇɴᴇʀᴀᴛᴇᴅ ᴏɴ ${toSmallCaps(toISTString(Date.now()))}   ║
╚══════════════════════════════════════════════╝

`;
  const body = logs.map(l => {
    const emoji = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
    const ago = fancyAgo(Date.now() - l.time);
    const action = l.type === "join" ? "entered" :
      l.type === "leave" ? "left" : "came online";
    return `${emoji} ${l.type === "join" ? "ᴊᴏɪɴ" : l.type === "leave" ? "ʟᴇᴀᴠᴇ" : "ᴏɴʟɪɴᴇ"} — ${l.user} ${action} ${l.channel}
  🕒 ${ago} • ${toISTString(l.time)}\n`;
  }).join("\n");
  await fsp.writeFile(filePath, header + body, "utf8");
  return filePath;
}

// ---------- Discord client ----------
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

// ---------- Embeds colors ----------
const EmbedColors = {
  SUCCESS: 0x1abc9c,
  ERROR: 0xe74c3c,
  WARNING: 0xffcc00,
  INFO: 0x5865f2,
  VC_JOIN: 0x00ffcc,
  VC_LEAVE: 0xff5e5e,
  ONLINE: 0x55ff55,
  RESET: 0x00ccff,
  SOUND: 0xf39c12
};

// ---------- Reusable embed builder (small-caps everywhere) ----------
function makeEmbed({ title, description, color = EmbedColors.INFO, guild }) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: toSmallCaps(title), iconURL: client.user?.displayAvatarURL() })
    .setDescription(toSmallCaps(description))
    .setFooter({
      text: (guild?.name ? toSmallCaps(guild.name) : toSmallCaps("VC ALERT CONTROL PANEL")),
      iconURL: guild?.iconURL ? (guild.iconURL({ dynamic: true }) || client.user.displayAvatarURL()) : client.user?.displayAvatarURL()
    })
    .setTimestamp();
  return e;
}

// ---------- Control Panel builder (small-caps labels) ----------
function buildControlPanel(settings, guild) {
  const embed = new EmbedBuilder()
    .setColor(settings.alertsEnabled ? EmbedColors.SUCCESS : EmbedColors.ERROR)
    .setAuthor({
      name: toSmallCaps("🎛️ VC ALERT CONTROL PANEL"),
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription(
      toSmallCaps(`**Your Central Hub for Voice Chat Alerts!** ✨\n\n`) +
      `> ${toSmallCaps("📢 Alerts Channel:")} ${settings.textChannelId ? `<#${settings.textChannelId}>` : toSmallCaps("Not set — assign one below!")}\n` +
      `> ${toSmallCaps("🔔 Status:")} ${settings.alertsEnabled ? toSmallCaps("🟢 Active! (All systems go)") : toSmallCaps("🔴 Disabled (Peace & quiet)")} \n` +
      `> ${toSmallCaps("👋 Join Alerts:")} ${settings.joinAlerts ? toSmallCaps("✅ On") : toSmallCaps("❌ Off")}\n` +
      `> ${toSmallCaps("🏃‍♂️ Leave Alerts:")} ${settings.leaveAlerts ? toSmallCaps("✅ On") : toSmallCaps("❌ Off")}\n` +
      `> ${toSmallCaps("🟢 Online Alerts:")} ${settings.onlineAlerts ? toSmallCaps("✅ On") : toSmallCaps("❌ Off")}\n` +
      `> ${toSmallCaps("🪪 Private Alerts:")} ${settings.privateThreadAlerts ? toSmallCaps("✅ On") : toSmallCaps("❌ Off")}\n` +
      `> ${toSmallCaps("🙈 Ignored Role:")} ${settings.ignoredRoleId ? `<@&${settings.ignoredRoleId}> (${settings.ignoreRoleEnabled ? toSmallCaps("✅ Active") : toSmallCaps("❌ Inactive")})` : toSmallCaps("None set")}\n` +
      `> ${toSmallCaps("🧹 Auto-Delete:")} ${settings.autoDelete ? toSmallCaps("✅ On (30s)") : toSmallCaps("❌ Off")}\n\n` +
      toSmallCaps("*Use the buttons below to fine-tune your settings instantly!* ⚙️")
    )
    .setFooter({ text: toSmallCaps(guild?.name || `Server ID: ${settings.guildId}`), iconURL: guild?.iconURL?.({ dynamic: true }) || client.user.displayAvatarURL() })
    .setTimestamp();

  // Buttons with small-caps labels
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('toggleJoinAlerts').setLabel(toSmallCaps('👋 Join')).setStyle(settings.joinAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('toggleLeaveAlerts').setLabel(toSmallCaps('🏃‍♂️ Leave')).setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('toggleOnlineAlerts').setLabel(toSmallCaps('🟢 Online')).setStyle(settings.onlineAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('togglePrivateThreads').setLabel(toSmallCaps('🪪 Private Alerts')).setStyle(settings.privateThreadAlerts ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('toggleIgnoreRole').setLabel(toSmallCaps('🙈 Ignore Alerts')).setStyle(settings.ignoreRoleEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('toggleAutoDelete').setLabel(toSmallCaps('🧹 Auto-Delete')).setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('resetSettings').setLabel(toSmallCaps('♻️ Reset Settings')).setStyle(ButtonStyle.Danger)
  );

  return { embed, buttons: [row1, row2] };
}

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("⚙️ ᴠɪᴇᴡ ᴀɴᴅ ᴍᴀɴᴀɢᴇ ᴠᴏɪᴄᴇ ᴀᴄᴛɪᴠɪᴛʏ ᴀɴᴅ ᴘʀᴇsᴇɴᴄᴇ ᴀʟᴇʀᴛs"),
  new SlashCommandBuilder()
    .setName("activate")
    .setDescription("🚀 ᴀᴄᴛɪᴠᴀᴛᴇ ᴠᴄ ᴀʟᴇʀᴛs")
    .addChannelOption(opt => opt.setName("channel").setDescription("Select a text channel to receive alerts").addChannelTypes(ChannelType.GuildText).setRequired(false)),
  new SlashCommandBuilder()
    .setName("deactivate")
    .setDescription("🛑 ᴅɪsᴀʙʟᴇ ᴀʟʟ ᴠᴄ ᴀʟᴇʀᴛs"),
  new SlashCommandBuilder()
    .setName("setignorerole")
    .setDescription("🙈 ɪɢɴᴏʀᴇ ᴀ ʀᴏʟᴇ ғʀᴏᴍ ᴀʟᴇʀᴛs")
    .addRoleOption(opt => opt.setName("role").setDescription("Role to ignore").setRequired(true)),
  new SlashCommandBuilder()
    .setName("resetignorerole")
    .setDescription("♻️ ʀᴇsᴇᴛ ɪɢɴᴏʀᴇ ʀᴏʟᴇ"),
  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("📜 ᴠɪᴇᴡ sᴇʀᴠᴇʀ ᴀᴄᴛɪᴠɪᴛʏ ʟᴏɢs")
    .addStringOption(opt => opt
      .setName("range")
      .setDescription("Select a time range")
      .setRequired(false)
      .addChoices(
        { name: "📅 Today", value: "today" },
        { name: "🕓 Yesterday", value: "yesterday" },
        { name: "📆 Last 7 days", value: "7days" },
        { name: "🗓️ Last 30 days", value: "30days" }
      ))
    .addUserOption(opt => opt.setName("user").setDescription("Select a user to view their logs").setRequired(false)),
  // --- Soundboard Commands ---
  new SlashCommandBuilder()
    .setName("soundboard")
    .setDescription("SOUNDBOARD 🔊 ᴏᴘᴇɴ ᴛʜᴇ sᴏᴜɴᴅʙᴏᴀʀᴅ ᴘᴀɴᴇʟ (ᴀᴅᴍɪɴ ᴏɴʟʏ)"),
  new SlashCommandBuilder()
    .setName("addsound")
    .setDescription("SOUNDBOARD ➕ ᴀᴅᴅ ᴀ ɴᴇᴡ sᴏᴜɴᴅ (ᴀᴅᴍɪɴ ᴏɴʟʏ)")
    .addStringOption(opt => opt
      .setName("name")
      .setDescription("ᴛʜᴇ ɴᴀᴍᴇ ғᴏʀ ᴛʜɪs sᴏᴜɴᴅ (ᴇ.ɢ., 'ʙʀᴜʜ')")
      .setRequired(true))
    .addAttachmentOption(opt => opt
      .setName("file")
      .setDescription("ᴛʜᴇ ᴀᴜᴅɪᴏ ғɪʟᴇ (ᴍᴀx 5ᴍʙ)")
      .setRequired(true))
].map(c => c.toJSON());

// ---------- Ready & register commands ----------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try { client.user.setActivity("the VC vibes unfold 🎧✨", { type: "WATCHING" }); } catch(e) {}
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Command registration error:", err);
  }
});

// ---------- Interaction handler ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) return;
    const guild = interaction.guild;
    const guildId = guild.id;

    // Chat input commands
    if (interaction.isChatInputCommand()) {
      let settings = await getGuildSettings(guildId);
      // UPDATED: Admin check for ALL slash commands
      if (!await checkAdmin(interaction)) return; 

      switch (interaction.commandName) {
        // ... [Existing cases: settings, activate, deactivate, setignorerole, resetignorerole, logs] ...
        // ⚙️ SETTINGS PANEL
        case "settings": {
          const panel = buildControlPanel(settings, guild);
          return interaction.reply({
            embeds: [panel.embed],
            components: panel.buttons,
            ephemeral: true,
          });
        }
      
        // 🚀 ACTIVATE VC ALERTS
        case "activate": {
          const selected = interaction.options.getChannel("channel");
          let channel = selected ?? (
            settings.textChannelId
              ? (guild.channels.cache.get(settings.textChannelId) ??
                 await guild.channels.fetch(settings.textChannelId).catch(() => null))
              : interaction.channel
          );
        
          if (!channel || channel.type !== ChannelType.GuildText) {
            return interaction.reply({
              embeds: [
                makeEmbed({
                  title: toSmallCaps("⚠️ invalid channel"),
                  description: toSmallCaps("please choose a **text channel** where i can post vc alerts.\ntry `/activate #channel` to set one manually 💬"),
                  color: EmbedColors.ERROR,
                  guild,
                }),
              ],
              ephemeral: true,
            });
          }
        
          const botMember = await guild.members.fetch(client.user.id).catch(() => null);
          if (!botMember) {
             return interaction.reply({
              embeds: [
                makeEmbed({
                  title: toSmallCaps("🚫 Error fetching bot member"),
                  description: toSmallCaps(`i couldn't verify my own permissions. please try again.`),
                  color: EmbedColors.ERROR,
                  guild,
                }),
              ],
              ephemeral: true,
            });
          }
          const perms = channel.permissionsFor(botMember);
          if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
            return interaction.reply({
              embeds: [
                makeEmbed({
                  title: toSmallCaps("🚫 missing permissions"),
                  description: toSmallCaps(`i need **view** + **send** permissions in ${channel} to post vc alerts.\nplease fix that and try again 🔧`),
                  color: EmbedColors.ERROR,
                  guild,
                }),
              ],
              ephemeral: true,
            });
          }
        
          if (settings.alertsEnabled && settings.textChannelId === channel.id) {
            return interaction.reply({
              embeds: [
                makeEmbed({
                  title: toSmallCaps("🟢 vc alerts already active"),
                  description: toSmallCaps(`alerts are already running in ${channel} ⚡\nuse \`/settings\` to tweak or customize them.`),
                  color: EmbedColors.WARNING,
                  guild,
                }),
              ],
              ephemeral: true,
            });
          }
        
          settings.alertsEnabled = true;
          settings.textChannelId = channel.id;
          await updateGuildSettings(settings);
        
          return interaction.reply({
            embeds: [
              makeEmbed({
                title: toSmallCaps("✅ vc alerts activated"),
                description: toSmallCaps(`vibe monitor engaged! 🎧\nall voice activity will now appear in ${channel}.\nuse \`/settings\` to fine-tune your alerts ✨`),
                color: EmbedColors.SUCCESS,
                guild,
              }),
            ],
            ephemeral: true,
          });
        }
      
        // 🔕 DEACTIVATE VC ALERTS
        case "deactivate": {
          if (!settings.alertsEnabled) {
            return interaction.reply({
              embeds: [
                makeEmbed({
                  title: toSmallCaps("💤 vc alerts already off"),
                  description: toSmallCaps("they’re already paused 😴\nuse `/activate` when you’re ready to bring the vibes back."),
                  color: EmbedColors.WARNING,
                  guild,
                }),
              ],
              ephemeral: true,
            });
          }
        
          settings.alertsEnabled = false;
          await updateGuildSettings(settings);
        
          return interaction.reply({
            embeds: [
              makeEmbed({
                title: toSmallCaps("🔕 vc alerts powered down"),
                description: toSmallCaps("taking a chill break 🪷\nno join or leave pings until you power them up again with `/activate`."),
                color: EmbedColors.ERROR,
                guild,
              }),
            ],
            ephemeral: true,
          });
        }
      
        // 🙈 SET IGNORED ROLE
        case "setignorerole": {
          const role = interaction.options.getRole("role");
          settings.ignoredRoleId = role.id;
          settings.ignoreRoleEnabled = true;
          await updateGuildSettings(settings);
        
          return interaction.reply({
            embeds: [
              makeEmbed({
                title: toSmallCaps("🙈 ignored role set"),
                description: toSmallCaps(`members with the ${role} role will now be skipped in vc alerts 🚫\nperfect for staff, bots, or background lurkers 😌`),
                color: EmbedColors.RESET,
                guild,
              }),
            ],
            ephemeral: true,
          });
        }
      
        // 👀 RESET IGNORED ROLE
        case "resetignorerole": {
          settings.ignoredRoleId = null;
          settings.ignoreRoleEnabled = false;
          await updateGuildSettings(settings);
        
          return interaction.reply({
            embeds: [
              makeEmbed({
                title: toSmallCaps("👀 ignored role cleared"),
                description: toSmallCaps("everyone’s back on the radar 🌍\nall members will now appear in vc alerts again 💫"),
                color: EmbedColors.RESET,
                guild,
              }),
            ],
            ephemeral: true,
          });
        }

        case "logs": {
          await interaction.deferReply({ ephemeral: true });
        
          const range = interaction.options.getString("range");
          const user = interaction.options.getUser("user");
          
          // TODO: Implement actual filtering
          const logs = await GuildLog.find({ guildId: guild.id }).sort({ time: -1 }).limit(20).lean();
        
          if (logs.length === 0) {
              return interaction.editReply({
                  embeds: [makeEmbed({
                      title: "No recent activity found",
                      description: "no matching logs were found for your query.",
                      color: EmbedColors.INFO,
                      guild
                  })]
              });
          }
        
          const desc = logs.map(l => {
              const emoji = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
              const ago = fancyAgo(Date.now() - l.time);
              const action = l.type === "join" ? "entered" : l.type === "leave" ? "left" : "came online";
              return toSmallCaps(`**${emoji} ${l.type.toUpperCase()}** — ${l.user} ${action} ${l.channel}\n> 🕒 ${ago} • ${toISTString(l.time)}`);
          }).join("\n\n");
        
          const embed = new EmbedBuilder()
              .setColor(0x2b2d31)
              .setAuthor({ name: toSmallCaps(`${guild.name} recent activity`), iconURL: guild.iconURL({dynamic: true}) })
              .setDescription(desc)
              .setFooter({ text: toSmallCaps(`Showing latest ${logs.length} entries • Server: ${guild.name}`) })
              .setTimestamp();
        
          const filePath = await generateActivityFile(guild, logs);
          
          await interaction.followUp({
              embeds: [embed],
              files: [{ attachment: filePath, name: `${guild.name}_activity.txt` }],
              ephemeral: false
          });
          await interaction.deleteReply().catch(() => {});
          break;
        }

        // --- /addsound ---
        case "addsound": {
          if (!bucket) {
            return interaction.reply({ embeds: [makeEmbed({ title: "Database Error", description: "GridFS is not initialized. Please try again later.", color: EmbedColors.ERROR, guild })], ephemeral: true });
          }
          await interaction.deferReply({ ephemeral: true });
          
          const name = interaction.options.getString("name").toLowerCase().replace(/[^a-z0-9_]/g, '-').slice(0, 30);
          const file = interaction.options.getAttachment("file");
          
          // Validation
          const existing = await SoundboardSound.findOne({ guildId, name });
          if (existing) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "Name Taken", description: `a sound named \`${name}\` already exists. please choose a different name or delete the old one.`, color: EmbedColors.ERROR, guild })] });
          }
          
          const allowedTypes = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/opus'];
          if (!file.contentType || !allowedTypes.includes(file.contentType)) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "Invalid File Type", description: `this file type (${file.contentType}) is not supported.\nplease upload an \`mp3\`, \`ogg\`, \`wav\`, or \`voice message\`.`, color: EmbedColors.ERROR, guild })] });
          }
          
          if (file.size > MAX_SOUND_SIZE_MB * 1024 * 1024) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "File Too Large", description: `this file is too large (${(file.size / 1024 / 1024).toFixed(2)}mb).\nthe limit is \`${MAX_SOUND_SIZE_MB}mb\`.`, color: EmbedColors.ERROR, guild })] });
          }
          
          try {
            // Download file and upload to GridFS
            const response = await fetch(file.url);
            if (!response.ok || !response.body) {
              throw new Error("Failed to download file from Discord.");
            }
            
            const uploadStream = bucket.openUploadStream(file.filename, {
              metadata: { guildId: guild.id, uploaderId: interaction.user.id, name: name, contentType: file.contentType }
            });
            
            await new Promise((resolve, reject) => {
              response.body.pipe(uploadStream)
                .on('finish', resolve)
                .on('error', reject);
            });

            // Save reference to Mongoose
            await SoundboardSound.create({
              guildId,
              name,
              fileId: uploadStream.id,
              uploaderId: interaction.user.id
            });
            
            return interaction.editReply({ embeds: [makeEmbed({ title: "✅ Sound Added!", description: `your new sound \`${name}\` has been added to the soundboard.`, color: EmbedColors.SUCCESS, guild })] });
            
          } catch (e) {
            console.error("[AddSound Error]", e);
            return interaction.editReply({ embeds: [makeEmbed({ title: "Upload Failed", description: `something went wrong while saving your sound. please try again.\n\n\`${e.message}\``, color: EmbedColors.ERROR, guild })] });
          }
        }

        // --- /soundboard ---
        case "soundboard": {
          await interaction.deferReply({ ephemeral: true });
          
          const sounds = await SoundboardSound.find({ guildId }).limit(25).sort({ name: 1 }).lean();
          
          if (sounds.length === 0) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "Soundboard is Empty", description: "no sounds have been added yet!\nuse `/addsound <name> <file>` to add one.", color: EmbedColors.INFO, guild })] });
          }

          const embed = new EmbedBuilder()
            .setColor(EmbedColors.SOUND)
            .setAuthor({ name: toSmallCaps("🔊 Server Soundboard"), iconURL: guild.iconURL() || client.user.displayAvatarURL() })
            .setDescription(toSmallCaps(sounds.length > 0 ? "select a sound to play or delete from the menus below." : "use `/addsound` to get started!"))
            .setFooter({ text: toSmallCaps(`${sounds.length} sound(s) loaded • ${guild.name}`)})
            .setTimestamp();
            
          const playOptions = sounds.map(s => 
            new StringSelectMenuOptionBuilder()
              .setLabel(s.name)
              .setValue(`play_${s._id.toString()}`)
              .setEmoji('▶️')
          );
          
          const deleteOptions = sounds.map(s => 
            new StringSelectMenuOptionBuilder()
              .setLabel(s.name)
              .setValue(`del_${s._id.toString()}`)
              .setEmoji('❌')
          );
          
          const playMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('soundboard_action')
              .setPlaceholder(toSmallCaps('▶️ ᴘʟᴀʏ ᴀ sᴏᴜɴᴅ...'))
              .setOptions(playOptions)
          );
          
          const deleteMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('soundboard_admin')
              .setPlaceholder(toSmallCaps('❌ ᴀᴅᴍɪɴ: ᴅᴇʟᴇᴛᴇ ᴀ sᴏᴜɴᴅ...'))
              .setOptions(deleteOptions)
          );
          
          return interaction.editReply({ embeds: [embed], components: [playMenu, deleteMenu] });
        }
      }
    }

    // Button interactions
    if (interaction.isButton()) {
      if (!await checkAdmin(interaction)) return;
      
      await interaction.deferUpdate();

      let settingsToUpdate = await getGuildSettings(guildId); 

      switch (interaction.customId) {
        // ... [Existing button cases] ...
        case "toggleLeaveAlerts":
          settingsToUpdate.leaveAlerts = !settingsToUpdate.leaveAlerts;
          break;
        case "toggleJoinAlerts":
          settingsToUpdate.joinAlerts = !settingsToUpdate.joinAlerts;
          break;
        case "toggleOnlineAlerts":
          settingsToUpdate.onlineAlerts = !settingsToUpdate.onlineAlerts;
          break;
        case "togglePrivateThreads":
          settingsToUpdate.privateThreadAlerts = !settingsToUpdate.privateThreadAlerts;
          break;
        case "toggleAutoDelete":
          settingsToUpdate.autoDelete = !settingsToUpdate.autoDelete;
          break;
        case "toggleIgnoreRole":
          settingsToUpdate.ignoreRoleEnabled = !settingsToUpdate.ignoreRoleEnabled;
          break;
        case "resetSettings": {
          const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("confirmReset")
              .setLabel("✅ Yes, Reset")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("cancelReset")
              .setLabel("❌ No, Cancel")
              .setStyle(ButtonStyle.Secondary)
          );
        
          return interaction.editReply({
            embeds: [
              makeEmbed({
                title: "⚠️ Confirm Reset",
                description:
                  "You are about to **reset all VC alert settings** to default. 🪷\n" +
                  "This will remove custom channels, ignored roles, and alert preferences.\n\n" +
                  "Do you want to proceed?",
                color: EmbedColors.WARNING,
                guild,
              })
            ],
            components: [confirmRow]
          });
        }
        case "confirmReset": {
          try {
            await GuildSettings.deleteOne({ guildId });
            guildSettingsCache.delete(guildId);
            const newSettings = await getGuildSettings(guildId);
            const panel = buildControlPanel(newSettings, guild);
          
            await interaction.editReply({
              embeds: [panel.embed],
              components: panel.buttons,
            });

            await interaction.followUp({
              content: "🎉 **VC Alert Settings Reset!**\nAll settings have been restored to their default values. ✅",
              ephemeral: true,
            });

          } catch (e) {
            console.error(`[RESET ERROR] ${e?.message || e}`);
            await interaction.followUp({
              content: "❌ Something went wrong while resetting. Please try again later.",
              ephemeral: true,
            });
          }
          return;
        }
      
        case "cancelReset": {
          const currentSettings = await getGuildSettings(guildId);
          const panel = buildControlPanel(currentSettings, guild);
        
          await interaction.editReply({
            embeds: [panel.embed],
            components: panel.buttons,
          });

          return;
        }
        default:
          return;
      }

      await updateGuildSettings(settingsToUpdate);
      const updatedPanel = buildControlPanel(settingsToUpdate, guild);
      return interaction.editReply({ embeds: [updatedPanel.embed], components: updatedPanel.buttons });
    }
    
    // --- Select Menu Handler ---
    if (interaction.isStringSelectMenu()) {
      // UPDATED: Admin check for ALL menu interactions (play and delete)
      if (!await checkAdmin(interaction)) return;
      
      await interaction.deferUpdate(); // Acknowledge the interaction
      
      const [action, soundId] = interaction.values[0].split('_');
      
      if (!soundId) return; // Invalid value
      
      // --- Handle Sound Deletion (Admin) ---
      if (interaction.customId === 'soundboard_admin' && action === 'del') {
        // Admin check already passed above
        try {
          const sound = await SoundboardSound.findById(soundId);
          if (!sound) {
            return interaction.followUp({ embeds: [makeEmbed({ title: "Error", description: "this sound could not be found. it might have already been deleted.", color: EmbedColors.ERROR, guild })], ephemeral: true });
          }
          
          await bucket.delete(sound.fileId); // Delete from GridFS
          await SoundboardSound.deleteOne({ _id: soundId }); // Delete from Mongo
          
          await interaction.followUp({ embeds: [makeEmbed({ title: "✅ Sound Deleted", description: `\`${sound.name}\` has been permanently removed.`, color: EmbedColors.SUCCESS, guild })], ephemeral: true });
          
          // Refresh the panel
          const sounds = await SoundboardSound.find({ guildId }).limit(25).sort({ name: 1 }).lean();
          const embed = new EmbedBuilder()
            .setColor(EmbedColors.SOUND)
            .setAuthor({ name: toSmallCaps("🔊 Server Soundboard"), iconURL: guild.iconURL() || client.user.displayAvatarURL() })
            .setDescription(toSmallCaps(sounds.length > 0 ? "select a sound to play or delete from the menus below." : "all sounds have been deleted!"))
            .setFooter({ text: toSmallCaps(`${sounds.length} sound(s) loaded • ${guild.name}`)})
            .setTimestamp();
            
          const playOptions = sounds.map(s => new StringSelectMenuOptionBuilder().setLabel(s.name).setValue(`play_${s._id.toString()}`).setEmoji('▶️'));
          const deleteOptions = sounds.map(s => new StringSelectMenuOptionBuilder().setLabel(s.name).setValue(`del_${s._id.toString()}`).setEmoji('❌'));
          
          const playMenu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('soundboard_action').setPlaceholder(toSmallCaps('▶️ ᴘʟᴀʏ ᴀ sᴏᴜɴᴅ...')).setOptions(playOptions.length > 0 ? playOptions : [{label: 'empty', value: 'empty', emoji: '🕳️'}]).setDisabled(sounds.length === 0));
          const deleteMenu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('soundboard_admin').setPlaceholder(toSmallCaps('❌ ᴀᴅᴍɪɴ: ᴅᴇʟᴇᴛᴇ ᴀ sᴏᴜɴᴅ...')).setOptions(deleteOptions.length > 0 ? deleteOptions : [{label: 'empty', value: 'empty', emoji: '🕳️'}]).setDisabled(sounds.length === 0));

          return interaction.editReply({ embeds: [embed], components: [playMenu, deleteMenu] });
          
        } catch (e) {
          console.error("[Sound Delete Error]", e);
          return interaction.followUp({ embeds: [makeEmbed({ title: "Error", description: `failed to delete sound: \`${e.message}\``, color: EmbedColors.ERROR, guild })], ephemeral: true });
        }
      }
      
      // --- Handle Sound Playing (Admin) ---
      if (interaction.customId === 'soundboard_action' && action === 'play') {
        // Admin check already passed above
        const member = interaction.member;
        const voiceChannel = member.voice.channel;
        
        if (!voiceChannel) {
          return interaction.followUp({ embeds: [makeEmbed({ title: "No VC Detected", description: "you must be in a voice channel to play a sound.", color: EmbedColors.ERROR, guild })], ephemeral: true });
        }
        
        const sound = await SoundboardSound.findById(soundId).lean();
        if (!sound) {
          return interaction.followUp({ embeds: [makeEmbed({ title: "Error", description: "could not find that sound. it may have been deleted.", color: EmbedColors.ERROR, guild })], ephemeral: true });
        }
        
        try {
          let connection = getVoiceConnection(guild.id);
          
          if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
            connection.destroy();
            connection = null;
          }

          if (!connection) {
            connection = joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
            });
          }

          const player = createAudioPlayer();
          const downloadStream = bucket.openDownloadStream(sound.fileId);
          const resource = createAudioResource(downloadStream);
          
          connection.subscribe(player);
          player.play(resource);
          
          if (voiceInactivityTimers.has(guild.id)) {
            clearTimeout(voiceInactivityTimers.get(guild.id));
            voiceInactivityTimers.delete(guild.id);
          }
          
          player.on(AudioPlayerStatus.Idle, () => {
            const timeout = setTimeout(() => {
              const conn = getVoiceConnection(guild.id);
              if (conn) conn.destroy();
              voiceInactivityTimers.delete(guild.id);
            }, 5 * 60 * 1000); // 5 minutes
            voiceInactivityTimers.set(guild.id, timeout);
          });
          
          player.on('error', (e) => {
            console.error(`[AudioPlayer Error] ${e.message}`);
            interaction.followUp({ embeds: [makeEmbed({ title: "Playback Error", description: `failed to play \`${sound.name}\`: \`${e.message}\``, color: EmbedColors.ERROR, guild })], ephemeral: true });
          });
          
          return interaction.followUp({ embeds: [makeEmbed({ title: `▶️ Playing Sound`, description: `now playing \`${sound.name}\` in ${voiceChannel}`, color: EmbedColors.SOUND, guild })], ephemeral: true });
          
        } catch (e) {
           console.error("[Sound Play Error]", e);
          return interaction.followUp({ embeds: [makeEmbed({ title: "Error", description: `failed to play sound: \`${e.message}\``, color: EmbedColors.ERROR, guild })], ephemeral: true });
        }
      }
    }

  } catch (err) {
    console.error("[Interaction Handler] Error:", err?.stack ?? err?.message ?? err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: toSmallCaps("An error occurred while processing your request."), ephemeral: true });
      } else if (interaction && (interaction.replied || interaction.deferred)) {
        await interaction.followUp({ content: toSmallCaps("An error occurred while processing your request."), ephemeral: true });
      }
    } catch (_) {}
  }
});



// ---------- Voice state handling & thread management ----------
const activeVCThreads = new Map(); // VC.id => thread
const threadDeletionTimeouts = new Map(); // VC.id => timeout ID
const THREAD_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes
const voiceInactivityTimers = new Map(); // guildId => Timeout (for soundboard)

async function fetchTextChannel(guild, channelId) {
  try {
    let ch = guild.channels.cache.get(channelId);
    if (!ch) ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased()) return null;
    return ch;
  } catch {
    return null;
  }
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const user = newState.member?.user ?? oldState.member?.user;
    if (!user || user.bot) return;

    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const settings = await getGuildSettings(guild.id);
    if (!settings || !settings.alertsEnabled || !settings.textChannelId) return;

    const member = newState.member ?? oldState.member;
    if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member?.roles?.cache?.has(settings.ignoredRoleId)) return;

    // Ignore VC switch (move)
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) return;

    const logChannel = await fetchTextChannel(guild, settings.textChannelId);
    if (!logChannel) {
      console.error(`[VC Alert] ❌ Could not fetch log channel ${settings.textChannelId} for ${guild.id}`);
      return;
    }

    const avatar = user.displayAvatarURL?.({ dynamic: true });
    let embed;

    // ---- JOIN ----
    if (!oldState.channelId && newState.channelId && settings.joinAlerts) {
      await addLog("join", user.tag, newState.channel?.name || "-", guild);
      embed = new EmbedBuilder()
        .setColor(EmbedColors.VC_JOIN)
        .setAuthor({ name: toSmallCaps(`${user.username} just popped in! 🔊`), iconURL: avatar })
        .setDescription(toSmallCaps(`🎧 ${user.username} joined ${newState.channel.name} — let the vibes begin!`))
        .setFooter({ text: toSmallCaps("🎉 welcome to the voice party!"), iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
    }

    // ---- LEAVE ----
    else if (oldState.channelId && !newState.channelId && settings.leaveAlerts) {
      await addLog("leave", user.tag, oldState.channel?.name || "-", guild);
      embed = new EmbedBuilder()
        .setColor(EmbedColors.VC_LEAVE)
        .setAuthor({ name: toSmallCaps(`${user.username} dipped out! 🏃‍♂️`), iconURL: avatar })
        .setDescription(toSmallCaps(`👋 ${user.username} left ${oldState.channel.name} — see ya next time!`))
        .setFooter({ text: toSmallCaps("💨 gone but not forgotten."), iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
    } else return;

    const vc = newState.channel ?? oldState.channel;
    if (!vc) return;

    const everyoneRole = vc.guild.roles.everyone;
    const isPrivateVC = everyoneRole ? !vc.permissionsFor(everyoneRole).has(PermissionsBitField.Flags.ViewChannel) : false;

    // ---- PRIVATE VC THREAD HANDLING (Fast version for single server) ----
    if (isPrivateVC && settings.privateThreadAlerts) {
      let thread = activeVCThreads.get(vc.id);
    
      const threadValid = thread && !thread.archived && thread.id && logChannel.threads.cache.has(thread.id);
      if (!threadValid) {
        try {
          const Vc_Name = vc.name.length > 25 ? vc.name.slice(0, 25) + "…" : vc.name;

          thread = await logChannel.threads.create({
            name: `🔊│${Vc_Name} • Vc-Alerts`,
            autoArchiveDuration: 1440,
            type: ChannelType.PrivateThread,
            reason: `Private VC alert thread for ${vc.name}`,
          });
          activeVCThreads.set(vc.id, thread);
          console.log(`[VC Thread] 🧵 Created new private thread for ${vc.name}`);
        } catch (err) {
          console.error(`[VC Alert] ❌ Failed to create thread for ${vc.name}:`, err.message);
          return;
        }
      }
    
      if (threadDeletionTimeouts.has(vc.id)) {
        clearTimeout(threadDeletionTimeouts.get(vc.id));
        threadDeletionTimeouts.delete(vc.id);
      }
      const timeoutId = setTimeout(async () => {
        try {
          await thread.delete().catch(() => {});
          console.log(`[VC Thread] 🗑️ Deleted thread for ${vc.name} (inactive).`);
        } catch {}
        activeVCThreads.delete(vc.id);
        threadDeletionTimeouts.delete(vc.id);
      }, THREAD_INACTIVITY_MS);
      threadDeletionTimeouts.set(vc.id, timeoutId);
    
      try {
        const members = await vc.guild.members.fetch();
        const visible = members.filter(
          m => !m.user.bot && vc.permissionsFor(m).has(PermissionsBitField.Flags.ViewChannel)
        );
      
        const addPromises = visible.map(m =>
          !thread.members.cache.has(m.id)
            ? thread.members.add(m.id).catch(err => {
                console.warn(`[VC Thread] ⚠️ Failed to add ${m.user.tag}:`, err.message);
              })
            : null
        );
      
        await Promise.allSettled(addPromises);
      
        const msg = await thread.send({ embeds: [embed] }).catch(err => {
          console.warn(`[VC Thread] ⚠️ Failed to send message in ${vc.name}:`, err.message);
        });
      
        if (msg && settings.autoDelete) {
          setTimeout(() => msg.delete().catch(() => {}), 30_000);
        }
      
      } catch (err) {
        console.error(`[VC Thread] ❌ Error while handling ${vc.name}:`, err.message);
      }
    }

    // ---- PUBLIC ALERTS ----
    else {
      const msg = await logChannel.send({ embeds: [embed] }).catch(e => console.warn(`[VC Alert] ⚠️ Send failed in ${vc.name}:`, e.message));
      if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000);
    }

  } catch (e) {
    console.error("[voiceStateUpdate] Error:", e?.stack ?? e?.message ?? e);
  }
});



// ---------- Presence (online) handler ----------
client.on("presenceUpdate", async (oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (!member || member.user.bot || newPresence.status !== "online" || oldPresence?.status === "online") return;

    const settings = await getGuildSettings(member.guild.id);
    if (!settings?.alertsEnabled || !settings.onlineAlerts || !settings.textChannelId) return;
    if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member.roles.cache.has(settings.ignoredRoleId)) return;

    const channel = await fetchTextChannel(member.guild, settings.textChannelId);
    if (!channel) {
      console.error(`[Online Alert] Failed to fetch log channel ${settings.textChannelId} for guild ${member.guild.id}`);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(EmbedColors.ONLINE)
      .setAuthor({ name: toSmallCaps(`${member.user.username} just came online! 🟢`), iconURL: member.user.displayAvatarURL({ dynamic: true }) })
      .setDescription(toSmallCaps(`👀 ${member.user.username} is now online — something's cooking!`))
      .setFooter({ text: toSmallCaps("✨ Ready to vibe!"), iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    await addLog("online", member.user.tag, "-", member.guild);
    const msg = await channel.send({ embeds: [embed] }).catch(e => console.warn(`Failed to send online alert for ${member.user.username}:`, e?.message ?? e));
    if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000);
  } catch (e) {
    console.error("[presenceUpdate] Handler error:", e?.stack ?? e?.message ?? e);
  }
});

// ---------- Permission helper (UPDATED) ----------
async function checkAdmin(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  
  // Check for Admin or Manage Guild permissions
  const hasPermission =
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild);

  if (!hasPermission) {
    const replyPayload = { 
      embeds: [makeEmbed({ 
        title: "No Permission", 
        description: "You need Administrator or Manage Server permission to use this.", 
        color: EmbedColors.ERROR, 
        guild 
      })], 
      ephemeral: true 
    };
    
    // Reply or followUp depending on interaction state
    if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyPayload);
    } else {
        await interaction.reply(replyPayload);
    }
    return false;
  }
  // User has permission
  return true;
}


// ---------- Graceful shutdown ----------
async function shutdown(signal) {
  try {
    console.log(`[Shutdown] Received ${signal}. Cleaning up...`);
    // Clear all voice connections
    client.guilds.cache.forEach(guild => {
      getVoiceConnection(guild.id)?.destroy();
    });
    voiceInactivityTimers.forEach(clearTimeout);
    voiceInactivityTimers.clear();
    
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer);
      pendingSaveTimer = null;
    }
    if (pendingSaveQueue.size > 0) {
      const entries = Array.from(pendingSaveQueue.entries());
      pendingSaveQueue.clear();
      await Promise.all(entries.map(([guildId, settings]) =>
        GuildSettings.findOneAndUpdate({ guildId }, settings, { upsert: true, setDefaultsOnInsert: true }).exec().catch(e => console.error(`[DB] Shutdown save failed for ${guildId}:`, e?.message ?? e))
      ));
    }
    for (const t of threadDeletionTimeouts.values()) clearTimeout(t);
    threadDeletionTimeouts.clear();
    activeVCThreads.clear();
    await mongoose.disconnect().catch(() => {});
    try { await client.destroy(); } catch (_) {}
    console.log("[Shutdown] Completed. Exiting.");
    process.exit(0);
  } catch (err) {
    console.error("[Shutdown] Error during shutdown:", err);
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ---------- Connect to MongoDB and login ----------
let bucket; // GridFS bucket
(async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI not provided in .env");
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "Discord-Alert-Bot"
    });
    console.log("✅ MongoDB Connected to DB");
    
    // --- Initialize GridFS Bucket ---
    mongoose.connection.once('open', () => {
      bucket = new GridFSBucket(mongoose.connection.db, {
        bucketName: 'soundboard'
      });
      console.log('✅ GridFS Bucket "soundboard" initialized.');
    });

  } catch (e) {
    console.error("❌ MongoDB connection error:", e?.message ?? e);
    process.exit(1);
  }

  if (!process.env.TOKEN) {
    console.error("❌ TOKEN not set in .env");
    process.exit(1);
  }
  client.login(process.env.TOKEN).catch(err => console.error("❌ Login failed:", err));
})();