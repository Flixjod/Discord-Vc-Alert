// ============================================================
//  Discord VC Alert & Soundboard Bot  —  Production Build
// ============================================================
//  Architecture & Optimisations
//  ─────────────────────────────
//  • LRU-capped guild-settings cache (200 entries, O(1) eviction)
//  • Batched debounced DB writes — single timer, $set projection
//  • /inv:  VC-presence detection → permission-filtered results
//           • Per-user Invite button (DM + Join deeplink)
//           • Per-user Join button (discord:// deep-link)
//           • Graceful DM-fallback to channel mention
//           • Removed limit option — always shows results inline
//  • Duplicate listener prevention (player + voice connection)
//  • Centralised error handler; no silent catches on hot paths
//  • Temp-file cleanup on every track finish (not only Idle)
//  • Thread inactivity via periodic interval + per-thread safety net
//  • setInterval / setTimeout use .unref() to avoid holding loop
//  • Lean DB queries with minimal field projections
//  • Single-pass aggregation for stats (Map, not filter+length×3)
//  • Mutex (per-VC lock chain) for thread creation race conditions
//  • Voice reconnect guard (Signalling/Connecting window)
//  • Graceful shutdown: flushes DB queue, cleans temp, destroys conns
// ============================================================

import express   from "express";
import fs        from "fs";
const fsp = fs.promises;
import path      from "path";
import { fileURLToPath } from "url";
import axios     from "axios";
import { pipeline } from "stream";
import { promisify }  from "util";
const streamPipeline = promisify(pipeline);

import {
  Client, GatewayIntentBits, PermissionsBitField, PermissionFlagsBits,
  Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder,
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events
} from "discord.js";

import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, getVoiceConnection, entersState,
  VoiceConnectionStatus, StreamType
} from "@discordjs/voice";

import mongoose from "mongoose";
import dotenv   from "dotenv";
dotenv.config();

// ─── Paths ────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TEMP_DIR   = path.join(__dirname, "temp");
const LOGS_DIR   = path.join(__dirname, "logs");

for (const dir of [LOGS_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Non-blocking startup temp-dir purge
fsp.readdir(TEMP_DIR)
  .then(files => Promise.all(files.map(f => fsp.unlink(path.join(TEMP_DIR, f)).catch(() => {}))))
  .catch(() => {});

// ─── Config ───────────────────────────────────────────────────
const PORT     = process.env.PORT     || 8000;
const OWNER_ID = process.env.OWNER_ID || null;

// ─── Small-caps map (frozen → V8 can optimise hidden class) ───
const SMALL_CAPS_MAP = Object.freeze({
  a:"ᴀ",b:"ʙ",c:"ᴄ",d:"ᴅ",e:"ᴇ",f:"ꜰ",g:"ɢ",h:"ʜ",i:"ɪ",
  j:"ᴊ",k:"ᴋ",l:"ʟ",m:"ᴍ",n:"ɴ",o:"ᴏ",p:"ᴘ",q:"ǫ",r:"ʀ",
  s:"s",t:"ᴛ",u:"ᴜ",v:"ᴠ",w:"ᴡ",x:"x",y:"ʏ",z:"ᴢ",
  A:"ᴀ",B:"ʙ",C:"ᴄ",D:"ᴅ",E:"ᴇ",F:"ꜰ",G:"ɢ",H:"ʜ",I:"ɪ",
  J:"ᴊ",K:"ᴋ",L:"ʟ",M:"ᴍ",N:"ɴ",O:"ᴏ",P:"ᴘ",Q:"ǫ",R:"ʀ",
  S:"s",T:"ᴛ",U:"ᴜ",V:"ᴠ",W:"ᴡ",X:"x",Y:"ʏ",Z:"ᴢ",
  "0":"0","1":"1","2":"2","3":"3","4":"4",
  "5":"5","6":"6","7":"7","8":"8","9":"9",
  "!":"!","?":"?",".":".",",":",",":":":","'":"'",'"':'"',"-":" - ","_":"_"," ":" "
});
const sc = (text = "") =>
  String(text).split("").map(ch => SMALL_CAPS_MAP[ch] ?? ch).join("");

// ─── Time helpers ─────────────────────────────────────────────
function toISTString(ts) {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone:"Asia/Kolkata", hour12:true,
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  }).replace(",", "");
}

