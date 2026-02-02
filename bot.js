import express from "express";
import fs from "fs";
const fsp = fs.promises;
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios"; 
import { pipeline } from "stream";
import { promisify } from "util";
const streamPipeline = promisify(pipeline);

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
  Events
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  StreamType
} from "@discordjs/voice";

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Temp Directory for downloads
const TEMP_DIR = path.join(__dirname, "temp");
const LOGS_DIR = path.join(__dirname, "logs");

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Clean temp dir on startup
fs.readdir(TEMP_DIR, (err, files) => {
  if (err) return;
  for (const file of files) {
    fs.unlink(path.join(TEMP_DIR, file), () => {});
  }
});

// ---------- Configuration ----------
const PORT = process.env.PORT || 8000;

// ---------- Small-caps utility ----------
const SMALL_CAPS_MAP = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
  s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
  A: "ᴀ", B: "ʙ", C: "ᴄ", D: "ᴅ", E: "ᴇ", F: "ꜰ", G: "ɢ", H: "ʜ", I: "ɪ",
  J: "ᴊ", K: "ᴋ", L: "ʟ", M: "ᴍ", N: "ɴ", O: "ᴏ", P: "ᴘ", Q: "ǫ", R: "ʀ",
  S: "s", T: "ᴛ", U: "ᴜ", V: "ᴠ", W: "ᴡ", X: "x", Y: "ʏ", Z: "ᴢ",
  "0": "0","1": "1","2": "2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9",
  "!":"!","?":"?",".":".",",":",",":":":","'":"'",'"':'"','-':" - ", "_":"_", " ":" "
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
  guildId: { type: String, required: true, index: true },
  guildName: String,
  user: { type: String, required: true },
  channel: String,
  type: { type: String, required: true, enum: ["join", "leave", "online"] },
  time: { type: Date, default: Date.now, index: true }
});
logSchema.index({ time: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
logSchema.index({ guildId: 1, time: -1 });
logSchema.index({ guildId: 1, user: 1, time: -1 });
const GuildLog = mongoose.model("GuildLog", logSchema);

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
  }, 300);
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
  let settings = await GuildSettings.findOne({ guildId }).lean().select('-__v').catch(() => null);
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

// ---------- Helper: log creation (Non-blocking) ----------
async function addLog(type, user, channel, guild) {
  // Fire and forget - don't block alert sending
  GuildLog.create({
    guildId: guild.id ?? guild,
    guildName: guild.name ?? guild,
    user,
    channel,
    type,
    time: Date.now()
  }).catch(err => {
    console.error(`[MongoDB Log Error] ${err?.message ?? err}`);
  });
}

