import express from "express";
import fs from "fs";
// const fsp = fs.promises; // <- No longer needed
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
  AttachmentBuilder
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
// import { GridFSBucket } from "mongodb"; // <- No longer needed
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
const MAX_SOUND_SIZE_MB = 5; // We can still keep this check
const SOUNDS_PER_PAGE = 15;

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

// --- Soundboard Schema (Stores URL) ---
const soundboardSoundSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  url: { type: String, required: true }, // Stores the Discord CDN URL or external URL
  uploaderId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
soundboardSoundSchema.index({ guildId: 1, name: 1 }, { unique: true });
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
  // We need fsp for this one function
  await fs.promises.writeFile(filePath, header + body, "utf8");
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

// ---------- Soundboard Panel Builder ----------
async function buildSoundboardPanel(guild, page, isDeleteMode) {
  const totalSounds = await SoundboardSound.countDocuments({ guildId: guild.id });
  const totalPages = Math.ceil(totalSounds / SOUNDS_PER_PAGE) || 1;
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1); // Clamp page number

  const sounds = await SoundboardSound.find({ guildId: guild.id })
    .sort({ name: 1 })
    .skip(currentPage * SOUNDS_PER_PAGE)
    .limit(SOUNDS_PER_PAGE)
    .lean();

  const embed = new EmbedBuilder()
    .setColor(isDeleteMode ? EmbedColors.ERROR : EmbedColors.SOUND)
    .setAuthor({
      name: toSmallCaps(isDeleteMode ? "❌ ᴅᴇʟᴇᴛᴇ ᴍᴏᴅᴇ ❌" : "🔊 sᴏᴜɴᴅʙᴏᴀʀᴅ ᴘᴀɴᴇʟ"),
      iconURL: guild.iconURL() || client.user.displayAvatarURL()
    })
    .setDescription(toSmallCaps(
      isDeleteMode
      ? "click any red sound button below to delete it.\nthis is permanent! click 'cancel' to exit."
      : "click a button to play a sound in your vc.\nuse the controls to navigate or delete sounds."
    ))
    .setFooter({ text: toSmallCaps(`ᴘᴀɢᴇ ${currentPage + 1} / ${totalPages} • ${totalSounds} ᴛᴏᴛᴀʟ sᴏᴜɴᴅs`) });

  const components = [];
  let buttonRows = [];
  
  // Create sound buttons (up to 3 rows of 5)
  if (sounds.length > 0) {
    let currentRow = new ActionRowBuilder();
    for (const sound of sounds) {
      if (currentRow.components.length === 5) {
        buttonRows.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
      currentRow.addComponents(
        new ButtonBuilder()
          .setCustomId(isDeleteMode ? `sound_delete_${sound._id}` : `sound_play_${sound._id}`)
          .setLabel(sound.name.slice(0, 80)) // Button labels have 80 char limit
          .setStyle(isDeleteMode ? ButtonStyle.Danger : ButtonStyle.Secondary)
      );
    }
    buttonRows.push(currentRow); // Add the last row
  }
  
  components.push(...buttonRows);

  // Pagination Row
  const pageRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sound_page_first_${isDeleteMode}`)
      .setLabel("«")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`sound_page_prev_${currentPage}_${isDeleteMode}`)
      .setLabel("‹")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("sound_page_info")
      .setLabel(`Page ${currentPage + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`sound_page_next_${currentPage}_${isDeleteMode}`)
      .setLabel("›")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`sound_page_last_${totalPages - 1}_${isDeleteMode}`)
      .setLabel("»")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage >= totalPages - 1)
  );
  components.push(pageRow);

  // Action Row
  const actionRow = new ActionRowBuilder().addComponents(
    isDeleteMode
      ? new ButtonBuilder()
          .setCustomId(`sound_cancel_delete_${currentPage}`)
          .setLabel("ᴄᴀɴᴄᴇʟ ᴅᴇʟᴇᴛᴇ ᴍᴏᴅᴇ")
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(`sound_toggle_delete_${currentPage}`)
          .setLabel("ᴅᴇʟᴇᴛᴇ ᴀ sᴏᴜɴᴅ")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("sound_add_new")
      .setLabel("ᴀᴅᴅ sᴏᴜɴᴅ")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`sound_refresh_${currentPage}_${isDeleteMode}`)
      .setLabel("ʀᴇғʀᴇsʜ")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Primary)
  );
  components.push(actionRow);

  return { embeds: [embed], components, ephemeral: true };
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
  // --- Soundboard Commands (UPDATED) ---
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
      .setDescription("ᴛʜᴇ ᴀᴜᴅɪᴏ ғɪʟᴇ ᴏʀ ᴀ ᴠᴏɪᴄᴇ ᴍᴇssᴀɢᴇ (ᴍᴀx 5ᴍʙ)")
      .setRequired(false)) // <- No longer required
    .addStringOption(opt => opt
      .setName("link")
      .setDescription("ᴀ ᴅɪʀᴇᴄᴛ ʟɪɴᴋ ᴛᴏ ᴀ sᴏᴜɴᴅ ғɪʟᴇ (ᴍᴘ3, ᴏɢɢ, ᴡᴀᴠ)")
      .setRequired(false)) // <- New option
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
      if (!await checkAdmin(interaction)) return; 

      switch (interaction.commandName) {
        // ... [Existing cases: settings, activate, deactivate, setignorerole, resetignorerole, logs] ...
        // ⚙️ SETTINGS PANEL
        case "settings": {
          let settings = await getGuildSettings(guildId);
          const panel = buildControlPanel(settings, guild);
          return interaction.reply({
            embeds: [panel.embed],
            components: panel.buttons,
            ephemeral: true,
          });
        }
      
        // 🚀 ACTIVATE VC ALERTS
        case "activate": {
          let settings = await getGuildSettings(guildId);
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
          let settings = await getGuildSettings(guildId);
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
          let settings = await getGuildSettings(guildId);
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
          let settings = await getGuildSettings(guildId);
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
          
          // TODO: Implement actual filtering based on range/user
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

        // --- /addsound (UPDATED) ---
        case "addsound": {
          await interaction.deferReply({ ephemeral: true });
          
          const name = interaction.options.getString("name").toLowerCase().replace(/[^a-z0-9_]/g, '-').slice(0, 30);
          const file = interaction.options.getAttachment("file");
          const link = interaction.options.getString("link");
          
          // --- Validation ---
          if (!file && !link) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "No Source Provided", description: "you must provide either a `file` attachment or a `link`.", color: EmbedColors.ERROR, guild })] });
          }
          if (file && link) {
             return interaction.editReply({ embeds: [makeEmbed({ title: "Too Many Sources", description: "please provide *either* a `file` or a `link`, not both.", color: EmbedColors.ERROR, guild })] });
          }

          const existing = await SoundboardSound.findOne({ guildId, name });
          if (existing) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "Name Taken", description: `a sound named \`${name}\` already exists. please choose a different name or delete the old one.`, color: EmbedColors.ERROR, guild })] });
          }
          
          let soundUrl;

          // --- File Logic ---
          if (file) {
            const allowedTypes = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/opus'];
            if (!file.contentType || !allowedTypes.includes(file.contentType)) {
              return interaction.editReply({ embeds: [makeEmbed({ title: "Invalid File Type", description: `this file type (${file.contentType}) is not supported.\nplease upload an \`mp3\`, \`ogg\`, \`wav\`, or a \`voice message (opus)\`.`, color: EmbedColors.ERROR, guild })] });
            }
            
            if (file.size > MAX_SOUND_SIZE_MB * 1024 * 1024) {
              return interaction.editReply({ embeds: [makeEmbed({ title: "File Too Large", description: `this file is too large (${(file.size / 1024 / 1024).toFixed(2)}mb).\nthe limit is \`${MAX_SOUND_SIZE_MB}mb\`.`, color: EmbedColors.ERROR, guild })] });
            }
            soundUrl = file.url;
          }
          
          // --- Link Logic ---
          if (link) {
            try {
              const url = new URL(link); // Check if it's a valid URL structure
              if (!/\.(mp3|ogg|wav)$/i.test(url.pathname)) {
                 return interaction.editReply({ embeds: [makeEmbed({ title: "Invalid Link", description: "the link does not seem to be a direct audio file. it must end in `.mp3`, `.ogg`, or `.wav`.", color: EmbedColors.ERROR, guild })] });
              }
              soundUrl = link;
            } catch (e) {
              return interaction.editReply({ embeds: [makeEmbed({ title: "Invalid Link", description: "that doesn't look like a valid url. please provide a direct link to a sound file.", color: EmbedColors.ERROR, guild })] });
            }
          }

          // --- Save to DB ---
          try {
            await SoundboardSound.create({
              guildId,
              name,
              url: soundUrl,
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
          const panel = await buildSoundboardPanel(guild, 0, false);
          return interaction.editReply(panel);
        }
      }
    }

    // Button interactions
    if (interaction.isButton()) {
      if (!await checkAdmin(interaction)) return;
      
      const customId = interaction.customId;

      // --- Soundboard Button Handler ---
      if (customId.startsWith('sound_')) {
        // --- Play Sound (UPDATED) ---
        if (customId.startsWith('sound_play_')) {
          const soundId = customId.split('_')[2];
          const member = interaction.member;
          const voiceChannel = member.voice.channel;
          
          if (!voiceChannel) {
            return interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("No VC Detected"), description: toSmallCaps("you must be in a voice channel to play a sound."), color: EmbedColors.ERROR, guild })], ephemeral: true });
          }
          
          const sound = await SoundboardSound.findById(soundId).lean();
          if (!sound) {
             await interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("Error"), description: toSmallCaps("could not find that sound. it may have been deleted."), color: EmbedColors.ERROR, guild })], ephemeral: true });
             // Refresh the panel since the sound is gone
             const panel = await buildSoundboardPanel(guild, 0, false);
             return interaction.editReply(panel);
          }
          
          try {
            let connection = getVoiceConnection(guild.id);
            
            // --- NEW/UPDATED CHECK: Bot is busy in another channel ---
            if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
              return interaction.followUp({ 
                  embeds: [makeEmbed({ 
                      title: toSmallCaps("⚠️ ʙᴏᴛ ɪs ʙᴜsʏ"), 
                      description: toSmallCaps(`i'm already playing sounds in <#${connection.joinConfig.channelId}>.\n\nplease wait until i'm free or join that channel to play sounds.`), 
                      color: EmbedColors.ERROR, 
                      guild 
                  })], 
                  ephemeral: true 
              });
            }
            
            // If bot is not busy, or is already in the user's channel, proceed.
            if (!connection) {
              connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
              });
            }

            const player = createAudioPlayer();
            // Create resource directly from the URL (works for Discord CDN or external links)
            const resource = createAudioResource(sound.url); 
            
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
              interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("Playback Error"), description: toSmallCaps(`failed to play \`${sound.name}\`: \`${e.message}\`\n\nif this is a link, it might be broken or private.`), color: EmbedColors.ERROR, guild })], ephemeral: true });
            });
            
            return interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps(`▶️ Playing Sound`), description: toSmallCaps(`now playing \`${sound.name}\` in ${voiceChannel}`), color: EmbedColors.SOUND, guild })], ephemeral: true });
            
          } catch (e) {
             console.error("[Sound Play Error]", e);
            return interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("Error"), description: toSmallCaps(`failed to play sound: \`${e.message}\``), color: EmbedColors.ERROR, guild })], ephemeral: true });
          }
        }
        
        // --- Show Delete Confirmation ---
        if (customId.startsWith('sound_delete_')) {
          if (!customId.startsWith('sound_delete_confirm_') && !customId.startsWith('sound_delete_cancel_')) {
            const soundId = customId.split('_')[2];
            const sound = await SoundboardSound.findById(soundId).lean();
            if (!sound) {
              return interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("Error"), description: toSmallCaps("this sound no longer exists."), color: EmbedColors.ERROR, guild })], ephemeral: true });
            }
            
            const confirmEmbed = new EmbedBuilder()
              .setColor(EmbedColors.ERROR)
              .setTitle(toSmallCaps("⚠️ ᴀʀᴇ ʏᴏᴜ sᴜʀᴇ?"))
              .setDescription(toSmallCaps(`this will permanently delete the sound \`${sound.name}\`.\nthis action cannot be undone.`));
              
            const confirmRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`sound_delete_confirm_${soundId}`)
                .setLabel("Yes, Delete It")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`sound_delete_cancel_${soundId}`)
                .setLabel("No, Cancel")
                .setStyle(ButtonStyle.Secondary)
            );
            return interaction.update({ embeds: [confirmEmbed], components: [confirmRow] });
          }
        }
        
        // --- Confirm Deletion ---
        if (customId.startsWith('sound_delete_confirm_')) {
          const soundId = customId.split('_')[3];
          try {
            const sound = await SoundboardSound.findById(soundId);
            if (!sound) throw new Error("Sound already deleted.");
            
            // Just delete from Mongo
            await SoundboardSound.deleteOne({ _id: soundId });
            
            interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("✅ Sound Deleted"), description: toSmallCaps(`\`${sound.name}\` has been permanently removed.`), color: EmbedColors.SUCCESS, guild })], ephemeral: true });
            
            const panel = await buildSoundboardPanel(guild, 0, true); // Rebuild delete panel on page 0
            return interaction.update(panel);
            
          } catch (e) {
            console.error("[Sound Delete Error]", e);
            interaction.followUp({ embeds: [makeEmbed({ title: toSmallCaps("Error"), description: toSmallCaps(`failed to delete sound: \`${e.message}\``), color: EmbedColors.ERROR, guild })], ephemeral: true });
            const panel = await buildSoundboardPanel(guild, 0, true);
            return interaction.update(panel);
          }
        }
        
        // --- Cancel Deletion ---
        if (customId.startsWith('sound_delete_cancel_')) {
          const panel = await buildSoundboardPanel(guild, 0, true); // Go back to delete mode panel
          return interaction.update(panel);
        }

        // --- Pagination ---
        let page = 0;
        let isDeleteMode = false;
        if (customId.startsWith('sound_page_')) {
          const parts = customId.split('_');
          const action = parts[2];
          isDeleteMode = parts[parts.length - 1] === 'true';
          
          if (action === 'first') {
            page = 0;
          } else if (action === 'last') {
            page = parseInt(parts[3], 10);
          } else if (action === 'prev') {
            page = parseInt(parts[3], 10) - 1;
          } else if (action === 'next') {
            page = parseInt(parts[3], 10) + 1;
          } else {
            return; // It was 'sound_page_info'
          }
          const panel = await buildSoundboardPanel(guild, page, isDeleteMode);
          return interaction.update(panel);
        }
        
        // --- Panel Actions (Toggle Delete, Add, Refresh) ---
        if (customId.startsWith('sound_toggle_delete_')) {
          page = parseInt(customId.split('_')[3], 10);
          const panel = await buildSoundboardPanel(guild, page, true); // Enable delete mode
          return interaction.update(panel);
        }
        if (customId.startsWith('sound_cancel_delete_')) {
          page = parseInt(customId.split('_')[3], 10);
          const panel = await buildSoundboardPanel(guild, page, false); // Disable delete mode
          return interaction.update(panel);
        }
        if (customId.startsWith('sound_refresh_')) {
          const parts = customId.split('_');
          page = parseInt(parts[2], 10);
          isDeleteMode = parts[3] === 'true';
          const panel = await buildSoundboardPanel(guild, page, isDeleteMode);
          await interaction.followUp({ content: "Panel refreshed!", ephemeral: true });
          return interaction.update(panel);
        }
        // --- Updated 'Add' button message ---
        if (customId === 'sound_add_new') {
          return interaction.followUp({
            embeds: [makeEmbed({
              title: toSmallCaps("➕ ᴀᴅᴅ ᴀ ɴᴇᴡ sᴏᴜɴᴅ"),
              description: toSmallCaps("to add a sound, use the `/addsound` command.\n\nyou can either attach a `file` (or voice message) or provide a direct `link` to a sound."),
              color: EmbedColors.INFO,
              guild
            })],
            ephemeral: true
          });
        }
        return; // Fallthrough
      }
      
      // --- Original Settings Button Handler ---
      await interaction.deferUpdate();
      let settingsToUpdate = await getGuildSettings(guildId); 

      switch (interaction.customId) {
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
          // Unknown button, maybe from an old message
          return interaction.followUp({ content: "This button is no longer active.", ephemeral: true });
      }

      await updateGuildSettings(settingsToUpdate);
      const updatedPanel = buildControlPanel(settingsToUpdate, guild);
      return interaction.editReply({ embeds: [updatedPanel.embed], components: updatedPanel.buttons });
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
    // --- VC Alert Logic ---
    const user = newState.member?.user ?? oldState.member?.user;
    if (!user || user.bot) return; // Ignore bots

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

    // ---- PRIVATE VC THREAD HANDLING ----
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

// ---------- Permission helper ----------
async function checkAdmin(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  
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
    
    if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyPayload);
    } else {
        await interaction.reply(replyPayload);
    }
    return false;
  }
  return true;
}


// ---------- Graceful shutdown ----------
async function shutdown(signal) {
  try {
    console.log(`[Shutdown] Received ${signal}. Cleaning up...`);
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
(async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI not provided in .env");
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "Discord-Alert-Bot"
    });
    console.log("✅ MongoDB Connected to DB");
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