function fancyAgo(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}ʜ ${m % 60}ᴍ ᴀɢᴏ`;
  if (m > 0) return `${m}ᴍ ${s % 60}ꜱ ᴀɢᴏ`;
  return `${s}ꜱ ᴀɢᴏ`;
}

// ─── Express health endpoint ──────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.get("/", (_, res) =>
  res.status(200).json({
    status:  "✅ Bot is alive",
    uptime:  Math.floor(process.uptime()),
    memory:  `${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB`
  })
);
app.listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

// ─── Mongoose Schemas & Models ────────────────────────────────
const guildSettingsSchema = new mongoose.Schema({
  guildId:             { type: String, required: true, unique: true },
  alertsEnabled:       { type: Boolean, default: false },
  textChannelId:       { type: String,  default: null  },
  joinAlerts:          { type: Boolean, default: true  },
  leaveAlerts:         { type: Boolean, default: true  },
  onlineAlerts:        { type: Boolean, default: true  },
  privateThreadAlerts: { type: Boolean, default: true  },
  autoDelete:          { type: Boolean, default: true  },
  ignoredRoleId:       { type: String,  default: null  },
  ignoreRoleEnabled:   { type: Boolean, default: false }
}, { timestamps: true });
const GuildSettings = mongoose.model("GuildSettings", guildSettingsSchema);

const logSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  guildName: String,
  user:      { type: String, required: true },
  channel:   String,
  type:      { type: String, required: true, enum: ["join","leave","online"] },
  time:      { type: Date,   default: Date.now }
});
logSchema.index({ time: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }); // TTL 30 days
logSchema.index({ guildId: 1, time: -1 });
logSchema.index({ guildId: 1, user: 1, time: -1 });
const GuildLog = mongoose.model("GuildLog", logSchema);

const soundSchema = new mongoose.Schema({
  guildId:          { type: String, required: true },
  name:             { type: String, required: true },
  fileURL:          { type: String, required: true },
  storageMessageId: { type: String, default: null },
  addedBy:          { type: String, default: null },
  playCount:        { type: Number, default: 0    },
  createdAt:        { type: Date,   default: Date.now }
});
soundSchema.index({ guildId: 1, name: 1 }, { unique: true });
soundSchema.index({ guildId: 1, playCount: -1 });
const Sound = mongoose.model("Soundboards", soundSchema);

// ─── Guild Settings Cache + Debounced Writer ──────────────────
//  LRU-capped at MAX_CACHE_SIZE. Oldest entry evicted on overflow.
//  Writes are batched into a 300 ms window and flushed together.
const MAX_CACHE_SIZE     = 200;
const guildSettingsCache = new Map();  // guildId → POJO
const pendingSaveQueue   = new Map();  // guildId → POJO
let   pendingSaveTimer   = null;

function evictOldestCache() {
  const key = guildSettingsCache.keys().next().value;
  if (key) guildSettingsCache.delete(key);
}

function scheduleSaves() {
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(async () => {
    const entries = [...pendingSaveQueue.entries()];
    pendingSaveQueue.clear();
    pendingSaveTimer = null;
    await Promise.all(entries.map(([guildId, s]) =>
      GuildSettings
        .findOneAndUpdate({ guildId }, s, { upsert: true, setDefaultsOnInsert: true })
        .lean().exec()
        .catch(e => console.error(`[DB SAVE] ${guildId}:`, e?.message ?? e))
    ));
  }, 300);
  pendingSaveTimer.unref();
}

function updateGuildSettings(settings) {
  if (!settings?.guildId) return;
  // Move-to-end for LRU refresh
  guildSettingsCache.delete(settings.guildId);
  guildSettingsCache.set(settings.guildId, settings);
  if (guildSettingsCache.size > MAX_CACHE_SIZE) evictOldestCache();
  pendingSaveQueue.set(settings.guildId, settings);
  scheduleSaves();
}

async function getGuildSettings(guildId) {
  const hit = guildSettingsCache.get(guildId);
  if (hit) {
    // Refresh LRU order
    guildSettingsCache.delete(guildId);
    guildSettingsCache.set(guildId, hit);
    return hit;
  }

  let settings = await GuildSettings
    .findOne({ guildId }).lean().select("-__v")
    .catch(() => null);

  if (!settings) {
    settings = {
      guildId, alertsEnabled: false, textChannelId: null,
      joinAlerts: true, leaveAlerts: true, onlineAlerts: true,
      privateThreadAlerts: true, autoDelete: true,
      ignoredRoleId: null, ignoreRoleEnabled: false
    };
    await new GuildSettings(settings).save().catch(e => {
      if (e.code !== 11000)
        console.error(`[DB] default save failed for ${guildId}:`, e?.message ?? e);
    });
  }

  if (guildSettingsCache.size >= MAX_CACHE_SIZE) evictOldestCache();
  guildSettingsCache.set(guildId, settings);
  return settings;
}

// ─── Non-blocking log creation ────────────────────────────────
function addLog(type, user, channel, guild) {
  GuildLog.create({
    guildId:   guild.id   ?? guild,
    guildName: guild.name ?? String(guild),
    user, channel, type, time: Date.now()
  }).catch(err => console.error(`[Log Error]`, err?.message ?? err));
}

// ─── Activity file generator ──────────────────────────────────
async function generateActivityFile(guild, logs) {
  const filePath = path.join(LOGS_DIR, `${guild.id}_activity.txt`);
  const header =
`╔══════════════════════════════════════════════╗
║  🌌 ${sc(guild.name)} ᴀᴄᴛɪᴠɪᴛʏ ʟᴏɢꜱ
║  🗓️  ${sc(toISTString(Date.now()))}
╚══════════════════════════════════════════════╝\n\n`;
  const body = logs.map(l => {
    const emoji  = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
    const action = l.type === "join" ? "entered" : l.type === "leave" ? "left" : "came online";
    return `${emoji} ${sc(l.type.toUpperCase())} — ${l.user} ${action} ${l.channel}\n    🕒 ${fancyAgo(Date.now() - l.time)} • ${toISTString(l.time)}\n`;
  }).join("\n");
  await fsp.writeFile(filePath, header + body, "utf8");
  return filePath;
}

// ─── Embed colours (frozen object) ───────────────────────────
const EmbedColors = Object.freeze({
  SUCCESS: 0x1abc9c, ERROR: 0xe74c3c, WARNING: 0xffcc00,
  INFO: 0x5865f2, VC_JOIN: 0x00ffcc, VC_LEAVE: 0xff5e5e,
  ONLINE: 0x55ff55, RESET: 0x00ccff, INVITE: 0x7289da
});

function makeEmbed({ title, description, color = EmbedColors.INFO, guild }) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: sc(title), iconURL: client.user?.displayAvatarURL() })
    .setDescription(sc(description))
    .setFooter({
      text:    guild?.name ? sc(guild.name) : sc("VC Alert Bot"),
      iconURL: guild?.iconURL?.({ dynamic: true }) ?? client.user?.displayAvatarURL()
    })
    .setTimestamp();
}

// ─── Control Panel Builder ────────────────────────────────────
function buildControlPanel(settings, guild) {
  const embed = new EmbedBuilder()
    .setColor(settings.alertsEnabled ? EmbedColors.SUCCESS : EmbedColors.ERROR)
    .setAuthor({ name: sc("🎛️ VC ALERT CONTROL PANEL"), iconURL: client.user.displayAvatarURL() })
    .setDescription(
      sc("**Your Central Hub for Voice Chat Alerts!** ✨\n\n") +
      `> ${sc("📢 Alerts Channel:")} ${settings.textChannelId ? `<#${settings.textChannelId}>` : sc("Not set")}\n` +
      `> ${sc("🔔 Status:")} ${settings.alertsEnabled ? sc("🟢 Active") : sc("🔴 Disabled")}\n` +
      `> ${sc("👋 Join Alerts:")} ${settings.joinAlerts ? sc("✅ On") : sc("❌ Off")}\n` +
      `> ${sc("🏃 Leave Alerts:")} ${settings.leaveAlerts ? sc("✅ On") : sc("❌ Off")}\n` +
      `> ${sc("🟢 Online Alerts:")} ${settings.onlineAlerts ? sc("✅ On") : sc("❌ Off")}\n` +
      `> ${sc("🪪 Private Alerts:")} ${settings.privateThreadAlerts ? sc("✅ On") : sc("❌ Off")}\n` +
      `> ${sc("🙈 Ignored Role:")} ${settings.ignoredRoleId ? `<@&${settings.ignoredRoleId}> (${settings.ignoreRoleEnabled ? sc("✅ Active") : sc("❌ Inactive")})` : sc("None set")}\n` +
      `> ${sc("🧹 Auto-Delete:")} ${settings.autoDelete ? sc("✅ On (30s)") : sc("❌ Off")}\n\n` +
      sc("*Use the buttons below to configure settings.* ⚙️")
    )
    .setFooter({
      text:    sc(guild?.name || `Server ID: ${settings.guildId}`),
      iconURL: guild?.iconURL?.({ dynamic: true }) ?? client.user.displayAvatarURL()
    })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("toggleJoinAlerts")
      .setLabel(sc("👋 Join")).setStyle(settings.joinAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleLeaveAlerts")
      .setLabel(sc("🏃 Leave")).setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleOnlineAlerts")
      .setLabel(sc("🟢 Online")).setStyle(settings.onlineAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("togglePrivateThreads")
      .setLabel(sc("🪪 Private Alerts")).setStyle(settings.privateThreadAlerts ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleIgnoreRole")
      .setLabel(sc("🙈 Ignore Alerts")).setStyle(settings.ignoreRoleEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleAutoDelete")
      .setLabel(sc("🧹 Auto-Delete")).setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("resetSettings")
      .setLabel(sc("♻️ Reset Settings")).setStyle(ButtonStyle.Danger)
  );
  return { embed, buttons: [row1, row2] };
}

// ─── Soundboard ───────────────────────────────────────────────
// sbQueues: guildId → queue object (lazy-created, destroyed on stop)
const sbQueues = new Map();
const sbPanels = new Map();  // guildId → { messageId, channelId }

function getSbQueue(guildId) {
  if (sbQueues.has(guildId)) return sbQueues.get(guildId);

  const player = createAudioPlayer();
  const q = {
    player,
    list:            [],   // pending tracks
    now:             null, // currently playing track
    vcId:            null,
    timeout:         null, // idle-leave timer
    guildId,
    lastTextChannel: null,
    currentFile:     null, // temp file path
    volume:          1.0,
    resource:        null
  };

  // ── Audio-player events (registered exactly once per queue) ──
  player.on("stateChange", (_old, next) => {
    if (next.status === AudioPlayerStatus.Buffering) {
      // Auto-skip if stuck buffering > 8 s
      const guard = setTimeout(() => {
        if (q.player.state.status === AudioPlayerStatus.Buffering) {
          console.warn(`[Soundboard] Stuck buffering in guild ${guildId}; auto-skipping.`);
          q.player.stop();
        }
      }, 8_000);
      guard.unref();
    }
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    try {
      q.resource = null;
      if (q.currentFile) {
        const f = q.currentFile; q.currentFile = null;
        fsp.unlink(f).catch(() => {});
      }
      q.now = null;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      if (q.list.length === 0) startSbLeaveTimer(guildId);
      else await sbPlayNext(guild, q.lastTextChannel);
      sbUpdatePanel(guild);
    } catch (err) { console.error("[Soundboard Idle]", err); }
  });

  player.on("error", err => {
    console.error("[Soundboard Player Error]", err);
    q.lastTextChannel?.send({ content: `⚠️ **${q.now?.name ?? "Track"}** failed. Skipping…` }).catch(() => {});
    q.player.stop();
  });

  sbQueues.set(guildId, q);
  return q;
}

function destroySbQueue(guildId) {
  const q = sbQueues.get(guildId);
  if (!q) return;
  if (q.timeout) { clearTimeout(q.timeout); q.timeout = null; }
  try { q.player.stop(true); } catch (_) {}
  if (q.currentFile) { fsp.unlink(q.currentFile).catch(() => {}); q.currentFile = null; }
  sbQueues.delete(guildId);
}

// 10-min idle timer before bot auto-disconnects
function startSbLeaveTimer(guildId) {
  const q = sbQueues.get(guildId);
  if (!q) return;
  if (q.timeout) clearTimeout(q.timeout);
  const vcId = q.vcId;
  q.timeout = setTimeout(() => {
    const conn = getVoiceConnection(guildId);
    if (conn && conn.joinConfig.channelId === vcId) conn.destroy();
    q.list = []; q.now = null; q.vcId = null; q.resource = null;
  }, 10 * 60_000);
  q.timeout.unref();
}

// Ensure soundboard-storage channel exists (creates if missing)
async function sbEnsureStorage(guild) {
  const ch = guild.channels.cache.find(
    c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText
  );
  if (ch) return ch;

  const me = await guild.members.fetch(client.user.id).catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels))
    throw new Error("Missing ManageChannels to create storage channel");

  return guild.channels.create({
    name: "soundboard-storage",
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: client.user.id, allow: ["ViewChannel","SendMessages","AttachFiles"] }
    ]
  });
}

// Play next track in queue (up to 3 download attempts)
async function sbPlayNext(guild, textChannel = null, retryCount = 0) {
  const q = getSbQueue(guild.id);
  if (textChannel) q.lastTextChannel = textChannel;
  if (!q.list.length) { q.now = null; startSbLeaveTimer(guild.id); sbUpdatePanel(guild); return; }

  const next = q.list.shift();
  q.now = next;
  if (next._id) Sound.updateOne({ _id: next._id }, { $inc: { playCount: 1 } }).catch(() => {});

  let localFile = null;
  try {
    // Prefer storage-message URL (always fresh) over stored URL
    let downloadUrl = next.fileURL;
    const storageCh = guild.channels.cache.find(
      c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText
    );
    if (storageCh && next.storageMessageId) {
      const msg = await storageCh.messages.fetch(next.storageMessageId).catch(() => null);
      if (msg?.attachments.size) downloadUrl = msg.attachments.first().url;
    }

    const fileExt = path.extname(new URL(downloadUrl).pathname) || ".mp3";
    localFile = path.join(TEMP_DIR, `${guild.id}_${Date.now()}${fileExt}`);

    let downloaded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await axios({
          method: "GET", url: downloadUrl,
          responseType: "stream", timeout: 30_000
        });
        await streamPipeline(resp.data, fs.createWriteStream(localFile));
        downloaded = true; break;
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1_000));
      }
    }
    if (!downloaded) throw new Error("Download failed after 3 attempts");

    const { size } = await fsp.stat(localFile);
    if (size === 0) throw new Error("Downloaded file is empty");

    const resource = createAudioResource(localFile, {
      inputType: StreamType.Arbitrary, inlineVolume: true
    });
    resource.volume.setVolume(q.volume);
    q.currentFile = localFile;
    q.resource    = resource;
    q.player.play(resource);

    textChannel?.send({
      embeds: [
        new EmbedBuilder()
          .setColor(EmbedColors.VC_JOIN)
          .setTitle(sc("🎧 ɴᴏᴡ ᴘʟᴀʏɪɴɢ"))
          .setDescription(sc(`**${next.name}**`))
          .setFooter({ text: `Volume: ${Math.round(q.volume * 100)}%` })
          .setTimestamp()
      ]
    }).catch(() => {});
    sbUpdatePanel(guild);
  } catch (e) {
    console.error("[Soundboard playNext]", e);
    if (localFile) fsp.unlink(localFile).catch(() => {});
    textChannel?.send(`⚠️ **${next.name}** failed to load. ${retryCount < 1 ? "Retrying…" : "Skipping…"}`).catch(() => {});
    q.now = null;
    if (retryCount < 1) {
      q.list.unshift(next);
      setTimeout(() => sbPlayNext(guild, textChannel, retryCount + 1).catch(() => {}), 2_000).unref();
    } else {
      setTimeout(() => sbPlayNext(guild, textChannel, 0).catch(() => {}), 1_000).unref();
    }
  }
}

// Connect bot to the member's current VC
async function sbConnectToMember(member) {
  if (!member.voice.channel) return { error: "not_in_vc" };
  const vc = member.voice.channel, guild = member.guild;

  try {
    const existing = getVoiceConnection(guild.id);
    if (existing) {
      if (existing.state.status === VoiceConnectionStatus.Ready) {
        const q = getSbQueue(guild.id);
        q.vcId = vc.id;
        if (q.timeout) { clearTimeout(q.timeout); q.timeout = null; }
        existing.subscribe(q.player);
        return { connection: existing, channel: vc };
      }
      existing.destroy();
    }

    const conn = joinVoiceChannel({
      channelId: vc.id, guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false
    });

    // Reconnect guard
    conn.once(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting,  5_000)
        ]);
      } catch {
        conn.destroy();
        const q = sbQueues.get(guild.id);
        if (q) { q.vcId = null; q.list = []; q.now = null; }
      }
    });

    conn.once(VoiceConnectionStatus.Destroyed, () => {
      const q = sbQueues.get(guild.id);
      if (q) q.vcId = null;
    });

    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      conn.destroy();
      return { error: "connect_timeout" };
    }

    const q = getSbQueue(guild.id);
    q.vcId = vc.id;
    if (q.timeout) { clearTimeout(q.timeout); q.timeout = null; }
    conn.subscribe(q.player);
    return { connection: conn, channel: vc };
  } catch (err) {
    console.error("[Soundboard connect]", err);
    return { error: "connect_failed", details: err.message };
  }
}

// Build the soundboard panel embed + buttons
async function buildSoundPanelEmbed(guild) {
  const q     = getSbQueue(guild.id);
  const total = await Sound.countDocuments({ guildId: guild.id }).catch(() => 0);
  const conn  = getVoiceConnection(guild.id);

  const statusLabel = q.now ? "🟢 ᴘʟᴀʏɪɴɢ" : (conn ? "🟡 ᴄᴏɴɴᴇᴄᴛᴇᴅ" : "🔴 ɪᴅʟᴇ");
  const nowPlaying  = q.now ? `🎧 ${q.now.name}` : "—";
  const queueLines  = q.list.slice(0, 8).map((s, i) => `\`${i + 1}.\` ${s.name}`).join("\n") || sc("ɴᴏ ǫᴜᴇᴜᴇᴅ sᴏᴜɴᴅs");
  const moreText    = q.list.length > 8 ? `\n…and ${q.list.length - 8} more` : "";

  const embed = new EmbedBuilder()
    .setColor(EmbedColors.VC_JOIN)
    .setAuthor({ name: sc("🎛 sᴏᴜɴᴅʙᴏᴀʀᴅ ᴘᴀɴᴇʟ"), iconURL: client.user.displayAvatarURL() })
    .setDescription(
      `${sc("> sᴛᴀᴛᴜs:")} ${sc(statusLabel)}\n` +
      `${sc("> ᴠᴏʟᴜᴍᴇ:")} ${Math.round(q.volume * 100)}%\n` +
      `${sc("> ɴᴏᴡ ᴘʟᴀʏɪɴɢ:")} ${sc(nowPlaying)}\n` +
      `${sc("> ᴛᴏᴛᴀʟ sᴏᴜɴᴅs:")} ${total}\n\n` +
      `${sc("📜 ǫᴜᴇᴜᴇ:")}\n${sc(queueLines + moreText)}`
    )
    .setFooter({ text: sc(guild.name) })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sb_connect").setLabel(sc("🎧 ᴄᴏɴɴᴇᴄᴛ")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("sb_skip").setLabel(sc("⏭ sᴋɪᴘ")).setStyle(ButtonStyle.Secondary).setDisabled(!q.now),
    new ButtonBuilder().setCustomId("sb_stop").setLabel(sc("⛔ sᴛᴏᴘ")).setStyle(ButtonStyle.Danger).setDisabled(!q.now),
    new ButtonBuilder().setCustomId("sb_refresh").setLabel(sc("🔃 ʀᴇꜰʀᴇsʜ")).setStyle(ButtonStyle.Secondary)
  );
  return { embed, buttons: [row] };
}