// ---------- Helper: generate activity file ----------
async function generateActivityFile(guild, logs) {
  const filePath = path.join(LOGS_DIR, `${guild.id}_activity.txt`);
  const header =
`╔══════════════════════════════════════════════╗
║           🌌 ${toSmallCaps(guild.name)} ᴀᴄᴛɪᴠɪᴛʏ ʟᴏɢꜱ           ║
║            🗓️ ɢᴇɴᴇʀᴀᴛᴇᴅ ᴏɴ ${toSmallCaps(toISTString(Date.now()))}     ║
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

// ---------- Sound model ----------
const soundSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  fileURL: { type: String, required: true },
  storageMessageId: { type: String, default: null },
  addedBy: { type: String, default: null },
  playCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
soundSchema.index({ guildId: 1, name: 1 }, { unique: true });
soundSchema.index({ guildId: 1, playCount: -1 });
const Sound = mongoose.model("Soundboards", soundSchema);

// ---------- In-memory queue & panels ----------
const sbQueues = new Map();   // guildId -> { player, list[], now, vcId, timeout, lastTextChannel, currentFile, volume, resource }
const sbPanels = new Map();   // guildId -> { messageId, channelId }



// ---------- queue helper (Enhanced Debug & Auto-Recovery) ----------
function getSbQueue(guildId) {
  if (!sbQueues.has(guildId)) {
    const player = createAudioPlayer();
    const q = { 
      player, 
      list: [], 
      now: null, 
      vcId: null, 
      timeout: null,
      guildId: guildId,
      lastTextChannel: null,
      currentFile: null,
      volume: 1.0, // Default Volume
      resource: null // Track active resource for volume control
    };

    // DEBUG: Monitor player state
    player.on('stateChange', (oldState, newState) => {
      console.log(`[AudioPlayer] ${oldState.status} -> ${newState.status} (Guild: ${guildId})`);
      if (newState.status === 'buffering') {
        setTimeout(() => {
          if (q.player.state.status === 'buffering') {
            console.warn('[sb Auto-Recovery] Stuck buffering, skipping track.');
            q.player.stop(); 
          }
        }, 8000);
      }
    });

    // Event: Track finished (Idle)
    player.on(AudioPlayerStatus.Idle, async () => {
      try {
        q.resource = null; // Clear resource ref
        // DELETE LOCAL FILE
        if (q.currentFile && fs.existsSync(q.currentFile)) {
            try {
                await fsp.unlink(q.currentFile);
                console.log(`[sb] Deleted temp file: ${q.currentFile}`);
            } catch(e) { console.error("[sb] Failed delete:", e); }
            q.currentFile = null;
        }

        q.now = null;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        if (q.list.length === 0) {
          startSbLeaveTimer(guildId);
        } else {
          await sbPlayNext(guild, q.lastTextChannel);
        }
        await sbUpdatePanel(guild);
      } catch (err) {
        console.error("[sb player idle]", err);
      }
    });

    // Event: Player Error
    player.on("error", (err) => {
      console.error("[sb player error]", err);
      if (q.lastTextChannel) {
        q.lastTextChannel.send({ 
            content: `⚠️ **${q.now?.name || 'Track'}** failed. Skipping...` 
        }).catch(()=>{});
      }
      q.player.stop(); 
    });

    sbQueues.set(guildId, q);
  }
  return sbQueues.get(guildId);
}

// ---------- leave timer (10 min) ----------
function startSbLeaveTimer(guildId) {
  const q = getSbQueue(guildId);
  if (q.timeout) clearTimeout(q.timeout);
  const lockedVc = q.vcId;

  q.timeout = setTimeout(() => {
    try {
      const conn = getVoiceConnection(guildId);
      if (conn && conn.joinConfig.channelId === lockedVc) {
        conn.destroy();
        console.log(`[sb] auto-left VC ${lockedVc} for guild ${guildId} (timer)`);
      }
    } catch (e) { console.error(e); }

    q.list = [];
    q.now = null;
    q.vcId = null;
    q.resource = null;
  }, 10 * 60 * 1000);
}

// ---------- ensure storage channel (only on add) ----------
async function sbEnsureStorage(guild) {
  let channel = guild.channels.cache.find(c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText);
  if (channel) return channel;

  const me = await guild.members.fetch(client.user.id).catch(()=>null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Missing ManageChannels permission to create storage channel");
  }

  channel = await guild.channels.create({
    name: "soundboard-storage",
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id ?? guild.roles.everyone, deny: ["ViewChannel"] },
      { id: client.user.id, allow: ["ViewChannel","SendMessages","AttachFiles"] }
    ]
  });
  return channel;
}

// ---------- play next in queue (DOWNLOAD -> PLAY -> DELETE) ----------
async function sbPlayNext(guild, textChannel = null) {
  const q = getSbQueue(guild.id);
  if (textChannel) q.lastTextChannel = textChannel;

  if (!q.list.length) {
    q.now = null;
    startSbLeaveTimer(guild.id);
    await sbUpdatePanel(guild);
    return;
  }

  const next = q.list.shift();
  q.now = next;

  // Increment Play Count
  if (next._id) {
    Sound.updateOne({ _id: next._id }, { $inc: { playCount: 1 } }).catch(() => {});
  }

  let localFilePath = null;

  try {
    console.log(`[sb] preparing: ${next.name}`);

    // 1. Resolve URL (ID refresh logic)
    let downloadUrl = next.fileURL;
    const channels = await guild.channels.fetch();
    const storageCh = channels.find(c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText);

    if (storageCh && next.storageMessageId) {
      try {
        const msg = await storageCh.messages.fetch(next.storageMessageId);
        if (msg.attachments.size > 0) {
          downloadUrl = msg.attachments.first().url;
        }
      } catch (err) {
        console.warn(`[sb] ID refresh failed for ${next.name}, trying stored URL...`);
      }
    }

    // 2. Download File
    const fileExt = path.extname(new URL(downloadUrl).pathname) || ".mp3";
    const fileName = `${guild.id}_${Date.now()}${fileExt}`;
    localFilePath = path.join(TEMP_DIR, fileName);

    console.log(`[sb] Downloading ${next.name} to ${localFilePath}...`);
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream'
    });

    await streamPipeline(response.data, fs.createWriteStream(localFilePath));
    console.log(`[sb] Download complete.`);

    // 3. Play Local File
    const resource = createAudioResource(localFilePath, { 
      inputType: StreamType.Arbitrary,
      inlineVolume: true 
    });
    resource.volume.setVolume(q.volume);
    
    // Assign file to queue so Idle event can delete it later
    q.currentFile = localFilePath;
    q.resource = resource; // Store ref for volume control
    q.player.play(resource);

    if (textChannel && textChannel.send) {
      await textChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(EmbedColors.VC_JOIN)
            .setTitle(toSmallCaps("🎧 ɴᴏᴡ ᴘʟᴀʏɪɴɢ"))
            .setDescription(toSmallCaps(`**${next.name}**`))
            .setFooter({ text: `Volume: ${Math.round(q.volume * 100)}%` })
            .setTimestamp()
        ]
      }).catch(()=>{});
    }
    await sbUpdatePanel(guild);

  } catch (e) {
    console.error("[sb playNext error]", e);
    
    // Cleanup failed download if it exists
    if (localFilePath && fs.existsSync(localFilePath)) {
        fs.unlink(localFilePath, ()=>{});
    }

    if (textChannel) {
        textChannel.send(`⚠️ **${next.name}** failed to load. Skipping...`).catch(()=>{});
    }
    q.now = null;
    // Try next one
    setTimeout(()=> sbPlayNext(guild, textChannel).catch(()=>{}), 1000);
  }
}

// ---------- connect to VC ----------
async function sbConnectToMember(member) {
  if (!member.voice.channel) return { error: "not_in_vc" };
  const vc = member.voice.channel;
  const guild = member.guild;

  try {
    const conn = joinVoiceChannel({
      channelId: vc.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false
    });

    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      console.error("[sb connect] Connection never became ready", err);
      conn.destroy();
      return { error: "connect_timeout" };
    }

    const q = getSbQueue(guild.id);
    q.vcId = vc.id;
    
    if (q.timeout) { clearTimeout(q.timeout); q.timeout = null; }
    conn.subscribe(q.player);
    return { connection: conn, channel: vc };
  } catch (err) {
    console.error("[sb connect]", err);
    return { error: "connect_failed" };
  }
}

async function sbUpdatePanel(guild) {
  try {
    const panel = sbPanels.get(guild.id);
    if (!panel) return;
    const ch = guild.channels.cache.get(panel.channelId) || await guild.channels.fetch(panel.channelId).catch(()=>null);
    if (!ch) return;
    const msg = await ch.messages.fetch(panel.messageId).catch(()=>null);
    if (!msg) return;
    const ui = await buildSoundPanelEmbed(guild);
    await msg.edit({ embeds: [ui.embed], components: ui.buttons }).catch(()=>{});
  } catch (e) { console.error("[sbUpdatePanel]", e); }
}


// ---------- Sound Panel builder ----------
async function buildSoundPanelEmbed(guild) {
  const q = getSbQueue(guild.id);
  const total = await Sound.countDocuments({ guildId: guild.id }).catch(()=>0);

  const status = q.now ? "🟢 ᴘʟᴀʏɪɴɢ" : (getVoiceConnection(guild.id) ? "🟡 ᴄᴏɴɴᴇᴄᴛᴇᴅ" : "🔴 ɪᴅʟᴇ");
  const nowPlaying = q.now ? `🎧 ${q.now.name}` : "—";
  
  const queuePreview = q.list.length ? q.list.slice(0, 8).map((s,i)=> `\`${i+1}.\` ${s.name}`).join("\n") : toSmallCaps("ɴᴏ ǫᴜᴇᴜᴇᴅ sᴏᴜɴᴅs");
  if (q.list.length > 8) queuePreview += `\n...and ${q.list.length - 8} more`;

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.VC_JOIN)
    .setAuthor({ name: toSmallCaps("🎛 sᴏᴜɴᴅʙᴏᴀʀᴅ ᴘᴀɴᴇʟ"), iconURL: client.user.displayAvatarURL() })
    .setDescription(
      `${toSmallCaps("> sᴛᴀᴛᴜs:")} ${toSmallCaps(status)}\n` +
      `${toSmallCaps("> ᴠᴏʟᴜᴍᴇ:")} ${Math.round(q.volume * 100)}%\n` +
      `${toSmallCaps("> ɴᴏᴡ ᴘʟᴀʏɪɴɢ:")} ${toSmallCaps(nowPlaying)}\n` +
      `${toSmallCaps("> ᴛᴏᴛᴀʟ sᴏᴜɴᴅs:")} ${total}\n\n` +
      `${toSmallCaps("📜 ǫᴜᴇᴜᴇ:")}\n${toSmallCaps(queuePreview)}`
    )
    .setFooter({ text: toSmallCaps(guild.name) })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sb_connect").setLabel(toSmallCaps("🎧 ᴄᴏɴɴᴇᴄᴛ")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("sb_skip").setLabel(toSmallCaps("⏭ sᴋɪᴘ")).setStyle(ButtonStyle.Secondary).setDisabled(!q.now),
    new ButtonBuilder().setCustomId("sb_stop").setLabel(toSmallCaps("⛔ sᴛᴏᴘ")).setStyle(ButtonStyle.Danger).setDisabled(!q.now),
    new ButtonBuilder().setCustomId("sb_refresh").setLabel(toSmallCaps("ʀᴇꜰʀᴇsʜ")).setStyle(ButtonStyle.Secondary)
  );

  return { embed, buttons: [row1] };
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
  RESET: 0x00ccff
};