async function sbUpdatePanel(guild) {
  const panel = sbPanels.get(guild.id);
  if (!panel) return;
  try {
    const ch = guild.channels.cache.get(panel.channelId)
      ?? await guild.channels.fetch(panel.channelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
    if (!msg) return;
    const ui = await buildSoundPanelEmbed(guild);
    await msg.edit({ embeds: [ui.embed], components: ui.buttons }).catch(() => {});
  } catch (e) { console.error("[sbUpdatePanel]", e); }
}

// ─── Discord Client ───────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials:            [Partials.User, Partials.GuildMember],
  ws:                  { properties: { browser: "Discord iOS" } },
  shards:              "auto",
  restRequestTimeout:  30_000
});

// ─── Slash Commands ───────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("⚙️ View and manage VC activity & presence alerts"),

  new SlashCommandBuilder()
    .setName("activate")
    .setDescription("🚀 Activate VC alerts")
    .addChannelOption(o =>
      o.setName("channel").setDescription("Text channel for alerts")
        .addChannelTypes(ChannelType.GuildText).setRequired(false)),

  new SlashCommandBuilder()
    .setName("deactivate")
    .setDescription("🛑 Disable all VC alerts"),

  new SlashCommandBuilder()
    .setName("ignorerole")
    .setDescription("🙈 Manage the ignored-role setting")
    .addStringOption(o =>
      o.setName("action").setDescription("Action to perform").setRequired(true)
        .addChoices(
          { name:"View", value:"view" }, { name:"Set", value:"set" },
          { name:"Reset", value:"reset" }, { name:"Toggle On/Off", value:"toggle" }
        ))
    .addRoleOption(o =>
      o.setName("role").setDescription("Role to ignore (required for 'set')").setRequired(false)),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("👤 Get detailed info about a user")
    .addUserOption(o =>
      o.setName("user").setDescription("User to inspect (default: yourself)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("owner")
    .setDescription("👑 Bot owner dashboard (DM only)"),

  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("📜 View server activity logs")
    .addStringOption(o =>
      o.setName("range").setDescription("Time range").setRequired(false)
        .addChoices(
          { name:"📅 Today", value:"today" },
          { name:"🕓 Yesterday", value:"yesterday" },
          { name:"📆 Last 7 days", value:"7days" },
          { name:"🗓️ Last 30 days", value:"30days" }
        ))
    .addUserOption(o =>
      o.setName("user").setDescription("Filter by user").setRequired(false)),

  new SlashCommandBuilder()
    .setName("sound")
    .setDescription("🔊 Soundboard controls")
    .addSubcommand(s => s.setName("add").setDescription("➕ Add a sound")
      .addStringOption(o => o.setName("name").setDescription("Sound name").setRequired(true))
      .addAttachmentOption(o => o.setName("file").setDescription("Audio file")))
    .addSubcommand(s => s.setName("play").setDescription("▶ Play a sound")
      .addStringOption(o => o.setName("name").setDescription("Sound name").setAutocomplete(true).setRequired(true)))
    .addSubcommand(s => s.setName("delete").setDescription("🗑 Delete a sound")
      .addStringOption(o => o.setName("name").setDescription("Sound name").setAutocomplete(true).setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("📜 List all sounds"))
    .addSubcommand(s => s.setName("panel").setDescription("🎛 Open soundboard panel"))
    .addSubcommand(s => s.setName("volume").setDescription("🔊 Set playback volume (0–100)")
      .addIntegerOption(o => o.setName("level").setDescription("0 – 100").setRequired(true).setMinValue(0).setMaxValue(100)))
    .addSubcommand(s => s.setName("top").setDescription("🏆 Most-played sounds")),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("📊 Show server activity statistics")
    .addStringOption(o =>
      o.setName("period").setDescription("Time period").setRequired(false)
        .addChoices(
          { name:"📅 Today", value:"today" },
          { name:"📆 Last 7 days", value:"7days" },
          { name:"🗓️ Last 30 days", value:"30days" },
          { name:"📈 All time", value:"all" }
        )),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("🏓 Check bot latency and status"),

  new SlashCommandBuilder()
    .setName("cleanup")
    .setDescription("🧹 Clean up old logs and temp files"),

  // ── /inv — Invite users to your Voice Channel ─────────────
  //   • Detects whether the command user is in a VC
  //   • Filters to only users who can access that VC
  //   • Shows results directly — no limit option needed
  //   • Per-user Invite button (DM + fallback channel mention)
  //   • Per-user Join button (discord:// deep-link to the VC)
  new SlashCommandBuilder()
    .setName("inv")
    .setDescription("📨 Invite someone to your voice channel")
    .addStringOption(o =>
      o.setName("search")
        .setDescription("Search by name — leave empty to see top VC users")
        .setRequired(false)
        .setAutocomplete(true))

].map(c => c.toJSON());

// ─── Heartbeat Monitor ────────────────────────────────────────
let lastHeartbeat       = Date.now();
let reconnectAttempts   = 0;
let lastHbWarnAt        = 0;
const MAX_RECONNECT     = 5;
const HB_WARN_CD        = 5 * 60_000;  // 5 min cooldown on warnings

const heartbeatInterval = setInterval(() => {
  const gap = Date.now() - lastHeartbeat;
  if (gap > 60_000) {
    const now = Date.now();
    if (now - lastHbWarnAt > HB_WARN_CD) {
      console.warn(`⚠️ No heartbeat for ${Math.floor(gap / 1000)}s`);
      lastHbWarnAt = now;
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT}…`);
        client.destroy();
        setTimeout(() =>
          client.login(process.env.TOKEN).catch(e =>
            console.error("❌ Reconnect failed:", e)
          ), 5_000
        ).unref();
      }
    }
  }
}, 30_000);
heartbeatInterval.unref();

// ─── Ready ────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  lastHeartbeat     = Date.now();
  reconnectAttempts = 0;

  try { client.user.setActivity("the VC vibes unfold 🎧✨", { type: 3 }); } catch (_) {}

  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  await rest
    .put(Routes.applicationCommands(client.user.id), { body: commands })
    .then(() => console.log("✅ Slash commands registered"))
    .catch(e  => console.error("❌ Command registration error:", e));

  // Pre-warm settings cache for known guilds
  const ids = client.guilds.cache.map(g => g.id);
  await Promise.all(ids.map(id => getGuildSettings(id).catch(() => null)));
  console.log(`✅ Cache pre-warmed for ${ids.length} guild(s)`);
});

// ─── Admin guard helper ───────────────────────────────────────
async function checkAdmin(interaction) {
  const ok = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)
          || interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  if (!ok) {
    await interaction.reply({
      embeds: [makeEmbed({
        title: "🚫 No Permission",
        description: "You need **Administrator** or **Manage Server** permission to do that.",
        color: EmbedColors.ERROR,
        guild: interaction.guild
      })],
      flags: 64
    });
  }
  return !!ok;
}

// ─── /inv: VC permission helper ───────────────────────────────
function canAccessVC(member, vc) {
  const p = vc.permissionsFor(member);
  return p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.Connect);
}

// ─── /inv: Build per-user button rows ─────────────────────────
//  Each candidate gets TWO buttons:
//    • 📨 Invite  → sends DM + fallback channel mention
//    • 🔊 Join    → discord:// deep-link (opens VC in app)
//  Button IDs: inv_notify_{memberId}_{vcId}
//              inv_join_{memberId}_{vcId}        (link button — no handler needed)
//
//  Discord limits 5 buttons per row, 5 rows per message (25 max).
//  With 2 buttons each, we safely support up to 5 candidates (10 buttons = 2 rows).
function buildInviteRows(candidates, invokerVC) {
  if (!invokerVC || candidates.length === 0) return [];

  const rows = [];
  // Chunk candidates into groups of up to 2 per row (each contributes 2 buttons → max 4/row)
  // We use a slightly different strategy: each user gets their own ActionRow of 2 buttons.
  // Cap at 5 rows (Discord max).
  const cappedCandidates = candidates.slice(0, 5);

  for (const m of cappedCandidates) {
    const shortName  = m.displayName.slice(0, 18);
    const vcDeepLink = `https://discord.com/channels/${m.guild.id}/${invokerVC.id}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`inv_notify_${m.id}_${invokerVC.id}`)
        .setLabel(`📨 Invite ${shortName}`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setLabel(`🔊 Open ${invokerVC.name.slice(0, 20)}`)
        .setStyle(ButtonStyle.Link)
        .setURL(vcDeepLink)
    );
    rows.push(row);
  }
  return rows;
}

// ─── Interaction Handler ──────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild() && interaction.commandName !== "owner") return;

    const guild   = interaction.guild;
    const guildId = guild?.id;
    const settings = guildId ? await getGuildSettings(guildId) : null;

    // ──────────────────────────────────────────────────────────
    //  SLASH COMMANDS
    // ──────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const publicCmds = new Set(["owner", "inv", "ping", "userinfo"]);
      if (!publicCmds.has(interaction.commandName) && !await checkAdmin(interaction)) return;

      switch (interaction.commandName) {

        // ─── /settings ───────────────────────────────────────
        case "settings": {
          const panel = buildControlPanel(settings, guild);
          return interaction.reply({ embeds: [panel.embed], components: panel.buttons, flags: 64 });
        }

        // ─── /activate ───────────────────────────────────────
        case "activate": {
          const selected = interaction.options.getChannel("channel");
          let channel = selected
            ?? (settings.textChannelId
                ? (guild.channels.cache.get(settings.textChannelId)
                   ?? await guild.channels.fetch(settings.textChannelId).catch(() => null))
                : interaction.channel);

          if (!channel || channel.type !== ChannelType.GuildText)
            return interaction.reply({
              embeds: [makeEmbed({ title: "⚠️ Invalid Channel", description: "Please select a text channel.", color: EmbedColors.ERROR, guild })],
              flags: 64
            });

          const botMember = await guild.members.fetch(client.user.id).catch(() => null);
          const perms     = channel.permissionsFor(botMember);
          if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages))
            return interaction.reply({
              embeds: [makeEmbed({ title: "🚫 Missing Permissions", description: `I need **View Channel** + **Send Messages** in <#${channel.id}>.`, color: EmbedColors.ERROR, guild })],
              flags: 64
            });

          if (settings.alertsEnabled && settings.textChannelId === channel.id)
            return interaction.reply({
              embeds: [makeEmbed({ title: "🟢 Already Active", description: `Alerts are already running in <#${channel.id}>.`, color: EmbedColors.WARNING, guild })],
              flags: 64
            });

          settings.alertsEnabled = true;
          settings.textChannelId = channel.id;
          updateGuildSettings(settings);
          return interaction.reply({
            embeds: [makeEmbed({ title: "✅ VC Alerts Activated", description: `Alerts will now appear in <#${channel.id}>.`, color: EmbedColors.SUCCESS, guild })],
            flags: 64
          });
        }

        // ─── /deactivate ─────────────────────────────────────
        case "deactivate": {
          if (!settings.alertsEnabled)
            return interaction.reply({
              embeds: [makeEmbed({ title: "💤 Already Off", description: "Use `/activate` to re-enable alerts.", color: EmbedColors.WARNING, guild })],
              flags: 64
            });
          settings.alertsEnabled = false;
          updateGuildSettings(settings);
          return interaction.reply({
            embeds: [makeEmbed({ title: "🔕 VC Alerts Disabled", description: "No more alerts until you run `/activate` again.", color: EmbedColors.ERROR, guild })],
            flags: 64
          });
        }

        // ─── /ignorerole ─────────────────────────────────────
        case "ignorerole": {
          const action = interaction.options.getString("action");
          const role   = interaction.options.getRole("role");

          if (action === "view") {
            return interaction.reply({
              embeds: [makeEmbed({
                title: "🙈 Ignore Role Settings",
                description:
                  `**Status:** ${settings.ignoreRoleEnabled ? "🟢 Active" : "🔴 Inactive"}\n` +
                  `**Ignored Role:** ${settings.ignoredRoleId ? `<@&${settings.ignoredRoleId}>` : "None set"}`,
                color: settings.ignoreRoleEnabled ? EmbedColors.SUCCESS : EmbedColors.INFO,
                guild
              })],
              flags: 64
            });
          }

          if (action === "set") {
            if (!role)
              return interaction.reply({
                embeds: [makeEmbed({ title: "⚠️ Role Required", description: "Provide a role with the `role` option.", color: EmbedColors.WARNING, guild })],
                flags: 64
              });
            settings.ignoredRoleId    = role.id;
            settings.ignoreRoleEnabled = true;
            updateGuildSettings(settings);
            return interaction.reply({
              embeds: [makeEmbed({ title: "✅ Ignore Role Set", description: `Members with ${role} will be skipped in VC alerts.`, color: EmbedColors.SUCCESS, guild })],
              flags: 64
            });
          }

          if (action === "reset") {
            if (!settings.ignoredRoleId)
              return interaction.reply({
                embeds: [makeEmbed({ title: "ℹ️ Nothing to Reset", description: "No ignored role is currently configured.", color: EmbedColors.INFO, guild })],
                flags: 64
              });
            settings.ignoredRoleId    = null;
            settings.ignoreRoleEnabled = false;
            updateGuildSettings(settings);
            return interaction.reply({
              embeds: [makeEmbed({ title: "♻️ Ignore Role Reset", description: "All members will now appear in VC alerts.", color: EmbedColors.RESET, guild })],
              flags: 64
            });
          }

          if (action === "toggle") {
            if (!settings.ignoredRoleId)
              return interaction.reply({
                embeds: [makeEmbed({ title: "⚠️ No Role Configured", description: "Set a role first with `/ignorerole action:set`.", color: EmbedColors.WARNING, guild })],
                flags: 64
              });
            settings.ignoreRoleEnabled = !settings.ignoreRoleEnabled;
            updateGuildSettings(settings);
            return interaction.reply({
              embeds: [makeEmbed({
                title: `${settings.ignoreRoleEnabled ? "✅" : "🔴"} Ignore Role ${settings.ignoreRoleEnabled ? "Activated" : "Deactivated"}`,
                description: `Role: <@&${settings.ignoredRoleId}>`,
                color: settings.ignoreRoleEnabled ? EmbedColors.SUCCESS : EmbedColors.WARNING,
                guild
              })],
              flags: 64
            });
          }
          break;
        }

        // ─── /userinfo ────────────────────────────────────────
        case "userinfo": {
          await interaction.deferReply({ flags: 64 });
          const targetUser = interaction.options.getUser("user") || interaction.user;
          const member     = await guild.members.fetch(targetUser.id).catch(() => null);
          if (!member)
            return interaction.editReply({
              embeds: [makeEmbed({ title: "❌ User Not Found", description: "This user is not in the server.", color: EmbedColors.ERROR, guild })]
            });

          const createdStr    = new Date(targetUser.createdTimestamp).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric", timeZone:"Asia/Kolkata" });
          const daysSinceCreated = Math.floor((Date.now() - targetUser.createdTimestamp) / 86_400_000);
          const joinedStr     = member.joinedAt?.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric", timeZone:"Asia/Kolkata" }) ?? "N/A";
          const daysSinceJoin = Math.floor((Date.now() - (member.joinedTimestamp ?? 0)) / 86_400_000);

          const roles = member.roles.cache
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`)
            .slice(0, 20);

          const keyPerms = [];
          const P = PermissionFlagsBits;
          if (member.permissions.has(P.Administrator))  keyPerms.push("👑 Administrator");
          if (member.permissions.has(P.ManageGuild))    keyPerms.push("🛠️ Manage Server");
          if (member.permissions.has(P.ManageChannels)) keyPerms.push("📁 Manage Channels");
          if (member.permissions.has(P.ManageRoles))    keyPerms.push("🎭 Manage Roles");
          if (member.permissions.has(P.KickMembers))    keyPerms.push("🚪 Kick Members");
          if (member.permissions.has(P.BanMembers))     keyPerms.push("🔨 Ban Members");

          const status      = member.presence?.status || "offline";
          const statusEmoji = { online:"🟢", idle:"🟡", dnd:"🔴" }[status] || "⚫";
          const badges      = [
            ...(member.user.bot      ? ["🤖 Bot"]     : []),
            ...(member.premiumSince  ? ["💎 Booster"] : []),
            ...(targetUser.id === guild.ownerId ? ["👑 Owner"] : [])
          ];
          const voiceText = member.voice.channel ? `🎧 ${member.voice.channel.name}` : "Not in voice";

          const embed = new EmbedBuilder()
            .setColor(member.displayHexColor || EmbedColors.INFO)
            .setAuthor({
              name:    `${member.user.username}'s Profile`,
              iconURL: targetUser.displayAvatarURL({ dynamic: true, size: 256 })
            })
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(
              `**User:** ${targetUser}\n**Display Name:** ${member.displayName}\n` +
              `**Status:** ${statusEmoji} ${status}\n**Voice:** ${voiceText}`
            )
            .addFields(
              { name:"📅 Account Created", value:`${createdStr}\n(${daysSinceCreated} days ago)`, inline:true },
              { name:"📥 Joined Server",   value:`${joinedStr}\n(${daysSinceJoin} days ago)`,   inline:true },
              { name:"🏅 Badges",          value: badges.join(", ") || "None",                   inline:false },
              { name:`🎭 Roles (${member.roles.cache.size - 1})`, value: roles.join(", ") || "No roles", inline:false },
              { name:"🔑 Key Permissions", value: keyPerms.join(", ") || "None",                 inline:false }
            )
            .setFooter({ text: `ID: ${targetUser.id} • All times in IST` })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        }

        // ─── /owner ───────────────────────────────────────────
        case "owner": {
          if (!OWNER_ID || interaction.user.id !== OWNER_ID)
            return interaction.reply({
              embeds: [makeEmbed({ title: "🚫 Unauthorized", description: "This command is restricted to the bot owner.", color: EmbedColors.ERROR, guild })],
              flags: 64
            });

          // Quick summary in server context
          if (interaction.guild) {
            const up = Math.floor(process.uptime());
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING)
                .setAuthor({ name: sc("👑 ᴏᴡɴᴇʀ ᴅᴀsʜʙᴏᴀʀᴅ"), iconURL: client.user.displayAvatarURL() })
                .setDescription(
                  sc("💡 Use this command in DM for the full dashboard.\n\n") +
                  `> 🌐 **Servers:** ${client.guilds.cache.size}\n` +
                  `> 👥 **Members:** ${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0).toLocaleString()}\n` +
                  `> 📡 **WS Ping:** ${client.ws.ping}ms\n` +
                  `> ⏱️ **Uptime:** ${Math.floor(up/86400)}d ${Math.floor((up%86400)/3600)}h ${Math.floor((up%3600)/60)}m`
                )
                .setFooter({ text: sc("dm the bot for full analytics") }).setTimestamp()
              ],
              flags: 64
            });
          }

          // Full dashboard in DM
          await interaction.deferReply({ flags: 64 });
          const oneDayAgo = new Date(Date.now() - 86_400_000);
          const [
            recentLogsCount, totalLogs, totalSounds, activeGuilds, totalSettings,
            joinCount24h, leaveCount24h, onlineCount24h, guildActivity
          ] = await Promise.all([
            GuildLog.countDocuments({ time: { $gte: oneDayAgo } }).catch(() => 0),
            GuildLog.countDocuments().catch(() => 0),
            Sound.countDocuments().catch(() => 0),
            GuildSettings.countDocuments({ alertsEnabled: true }).catch(() => 0),
            GuildSettings.countDocuments().catch(() => 0),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo }, type:"join"   }).catch(() => 0),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo }, type:"leave"  }).catch(() => 0),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo }, type:"online" }).catch(() => 0),
            GuildLog.aggregate([
              { $match: { time: { $gte: oneDayAgo } } },
              { $group: { _id: "$guildId", count: { $sum: 1 }, name: { $first: "$guildName" } } },
              { $sort: { count: -1 } }, { $limit: 10 }
            ]).catch(() => [])
          ]);

          const totalGuilds  = client.guilds.cache.size;
          const totalMembers = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
          const mem    = process.memoryUsage();
          const upSecs = Math.floor(process.uptime());
          const topGuilds = [...client.guilds.cache.values()]
            .sort((a, b) => b.memberCount - a.memberCount)
            .slice(0, 10)
            .map((g, i) => `${i + 1}. **${g.name}** — ${g.memberCount.toLocaleString()} members`)
            .join("\n");

          return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(EmbedColors.INFO)
              .setAuthor({ name: sc("👑 ʙᴏᴛ ᴏᴡɴᴇʀ ᴅᴀsʜʙᴏᴀʀᴅ"), iconURL: client.user.displayAvatarURL() })
              .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
              .setDescription(
                `> 🤖 **Bot:** ${client.user.username}\n> 🟢 **Status:** Online\n` +
                `> ⏱️ **Uptime:** ${Math.floor(upSecs/86400)}d ${Math.floor((upSecs%86400)/3600)}h ${Math.floor((upSecs%3600)/60)}m\n` +
                `> 📡 **WS Ping:** ${client.ws.ping}ms`
              )
              .addFields(
                {
                  name: sc("📊 ɢʟᴏʙᴀʟ sᴛᴀᴛs"),
                  value: `🌐 **Servers:** ${totalGuilds}\n👥 **Members:** ${totalMembers.toLocaleString()}\n✅ **Active Guilds:** ${activeGuilds}/${totalSettings}\n🔊 **Sounds:** ${totalSounds}`,
                  inline: true
                },
                {
                  name: sc("⚡ ʟᴀsᴛ 24ʜ"),
                  value: `📈 **Events:** ${recentLogsCount.toLocaleString()}\n🟢 **Joins:** ${joinCount24h}\n🔴 **Leaves:** ${leaveCount24h}\n💠 **Online:** ${onlineCount24h}`,
                  inline: true
                },
                {
                  name: sc("💾 sʏsᴛᴇᴍ"),
                  value:
                    `🧠 **Heap:** ${(mem.heapUsed/1048576).toFixed(2)} MB / ${(mem.heapTotal/1048576).toFixed(2)} MB\n` +
                    `📦 **RSS:**  ${(mem.rss/1048576).toFixed(2)} MB\n` +
                    `⚙️ **Node:** ${process.version}\n` +
                    `🖥️ **Platform:** ${process.platform} ${process.arch}\n` +
                    `📜 **DB Logs:** ${totalLogs.toLocaleString()}`,
                  inline: false
                },
                { name: sc("🏆 ᴛᴏᴘ sᴇʀᴠᴇʀs"),          value: topGuilds || "—", inline:false },
                {
                  name: sc("🔥 ᴍᴏsᴛ ᴀᴄᴛɪᴠᴇ (24ʜ)"),
                  value: guildActivity
                    .map((g, i) => `${i+1}. **${g.name ?? g._id}** — ${g.count} events`)
                    .join("\n") || sc("no activity"),
                  inline: false
                }
              )
              .setFooter({ text: sc("owner dashboard • confidential") }).setTimestamp()
            ]
          });
        }

        // ─── /logs ────────────────────────────────────────────
        case "logs": {
          await interaction.deferReply({ flags: 64 });
          const rangeOpt = interaction.options.getString("range") || "today";
          const userOpt  = interaction.options.getUser("user");
          const now      = Date.now();

          let startTime, endTime = null;
          if (rangeOpt === "today") {
            const d = new Date(); d.setHours(0,0,0,0); startTime = d.getTime();
          } else if (rangeOpt === "yesterday") {
            const d = new Date(); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); startTime = d.getTime();
            const e = new Date(d); e.setHours(23,59,59,999); endTime = e.getTime();
          } else if (rangeOpt === "7days") {
            startTime = now - 7  * 86_400_000;
          } else {
            startTime = now - 30 * 86_400_000;
          }

          const query = { guildId: guild.id, time: { $gte: new Date(startTime) } };
          if (endTime) query.time.$lt = new Date(endTime);
          if (userOpt) query.user = { $regex: `^${userOpt.tag}`, $options: "i" };

          const logs = await GuildLog.find(query).sort({ time: -1 }).limit(100).lean();
          if (!logs.length)
            return interaction.editReply({
              embeds: [makeEmbed({ title: "No Activity", description: "No logs found for the selected range.", color: EmbedColors.INFO, guild })]
            });

          const desc = logs.slice(0, 20).map(l => {
            const emoji  = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
            const action = l.type === "join" ? "entered" : l.type === "leave" ? "left" : "came online";
            return `**${emoji} ${l.type.toUpperCase()}** — ${l.user} ${action} ${l.channel}\n> 🕒 ${fancyAgo(Date.now() - l.time)} • ${toISTString(l.time)}`;
          }).join("\n\n");

          const rangeLabel = { today:"Today", yesterday:"Yesterday", "7days":"Last 7 Days", "30days":"Last 30 Days" }[rangeOpt] ?? rangeOpt;
          const embed = new EmbedBuilder().setColor(0x2b2d31)
            .setTitle(`${guild.name} Activity — ${rangeLabel}${userOpt ? ` for ${userOpt.tag}` : ""}`)
            .setDescription(desc)
            .setFooter({ text: `Showing ${Math.min(20, logs.length)} of ${logs.length} entries` })
            .setTimestamp();

          const filePath = await generateActivityFile(guild, logs);
          return interaction.followUp({
            embeds: [embed],
            files:  [{ attachment: filePath, name: `${guild.name}_activity.txt` }],
            ephemeral: false
          });
        }

        // ─── /stats ───────────────────────────────────────────
        case "stats": {
          await interaction.deferReply({ flags: 64 });
          const period = interaction.options.getString("period") || "today";
          const now    = Date.now();

          const periodLabel = { today:"Today", "7days":"Last 7 Days", "30days":"Last 30 Days", all:"All Time" }[period] ?? "Today";
          let startTime = 0;
          if (period === "today")  { const d = new Date(); d.setHours(0,0,0,0); startTime = d.getTime(); }
          else if (period === "7days")  startTime = now - 7  * 86_400_000;
          else if (period === "30days") startTime = now - 30 * 86_400_000;

          const query = { guildId: guild.id };
          if (startTime > 0) query.time = { $gte: new Date(startTime) };
          const logs = await GuildLog.find(query).lean();
          if (!logs.length)
            return interaction.editReply({
              embeds: [makeEmbed({ title: "📊 No Statistics", description: "No activity logged for this period.", color: EmbedColors.INFO, guild })]
            });

          // Single-pass aggregation
          const userActivity    = new Map();
          const channelActivity = new Map();
          const hourlyActivity  = new Map();
          let joinCount = 0, leaveCount = 0, onlineCount = 0;

          for (const log of logs) {
            if (log.type === "join")        joinCount++;
            else if (log.type === "leave")  leaveCount++;
            else if (log.type === "online") onlineCount++;

            const ua = userActivity.get(log.user) ?? { joins:0, leaves:0, online:0, total:0 };
            if (log.type === "join")   ua.joins++;
            if (log.type === "leave")  ua.leaves++;
            if (log.type === "online") ua.online++;
            ua.total++;
            userActivity.set(log.user, ua);

            if (log.channel && log.channel !== "-")
              channelActivity.set(log.channel, (channelActivity.get(log.channel) ?? 0) + 1);

            const ist  = new Date(new Date(log.time).getTime() + 19_800_000);
            const hour = ist.getUTCHours();
            hourlyActivity.set(hour, (hourlyActivity.get(hour) ?? 0) + 1);
          }

          const topUsers    = [...userActivity.entries()]
            .sort((a, b) => b[1].total - a[1].total).slice(0, 5)
            .map(([u, s], i) => `${"🥇🥈🥉"[i] ?? `${i+1}.`} **${u}** — ${s.total} events (${s.joins}↑ ${s.leaves}↓)`);
          const topChannels = [...channelActivity.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([ch, n], i) => `${i+1}. **${ch}** — ${n} events`);
          const peakEntry   = [...hourlyActivity.entries()].sort((a, b) => b[1] - a[1])[0];
          let peakHourText  = "N/A";
          if (peakEntry) {
            const h = peakEntry[0], isPM = h >= 12;
            peakHourText = `**${h === 0 ? 12 : h > 12 ? h-12 : h}:00 ${isPM ? "PM" : "AM"} IST** (${peakEntry[1]} events)`;
          }

          const embed = new EmbedBuilder().setColor(EmbedColors.INFO)
            .setTitle("📊 Server Activity Statistics")
            .setDescription(`**${periodLabel}** — ${guild.name}`)
            .addFields(
              {
                name:  "📈 Overview",
                value: `Total: **${logs.length}**\n🟢 Joins: **${joinCount}**\n🔴 Leaves: **${leaveCount}**\n💠 Online: **${onlineCount}**`,
                inline: true
              },
              { name:"⏰ Peak Hour (IST)", value: peakHourText, inline:true },
              { name:"👥 Most Active Users", value: topUsers.join("\n") || "No data", inline:false }
            );
          if (topChannels.length) embed.addFields({ name:"🎧 Most Active VCs", value: topChannels.join("\n"), inline:false });
          embed.setFooter({ text: `Analysed ${logs.length} events` }).setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        }

        // ─── /ping ────────────────────────────────────────────
        case "ping": {
          const t0 = Date.now();
          await interaction.deferReply({ flags: 64 });
          const apiLatency  = Date.now() - t0;
          const ws          = client.ws.ping;
          const statusEmoji = ws < 200 && apiLatency < 500  ? "🟢"
                            : ws < 500 && apiLatency < 1000 ? "🟡"
                            : ws < 1000                     ? "🟠" : "🔴";
          const statusText  = statusEmoji === "🟢" ? "Excellent" : statusEmoji === "🟡" ? "Good" : statusEmoji === "🟠" ? "Fair" : "Poor";
          const up          = process.uptime();
          return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle("🏓 Pong!")
              .setDescription(
                `**Status:** ${statusEmoji} ${statusText}\n\n` +
                `> 🌐 API Latency: \`${apiLatency}ms\`\n` +
                `> 📡 WS Ping:     \`${ws}ms\`\n` +
                `> ⏱️ Uptime:      \`${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m\``
              )
              .setFooter({ text: "Bot Health Monitor" }).setTimestamp()
            ]
          });
        }

        // ─── /cleanup ─────────────────────────────────────────
        case "cleanup": {
          await interaction.deferReply({ flags: 64 });
          const cutoff  = new Date(Date.now() - 30 * 86_400_000);
          const deleted = await GuildLog
            .deleteMany({ guildId: guild.id, time: { $lt: cutoff } })
            .catch(() => ({ deletedCount: 0 }));

          const files   = await fsp.readdir(TEMP_DIR).catch(() => []);
          let cleaned   = 0;
          await Promise.all(files.map(async f => {
            const fp = path.join(TEMP_DIR, f);
            const st = await fsp.stat(fp).catch(() => null);
            if (st && Date.now() - st.mtimeMs > 3_600_000) {
              await fsp.unlink(fp).catch(() => {});
              cleaned++;
            }
          }));

          return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle("🧹 Cleanup Complete")
              .setDescription(`📜 Removed **${deleted.deletedCount}** old log entries\n📁 Cleaned **${cleaned}** temp file(s)`)
              .setFooter({ text: "Cleanup finished" }).setTimestamp()
            ]
          });
        }

        // ─── /inv ─────────────────────────────────────────────
        //  Full flow:
        //  1. Defer immediately (prevents timeout)
        //  2. Check whether invoker is in a VC
        //     • YES → filter candidates to those with access to that VC
        //     • NO  → show general top VC users; prompt user to join a VC first
        //  3. In SEARCH mode → filter by name, then by VC access
        //  4. In DEFAULT mode → pull top join-frequency users from DB
        //  5. Fallback (no DB data) → sort members by join date
        //  6. Build embed with status, VC info, and user list
        //  7. Attach per-user rows:  📨 Invite button + 🔊 Join link button
        //  8. 📨 Invite button (handled below) → DM invite + fallback channel
        // ──────────────────────────────────────────────────────
        case "inv": {
          await interaction.deferReply({ flags: 64 });

          const searchQuery = (interaction.options.getString("search") ?? "").trim().toLowerCase();
          const MAX_RESULTS = 10;

          // Populate member cache if not already done
          await guild.members.fetch().catch(() => {});

          const invokerMember = interaction.member;
          const invokerVC     = invokerMember?.voice?.channel ?? null;

          // ── Build candidate list ──────────────────────────────
          let candidates = [];

          if (searchQuery.length > 0) {
            // SEARCH MODE — filter by name, then by VC permission
            for (const [, m] of guild.members.cache) {
              if (m.user.bot) continue;
              if (m.id === interaction.user.id) continue; // skip self

              const nameMatch =
                m.user.username.toLowerCase().includes(searchQuery) ||
                (m.nickname ?? "").toLowerCase().includes(searchQuery) ||
                m.displayName.toLowerCase().includes(searchQuery);
              if (!nameMatch) continue;

              if (invokerVC) {
                // Only show members who can access the invoker's VC
                if (!canAccessVC(m, invokerVC)) continue;
                candidates.push(m);
              } else {
                // No VC context — include if they can access any VC
                const anyVC = guild.channels.cache.some(
                  c => c.type === ChannelType.GuildVoice && canAccessVC(m, c)
                );
                if (anyVC) candidates.push(m);
              }
              if (candidates.length >= MAX_RESULTS) break;
            }
          } else {
            // DEFAULT MODE — top VC users by join frequency from DB
            const freqResults = await GuildLog.aggregate([
              { $match: { guildId: guild.id, type: "join" } },
              { $group: { _id: "$user", joinCount: { $sum: 1 } } },
              { $sort: { joinCount: -1 } },
              { $limit: MAX_RESULTS * 4 }   // over-fetch to handle permission filtering
            ]).catch(() => []);

            const seen = new Set();
            for (const entry of freqResults) {
              if (candidates.length >= MAX_RESULTS) break;
              const member = guild.members.cache.find(
                m => m.user.tag === entry._id || m.user.username === entry._id
              );
              if (!member || member.user.bot || seen.has(member.id)) continue;
              if (member.id === interaction.user.id) continue; // skip self
              seen.add(member.id);
              if (invokerVC && !canAccessVC(member, invokerVC)) continue;
              candidates.push(member);
            }

            // Fallback: sort by join date when no DB logs exist
            if (candidates.length === 0) {
              candidates = [...guild.members.cache.values()]
                .filter(m =>
                  !m.user.bot &&
                  m.id !== interaction.user.id &&
                  (!invokerVC || canAccessVC(m, invokerVC))
                )
                .sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0))
                .slice(0, MAX_RESULTS);
            }
          }

          candidates = candidates.slice(0, MAX_RESULTS);

          // ── No results ────────────────────────────────────────
          if (candidates.length === 0) {
            const desc = invokerVC
              ? `No members found with access to **${invokerVC.name}**${searchQuery ? ` matching \`${searchQuery}\`` : ""}.`
              : `No members found${searchQuery ? ` matching \`${searchQuery}\`` : ""}.`;
            return interaction.editReply({
              embeds: [makeEmbed({
                title:       "📭 No Results Found",
                description: desc,
                color:       EmbedColors.WARNING,
                guild
              })]
            });
          }

          // ── Build embed ───────────────────────────────────────
          const medals = ["🥇","🥈","🥉"];
          const listText = candidates.map((m, i) => {
            const medal      = medals[i] ?? `\`${i+1}.\``;
            const status     = m.presence?.status ?? "offline";
            const statusMoji = { online:"🟢", idle:"🟡", dnd:"🔴" }[status] ?? "⚫";
            const inVC       = m.voice?.channel;
            const vcLine     = inVC
              ? `🎧 Already in \`${inVC.name}\``
              : sc("not in vc");
            return `${medal} ${m} ${statusMoji}\n> ${vcLine}`;
          }).join("\n\n");

          // Context block at top of embed
          let contextBlock = "";
          if (invokerVC) {
            const memberWord = invokerVC.members.size === 1 ? "member" : "members";
            contextBlock =
              `📍 **Your VC:** ${invokerVC} — ${invokerVC.members.size} ${memberWord}\n` +
              `🔒 Showing only users with access to this channel\n\n`;
          } else {
            contextBlock =
              `💡 **Tip:** Join a voice channel first to see who can access it, then invite them!\n\n`;
          }

          const modeLabel = searchQuery
            ? `🔍 Results for \`${searchQuery}\``
            : `🎙️ Top ${candidates.length} VC ${candidates.length === 1 ? "user" : "users"}`;

          const invEmbed = new EmbedBuilder()
            .setColor(EmbedColors.INVITE)
            .setAuthor({
              name:    sc("📨 ɪɴᴠɪᴛᴇ ᴛᴏ ᴠᴏɪᴄᴇ ᴄʜᴀɴɴᴇʟ"),
              iconURL: client.user.displayAvatarURL()
            })
            .setDescription(`${contextBlock}${modeLabel}\n\n${listText}`)
            .setFooter({
              text: sc(`/inv search:<name> to find a specific user • ${guild.name}`)
            })
            .setTimestamp();

          // ── Per-user action rows ───────────────────────────────
          //  If invoker is in a VC → show Invite + Join buttons per user (max 5)
          //  If not in a VC       → show embed only with helpful tip
          const buttonRows = invokerVC ? buildInviteRows(candidates, invokerVC) : [];

          return interaction.editReply({ embeds: [invEmbed], components: buttonRows });
        }

        // ─── /sound ───────────────────────────────────────────
        case "sound": {
          const sub = interaction.options.getSubcommand();
          const q   = getSbQueue(guildId);

          // ── add ──
          if (sub === "add") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
              return interaction.reply({
                embeds: [makeEmbed({ title: "❌ Permission Denied", description: "Only admins can add sounds.", color: EmbedColors.ERROR, guild })],
                flags: 64
              });
            const name = interaction.options.getString("name");
            const file = interaction.options.getAttachment("file");
            if (!file)
              return interaction.reply({
                embeds: [makeEmbed({ title: "⚠️ No File", description: "Please attach an audio file.", color: EmbedColors.WARNING, guild })],
                flags: 64
              });
            if (await Sound.exists({ guildId, name }))
              return interaction.reply({
                embeds: [makeEmbed({ title: "⚠️ Already Exists", description: `**${name}** is already in the soundboard.`, color: EmbedColors.WARNING, guild })],
                flags: 64
              });

            await interaction.deferReply({ flags: 64 });
            let storage = null;
            try { storage = await sbEnsureStorage(guild); } catch (e) { console.error("[Soundboard storage]", e); }

            let uploadedUrl = file.url, storageMessageId = null;
            if (storage) {
              const m = await storage.send({ files: [file.url] }).catch(() => null);
              if (m) {
                uploadedUrl      = m.attachments.first()?.url ?? uploadedUrl;
                storageMessageId = m.id;
              }
            }
            await Sound.create({ guildId, name, fileURL: uploadedUrl, storageMessageId, addedBy: interaction.user.id });
            return interaction.editReply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS)
                .setTitle(sc("✅ sᴏᴜɴᴅ ᴀᴅᴅᴇᴅ"))
                .setDescription(sc(`**${name}** added to the soundboard!`))
                .setTimestamp()
              ]
            });
          }

          // ── play ──
          if (sub === "play") {
            const name  = interaction.options.getString("name");
            const sound = await Sound.findOne({ guildId, name }).lean();
            if (!sound)
              return interaction.reply({
                embeds: [new EmbedBuilder().setColor(EmbedColors.ERROR)
                  .setTitle(sc("❌ ɴᴏᴛ ꜰᴏᴜɴᴅ"))
                  .setDescription(sc("Sound not found. Use `/sound list` to see all sounds."))
                  .setTimestamp()],
                flags: 64
              });

            const res = await sbConnectToMember(interaction.member);
            if (res?.error)
              return interaction.reply({
                embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING)
                  .setTitle(sc("🎧 ᴊᴏɪɴ ᴀ ᴠᴄ ꜰɪʀsᴛ"))
                  .setDescription(sc("You need to be in a voice channel to play sounds."))
                  .setTimestamp()],
                flags: 64
              });

            const isIdle = !q.now;
            q.list.push({ _id: sound._id, name: sound.name, fileURL: sound.fileURL, storageMessageId: sound.storageMessageId });
            if (isIdle) {
              await sbPlayNext(guild, interaction.channel);
              return interaction.reply({
                embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS)
                  .setTitle(sc("▶️ ɴᴏᴡ ᴘʟᴀʏɪɴɢ"))
                  .setDescription(sc(`**${sound.name}**`))
                  .setTimestamp()
                ]
              });
            }
            sbUpdatePanel(guild);
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.INFO)
                .setTitle(sc("🎶 ᴀᴅᴅᴇᴅ ᴛᴏ ǫᴜᴇᴜᴇ"))
                .setDescription(sc(`**${sound.name}** — position #${q.list.length}`))
                .setTimestamp()
              ]
            });
          }

          // ── volume ──
          if (sub === "volume") {
            const level = interaction.options.getInteger("level");
            q.volume    = level / 100;
            if (q.resource?.volume) q.resource.volume.setVolume(q.volume);
            sbUpdatePanel(guild);
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS)
                .setTitle(sc("🔊 ᴠᴏʟᴜᴍᴇ ᴜᴘᴅᴀᴛᴇᴅ"))
                .setDescription(sc(`Volume set to **${level}%**`))
                .setTimestamp()
              ],
              flags: 64
            });
          }

          // ── top ──
          if (sub === "top") {
            const docs = await Sound.find({ guildId }).select("name playCount").sort({ playCount: -1 }).limit(10).lean();
            if (!docs.length)
              return interaction.reply({
                embeds: [new EmbedBuilder().setColor(EmbedColors.INFO)
                  .setTitle(sc("📜 ɴᴏ ᴅᴀᴛᴀ"))
                  .setDescription(sc("No sounds have been played yet."))
                  .setTimestamp()
                ],
                flags: 64
              });
            const text = docs.map((s, i) => `${"🥇🥈🥉"[i] ?? `\`#${i+1}\``} **${s.name}** — ${s.playCount} plays`).join("\n");
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS)
                .setTitle(sc("🏆 ᴍᴏsᴛ ᴘᴏᴘᴜʟᴀʀ sᴏᴜɴᴅs"))
                .setDescription(sc(text))
                .setTimestamp()
              ],
              flags: 64
            });
          }

          // ── delete ──
          if (sub === "delete") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
              return interaction.reply({
                embeds: [makeEmbed({ title: "❌ Permission Denied", description: "Only admins can delete sounds.", color: EmbedColors.ERROR, guild })],
                flags: 64
              });
            const name = interaction.options.getString("name");
            const doc  = await Sound.findOne({ guildId, name });
            if (!doc)
              return interaction.reply({
                embeds: [new EmbedBuilder().setColor(EmbedColors.ERROR)
                  .setTitle(sc("❌ ɴᴏᴛ ꜰᴏᴜɴᴅ"))
                  .setDescription(sc("Sound not found."))
                  .setTimestamp()
                ],
                flags: 64
              });

            if (doc.storageMessageId) {
              const storageCh = guild.channels.cache.find(c => c.name === "soundboard-storage");
              if (storageCh) {
                const msg = await storageCh.messages.fetch(doc.storageMessageId).catch(() => null);
                if (msg) await msg.delete().catch(() => {});
              }
            }
            await doc.deleteOne();
            sbUpdatePanel(guild);
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS)
                .setTitle(sc("🗑️ sᴏᴜɴᴅ ʀᴇᴍᴏᴠᴇᴅ"))
                .setDescription(sc(`**${name}** has been deleted.`))
                .setTimestamp()
              ]
            });
          }

          // ── list ──
          if (sub === "list") {
            const docs = await Sound.find({ guildId }).select("name playCount").sort({ name: 1 }).lean();
            if (!docs.length)
              return interaction.reply({
                embeds: [new EmbedBuilder().setColor(EmbedColors.INFO)
                  .setTitle(sc("📜 ᴇᴍᴘᴛʏ sᴏᴜɴᴅʙᴏᴀʀᴅ"))
                  .setDescription(sc("No sounds added yet. Use `/sound add` to get started."))
                  .setTimestamp()
                ],
                flags: 64
              });
            const text = docs.slice(0, 40).map((s, i) => `\`${i+1}.\` **${s.name}** (${s.playCount} plays)`).join("\n");
            const more = docs.length > 40 ? `\n…and ${docs.length - 40} more` : "";
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.INFO)
                .setTitle(sc("📜 sᴏᴜɴᴅ ʟɪsᴛ"))
                .setDescription(sc(text + more))
                .setFooter({ text: sc(`${docs.length} sound${docs.length === 1 ? "" : "s"} total`) })
                .setTimestamp()
              ],
              flags: 64
            });
          }

          // ── panel ──
          if (sub === "panel") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
              return interaction.reply({
                embeds: [makeEmbed({ title: "❌ Permission Denied", description: "Only admins can open the panel.", color: EmbedColors.ERROR, guild })],
                flags: 64
              });
            const ui  = await buildSoundPanelEmbed(guild);
            const msg = await interaction.reply({ embeds: [ui.embed], components: ui.buttons, withResponse: true });
            sbPanels.set(guildId, { messageId: msg.id, channelId: msg.channelId });
            return;
          }

          return interaction.reply({
            embeds: [new EmbedBuilder().setColor(EmbedColors.INFO)
              .setTitle(sc("🔊 sᴏᴜɴᴅ — ᴜsᴀɢᴇ"))
              .setDescription(sc("/sound add | play | delete | list | panel | volume | top"))
              .setTimestamp()
            ],
            flags: 64
          });
        }
      }
    }

    // ──────────────────────────────────────────────────────────
    //  BUTTON INTERACTIONS
    // ──────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { guild, guildId, member, customId } = interaction;
      if (!guild) return;

      // ── /inv — Invite Notification Button ──────────────────
      //  customId format: inv_notify_{targetMemberId}_{vcId}
      //  Action: DM the target user an invite embed with a Join button
      //          Falls back to mentioning them in the nearest text channel
      if (customId.startsWith("inv_notify_")) {
        const parts          = customId.split("_");
        // parts: ["inv","notify", targetMemberId, vcId]
        const targetMemberId = parts[2];
        const vcId           = parts[3];

        const [targetMember, vc] = await Promise.all([
          guild.members.fetch(targetMemberId).catch(() => null),
          Promise.resolve(guild.channels.cache.get(vcId))
        ]);

        if (!targetMember)
          return interaction.reply({ content: "❌ That user is no longer in this server.", flags: 64 });
        if (!vc)
          return interaction.reply({ content: "❌ That voice channel no longer exists.", flags: 64 });

        // Check invoker is still in the VC
        const invokerVC = member.voice?.channel;
        if (!invokerVC || invokerVC.id !== vcId)
          return interaction.reply({
            content: `⚠️ You're no longer in **${vc.name}**. Rejoin the VC to send invites.`,
            flags:   64
          });

        // Build DM embed with a direct link to join the VC
        const vcDeepLink = `https://discord.com/channels/${guild.id}/${vc.id}`;
        const dmEmbed    = new EmbedBuilder()
          .setColor(EmbedColors.INVITE)
          .setAuthor({
            name:    `${member.user.username} is inviting you to a voice channel!`,
            iconURL: member.user.displayAvatarURL({ dynamic: true })
          })
          .setTitle("📨 You've Been Invited to a Voice Channel")
          .setDescription(
            `**${member.displayName}** wants you to join:\n\n` +
            `> 🎧 **${vc.name}** in **${guild.name}**\n` +
            `> 👥 ${vc.members.size} ${vc.members.size === 1 ? "person" : "people"} already in there\n\n` +
            `Click the button below to jump right in!`
          )
          .setThumbnail(guild.iconURL({ dynamic: true }))
          .setFooter({ text: `Invite from ${guild.name}` })
          .setTimestamp();

        const joinRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(`🔊 Join ${vc.name.slice(0, 25)}`)
            .setStyle(ButtonStyle.Link)
            .setURL(vcDeepLink)
        );

        const dmSent = await targetMember.send({ embeds: [dmEmbed], components: [joinRow] })
          .then(() => true)
          .catch(() => false);

        if (dmSent) {
          return interaction.reply({
            content: `✅ Invite sent to **${targetMember.displayName}** via DM! They'll see a Join button.`,
            flags:   64
          });
        }

        // DMs are closed → fallback: post mention in a nearby text channel
        const fallbackCh =
          invokerVC.parent?.children?.cache?.find(c => c.isTextBased())
          ?? interaction.channel;

        if (fallbackCh?.isTextBased()) {
          await fallbackCh.send({
            content: `${targetMember} — **${member.displayName}** is inviting you to join **${vc.name}**! 🎧`,
            embeds:  [dmEmbed],
            components: [joinRow]
          }).catch(() => {});
          return interaction.reply({
            content: `📣 **${targetMember.displayName}**'s DMs are closed — mentioned them in <#${fallbackCh.id}> instead.`,
            flags:   64
          });
        }

        return interaction.reply({
          content: `⚠️ Couldn't reach **${targetMember.displayName}** — their DMs are closed and no fallback channel was found.`,
          flags:   64
        });
      }

      // ── Soundboard buttons ──────────────────────────────────
      if (customId.startsWith("sb_")) {
        if (!await checkAdmin(interaction)) return;
        const q = getSbQueue(guildId);

        if (customId === "sb_refresh") {
          await sbUpdatePanel(guild);
          return interaction.deferUpdate();
        }

        if (customId === "sb_connect") {
          const res = await sbConnectToMember(member);
          if (res?.error)
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING)
                .setTitle(sc("🎧 ᴊᴏɪɴ ᴀ ᴠᴄ ꜰɪʀsᴛ"))
                .setDescription(sc("You need to be in a voice channel."))
                .setTimestamp()
              ],
              flags: 64
            });
          q.vcId = res.channel.id;
          if (q.timeout) { clearTimeout(q.timeout); q.timeout = null; }
          await sbUpdatePanel(guild);
          return interaction.deferUpdate();
        }

        if (customId === "sb_skip") {
          try { q.player.stop(); } catch (_) {}
          await sbUpdatePanel(guild);
          return interaction.deferUpdate();
        }

        if (customId === "sb_stop") {
          q.list = []; q.now = null;
          if (q.currentFile) { fsp.unlink(q.currentFile).catch(() => {}); q.currentFile = null; }
          try { q.player.stop(true); } catch (_) {}
          const conn = getVoiceConnection(guildId);
          if (conn) conn.destroy();
          q.vcId = null;
          await sbUpdatePanel(guild);
          return interaction.deferUpdate();
        }

        return interaction.deferUpdate();
      }

      // ── Settings panel buttons ──────────────────────────────
      if (!await checkAdmin(interaction)) return;
      const currentSettings = await getGuildSettings(guildId);
      if (!currentSettings) return interaction.reply({ content: "❌ Settings not found.", flags: 64 });

      let didChange = false;
      switch (customId) {
        case "toggleJoinAlerts":     currentSettings.joinAlerts            = !currentSettings.joinAlerts;            didChange = true; break;
        case "toggleLeaveAlerts":    currentSettings.leaveAlerts           = !currentSettings.leaveAlerts;           didChange = true; break;
        case "toggleOnlineAlerts":   currentSettings.onlineAlerts          = !currentSettings.onlineAlerts;          didChange = true; break;
        case "togglePrivateThreads": currentSettings.privateThreadAlerts   = !currentSettings.privateThreadAlerts;   didChange = true; break;
        case "toggleAutoDelete":     currentSettings.autoDelete            = !currentSettings.autoDelete;            didChange = true; break;
        case "toggleIgnoreRole":     currentSettings.ignoreRoleEnabled     = !currentSettings.ignoreRoleEnabled;     didChange = true; break;

        case "resetSettings": {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirmReset").setLabel("✅ Yes, Reset Everything").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("cancelReset").setLabel("❌ No, Cancel").setStyle(ButtonStyle.Secondary)
          );
          return interaction.update({
            embeds: [makeEmbed({
              title:       "⚠️ Confirm Reset",
              description: "Are you sure you want to reset **all** VC alert settings? This cannot be undone.",
              color:       EmbedColors.WARNING,
              guild
            })],
            components: [row]
          });
        }

        case "confirmReset": {
          await GuildSettings.deleteOne({ guildId });
          guildSettingsCache.delete(guildId);
          const freshSettings = await getGuildSettings(guildId);
          const panel = buildControlPanel(freshSettings, guild);
          await interaction.update({ embeds: [panel.embed], components: panel.buttons });
          return interaction.followUp({ content: "🎉 All settings have been reset to defaults.", flags: 64 });
        }

        case "cancelReset": {
          const panel = buildControlPanel(currentSettings, guild);
          return interaction.update({ embeds: [panel.embed], components: panel.buttons });
        }

        default: return;
      }

      if (didChange) {
        // Atomic $set — only the boolean toggle fields
        GuildSettings.updateOne({ guildId }, {
          $set: {
            joinAlerts:          currentSettings.joinAlerts,
            leaveAlerts:         currentSettings.leaveAlerts,
            onlineAlerts:        currentSettings.onlineAlerts,
            privateThreadAlerts: currentSettings.privateThreadAlerts,
            autoDelete:          currentSettings.autoDelete,
            ignoreRoleEnabled:   currentSettings.ignoreRoleEnabled
          }
        }).catch(e => console.error(`[Button DB] ${guildId}:`, e));

        // Update cache
        guildSettingsCache.delete(guildId);
        guildSettingsCache.set(guildId, currentSettings);
      }

      const updated = buildControlPanel(currentSettings, guild);
      return interaction.update({ embeds: [updated.embed], components: updated.buttons });
    }

    // ──────────────────────────────────────────────────────────
    //  AUTOCOMPLETE
    // ──────────────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const focused  = (interaction.options.getFocused() ?? "").toString().toLowerCase();
      const guildId_ = interaction.guildId;
      const guild_   = interaction.guild;

      // /inv autocomplete — filter from cached members (fast, no DB)
      if (interaction.commandName === "inv") {
        const invokerVC = interaction.member?.voice?.channel ?? null;
        const results   = [];

        for (const [, m] of (guild_?.members?.cache ?? new Map())) {
          if (results.length >= 25) break;
          if (m.user.bot || m.id === interaction.user.id) continue;
          const nameMatch =
            m.user.username.toLowerCase().includes(focused) ||
            (m.nickname ?? "").toLowerCase().includes(focused) ||
            m.displayName.toLowerCase().includes(focused);
          if (!nameMatch) continue;
          // Show a ✅ indicator if they can access the invoker's VC
          const accessible = invokerVC ? canAccessVC(m, invokerVC) : true;
          const label      = `${m.displayName} (@${m.user.username})${accessible ? "" : " — no access"}`;
          results.push({ name: label.slice(0, 100), value: m.user.username });
        }

        return interaction.respond(
          results.length
            ? results
            : [{ name: "No matching members found", value: focused || "" }]
        );
      }

      // /sound autocomplete
      if (interaction.commandName === "sound") {
        const sub    = interaction.options.getSubcommand();
        const sounds = await Sound.find({ guildId: guildId_ })
          .select("name").limit(100).lean().catch(() => []);
        const names  = sounds.map(s => s.name);

        if (sub === "add") {
          const existing = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
          return interaction.respond(
            existing.length
              ? existing.map(n => ({ name: sc(`⚠️ ${n} (already exists)`), value: n }))
              : [{ name: "✅ New sound name", value: focused || "" }]
          );
        }

        const matches = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        return interaction.respond(
          matches.length
            ? matches.map(n => ({ name: sc(`🎵 ${n}`), value: n }))
            : [{ name: "No matching sounds", value: "" }]
        );
      }
    }

  } catch (err) {
    console.error("[InteractionCreate]", err?.stack ?? err?.message ?? err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred)
        await interaction.reply({ content: "❌ An error occurred. Please try again later.", flags: 64 });
    } catch (_) {}
  }
});