// ---------- Reusable embed builder ----------
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

// ---------- Control Panel builder ----------
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
  new SlashCommandBuilder().setName("sound").setDescription("🔊 sᴏᴜɴᴅʙᴏᴀʀᴅ")
    .addSubcommand(s => s.setName("add").setDescription("➕ ᴀᴅᴅ sᴏᴜɴᴅ")
      .addStringOption(o => o.setName("name").setDescription("sᴏᴜɴᴅ ɴᴀᴍᴇ").setRequired(true))
      .addAttachmentOption(o => o.setName("file").setDescription("ᴜᴘʟᴏᴀᴅ")))
    .addSubcommand(s => s.setName("play").setDescription("▶ ᴘʟᴀʏ")
      .addStringOption(o => o.setName("name").setDescription("sᴇʟᴇᴄᴛ").setAutocomplete(true).setRequired(true)))
    .addSubcommand(s => s.setName("delete").setDescription("🗑 ᴅᴇʟᴇᴛᴇ")
      .addStringOption(o => o.setName("name").setDescription("sᴇʟᴇᴄᴛ").setAutocomplete(true).setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("📜 ʟɪsᴛ"))
    .addSubcommand(s => s.setName("panel").setDescription("🎛 ᴏᴘᴇɴ ᴘᴀɴᴇʟ"))
    // NEW COMMANDS ADDED BELOW
    .addSubcommand(s => s.setName("volume").setDescription("🔊 sᴇᴛ ᴠᴏʟᴜᴍᴇ")
      .addIntegerOption(o => o.setName("level").setDescription("0 - 100").setRequired(true).setMinValue(0).setMaxValue(100)))
    .addSubcommand(s => s.setName("top").setDescription("🏆 ᴍᴏsᴛ ᴘʟᴀʏᴇᴅ sᴏᴜɴᴅs"))
].map(c => c.toJSON());