// ─── Voice Channel Alert System ───────────────────────────────
const activeVCThreads    = new Map();  // vcId → thread
const threadDeletion     = new Map();  // vcId → timeoutId
const threadLastActivity = new Map();  // vcId → timestamp
const vcLocks            = new Map();  // vcId → Promise (mutex)

const THREAD_INACTIVITY = 5 * 60_000;  // 5 min
const THREAD_CHECK_MS   = 30_000;      // 30 s poll

// Periodic thread inactivity checker (avoids individual timeouts where possible)
const threadCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [vcId, last] of threadLastActivity.entries()) {
    if (now - last >= THREAD_INACTIVITY) {
      activeVCThreads.get(vcId)?.delete().catch(() => {});
      activeVCThreads.delete(vcId);
      threadLastActivity.delete(vcId);
      const t = threadDeletion.get(vcId);
      if (t) clearTimeout(t);
      threadDeletion.delete(vcId);
    }
  }
}, THREAD_CHECK_MS);
threadCleanupInterval.unref();

// Per-VC mutex — serialises thread create/send operations
function withVCLock(vcId, fn) {
  const prev = vcLocks.get(vcId) ?? Promise.resolve();
  const next  = prev
    .then(() => fn())
    .finally(() => { if (vcLocks.get(vcId) === next) vcLocks.delete(vcId); });
  vcLocks.set(vcId, next);
  return next;
}