// ---------- Ready & register commands ----------
client.once("clientReady", async () => {
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

    // fetch or create cached settings for the guild
    let settings = await getGuildSettings(guildId);

    if (interaction.isChatInputCommand()) {
      if (!await checkAdmin(interaction)) return;

      switch (interaction.commandName) {
        case "settings": {
          const panel = buildControlPanel(settings, guild);
          return interaction.reply({
            embeds: [panel.embed],
            components: panel.buttons,
            flags: 64
          });
        }

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
              embeds: [makeEmbed({ title: toSmallCaps("⚠️ invalid channel"), description: toSmallCaps("please choose a **text channel** where i can post vc alerts.\ntry `/activate #channel` to set one manually 💬"), color: EmbedColors.ERROR, guild })],
              flags: 64,
            });
          }

          const botMember = await guild.members.fetch(client.user.id).catch(() => null);
          const perms = channel.permissionsFor(botMember);
          if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
            return interaction.reply({
              embeds: [makeEmbed({ title: toSmallCaps("🚫 missing permissions"), description: toSmallCaps(`i need **view** + **send** permissions in ${channel} to post vc alerts.\nplease fix that and try again 🔧`), color: EmbedColors.ERROR, guild })],
              flags: 64,
            });
          }

          if (settings.alertsEnabled && settings.textChannelId === channel.id) {
            return interaction.reply({
              embeds: [makeEmbed({ title: toSmallCaps("🟢 vc alerts already active"), description: toSmallCaps(`alerts are already running in ${channel} ⚡\nuse \`/settings\` to tweak or customize them.`), color: EmbedColors.WARNING, guild })],
              flags: 64,
            });
          }

          settings.alertsEnabled = true;
          settings.textChannelId = channel.id;
          await updateGuildSettings(settings);

          return interaction.reply({
            embeds: [makeEmbed({ title: toSmallCaps("✅ vc alerts activated"), description: toSmallCaps(`vibe monitor engaged! 🎧\nall voice activity will now appear in ${channel}.\nuse \`/settings\` to fine-tune your alerts ✨`), color: EmbedColors.SUCCESS, guild })],
            flags: 64,
          });
        }

        case "deactivate": {
          if (!settings.alertsEnabled) {
            return interaction.reply({ embeds: [makeEmbed({ title: toSmallCaps("💤 vc alerts already off"), description: toSmallCaps("they’re already paused 😴\nuse `/activate` when you’re ready to bring the vibes back."), color: EmbedColors.WARNING, guild })], flags: 64 });
          }
          settings.alertsEnabled = false;
          await updateGuildSettings(settings);
          return interaction.reply({ embeds: [makeEmbed({ title: toSmallCaps("🔕 vc alerts powered down"), description: toSmallCaps("taking a chill break 🪷\nno join or leave pings until you power them up again with `/activate`."), color: EmbedColors.ERROR, guild })], flags: 64 });
        }

        case "setignorerole": {
          const role = interaction.options.getRole("role");
          settings.ignoredRoleId = role.id;
          settings.ignoreRoleEnabled = true;
          await updateGuildSettings(settings);
          return interaction.reply({ embeds: [makeEmbed({ title: toSmallCaps("🙈 ignored role set"), description: toSmallCaps(`members with the ${role} role will now be skipped in vc alerts 🚫\nperfect for staff, bots, or background lurkers 😌`), color: EmbedColors.RESET, guild })], flags: 64 });
        }

        case "resetignorerole": {
          settings.ignoredRoleId = null;
          settings.ignoreRoleEnabled = false;
          await updateGuildSettings(settings);
          return interaction.reply({ embeds: [makeEmbed({ title: toSmallCaps("👀 ignored role cleared"), description: toSmallCaps("everyone’s back on the radar 🌍\nall members will now appear in vc alerts again 💫"), color: EmbedColors.RESET, guild })], flags: 64 });
        }

        case "logs": {
          await interaction.deferReply({ flags: 64 });
          
          // Get range and user options
          const rangeOpt = interaction.options.getString("range") || "today";
          const userOpt = interaction.options.getUser("user");
          
          // Calculate date range
          const now = Date.now();
          let startTime;
          switch (rangeOpt) {
            case "today":
              const todayStart = new Date();
              todayStart.setHours(0, 0, 0, 0);
              startTime = todayStart.getTime();
              break;
            case "yesterday":
              const yesterdayStart = new Date();
              yesterdayStart.setDate(yesterdayStart.getDate() - 1);
              yesterdayStart.setHours(0, 0, 0, 0);
              startTime = yesterdayStart.getTime();
              const yesterdayEnd = new Date(yesterdayStart);
              yesterdayEnd.setHours(23, 59, 59, 999);
              break;
            case "7days":
              startTime = now - (7 * 24 * 60 * 60 * 1000);
              break;
            case "30days":
              startTime = now - (30 * 24 * 60 * 60 * 1000);
              break;
            default:
              startTime = now - (24 * 60 * 60 * 1000);
          }
          
          // Build query
          const query = { guildId: guild.id, time: { $gte: new Date(startTime) } };
          if (rangeOpt === "yesterday") {
            const yesterdayEnd = new Date();
            yesterdayEnd.setHours(0, 0, 0, 0);
            query.time.$lt = yesterdayEnd;
          }
          if (userOpt) {
            query.user = { $regex: `^${userOpt.tag}`, $options: "i" };
          }
          
          const logs = await GuildLog.find(query).sort({ time: -1 }).limit(100).lean();

          if (logs.length === 0) {
            return interaction.editReply({ embeds: [makeEmbed({ title: "No activity found", description: `No logs found for the selected ${userOpt ? 'user and ' : ''}time range.`, color: EmbedColors.INFO, guild })] });
          }

          const desc = logs.slice(0, 20).map(l => {
            const emoji = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
            const ago = fancyAgo(Date.now() - l.time);
            const action = l.type === "join" ? "entered" : l.type === "leave" ? "left" : "came online";
            return `**${emoji} ${l.type.toUpperCase()}** — ${l.user} ${action} ${l.channel}\n> 🕒 ${ago} • ${toISTString(l.time)}`;
          }).join("\n\n");

          const rangeText = rangeOpt === "today" ? "Today" : rangeOpt === "yesterday" ? "Yesterday" : rangeOpt === "7days" ? "Last 7 Days" : "Last 30 Days";
          const userText = userOpt ? ` for ${userOpt.tag}` : "";
          const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle(`${guild.name} Activity - ${rangeText}${userText}`).setDescription(desc).setFooter({ text: `Showing ${Math.min(20, logs.length)} of ${logs.length} entries • Server: ${guild.name}` }).setTimestamp();
          const filePath = await generateActivityFile(guild, logs);
          await interaction.followUp({ embeds: [embed], files: [{ attachment: filePath, name: `${guild.name}_activity.txt` }], ephemeral: false });
          return;
        }

        // ------------------ SOUND-BOARD: top-level 'sound' command ------------------
        case "sound": {
          const sub = interaction.options.getSubcommand();
          const q = getSbQueue(guildId); 

          // ----- /sound add -----
          if (sub === "add") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
              return interaction.reply({ embeds: [ makeEmbed({ title: toSmallCaps("❌ ᴘᴇʀᴍɪssɪᴏɴ"), description: toSmallCaps("admins only"), color: EmbedColors.ERROR, guild }) ], flags: 64 });
            }
            const name = interaction.options.getString("name");
            const file = interaction.options.getAttachment("file");
            if (!file) return interaction.reply({ embeds: [ makeEmbed({ title: toSmallCaps("⚠ ɴᴏ ғɪʟᴇ"), description: toSmallCaps("attach an audio file"), color: EmbedColors.WARNING, guild }) ], flags: 64 });

            const exists = await Sound.findOne({ guildId, name });
            if (exists) return interaction.reply({ embeds: [ makeEmbed({ title: toSmallCaps("⚠ ᴀʟʀᴇᴀᴅʏ ᴇxɪsᴛs"), description: toSmallCaps(`**${name}** already exists`), color: EmbedColors.WARNING, guild }) ], flags: 64 });

            await interaction.deferReply({ flags: 64 });
            let storage = null;
            try { storage = await sbEnsureStorage(guild); } catch (e) { console.error("[sb ensure storage]", e); }
            let uploadedUrl = file.url;
            if (storage) {
              const m = await storage.send({ files: [file.url] }).catch(()=>null);
              uploadedUrl = m?.attachments?.first()?.url ?? uploadedUrl;
            }
            await Sound.create({ guildId, name, fileURL: uploadedUrl, storageMessageId: storage ? (await storage.messages.fetch({ limit:1 }).catch(()=>null))?.id ?? null : null, addedBy: interaction.user.id });
            return interaction.editReply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(toSmallCaps("✅ sᴏᴜɴᴅ ᴀᴅᴅᴇᴅ")).setDescription(toSmallCaps(`**${name}** ʜᴀs ʙᴇᴇɴ ᴀᴅᴅᴇᴅ`)).setTimestamp() ] });
          }

          // ----- /sound play -----
          if (sub === "play") {
            const name = interaction.options.getString("name");
            const sound = await Sound.findOne({ guildId, name });
            if (!sound) return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.ERROR).setTitle(toSmallCaps("❌ ɴᴏᴛ ғᴏᴜɴᴅ")).setDescription(toSmallCaps("that sound is not on the server")).setTimestamp() ], flags: 64 });

            const res = await sbConnectToMember(interaction.member);
            if (res?.error) return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(toSmallCaps("🎧 ᴊᴏɪɴ ᴀ ᴠᴄ")).setDescription(toSmallCaps("join a voice channel to play sounds")).setTimestamp() ], flags: 64 });

            const isIdle = !q.now; 
            
            q.list.push({ _id: sound._id, name: sound.name, fileURL: sound.fileURL, storageMessageId: sound.storageMessageId });
            
            if (isIdle) {
               await sbPlayNext(guild, interaction.channel);
               return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(toSmallCaps("▶️ ɴᴏᴡ ᴘʟᴀʏɪɴɢ")).setDescription(toSmallCaps(`**${sound.name}**`)).setTimestamp() ] });
            } else {
               await sbUpdatePanel(guild);
               const pos = q.list.length;
               return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(toSmallCaps("🎶 ᴀᴅᴅᴇᴅ ᴛᴏ ǫᴜᴇᴜᴇ")).setDescription(toSmallCaps(`**${sound.name}** is at position #${pos}`)).setTimestamp() ] });
            }
          }

          // ----- /sound volume (NEW) -----
          if (sub === "volume") {
            const level = interaction.options.getInteger("level");
            const newVol = level / 100;
            q.volume = newVol;
            
            // Adjust current resource if playing
            if (q.resource && q.resource.volume) {
                q.resource.volume.setVolume(newVol);
            }
            await sbUpdatePanel(guild);
            return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(toSmallCaps("🔊 ᴠᴏʟᴜᴍᴇ sᴇᴛ")).setDescription(toSmallCaps(`Volume set to **${level}%**`)).setTimestamp() ], flags: 64 });
          }

          // ----- /sound top (NEW) -----
          if (sub === "top") {
             const docs = await Sound.find({ guildId }).select('name playCount').sort({ playCount: -1 }).limit(10).lean();
             if (!docs.length) return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(toSmallCaps("📜 ᴇᴍᴘᴛʏ")).setDescription(toSmallCaps("no sounds played yet")).setTimestamp() ], flags: 64 });
             
             const text = docs.map((s, idx) => {
                 const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `\`#${idx+1}\``;
                 return `${medal} **${s.name}** — ${s.playCount} plays`;
             }).join("\n");

             return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(toSmallCaps("🏆 ᴍᴏsᴛ ᴘᴏᴘᴜʟᴀʀ sᴏᴜɴᴅs")).setDescription(toSmallCaps(text)).setTimestamp() ], flags: 64 });
          }

          // ----- /sound delete -----
          if (sub === "delete") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ embeds: [ makeEmbed({ title: toSmallCaps("❌ ᴘᴇʀᴍɪssɪᴏɴ"), description: toSmallCaps("admins only"), color: EmbedColors.ERROR, guild }) ], flags: 64 });
            const name = interaction.options.getString("name");
            const doc = await Sound.findOne({ guildId, name });
            if (!doc) return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.ERROR).setTitle(toSmallCaps("❌ ɴᴏᴛ ғᴏᴜɴᴅ")).setDescription(toSmallCaps("sound not found")).setTimestamp() ], flags: 64 });
            if (doc.storageMessageId) {
              const storage = guild.channels.cache.find(c => c.name === "soundboard-storage");
              if (storage) {
                const msg = await storage.messages.fetch(doc.storageMessageId).catch(()=>null);
                if (msg) await msg.delete().catch(()=>null);
              }
            }
            await doc.deleteOne();
            await sbUpdatePanel(guild);
            return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(toSmallCaps("🗑 sᴏᴜɴᴅ ʀᴇᴍᴏᴠᴇᴅ")).setDescription(toSmallCaps(`**${name}** removed`)).setTimestamp() ] });
          }

          // ----- /sound list -----
          if (sub === "list") {
            const docs = await Sound.find({ guildId }).select('name playCount').sort({ name: 1 }).lean();
            if (!docs.length) return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(toSmallCaps("📜 ᴇᴍᴘᴛʏ")).setDescription(toSmallCaps("no sounds added")).setTimestamp() ], flags: 64 });
            // Limit text size
            const text = docs.slice(0, 40).map((s, idx) => `\`${idx+1}.\` **${s.name}** (${s.playCount} plays)`).join("\n");
            const more = docs.length > 40 ? `\n...and ${docs.length - 40} more` : "";
            return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(toSmallCaps("📜 sᴏᴜɴᴅ ʟɪsᴛ")).setDescription(toSmallCaps(text + more)).setFooter({ text: toSmallCaps(`${docs.length} sᴏᴜɴᴅs`) }).setTimestamp() ], flags: 64 });
          }

          // ----- /sound panel -----
          if (sub === "panel") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ embeds: [ makeEmbed({ title: toSmallCaps("❌ ᴘᴇʀᴍɪssɪᴏɴ"), description: toSmallCaps("admins only"), color: EmbedColors.ERROR, guild }) ], flags: 64 });
            const ui = await buildSoundPanelEmbed(guild);
            const msg = await interaction.reply({ embeds: [ui.embed], components: ui.buttons, withResponse: true });
            sbPanels.set(guildId, { messageId: msg.id, channelId: msg.channelId });
            return;
          }
          return interaction.reply({ embeds: [ new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(toSmallCaps("sound — usage")).setDescription(toSmallCaps("/sound add|play|delete|list|panel|volume|top")).setTimestamp() ], flags: 64 });
        }
      }
    } 

    if (interaction.isButton()) {
      // 1. Setup & Safety Checks
      const { guild, guildId, member, customId } = interaction;
      if (!guild) return; 
      
      // Check Admin permissions
      if (!await checkAdmin(interaction)) return;

      try {
        if (customId.startsWith("sb_")) {
          const q = getSbQueue(guildId);
          
          // Safety: If queue is missing (bot restarted), warn user unless connecting
          if (!q && customId !== "sb_connect") {
             return interaction.reply({ content: toSmallCaps("⚠️ Player not active. Click Connect."), flags: 64 });
          }

          if (customId === "sb_refresh") { 
            await sbUpdatePanel(guild); 
            return interaction.deferUpdate(); 
          }
          
          if (customId === "sb_connect") {
            const res = await sbConnectToMember(member);
            if (res?.error) {
              return interaction.reply({ 
                embeds: [ new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(toSmallCaps("🎧 Connection Failed")).setDescription(toSmallCaps("Join a voice channel first.")).setTimestamp() ], 
                flags: 64 
              });
            }
            const queue = getSbQueue(guildId);
            queue.vcId = res.channel.id;
            if (queue.timeout) { clearTimeout(queue.timeout); queue.timeout = null; }
            await sbUpdatePanel(guild);
            return interaction.deferUpdate();
          }

          if (customId === "sb_skip") { 
            try { q.player.stop(); } catch(e) {} 
            await sbUpdatePanel(guild); 
            return interaction.deferUpdate(); 
          }

          if (customId === "sb_stop") { 
            q.list = []; 
            // Delete local file if exists
            if (q.currentFile && fs.existsSync(q.currentFile)) {
                fs.unlink(q.currentFile, (e) => {});
                q.currentFile = null;
            }
            q.now = null;
            try { q.player.stop(true); } catch(e) {} 
            
            const conn = getVoiceConnection(guildId); 
            if (conn) conn.destroy(); 
            q.vcId = null; 
            
            await sbUpdatePanel(guild); 
            return interaction.deferUpdate(); 
          }
          return interaction.deferUpdate(); // Catch-all
        }


        // Fetch current settings (Uses your cache system)
        let settings = await getGuildSettings(guildId);
        if (!settings) return interaction.reply({ content: "❌ Database error: Settings not found.", flags: 64 });

        let didChange = false;

        switch (customId) {
          // Toggles: Update local object immediately for UI speed
          case "toggleLeaveAlerts": settings.leaveAlerts = !settings.leaveAlerts; didChange = true; break;
          case "toggleJoinAlerts": settings.joinAlerts = !settings.joinAlerts; didChange = true; break;
          case "toggleOnlineAlerts": settings.onlineAlerts = !settings.onlineAlerts; didChange = true; break;
          case "togglePrivateThreads": settings.privateThreadAlerts = !settings.privateThreadAlerts; didChange = true; break;
          case "toggleAutoDelete": settings.autoDelete = !settings.autoDelete; didChange = true; break;
          case "toggleIgnoreRole": settings.ignoreRoleEnabled = !settings.ignoreRoleEnabled; didChange = true; break;
          
          // Reset Flow
          case "resetSettings": {
            const confirmRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("confirmReset").setLabel("✅ Yes, Reset").setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId("cancelReset").setLabel("❌ No, Cancel").setStyle(ButtonStyle.Secondary)
            );
            return interaction.update({ 
              embeds: [ makeEmbed({ title: toSmallCaps("⚠️ Confirm Reset"), description: toSmallCaps("Reset all VC alert settings?"), color: EmbedColors.WARNING, guild }) ], 
              components: [confirmRow] 
            });
          }
          case "confirmReset": {
            await GuildSettings.deleteOne({ guildId });
            guildSettingsCache.delete(guildId); // Clear cache
            
            // Re-fetch defaults
            settings = await getGuildSettings(guildId); 
            const panel = buildControlPanel(settings, guild);
            await interaction.update({ embeds: [panel.embed], components: [panel.buttons] });
            return interaction.followUp({ content: toSmallCaps("🎉 Settings Reset!"), flags: 64 });
          }
          case "cancelReset": {
            // Just re-render logic below
            break; 
          }
          default:
            return; // Unknown button
        }


        if (didChange) {
            // 1. Update Cache
            guildSettingsCache.set(guildId, settings);

            // 2. Force Database Update (Background)
            // We use specific $set to ensure atomic updates
            GuildSettings.updateOne({ guildId }, { 
                $set: { 
                    leaveAlerts: settings.leaveAlerts,
                    joinAlerts: settings.joinAlerts,
                    onlineAlerts: settings.onlineAlerts,
                    privateThreadAlerts: settings.privateThreadAlerts,
                    autoDelete: settings.autoDelete,
                    ignoreRoleEnabled: settings.ignoreRoleEnabled
                }
            }).catch(e => console.error(`[Button DB Save Error] ${guildId}:`, e));
        }

        // Re-draw panel using the updated `settings` object
        const updatedPanel = buildControlPanel(settings, guild);
        return interaction.update({ embeds: [updatedPanel.embed], components: updatedPanel.buttons });

      } catch (error) {
        console.error("Button Interaction Error:", error);
        if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({ content: "❌ An internal error occurred.", flags: 64 });
        }
      }
    }

    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "sound") return;
      const sub = interaction.options.getSubcommand();
      const focused = (interaction.options.getFocused() || "").toString().toLowerCase();
      const sounds = await Sound.find({ guildId }).select("name").limit(100).lean().catch(()=>[]);
      const names = sounds.map(s => s.name);

      if (sub === "add") {
        const exist = names.filter(n => n.toLowerCase().includes(focused)).slice(0,25);
        if (!exist.length) return interaction.respond([{ name: toSmallCaps("✅ new name"), value: focused || "" }]);
        return interaction.respond(exist.map(n => ({ name: toSmallCaps("⚠ " + n + " (exists)"), value: n })));
      }
      const matches = names.filter(n => n.toLowerCase().includes(focused)).slice(0,25);
      if (!matches.length) return interaction.respond([{ name: toSmallCaps("ɴᴏ ʀᴇsᴜʟᴛs"), value: "" }]);
      return interaction.respond(matches.map(n => ({ name: toSmallCaps("🎵 " + n), value: n })));
    }

  } catch (err) {
    console.error("[Interaction Handler] Error:", err?.stack ?? err?.message ?? err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: toSmallCaps("An error occurred while processing your request."), flags: 64 }); } catch (_) {}
  }
});