async function fetchTextChannel(guild, channelId) {
  const cached = guild.channels.cache.get(channelId);
  if (cached?.isTextBased()) return cached;
  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.isTextBased() ? fetched : null;
}

// Clean up maps when a channel/thread is deleted
client.on("channelDelete", channel => {
  const t = threadDeletion.get(channel.id);
  if (t) { clearTimeout(t); threadDeletion.delete(channel.id); }
  activeVCThreads.delete(channel.id);
  threadLastActivity.delete(channel.id);
});

// ─── Voice State Update ───────────────────────────────────────
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

    const joined = !oldState.channelId &&  newState.channelId && settings.joinAlerts;
    const left   =  oldState.channelId && !newState.channelId && settings.leaveAlerts;
    if (!joined && !left) return;

    const vc = newState.channel ?? oldState.channel;
    if (!vc) return;

    const logChannel = await fetchTextChannel(guild, settings.textChannelId);
    if (!logChannel) return;

    const avatar    = user.displayAvatarURL({ dynamic: true });
    const botAvatar = client.user.displayAvatarURL();

    let embed;
    if (joined) {
      addLog("join", user.tag, vc.name, guild);
      embed = new EmbedBuilder().setColor(EmbedColors.VC_JOIN)
        .setAuthor({ name: `${user.username} just joined the VC! 🔊`, iconURL: avatar })
        .setDescription(`🎧 **${user.username}** joined **${vc.name}** — let the vibes begin!`)
        .setFooter({ text: "🎉 Welcome to the voice party!", iconURL: botAvatar })
        .setTimestamp();
    } else {
      addLog("leave", user.tag, vc.name, guild);
      embed = new EmbedBuilder().setColor(EmbedColors.VC_LEAVE)
        .setAuthor({ name: `${user.username} left the VC 🏃`, iconURL: avatar })
        .setDescription(`👋 **${user.username}** left **${vc.name}** — see ya next time!`)
        .setFooter({ text: "💨 Gone but not forgotten.", iconURL: botAvatar })
        .setTimestamp();
    }

    await withVCLock(vc.id, async () => {
      const everyonePerms = vc.permissionsFor(guild.roles.everyone);
      const isPrivateVC   = everyonePerms && !everyonePerms.has(PermissionsBitField.Flags.ViewChannel);

      if (isPrivateVC && settings.privateThreadAlerts) {
        // Private VC → send in a private thread visible only to VC members
        let thread = activeVCThreads.get(vc.id);
        if (!thread || thread.archived || !logChannel.threads.cache.has(thread.id)) {
          const shortName = vc.name.length > 80 ? vc.name.slice(0, 80) + "…" : vc.name;
          try {
            thread = await logChannel.threads.create({
              name:                `🔊│${shortName} • VC Alerts`,
              type:                ChannelType.PrivateThread,
              autoArchiveDuration: 1440,
              reason:              `Private VC alert thread for ${vc.name}`
            });
            activeVCThreads.set(vc.id, thread);
          } catch (err) {
            console.warn("[VC Thread] create failed:", err.message);
            return;
          }
        }

        // Update activity timestamp + per-thread safety-net timer
        threadLastActivity.set(vc.id, Date.now());
        if (threadDeletion.has(vc.id)) clearTimeout(threadDeletion.get(vc.id));
        const t = setTimeout(async () => {
          activeVCThreads.get(vc.id)?.delete().catch(() => {});
          activeVCThreads.delete(vc.id);
          threadDeletion.delete(vc.id);
          threadLastActivity.delete(vc.id);
        }, THREAD_INACTIVITY);
        t.unref();
        threadDeletion.set(vc.id, t);

        // Add VC-accessible members in batches (rate-limit safe)
        const memberIds = [...guild.members.cache
          .filter(m => !m.user.bot && vc.permissionsFor(m)?.has(PermissionsBitField.Flags.ViewChannel))
          .keys()
        ];
        for (let i = 0; i < memberIds.length; i += 20) {
          await Promise.all(memberIds.slice(i, i + 20).map(id => thread.members.add(id).catch(() => {})));
          if (i + 20 < memberIds.length) await new Promise(r => setTimeout(r, 100));
        }

        const msg = await thread.send({ embeds: [embed] }).catch(() => null);
        if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref();
      } else {
        // Public VC → send in the configured alerts channel
        const msg = await logChannel.send({ embeds: [embed] }).catch(e => {
          console.warn("[VC Alert] send failed:", e?.message);
          return null;
        });
        if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref();
      }
    });
  } catch (err) {
    console.error("[voiceStateUpdate]", err);
  }
});

// ─── Presence Update (Online Alerts) ─────────────────────────
client.on("presenceUpdate", async (oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (!member || member.user.bot) return;
    if (newPresence.status !== "online" || oldPresence?.status === "online") return;

    const settings = await getGuildSettings(member.guild.id);
    if (!settings?.alertsEnabled || !settings.onlineAlerts || !settings.textChannelId) return;
    if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member.roles.cache.has(settings.ignoredRoleId)) return;

    const channel = await fetchTextChannel(member.guild, settings.textChannelId);
    if (!channel) return;

    addLog("online", member.user.tag, "-", member.guild);
    const embed = new EmbedBuilder().setColor(EmbedColors.ONLINE)
      .setAuthor({ name: `${member.user.username} just came online! 🟢`, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
      .setDescription(`👀 **${member.user.username}** is now online — something's cooking!`)
      .setFooter({ text: "✨ Ready to vibe!", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] }).catch(e => {
      console.warn(`[Online Alert] failed for ${member.user.username}:`, e?.message);
      return null;
    });
    if (msg && settings.autoDelete)
      setTimeout(() => msg.delete().catch(() => {}), 30_000).unref();
  } catch (e) {
    console.error("[presenceUpdate]", e?.stack ?? e?.message ?? e);
  }
});

// ─── Gateway Event Handlers ───────────────────────────────────
client.on("warn",              info  => console.warn("[Discord Warn]", info));
client.on("error",             error => console.error("[Discord Error]", error));
client.on("shardError",        error => console.error("[Shard Error]", error));
client.on("shardReconnecting", id    => { console.log(`🔄 Shard ${id} reconnecting…`); lastHeartbeat = Date.now(); });
client.on("shardResume",       (id, replayed) => {
  console.log(`✅ Shard ${id} resumed (${replayed} events replayed)`);
  lastHeartbeat     = Date.now();
  reconnectAttempts = 0;
});
client.on("shardDisconnect",   (ev, id) => console.warn(`⚠️ Shard ${id} disconnected (${ev.code})`));
client.ws.on("HEARTBEAT",      () => { lastHeartbeat = Date.now(); });