// ─────────────── Voice Channel Alert System ───────────────
const activeVCThreads = new Map();
const threadDeletionTimeouts = new Map();
const vcLocks = new Map();
const THREAD_INACTIVITY_MS = 5 * 60 * 1000; 

async function withVCLock(vcId, fn) {
  const prev = vcLocks.get(vcId) || Promise.resolve();
  const next = prev.then(() => fn()).finally(() => { if (vcLocks.get(vcId) === next) vcLocks.delete(vcId); });
  vcLocks.set(vcId, next);
  return next;
}
async function fetchTextChannel(guild, channelId) {
  try {
    const cached = guild.channels.cache.get(channelId);
    if (cached?.isTextBased()) return cached;
    const fetched = await guild.channels.fetch(channelId).catch(() => null);
    return fetched?.isTextBased() ? fetched : null;
  } catch { return null; }
}

client.on("channelDelete", (channel) => {
  if (threadDeletionTimeouts.has(channel.id)) { clearTimeout(threadDeletionTimeouts.get(channel.id)); threadDeletionTimeouts.delete(channel.id); }
  if (activeVCThreads.has(channel.id)) { activeVCThreads.delete(channel.id); }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const user = newState.member?.user ?? oldState.member?.user;
    if (!user || user.bot) return;
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;
    const settings = await getGuildSettings(guild.id);
    if (!settings?.alertsEnabled || !settings.textChannelId) return;
    const member = newState.member ?? oldState.member;
    if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member?.roles?.cache?.has(settings.ignoredRoleId)) return;

    const joined = !oldState.channelId && newState.channelId && settings.joinAlerts;
    const left = oldState.channelId && !newState.channelId && settings.leaveAlerts;
    if (!joined && !left) return;

    const vc = newState.channel ?? oldState.channel;
    if (!vc) return;
    const logChannel = await fetchTextChannel(guild, settings.textChannelId);
    if (!logChannel) return;

    const avatar = user.displayAvatarURL({ dynamic: true });
    const botAvatar = client.user.displayAvatarURL();
    let embed;
    if (joined) {
      addLog("join", user.tag, vc.name, guild); // Non-blocking
      embed = new EmbedBuilder().setColor(EmbedColors.VC_JOIN).setAuthor({ name: `${user.username} just popped in! 🔊`, iconURL: avatar }).setDescription(`🎧 **${user.username}** joined ${vc.name} — let the vibes begin!`).setFooter({ text: "🎉 welcome to the voice party!", iconURL: botAvatar }).setTimestamp();
    } else if (left) {
      addLog("leave", user.tag, vc.name, guild); // Non-blocking
      embed = new EmbedBuilder().setColor(EmbedColors.VC_LEAVE).setAuthor({ name: `${user.username} dipped out! 🏃‍♂️`, iconURL: avatar }).setDescription(`👋 **${user.username}** left ${vc.name} — see ya next time!`).setFooter({ text: "💨 gone but not forgotten.", iconURL: botAvatar }).setTimestamp();
    } else return;

    await withVCLock(vc.id, async () => {
      const everyonePerms = vc.permissionsFor(guild.roles.everyone);
      const isPrivateVC = everyonePerms && !everyonePerms.has(PermissionsBitField.Flags.ViewChannel);

      if (isPrivateVC && settings.privateThreadAlerts) {
        let thread = activeVCThreads.get(vc.id);
        if (!thread || thread.archived || !logChannel.threads.cache.has(thread.id)) {
          const shortName = vc.name.length > 80 ? vc.name.slice(0, 80) + "…" : vc.name;
          try {
            thread = await logChannel.threads.create({ name: `🔊│${shortName} • VC Alerts`, type: ChannelType.PrivateThread, autoArchiveDuration: 1440, reason: `Private VC alert thread for ${vc.name}` });
            activeVCThreads.set(vc.id, thread);
            console.log(`[VC Thread] 🧵 Created new thread for ${vc.name}`);
          } catch (err) { console.warn(`[VC Thread] Failed to create thread for ${vc.name}:`, err.message); return; }
        }
        if (threadDeletionTimeouts.has(vc.id)) clearTimeout(threadDeletionTimeouts.get(vc.id));
        const timeout = setTimeout(async () => {
          try { await thread.delete().catch(() => {}); console.log(`[VC Thread] 🗑️ Deleted inactive thread for ${vc.name}`); } finally { activeVCThreads.delete(vc.id); threadDeletionTimeouts.delete(vc.id); }
        }, THREAD_INACTIVITY_MS);
        timeout.unref();
        threadDeletionTimeouts.set(vc.id, timeout);

        const memberIds = new Set();
        const allMembers = guild.members.cache.filter((m) => !m.user.bot);
        allMembers.forEach((m) => { const perms = vc.permissionsFor(m); if (perms?.has(PermissionsBitField.Flags.ViewChannel)) memberIds.add(m.id); });
        const ids = [...memberIds];
        const BATCH_SIZE = 20;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) { const batch = ids.slice(i, i + BATCH_SIZE); await Promise.all(batch.map(id => thread.members.add(id).catch(() => {}))); await new Promise(res => setTimeout(res, 100)); }
        try { const msg = await thread.send({ embeds: [embed] }); if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref(); } catch (err) { console.warn(`[VC Thread] Failed to send embed in ${vc.name}:`, err.message); }
      } else {
        try { const msg = await logChannel.send({ embeds: [embed] }); if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref(); } catch (err) { console.warn(`[VC Alert] Failed to send public alert in ${logChannel.name}:`, err.message); }
      }
    });
  } catch (err) { console.error("[voiceStateUpdate] Error:", err); }
});