// ─── MongoDB Connection (with retry) ─────────────────────────
let mongoRetries = 0;
async function connectMongoDB() {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
    await mongoose.connect(process.env.MONGO_URI, {
      dbName:                    "Discord-Alert-Bot",
      serverSelectionTimeoutMS:  10_000,
      socketTimeoutMS:           45_000,
      maxPoolSize:               10,
      minPoolSize:               2,
      retryWrites:               true,
      retryReads:                true
    });
    console.log("✅ MongoDB connected");
    mongoRetries = 0;
  } catch (e) {
    console.error("❌ MongoDB error:", e?.message ?? e);
    if (mongoRetries < 5) {
      mongoRetries++;
      console.log(`🔄 MongoDB retry ${mongoRetries}/5 in 5 s…`);
      await new Promise(r => setTimeout(r, 5_000));
      return connectMongoDB();
    }
    console.error("❌ MongoDB failed after 5 retries. Exiting.");
    process.exit(1);
  }
}
mongoose.connection.on("error",       err => console.error("[MongoDB]", err));
mongoose.connection.on("disconnected", () => { console.warn("⚠️ MongoDB disconnected — reconnecting…"); connectMongoDB(); });
mongoose.connection.on("reconnected",  () => console.log("✅ MongoDB reconnected"));

// ─── Graceful Shutdown ────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[Shutdown] Received ${signal}`);

  // Flush pending DB writes
  if (pendingSaveTimer) { clearTimeout(pendingSaveTimer); pendingSaveTimer = null; }
  if (pendingSaveQueue.size > 0) {
    const entries = [...pendingSaveQueue.entries()];
    pendingSaveQueue.clear();
    await Promise.all(entries.map(([gid, s]) =>
      GuildSettings.findOneAndUpdate({ guildId: gid }, s, { upsert: true, setDefaultsOnInsert: true })
        .exec()
        .catch(e => console.error(`[Shutdown DB] ${gid}:`, e?.message ?? e))
    ));
  }

  // Purge temp files
  const files = await fsp.readdir(TEMP_DIR).catch(() => []);
  await Promise.all(files.map(f => fsp.unlink(path.join(TEMP_DIR, f)).catch(() => {})));

  // Clear timers
  for (const t of threadDeletion.values()) clearTimeout(t);
  threadDeletion.clear();
  activeVCThreads.clear();
  threadLastActivity.clear();

  await mongoose.disconnect().catch(() => {});
  try { await client.destroy(); } catch (_) {}
  console.log("[Shutdown] Complete.");
  process.exit(0);
}

process.on("SIGINT",             () => shutdown("SIGINT"));
process.on("SIGTERM",            () => shutdown("SIGTERM"));
process.on("uncaughtException",  err => { console.error("[uncaughtException]", err); shutdown("uncaughtException"); });
process.on("unhandledRejection", reason => console.error("[unhandledRejection]", reason));

// ─── Start ────────────────────────────────────────────────────
(async () => {
  await connectMongoDB();
  if (!process.env.TOKEN) {
    console.error("❌ TOKEN is not set. Exiting.");
    process.exit(1);
  }
  console.log("🔐 Logging in to Discord…");
  await client.login(process.env.TOKEN).catch(err => {
    console.error("❌ Discord login failed:", err);
    process.exit(1);
  });
})();