client.on("presenceUpdate", async (oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (!member || member.user.bot || newPresence.status !== "online" || oldPresence?.status === "online") return;
    const settings = await getGuildSettings(member.guild.id);
    if (!settings?.alertsEnabled || !settings.onlineAlerts || !settings.textChannelId) return;
    if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member.roles.cache.has(settings.ignoredRoleId)) return;
    const channel = await fetchTextChannel(member.guild, settings.textChannelId);
    if (!channel) return;

    const embed = new EmbedBuilder().setColor(EmbedColors.ONLINE).setAuthor({ name: `${member.user.username} just came online! 🟢`, iconURL: member.user.displayAvatarURL({ dynamic: true }) }).setDescription(`👀 **${member.user.username}** is now online — something's cooking!`).setFooter({ text: "✨ Ready to vibe!", iconURL: client.user.displayAvatarURL() }).setTimestamp();
    addLog("online", member.user.tag, "-", member.guild); // Non-blocking
    const msg = await channel.send({ embeds: [embed] }).catch(e => console.warn(`Failed to send online alert for ${member.user.username}:`, e?.message ?? e));
    if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000);
  } catch (e) { console.error("[presenceUpdate] Handler error:", e?.stack ?? e?.message ?? e); }
});

async function checkAdmin(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  const hasPermission = member?.permissions?.has(PermissionFlagsBits.Administrator) || member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  if (!hasPermission) { await interaction.reply({ embeds: [makeEmbed({ title: "No Permission", description: "You need Administrator or Manage Server permission to use this.", color: EmbedColors.ERROR, guild })], flags: 64 }); return false; }
  return true;
}

async function shutdown(signal) {
  try {
    console.log(`[Shutdown] Received ${signal}. Cleaning up...`);
    if (pendingSaveTimer) { clearTimeout(pendingSaveTimer); pendingSaveTimer = null; }
    if (pendingSaveQueue.size > 0) {
      const entries = Array.from(pendingSaveQueue.entries());
      pendingSaveQueue.clear();
      await Promise.all(entries.map(([guildId, settings]) => GuildSettings.findOneAndUpdate({ guildId }, settings, { upsert: true, setDefaultsOnInsert: true }).exec().catch(e => console.error(`[DB] Shutdown save failed for ${guildId}:`, e?.message ?? e))));
    }
    // Cleanup Temp Dir
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) fs.unlinkSync(path.join(TEMP_DIR, file));
    
    for (const t of threadDeletionTimeouts.values()) clearTimeout(t);
    threadDeletionTimeouts.clear();
    activeVCThreads.clear();
    await mongoose.disconnect().catch(() => {});
    try { await client.destroy(); } catch (_) {}
    console.log("[Shutdown] Completed. Exiting.");
    process.exit(0);
  } catch (err) { console.error("[Shutdown] Error during shutdown:", err); process.exit(1); }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); shutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', reason); });

(async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI not provided in .env");
    await mongoose.connect(process.env.MONGO_URI, { dbName: "Discord-Alert-Bot" });
    console.log("✅ MongoDB Connected to DB");
  } catch (e) { console.error("❌ MongoDB connection error:", e?.message ?? e); process.exit(1); }
  if (!process.env.TOKEN) { console.error("❌ TOKEN not set in .env"); process.exit(1); }
  client.login(process.env.TOKEN).catch(err => console.error("❌ Login failed:", err));
})();