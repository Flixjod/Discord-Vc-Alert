// ============================================================
//  Discord VC Alert & Soundboard Bot  —  Production Build
//  Architecture:
//    • Aggressive cache limiting (makeCache) for 40-50MB containers
//    • No guild.members.fetch() — never loads full member list
//    • activeVCThreads stores only threadId strings, not objects
//    • sbQueues stores channel IDs, not channel objects
//    • /inv: VC-aware candidate filtering without full-member loads
//    • /inv: smart ranking (hidden for single target)
//    • /inv: DM invite with actionable Join button + channel fallback
//    • /inv: clean single-user and multi-user layouts
//    • Batched debounced DB writes with $set projection
//    • Async flows cleaned up, no fire-and-forget race conditions
//    • Duplicate listener prevention on audio player & voice conn
//    • Temp-file cleanup on every track finish
//    • setInterval heartbeat monitor improved
//    • Auto-delete timers use unref() to avoid holding the loop
// ============================================================

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
  Events,
  Options
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

// ─── Paths ───────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TEMP_DIR   = path.join(__dirname, "temp");
const LOGS_DIR   = path.join(__dirname, "logs");

for (const dir of [LOGS_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Clean temp dir on startup (async, non-blocking)
fsp.readdir(TEMP_DIR)
  .then(files => Promise.all(files.map(f => fsp.unlink(path.join(TEMP_DIR, f)).catch(() => {}))))
  .catch(() => {});

// ─── Config ──────────────────────────────────────────────────
const PORT     = process.env.PORT || 8000;
const OWNER_ID = process.env.OWNER_ID;

// ─── Small-caps lookup (frozen for V8 optimisation) ──────────
const SMALL_CAPS_MAP = Object.freeze({
  a:"ᴀ",b:"ʙ",c:"ᴄ",d:"ᴅ",e:"ᴇ",f:"ꜰ",g:"ɢ",h:"ʜ",i:"ɪ",
  j:"ᴊ",k:"ᴋ",l:"ʟ",m:"ᴍ",n:"ɴ",o:"ᴏ",p:"ᴘ",q:"ǫ",r:"ʀ",
  s:"s",t:"ᴛ",u:"ᴜ",v:"ᴠ",w:"ᴡ",x:"x",y:"ʏ",z:"ᴢ",
  A:"ᴀ",B:"ʙ",C:"ᴄ",D:"ᴅ",E:"ᴇ",F:"ꜰ",G:"ɢ",H:"ʜ",I:"ɪ",
  J:"ᴊ",K:"ᴋ",L:"ʟ",M:"ᴍ",N:"ɴ",O:"ᴏ",P:"ᴘ",Q:"ǫ",R:"ʀ",
  S:"s",T:"ᴛ",U:"ᴜ",V:"ᴠ",W:"ᴡ",X:"x",Y:"ʏ",Z:"ᴢ",
  "0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9",
  "!":"!","?":"?",".":".",",":",",":":":","'":"'",'"':'"',"-":" - ","_":"_"," ":" "
});
const sc = (text = "") => String(text).split("").map(ch => SMALL_CAPS_MAP[ch] ?? ch).join("");

// ─── Time helpers ─────────────────────────────────────────────
function toISTString(ts) {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone:"Asia/Kolkata", hour12:true,
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  }).replace(",", "");
}
function fancyAgo(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}ʜ ${m % 60}ᴍ ᴀɢᴏ`;
  if (m > 0) return `${m}ᴍ ${s % 60}ꜱ ᴀɢᴏ`;
  return `${s}ꜱ ᴀɢᴏ`;
}

// ─── Express health endpoint ──────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.get("/", (_, res) => res.status(200).json({ status: "✅ ʙᴏᴛ ɪs ᴀʟɪᴠᴇ" }));
app.listen(PORT, () => console.log(`🌐 Web server on port ${PORT}`));

// ─── Mongoose Schemas & Models ────────────────────────────────
const guildSettingsSchema = new mongoose.Schema({
  guildId:              { type: String, required: true, unique: true },
  alertsEnabled:        { type: Boolean, default: false },
  textChannelId:        { type: String,  default: null },
  joinAlerts:           { type: Boolean, default: true },
  leaveAlerts:          { type: Boolean, default: true },
  onlineAlerts:         { type: Boolean, default: true },
  privateThreadAlerts:  { type: Boolean, default: true },
  autoDelete:           { type: Boolean, default: true },
  ignoredRoleId:        { type: String,  default: null },
  ignoreRoleEnabled:    { type: Boolean, default: false }
}, { timestamps: true });
const GuildSettings = mongoose.model("GuildSettings", guildSettingsSchema);

const logSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  guildName: String,
  user:      { type: String, required: true },
  channel:   String,
  type:      { type: String, required: true, enum: ["join","leave","online"] },
  time:      { type: Date, default: Date.now }
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
  playCount:        { type: Number, default: 0 },
  createdAt:        { type: Date,   default: Date.now }
});
soundSchema.index({ guildId: 1, name: 1 }, { unique: true });
soundSchema.index({ guildId: 1, playCount: -1 });
const Sound = mongoose.model("Soundboards", soundSchema);

// ─── Guild settings cache + debounced writer ──────────────────
// Cache capped at MAX_CACHE_SIZE entries; oldest evicted on overflow
const MAX_CACHE_SIZE     = 200;
const guildSettingsCache = new Map();   // guildId → settings POJO
const pendingSaveQueue   = new Map();   // guildId → settings POJO
let   pendingSaveTimer   = null;

function evictOldestCacheEntry() {
  const firstKey = guildSettingsCache.keys().next().value;
  if (firstKey) guildSettingsCache.delete(firstKey);
}

function schedulePendingSaves() {
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(async () => {
    const entries = [...pendingSaveQueue.entries()];
    pendingSaveQueue.clear();
    pendingSaveTimer = null;
    await Promise.all(entries.map(([guildId, s]) =>
      GuildSettings.findOneAndUpdate({ guildId }, s, { upsert: true, setDefaultsOnInsert: true })
        .lean().exec()
        .catch(e => console.error(`[DB SAVE] ${guildId}:`, e?.message ?? e))
    ));
  }, 300);
}

function updateGuildSettings(settings) {
  if (!settings?.guildId) return;
  // Move-to-front for LRU-like eviction
  guildSettingsCache.delete(settings.guildId);
  guildSettingsCache.set(settings.guildId, settings);
  if (guildSettingsCache.size > MAX_CACHE_SIZE) evictOldestCacheEntry();
  pendingSaveQueue.set(settings.guildId, settings);
  schedulePendingSaves();
}

async function getGuildSettings(guildId) {
  let settings = guildSettingsCache.get(guildId);
  if (settings) {
    // Refresh access order (LRU)
    guildSettingsCache.delete(guildId);
    guildSettingsCache.set(guildId, settings);
    return settings;
  }

  settings = await GuildSettings.findOne({ guildId }).lean().select("-__v").catch(() => null);
  if (!settings) {
    settings = {
      guildId, alertsEnabled: false, textChannelId: null,
      joinAlerts: true, leaveAlerts: true, onlineAlerts: true,
      privateThreadAlerts: true, autoDelete: true,
      ignoredRoleId: null, ignoreRoleEnabled: false
    };
    await new GuildSettings(settings).save().catch(e => {
      if (e.code !== 11000) console.error(`[DB] default save failed for ${guildId}:`, e?.message ?? e);
    });
  }

  if (guildSettingsCache.size >= MAX_CACHE_SIZE) evictOldestCacheEntry();
  guildSettingsCache.set(guildId, settings);
  return settings;
}

// ─── Non-blocking log creation ────────────────────────────────
function addLog(type, user, channel, guild) {
  GuildLog.create({
    guildId:   guild.id   ?? guild,
    guildName: guild.name ?? guild,
    user, channel, type, time: Date.now()
  }).catch(err => console.error(`[Log Error] ${err?.message ?? err}`));
}

// ─── Activity file generator ──────────────────────────────────
async function generateActivityFile(guild, logs) {
  const filePath = path.join(LOGS_DIR, `${guild.id}_activity.txt`);
  const header =
`╔══════════════════════════════════════════════╗
║  🌌 ${sc(guild.name)} ᴀᴄᴛɪᴠɪᴛʏ ʟᴏɢꜱ
║  🗓️ ${sc(toISTString(Date.now()))}
╚══════════════════════════════════════════════╝\n\n`;
  const body = logs.map(l => {
    const emoji  = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
    const action = l.type === "join" ? "entered" : l.type === "leave" ? "left" : "came online";
    return `${emoji} ${sc(l.type.toUpperCase())} — ${l.user} ${action} ${l.channel}\n    🕒 ${fancyAgo(Date.now() - l.time)} • ${toISTString(l.time)}\n`;
  }).join("\n");
  await fsp.writeFile(filePath, header + body, "utf8");
  return filePath;
}

// ─── /inv helpers (module-level, reused by command + autocomplete) ───────────

/**
 * Returns true if `member` can view and connect to `vc`.
 * Uses only cached permission data — no network calls.
 */
function canInviteToVC(member, vc) {
  try {
    const p = vc.permissionsFor(member);
    return !!(p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.Connect));
  } catch { return false; }
}

// ─── Embed helpers ────────────────────────────────────────────
const EmbedColors = Object.freeze({
  SUCCESS: 0x1abc9c, ERROR: 0xe74c3c, WARNING: 0xffcc00,
  INFO: 0x5865f2, VC_JOIN: 0x00ffcc, VC_LEAVE: 0xff5e5e,
  ONLINE: 0x55ff55, RESET: 0x00ccff
});

function makeEmbed({ title, description, color = EmbedColors.INFO, guild }) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: sc(title), iconURL: client.user?.displayAvatarURL() })
    .setDescription(sc(description))
    .setFooter({
      text: guild?.name ? sc(guild.name) : sc("VC ALERT CONTROL PANEL"),
      iconURL: guild?.iconURL?.({ dynamic: true }) ?? client.user?.displayAvatarURL()
    })
    .setTimestamp();
}

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
    .setFooter({ text: sc(guild?.name || `Server ID: ${settings.guildId}`), iconURL: guild?.iconURL?.({ dynamic: true }) ?? client.user.displayAvatarURL() })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("toggleJoinAlerts").setLabel(sc("👋 Join")).setStyle(settings.joinAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleLeaveAlerts").setLabel(sc("🏃 Leave")).setStyle(settings.leaveAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleOnlineAlerts").setLabel(sc("🟢 Online")).setStyle(settings.onlineAlerts ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("togglePrivateThreads").setLabel(sc("🪪 Private Alerts")).setStyle(settings.privateThreadAlerts ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleIgnoreRole").setLabel(sc("🙈 Ignore Alerts")).setStyle(settings.ignoreRoleEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("toggleAutoDelete").setLabel(sc("🧹 Auto-Delete")).setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("resetSettings").setLabel(sc("♻️ Reset Settings")).setStyle(ButtonStyle.Danger)
  );
  return { embed, buttons: [row1, row2] };
}

// ─── Soundboard ───────────────────────────────────────────────
// sbQueues: guildId → queue object (created lazily, destroyed on stop)
const sbQueues = new Map();
const sbPanels = new Map();  // guildId → { messageId, channelId }

function getSbQueue(guildId) {
  if (sbQueues.has(guildId)) return sbQueues.get(guildId);

  const player = createAudioPlayer();
  const q = {
    player,
    list:            [],
    now:             null,
    vcId:            null,
    timeout:         null,
    guildId,
    // Store only the channel ID — never the full channel object.
    // The live channel is resolved on-demand from guild.channels.cache.
    lastTextChannelId: null,
    currentFile:       null,
    volume:            1.0,
    resource:          null,
    prefetchTrack:     null,
    prefetchFile:      null
  };

  // ── Audio player listeners (registered once) ──
  player.on("stateChange", (_old, next) => {
    if (next.status === AudioPlayerStatus.Buffering) {
      // Auto-skip if stuck buffering for >8 s
      const guard = setTimeout(() => {
        if (q.player.state.status === AudioPlayerStatus.Buffering) {
          console.warn(`[sb] Stuck buffering in guild ${guildId}; auto-skipping.`);
          q.player.stop();
        }
      }, 8_000);
      guard.unref();
    }
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    try {
      q.resource = null;
      // Delete temp file immediately
      if (q.currentFile) {
        const f = q.currentFile;
        q.currentFile = null;
        fsp.unlink(f).catch(() => {});
      }
      q.now = null;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      if (q.list.length === 0) startSbLeaveTimer(guildId);
      else {
        // Resolve channel object on-demand from stored ID
        const textCh = q.lastTextChannelId
          ? (guild.channels.cache.get(q.lastTextChannelId) ?? null)
          : null;
        await sbPlayNext(guild, textCh);
      }
      sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {}); // fire-and-forget panel refresh
    } catch (err) { console.error("[sb idle]", err); }
  });

  player.on("error", err => {
    console.error("[sb player error]", err);
    // Resolve channel on-demand from stored ID — no object pinned in memory
    const errGuild = client.guilds.cache.get(guildId);
    const errCh = errGuild && q.lastTextChannelId
      ? (errGuild.channels.cache.get(q.lastTextChannelId) ?? null)
      : null;
    errCh?.send({ content: `⚠️ **${q.now?.name ?? "Track"}** failed. Skipping…` }).catch(() => {});
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
  // Clean up current and prefetch files
  if (q.currentFile) { fsp.unlink(q.currentFile).catch(() => {}); q.currentFile = null; }
  if (q.prefetchFile) { fsp.unlink(q.prefetchFile).catch(() => {}); q.prefetchFile = null; q.prefetchTrack = null; }
  sbQueues.delete(guildId);
}

// ── Leave timer (10 min idle before auto-disconnect) ──
function startSbLeaveTimer(guildId) {
  const q = sbQueues.get(guildId);
  if (!q) return;
  if (q.timeout) clearTimeout(q.timeout);
  const lockedVcId = q.vcId;
  q.timeout = setTimeout(() => {
    const conn = getVoiceConnection(guildId);
    if (conn && conn.joinConfig.channelId === lockedVcId) conn.destroy();
    q.list = []; q.now = null; q.vcId = null; q.resource = null;
  }, 10 * 60 * 1000);
  q.timeout.unref();
}

// ── Ensure soundboard-storage channel exists ──
async function sbEnsureStorage(guild) {
  let ch = guild.channels.cache.find(c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText);
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

// ── Play next in queue ──
// textChannel is the live channel object for this call only.
// We persist only its ID in q.lastTextChannelId to avoid holding Discord.js objects.

async function sbPrefetchNext(guild) {
  const q = getSbQueue(guild.id);
  if (!q.list.length || q.prefetchTrack) return;
  const next = q.list[0];
  q.prefetchTrack = next;
  try {
    let downloadUrl = next.fileURL;
    const storageCh = guild.channels.cache.find(c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText);
    if (storageCh && next.storageMessageId) {
      const msg = await storageCh.messages.fetch(next.storageMessageId).catch(() => null);
      if (msg?.attachments.size) downloadUrl = msg.attachments.first().url;
    }
    const fileExt = path.extname(new URL(downloadUrl).pathname) || ".mp3";
    const localFilePath = path.join(TEMP_DIR, `prefetch_${guild.id}_${Date.now()}${fileExt}`);
    const resp = await axios({ method: "GET", url: downloadUrl, responseType: "stream", timeout: 30_000 });
    await streamPipeline(resp.data, fs.createWriteStream(localFilePath));
    q.prefetchFile = localFilePath;
  } catch (e) {
    console.warn("[sb prefetch] failed:", e.message);
    q.prefetchTrack = null;
    if (q.prefetchFile) { fs.unlink(q.prefetchFile, () => {}); q.prefetchFile = null; }
  }
}
async function sbPlayNext(guild, textChannel = null, retryCount = 0) {
  const q = getSbQueue(guild.id);
  if (textChannel) q.lastTextChannelId = textChannel.id;
  if (!q.list.length) { q.now = null; startSbLeaveTimer(guild.id); sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {}); return; }

  let next, localFilePath = null;
  if (q.prefetchTrack && q.prefetchFile && q.list[0] && q.prefetchTrack.name === q.list[0].name) {
    next = q.list.shift();
    localFilePath = q.prefetchFile;
    q.prefetchFile = null;
    q.prefetchTrack = null;
  } else {
    if (q.prefetchFile) { fs.unlink(q.prefetchFile, () => {}); q.prefetchFile = null; q.prefetchTrack = null; }
    next = q.list.shift();
    let downloadUrl = next.fileURL;
    const storageCh = guild.channels.cache.find(c => c.name === "soundboard-storage" && c.type === ChannelType.GuildText);
    if (storageCh && next.storageMessageId) {
      const msg = await storageCh.messages.fetch(next.storageMessageId).catch(() => null);
      if (msg?.attachments.size) downloadUrl = msg.attachments.first().url;
    }
    const fileExt = path.extname(new URL(downloadUrl).pathname) || ".mp3";
    localFilePath = path.join(TEMP_DIR, `${guild.id}_${Date.now()}${fileExt}`);
    try {
      const resp = await axios({ method: "GET", url: downloadUrl, responseType: "stream", timeout: 30_000 });
      await streamPipeline(resp.data, fs.createWriteStream(localFilePath));
    } catch (e) {
      if (localFilePath) { fs.unlink(localFilePath, () => {}); localFilePath = null; }
      throw e;
    }
  }
  q.now = next;
  if (next._id) Sound.updateOne({ _id: next._id }, { $inc: { playCount: 1 } }).catch(() => {});
  try {

    const { size } = await fsp.stat(localFilePath);
    if (size === 0) throw new Error("Downloaded file is empty");

    const resource = createAudioResource(localFilePath, { inputType: StreamType.Arbitrary, inlineVolume: true });
    resource.volume.setVolume(q.volume);
    q.currentFile = localFilePath;
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
    sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
  } catch (e) {
    console.error("[sb playNext]", e);
    if (localFilePath) fsp.unlink(localFilePath).catch(() => {});
    textChannel?.send(`⚠️ **${next.name}** failed to load. ${retryCount < 1 ? "Retrying…" : "Skipping…"}`).catch(() => {});
    q.now = null;
    if (retryCount < 1) {
      q.list.unshift(next);
      // Resolve channel from ID for retry to avoid closure capture of stale objects
      setTimeout(() => {
        const retryCh = q.lastTextChannelId
          ? (guild.channels.cache.get(q.lastTextChannelId) ?? null)
          : null;
        sbPlayNext(guild, retryCh, retryCount + 1).catch(() => {});
      }, 2_000).unref();
    } else {
      setTimeout(() => {
        const retryCh = q.lastTextChannelId
          ? (guild.channels.cache.get(q.lastTextChannelId) ?? null)
          : null;
        sbPlayNext(guild, retryCh, 0).catch(() => {});
      }, 1_000).unref();
    }
  }
}

// ── Connect bot to member's VC ──
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

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Attempt to reconnect if disconnected unexpectedly
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (e) {
        if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
        const q = sbQueues.get(guild.id);
        if (q) {
          q.vcId = null; q.now = null;
          if (q.currentFile) { fsp.unlink(q.currentFile).catch(() => {}); q.currentFile = null; }
          if (q.prefetchFile) { fsp.unlink(q.prefetchFile).catch(() => {}); q.prefetchFile = null; q.prefetchTrack = null; }
          q.list = [];
        }
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
    console.error("[sb connect]", err);
    return { error: "connect_failed", details: err.message };
  }
}

// ── Sound panel embed ──
async function buildSoundPanelEmbed(guild) {
  const q     = getSbQueue(guild.id);
  const total = await Sound.countDocuments({ guildId: guild.id }).catch(() => 0);
  const conn  = getVoiceConnection(guild.id);
  const status    = q.now ? "🟢 ᴘʟᴀʏɪɴɢ" : (conn ? "🟡 ᴄᴏɴɴᴇᴄᴛᴇᴅ" : "🔴 ɪᴅʟᴇ");
  const nowPlaying = q.now ? `🎧 ${q.now.name}` : "—";
  const queueLines = q.list.slice(0, 8).map((s, i) => `\`${i + 1}.\` ${s.name}`).join("\n") || sc("ɴᴏ ǫᴜᴇᴜᴇᴅ sᴏᴜɴᴅs");
  const moreText   = q.list.length > 8 ? `\n…and ${q.list.length - 8} more` : "";

  const prefetchInfo = q.prefetchTrack ? `\n${sc("> ᴘʀᴇꜰᴇᴛᴄʜɪɴɢ:")} ${sc(q.prefetchTrack.name)} ${q.prefetchFile ? "✅" : "⏳"}` : "";
  const embed = new EmbedBuilder()
    .setColor(EmbedColors.VC_JOIN)
    .setAuthor({ name: sc("🎛 sᴏᴜɴᴅʙᴏᴀʀᴅ ᴘᴀɴᴇʟ"), iconURL: client.user.displayAvatarURL() })
    .setDescription(
      `${sc("> sᴛᴀᴛᴜs:")} ${sc(status)}\n` +
      `${sc("> ᴠᴏʟᴜᴍᴇ:")} ${Math.round(q.volume * 100)}%\n` +
      `${sc("> ɴᴏᴡ ᴘʟᴀʏɪɴɢ:")} ${sc(nowPlaying)}\n` +
      `${sc("> ᴛᴏᴛᴀʟ sᴏᴜɴᴅs:")} ${total}${sc(prefetchInfo)}\n\n` +
      `${sc("📜 ǫᴜᴇᴜᴇ:")}\n${sc(queueLines + moreText)}`
    )
    .setFooter({ text: sc(guild.name) })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sb_connect").setLabel(sc("🎧 ᴄᴏɴɴᴇᴄᴛ")).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("sb_skip").setLabel(sc("⏭ sᴋɪᴘ")).setStyle(ButtonStyle.Secondary).setDisabled(!q.now),
    new ButtonBuilder().setCustomId("sb_stop").setLabel(sc("⛔ sᴛᴏᴘ")).setStyle(ButtonStyle.Danger).setDisabled(!q.now),
    new ButtonBuilder().setCustomId("sb_refresh").setLabel(sc("ʀᴇꜰʀᴇsʜ")).setStyle(ButtonStyle.Secondary)
  );
  return { embed, buttons: [row] };
}

async function sbUpdatePanel(guild) {
  const panel = sbPanels.get(guild.id);
  if (!panel) return;
  try {
    const ch  = guild.channels.cache.get(panel.channelId) ?? await guild.channels.fetch(panel.channelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
    if (!msg) return;
    const ui = await buildSoundPanelEmbed(guild);
    await msg.edit({ embeds: [ui.embed], components: ui.buttons }).catch(() => {});
  } catch (e) { console.error("[sbUpdatePanel]", e); }
}

// ─── Discord Client ───────────────────────────────────────────
// Cache strategy: keep only what the bot actively needs.
// GuildMembers intent kept for voiceStateUpdate member access.
// GuildPresences intent kept for online alerts (presenceUpdate).
// makeCache aggressively limits collections to reduce heap pressure.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,   // required for VC join/leave events
    GatewayIntentBits.GuildMembers,        // required for member roles + voiceState.member
    GatewayIntentBits.GuildPresences       // required for online alerts
  ],
  partials: [Partials.User, Partials.GuildMember],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    // Messages are not needed — the bot does not read chat
    MessageManager:       0,
    // Reactions not needed
    ReactionManager:      0,
    // Threads only needed ephemerally; we track IDs ourselves
    ThreadManager:        0,
    ThreadMemberManager:  0,
    // Keep a small member cache for recent voice events; large servers
    // will still have members come in via voiceStateUpdate naturally.
    GuildMemberManager:   { maxSize: 500, keepOverLimit: m => m.id === client.user?.id },
    // Presences: only cache what we actually receive; hard-cap at 500
    PresenceManager:      500,
    // Channels: keep all (needed for permission checks + VC logic)
    // Guilds: keep all (small Map, one per server)
    // Roles: keep all (needed for ignoredRole checks)
    // Emojis / stickers / stage instances — not used
    GuildEmojiManager:    0,
    GuildStickerManager:  0,
    StageInstanceManager: 0,
    GuildScheduledEventManager: 0,
    AutoModerationRuleManager:  0
  }),
  ws: { properties: { browser: "Discord iOS" } },
  shards: "auto",
  restRequestTimeout: 30_000
});

// ─── Slash command definitions ────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("settings").setDescription("⚙️ View and manage VC activity and presence alerts"),
  new SlashCommandBuilder().setName("activate").setDescription("🚀 Activate VC alerts")
    .addChannelOption(o => o.setName("channel").setDescription("Text channel for alerts").addChannelTypes(ChannelType.GuildText).setRequired(false)),
  new SlashCommandBuilder().setName("deactivate").setDescription("🛑 Disable all VC alerts"),
  new SlashCommandBuilder().setName("ignorerole").setDescription("🙈 Manage ignored role settings")
    .addStringOption(o => o.setName("action").setDescription("Action to perform").setRequired(true)
      .addChoices({ name:"View",value:"view" },{ name:"Set",value:"set" },{ name:"Reset",value:"reset" },{ name:"Toggle On/Off",value:"toggle" }))
    .addRoleOption(o => o.setName("role").setDescription("Role to ignore (required for 'set')").setRequired(false)),
  new SlashCommandBuilder().setName("userinfo").setDescription("👤 Get detailed user information")
    .addUserOption(o => o.setName("user").setDescription("User to inspect (default: yourself)").setRequired(false)),
  new SlashCommandBuilder().setName("owner").setDescription("👑 Bot owner dashboard (DM only)"),
  new SlashCommandBuilder().setName("logs").setDescription("📜 View server activity logs")
    .addStringOption(o => o.setName("range").setDescription("Time range").setRequired(false)
      .addChoices({ name:"📅 Today",value:"today" },{ name:"🕓 Yesterday",value:"yesterday" },{ name:"📆 Last 7 days",value:"7days" },{ name:"🗓️ Last 30 days",value:"30days" }))
    .addUserOption(o => o.setName("user").setDescription("Filter by user").setRequired(false)),
  new SlashCommandBuilder().setName("sound").setDescription("🔊 Soundboard controls")
    .addSubcommand(s => s.setName("add").setDescription("➕ Add a sound")
      .addStringOption(o => o.setName("name").setDescription("Sound name").setRequired(true))
      .addAttachmentOption(o => o.setName("file").setDescription("Audio file")))
    .addSubcommand(s => s.setName("play").setDescription("▶ Play a sound")
      .addStringOption(o => o.setName("name").setDescription("Sound name").setAutocomplete(true).setRequired(true)))
    .addSubcommand(s => s.setName("delete").setDescription("🗑 Delete a sound")
      .addStringOption(o => o.setName("name").setDescription("Sound name").setAutocomplete(true).setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("📜 List all sounds"))
    .addSubcommand(s => s.setName("panel").setDescription("🎛 Open soundboard panel"))
    .addSubcommand(s => s.setName("volume").setDescription("🔊 Set volume (0–100)")
      .addIntegerOption(o => o.setName("level").setDescription("0 - 100").setRequired(true).setMinValue(0).setMaxValue(100)))
    .addSubcommand(s => s.setName("top").setDescription("🏆 Most played sounds"))
    .addSubcommand(s => s.setName("skip").setDescription("⏭️ Skip the current sound"))
    .addSubcommand(s => s.setName("stop").setDescription("⛔ Stop playback and clear queue"))
    .addSubcommand(s => s.setName("queue").setDescription("📜 View the current sound queue"))
    .addSubcommand(s => s.setName("shuffle").setDescription("🔀 Shuffle the current queue"))
    .addSubcommand(s => s.setName("search").setDescription("🔍 Search for a sound")
      .addStringOption(o => o.setName("query").setDescription("Keywords to search for").setRequired(true))),
  new SlashCommandBuilder().setName("stats").setDescription("📊 Show server activity statistics")
    .addStringOption(o => o.setName("period").setDescription("Time period").setRequired(false)
      .addChoices({ name:"📅 Today",value:"today" },{ name:"📆 Last 7 days",value:"7days" },{ name:"🗓️ Last 30 days",value:"30days" },{ name:"📈 All time",value:"all" })),
  new SlashCommandBuilder().setName("vclist").setDescription("🔊 List all active voice channels and members"),
  new SlashCommandBuilder().setName("userstats").setDescription("📈 View voice activity stats for a member")
    .addUserOption(o => o.setName("user").setDescription("Member to check").setRequired(false)),
  new SlashCommandBuilder().setName("ping").setDescription("🏓 Check bot latency and status"),
  new SlashCommandBuilder().setName("cleanup").setDescription("🧹 Clean up old logs and temp files"),

  // ── /inv — invite to VC ──────────────────────────────────────
  // Removed: limit option (results are always shown directly)
  new SlashCommandBuilder().setName("inv").setDescription("📨 Invite someone to your voice channel")
    .addStringOption(o => o.setName("search")
      .setDescription("Search by name — leave empty to see top VC users")
      .setRequired(false)
      .setAutocomplete(true))

].map(c => c.toJSON());

// ─── Heartbeat / connection health ────────────────────────────
let lastHeartbeat        = Date.now();
let reconnectAttempts    = 0;
let lastHeartbeatWarnAt  = 0;
const MAX_RECONNECT      = 5;
const HEARTBEAT_WARN_CD  = 5 * 60_000; // 5 min

const heartbeatInterval = setInterval(() => {
  const gap = Date.now() - lastHeartbeat;
  if (gap > 60_000) {
    const now = Date.now();
    if (now - lastHeartbeatWarnAt > HEARTBEAT_WARN_CD) {
      console.warn(`⚠️ No heartbeat for ${Math.floor(gap / 1000)}s`);
      lastHeartbeatWarnAt = now;
      if (reconnectAttempts < MAX_RECONNECT) {
        console.log(`🔄 Reconnect attempt ${reconnectAttempts + 1}/${MAX_RECONNECT}`);
        reconnectAttempts++;
        client.destroy();
        setTimeout(() => client.login(process.env.TOKEN).catch(e => console.error("❌ Reconnect failed:", e)), 5_000).unref();
      }
    }
  }
}, 30_000);
heartbeatInterval.unref();

// ─── Ready ───────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  lastHeartbeat    = Date.now();
  reconnectAttempts = 0;

  try { client.user.setActivity("the VC vibes unfold 🎧✨", { type: 3 }); } catch (_) {}

  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
    .then(() => console.log("✅ Slash commands registered"))
    .catch(e  => console.error("❌ Command registration error:", e));

  // Pre-warm settings cache for known guilds
  const ids = client.guilds.cache.map(g => g.id);
  await Promise.all(ids.map(id => getGuildSettings(id).catch(() => null)));
  console.log(`✅ Pre-warmed cache for ${ids.length} guild(s)`);
});

// ─── Admin check helper ────────────────────────────────────────
async function checkAdmin(interaction) {
  const ok = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)
          || interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  if (!ok) {
    await interaction.reply({
      embeds: [makeEmbed({ title: "No Permission", description: "Administrator or Manage Server permission required.", color: EmbedColors.ERROR, guild: interaction.guild })],
      flags: 64
    });
  }
  return !!ok;
}

// ─── Interaction handler ──────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild() && interaction.commandName !== "owner") return;
    const guild   = interaction.guild;
    const guildId = guild?.id;
    let settings  = guildId ? await getGuildSettings(guildId) : null;

    // ── Slash Commands ──────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const publicCmds = new Set(["owner","inv","ping","userinfo"]);
      if (!publicCmds.has(interaction.commandName) && !await checkAdmin(interaction)) return;

      switch (interaction.commandName) {

        // ─── /settings ───────────────────────────────────
        case "settings": {
          const panel = buildControlPanel(settings, guild);
          return interaction.reply({ embeds: [panel.embed], components: panel.buttons, flags: 64 });
        }

        // ─── /activate ───────────────────────────────────
        case "activate": {
          const selected = interaction.options.getChannel("channel");
          let channel = selected
            ?? (settings.textChannelId
                ? (guild.channels.cache.get(settings.textChannelId) ?? await guild.channels.fetch(settings.textChannelId).catch(() => null))
                : interaction.channel);
          if (!channel || channel.type !== ChannelType.GuildText)
            return interaction.reply({ embeds: [makeEmbed({ title: sc("⚠️ invalid channel"), description: sc("please choose a text channel"), color: EmbedColors.ERROR, guild })], flags: 64 });
          const botMember = await guild.members.fetch(client.user.id).catch(() => null);
          const perms     = channel.permissionsFor(botMember);
          if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages))
            return interaction.reply({ embeds: [makeEmbed({ title: sc("🚫 missing permissions"), description: sc(`i need view + send permissions in <#${channel.id}>`), color: EmbedColors.ERROR, guild })], flags: 64 });
          if (settings.alertsEnabled && settings.textChannelId === channel.id)
            return interaction.reply({ embeds: [makeEmbed({ title: sc("🟢 already active"), description: sc(`alerts already running in <#${channel.id}>`), color: EmbedColors.WARNING, guild })], flags: 64 });
          settings.alertsEnabled = true;
          settings.textChannelId = channel.id;
          updateGuildSettings(settings);
          return interaction.reply({ embeds: [makeEmbed({ title: sc("✅ vc alerts activated"), description: sc(`alerts will now appear in <#${channel.id}>`), color: EmbedColors.SUCCESS, guild })], flags: 64 });
        }

        // ─── /deactivate ─────────────────────────────────
        case "deactivate": {
          if (!settings.alertsEnabled)
            return interaction.reply({ embeds: [makeEmbed({ title: sc("💤 already off"), description: sc("use /activate to re-enable"), color: EmbedColors.WARNING, guild })], flags: 64 });
          settings.alertsEnabled = false;
          updateGuildSettings(settings);
          return interaction.reply({ embeds: [makeEmbed({ title: sc("🔕 vc alerts powered down"), description: sc("no alerts until you /activate again"), color: EmbedColors.ERROR, guild })], flags: 64 });
        }

        // ─── /ignorerole ─────────────────────────────────
        case "ignorerole": {
          const action = interaction.options.getString("action");
          const role   = interaction.options.getRole("role");

          if (action === "view") {
            return interaction.reply({
              embeds: [makeEmbed({
                title: sc("🙈 ignore role settings"),
                description: sc(
                  `**Status:** ${settings.ignoreRoleEnabled ? "🟢 Activated" : "🔴 Deactivated"}\n` +
                  `**Ignored Role:** ${settings.ignoredRoleId ? `<@&${settings.ignoredRoleId}>` : "None set"}`
                ),
                color: settings.ignoreRoleEnabled ? EmbedColors.SUCCESS : EmbedColors.INFO, guild
              })],
              flags: 64
            });
          }
          if (action === "set") {
            if (!role) return interaction.reply({ embeds: [makeEmbed({ title: sc("⚠️ role required"), description: sc("provide a role with the role option"), color: EmbedColors.WARNING, guild })], flags: 64 });
            settings.ignoredRoleId = role.id; settings.ignoreRoleEnabled = true;
            updateGuildSettings(settings);
            return interaction.reply({ embeds: [makeEmbed({ title: sc("✅ ignore role set"), description: sc(`Members with ${role} will be skipped in VC alerts`), color: EmbedColors.SUCCESS, guild })], flags: 64 });
          }
          if (action === "reset") {
            if (!settings.ignoredRoleId) return interaction.reply({ embeds: [makeEmbed({ title: sc("ℹ️ no role set"), description: sc("Nothing to reset"), color: EmbedColors.INFO, guild })], flags: 64 });
            settings.ignoredRoleId = null; settings.ignoreRoleEnabled = false;
            updateGuildSettings(settings);
            return interaction.reply({ embeds: [makeEmbed({ title: sc("♻️ ignore role reset"), description: sc("All members will appear in VC alerts again"), color: EmbedColors.RESET, guild })], flags: 64 });
          }
          if (action === "toggle") {
            if (!settings.ignoredRoleId) return interaction.reply({ embeds: [makeEmbed({ title: sc("⚠️ no role configured"), description: sc("Set a role first with /ignorerole action:set"), color: EmbedColors.WARNING, guild })], flags: 64 });
            settings.ignoreRoleEnabled = !settings.ignoreRoleEnabled;
            updateGuildSettings(settings);
            return interaction.reply({ embeds: [makeEmbed({ title: sc(`${settings.ignoreRoleEnabled ? "✅" : "🔴"} ignore role ${settings.ignoreRoleEnabled ? "activated" : "deactivated"}`), description: sc(`Role: <@&${settings.ignoredRoleId}>`), color: settings.ignoreRoleEnabled ? EmbedColors.SUCCESS : EmbedColors.WARNING, guild })], flags: 64 });
          }
          break;
        }

        // ─── /userinfo ────────────────────────────────────
        case "userinfo": {
          await interaction.deferReply({ flags: 64 });
          const targetUser = interaction.options.getUser("user") || interaction.user;
          const member     = await guild.members.fetch(targetUser.id).catch(() => null);
          if (!member) return interaction.editReply({ embeds: [makeEmbed({ title: sc("❌ user not found"), description: sc("This user is not in the server."), color: EmbedColors.ERROR, guild })] });

          const createdStr   = new Date(targetUser.createdTimestamp).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric", timeZone:"Asia/Kolkata" });
          const daysSinceCr  = Math.floor((Date.now() - targetUser.createdTimestamp) / 86_400_000);
          const joinedStr    = member.joinedAt?.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric", timeZone:"Asia/Kolkata" }) ?? "N/A";
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

          const status = member.presence?.status || "offline";
          const statusEmoji = { online:"🟢", idle:"🟡", dnd:"🔴" }[status] || "⚫";
          const badges = [...(member.user.bot ? ["🤖 Bot"] : []), ...(member.premiumSince ? ["💎 Booster"] : []), ...(targetUser.id === guild.ownerId ? ["👑 Owner"] : [])];
          const voiceText = member.voice.channel ? `🎧 ${member.voice.channel.name}` : "Not in voice";

          const embed = new EmbedBuilder()
            .setColor(member.displayHexColor || EmbedColors.INFO)
            .setAuthor({ name: `${member.user.username}'s Profile`, iconURL: targetUser.displayAvatarURL({ dynamic: true, size: 256 }) })
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(`**User:** ${targetUser}\n**Display Name:** ${member.displayName}\n**Status:** ${statusEmoji} ${status}\n**Voice:** ${voiceText}`)
            .addFields(
              { name:"📅 Account Created", value:`${createdStr}\n(${daysSinceCr} days ago)`, inline:true },
              { name:"📥 Joined Server",   value:`${joinedStr}\n(${daysSinceJoin} days ago)`, inline:true },
              { name:"🏅 Badges",          value: badges.join(", ") || "None", inline:false },
              { name:`🎭 Roles (${member.roles.cache.size - 1})`, value: roles.join(", ") || "No roles", inline:false },
              { name:"🔑 Key Permissions", value: keyPerms.join(", ") || "None", inline:false }
            )
            .setFooter({ text: `ID: ${targetUser.id} • All times in IST` })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        }

        // ─── /owner ───────────────────────────────────────
        case "owner": {
          const isOwner = OWNER_ID && interaction.user.id === OWNER_ID;
          if (!isOwner) return interaction.reply({ embeds: [makeEmbed({ title: sc("🚫 ᴜɴᴀᴜᴛʜᴏʀɪᴢᴇᴅ"), description: sc("Owner only command."), color: EmbedColors.ERROR, guild })], flags: 64 });

          if (interaction.guild) {
            const tg = client.guilds.cache.size;
            const tm = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
            const up = Math.floor(process.uptime());
            return interaction.reply({
              embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING)
                .setAuthor({ name: sc("👑 ᴏᴡɴᴇʀ ᴅᴀsʜʙᴏᴀʀᴅ"), iconURL: client.user.displayAvatarURL() })
                .setDescription(
                  sc("💡 Use this in DM for the full dashboard.\n\n") +
                  `> 🌐 **Servers:** ${tg}\n> 👥 **Members:** ${tm.toLocaleString()}\n` +
                  `> 📡 **WS Ping:** ${client.ws.ping}ms\n> ⏱️ **Uptime:** ${Math.floor(up/86400)}d ${Math.floor((up%86400)/3600)}h ${Math.floor((up%3600)/60)}m`
                )
                .setFooter({ text: sc("dm the bot for full analytics") }).setTimestamp()
              ],
              flags: 64
            });
          }

          await interaction.deferReply({ flags: 64 });
          const oneDayAgo = new Date(Date.now() - 86_400_000);
          const [totalGuilds, totalMembers, recentLogsCount, totalLogs, totalSounds, activeGuilds, totalSettings, joinCount24h, leaveCount24h, onlineCount24h, guildActivity] = await Promise.all([
            Promise.resolve(client.guilds.cache.size),
            Promise.resolve(client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo } }).catch(() => 0),
            GuildLog.countDocuments().catch(() => 0),
            Sound.countDocuments().catch(() => 0),
            GuildSettings.countDocuments({ alertsEnabled: true }).catch(() => 0),
            GuildSettings.countDocuments().catch(() => 0),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo }, type:"join" }).catch(() => 0),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo }, type:"leave" }).catch(() => 0),
            GuildLog.countDocuments({ time: { $gte: oneDayAgo }, type:"online" }).catch(() => 0),
            GuildLog.aggregate([
              { $match: { time: { $gte: oneDayAgo } } },
              { $group: { _id: "$guildId", count: { $sum: 1 }, name: { $first: "$guildName" } } },
              { $sort: { count: -1 } }, { $limit: 10 }
            ]).catch(() => [])
          ]);

          const mem    = process.memoryUsage();
          const upSecs = Math.floor(process.uptime());
          const topGuilds = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount).slice(0, 10)
            .map((g, i) => `${i + 1}. **${g.name}** — ${g.memberCount.toLocaleString()} members`).join("\n");

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
                { name: sc("📊 ɢʟᴏʙᴀʟ sᴛᴀᴛs"),
                  value: `🌐 **Servers:** ${totalGuilds}\n👥 **Members:** ${totalMembers.toLocaleString()}\n✅ **Active Guilds:** ${activeGuilds}/${totalSettings}\n🔊 **Sounds:** ${totalSounds}`, inline:true },
                { name: sc("⚡ ʟᴀsᴛ 24ʜ"),
                  value: `📈 **Events:** ${recentLogsCount.toLocaleString()}\n🟢 **Joins:** ${joinCount24h}\n🔴 **Leaves:** ${leaveCount24h}\n💠 **Online:** ${onlineCount24h}`, inline:true },
                { name: sc("💾 sʏsᴛᴇᴍ"),
                  value: `🧠 **Heap:** ${(mem.heapUsed/1048576).toFixed(2)}MB / ${(mem.heapTotal/1048576).toFixed(2)}MB\n⚙️ **Node:** ${process.version}\n🖥️ **Platform:** ${process.platform} ${process.arch}\n📜 **DB Logs:** ${totalLogs.toLocaleString()}`, inline:false },
                { name: sc("🏆 ᴛᴏᴘ sᴇʀᴠᴇʀs"), value: topGuilds || "—", inline:false },
                { name: sc("🔥 ᴍᴏsᴛ ᴀᴄᴛɪᴠᴇ (24ʜ)"), value: guildActivity.map((g, i) => `${i+1}. **${g.name ?? g._id}** — ${g.count} events`).join("\n") || sc("no activity"), inline:false }
              )
              .setFooter({ text: sc("owner dashboard • confidential") }).setTimestamp()
            ]
          });
        }

        // ─── /logs ────────────────────────────────────────
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
          } else if (rangeOpt === "7days")  { startTime = now - 7  * 86_400_000; }
          else                               { startTime = now - 30 * 86_400_000; }

          const query = { guildId: guild.id, time: { $gte: new Date(startTime) } };
          if (endTime) query.time.$lt = new Date(endTime);
          if (userOpt) query.user = { $regex: `^${userOpt.tag}`, $options: "i" };

          const logs = await GuildLog.find(query).sort({ time: -1 }).limit(100).lean();
          if (!logs.length) return interaction.editReply({ embeds: [makeEmbed({ title: "No activity", description: "No logs found for the selected range.", color: EmbedColors.INFO, guild })] });

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
          return interaction.followUp({ embeds: [embed], files: [{ attachment: filePath, name: `${guild.name}_activity.txt` }], ephemeral: false });
        }

        // ─── /stats ───────────────────────────────────────
        case "stats": {
          await interaction.deferReply({ flags: 64 });
          const period = interaction.options.getString("period") || "today";
          const now    = Date.now();
          let startTime = 0;
          const periodLabel = { today:"Today", "7days":"Last 7 Days", "30days":"Last 30 Days", all:"All Time" }[period] ?? "Last 7 Days";
          if (period === "today") { const d = new Date(); d.setHours(0,0,0,0); startTime = d.getTime(); }
          else if (period === "7days")  startTime = now - 7  * 86_400_000;
          else if (period === "30days") startTime = now - 30 * 86_400_000;

          const query = { guildId: guild.id };
          if (startTime > 0) query.time = { $gte: new Date(startTime) };
          const logs = await GuildLog.find(query).lean();
          if (!logs.length) return interaction.editReply({ embeds: [makeEmbed({ title: "📊 No Statistics", description: "No activity for this period.", color: EmbedColors.INFO, guild })] });

          const joinCount   = logs.filter(l => l.type === "join").length;
          const leaveCount  = logs.filter(l => l.type === "leave").length;
          const onlineCount = logs.filter(l => l.type === "online").length;

          // User activity aggregation (single pass)
          const userActivity = new Map();
          const channelActivity = new Map();
          const hourlyActivity  = new Map();
          for (const log of logs) {
            const ua = userActivity.get(log.user) ?? { joins:0, leaves:0, online:0, total:0 };
            if (log.type === "join")   { ua.joins++;  }
            if (log.type === "leave")  { ua.leaves++; }
            if (log.type === "online") { ua.online++; }
            ua.total++;
            userActivity.set(log.user, ua);

            if (log.channel && log.channel !== "-") channelActivity.set(log.channel, (channelActivity.get(log.channel) ?? 0) + 1);
            const ist  = new Date(new Date(log.time).getTime() + 19_800_000);
            const hour = ist.getUTCHours();
            hourlyActivity.set(hour, (hourlyActivity.get(hour) ?? 0) + 1);
          }

          const topUsers    = [...userActivity.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5)
            .map(([u, s], i) => `${"🥇🥈🥉"[i] ?? `${i+1}.`} **${u}** — ${s.total} events (${s.joins} joins, ${s.leaves} leaves)`);
          const topChannels = [...channelActivity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
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
              { name:"📈 Overview", value:`Total: **${logs.length}**\n🟢 Joins: **${joinCount}**\n🔴 Leaves: **${leaveCount}**\n💠 Online: **${onlineCount}**`, inline:true },
              { name:"⏰ Peak Hour (IST)", value: peakHourText, inline:true },
              { name:"👥 Most Active Users", value: topUsers.join("\n") || "No data", inline:false }
            );
          if (topChannels.length) embed.addFields({ name:"🎧 Most Active VCs", value: topChannels.join("\n"), inline:false });
          embed.setFooter({ text: `Analysed ${logs.length} events` }).setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        }


        // ─── /vclist ──────────────────────────────────────
        case "vclist": {
          const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);
          if (!voiceChannels.size) return interaction.reply({ embeds: [makeEmbed({ title: "No Voice Channels", description: "This server has no voice channels.", color: EmbedColors.INFO, guild })], flags: 64 });

          const activeVCs = voiceChannels.filter(vc => vc.members.size > 0);
          if (!activeVCs.size) return interaction.reply({ embeds: [makeEmbed({ title: "No Active VCs", description: "No one is currently in a voice channel.", color: EmbedColors.INFO, guild })], flags: 64 });

          const embed = new EmbedBuilder()
            .setColor(EmbedColors.INFO)
            .setAuthor({ name: sc("🔊 ᴀᴄᴛɪᴠᴇ ᴠᴏɪᴄᴇ ᴄʜᴀɴɴᴇʟs"), iconURL: guild.iconURL({ dynamic: true }) })
            .setDescription(activeVCs.map(vc => {
              const members = vc.members.map(m => `> • <@${m.id}>`).join("\n");
              return `**${vc.name}** (${vc.members.size})\n${members}`;
            }).join("\n\n"))
            .setFooter({ text: sc(guild.name) })
            .setTimestamp();
          return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // ─── /userstats ───────────────────────────────────
        case "userstats": {
          await interaction.deferReply({ flags: 64 });
          const target = interaction.options.getUser("user") || interaction.user;
          const oneMonthAgo = new Date(Date.now() - 30 * 86_400_000);

          const [logs, totalJoins, totalLeaves, totalOnline] = await Promise.all([
            GuildLog.find({ guildId: guild.id, user: { $regex: `^${target.tag}`, $options: "i" }, time: { $gte: oneMonthAgo } }).sort({ time: -1 }).limit(10).lean(),
            GuildLog.countDocuments({ guildId: guild.id, user: { $regex: `^${target.tag}`, $options: "i" }, type: "join", time: { $gte: oneMonthAgo } }),
            GuildLog.countDocuments({ guildId: guild.id, user: { $regex: `^${target.tag}`, $options: "i" }, type: "leave", time: { $gte: oneMonthAgo } }),
            GuildLog.countDocuments({ guildId: guild.id, user: { $regex: `^${target.tag}`, $options: "i" }, type: "online", time: { $gte: oneMonthAgo } })
          ]);

          const recentActivity = logs.map(l => {
            const emoji = l.type === "join" ? "🟢" : l.type === "leave" ? "🔴" : "💠";
            return `**${emoji} ${l.type.toUpperCase()}** — ${l.channel}\n> 🕒 ${fancyAgo(Date.now() - l.time)}`;
          }).join("\n") || "No recent activity recorded.";

          const embed = new EmbedBuilder()
            .setColor(EmbedColors.INFO)
            .setAuthor({ name: `${target.username}"s VC Stats`, iconURL: target.displayAvatarURL({ dynamic: true }) })
            .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(sc("Activity over the last 30 days:"))
            .addFields(
              { name: sc("📥 Total Joins"), value: "`" + totalJoins + "`", inline: true },
              { name: sc("📤 Total Leaves"), value: "`" + totalLeaves + "`", inline: true },
              { name: sc("💠 Online Events"), value: "`" + totalOnline + "`", inline: true },
              { name: sc("🕒 Recent Activity"), value: recentActivity, inline: false }
            )
            .setFooter({ text: "Stats derived from bot logs" })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        }

        // ─── /ping ────────────────────────────────────────
        case "ping": {
          const t0 = Date.now();
          await interaction.deferReply({ flags: 64 });
          const apiLatency = Date.now() - t0;
          const ws         = client.ws.ping;
          const statusEmoji = ws < 200 && apiLatency < 500 ? "🟢" : ws < 500 && apiLatency < 1000 ? "🟡" : ws < 1000 ? "🟠" : "🔴";
          const statusText  = ["🟢","🟡","🟠","🔴"].indexOf(statusEmoji) === 0 ? "Excellent" : statusEmoji === "🟡" ? "Good" : statusEmoji === "🟠" ? "Fair" : "Poor";
          const up = process.uptime();
          return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle("🏓 Pong!")
              .setDescription(`**Status:** ${statusEmoji} ${statusText}\n\n> 🌐 API Latency: \`${apiLatency}ms\`\n> 📡 WS Ping: \`${ws}ms\`\n> ⏱️ Uptime: \`${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m\``)
              .setFooter({ text: "Bot Health Monitor" }).setTimestamp()
            ]
          });
        }

        // ─── /cleanup ─────────────────────────────────────
        case "cleanup": {
          await interaction.deferReply({ flags: 64 });
          const cutoff  = new Date(Date.now() - 30 * 86_400_000);
          const deleted = await GuildLog.deleteMany({ guildId: guild.id, time: { $lt: cutoff } }).catch(() => ({ deletedCount: 0 }));
          const files   = await fsp.readdir(TEMP_DIR).catch(() => []);
          let cleaned   = 0;
          await Promise.all(files.map(async f => {
            const fp = path.join(TEMP_DIR, f);
            const st = await fsp.stat(fp).catch(() => null);
            if (st && Date.now() - st.mtimeMs > 3_600_000) { await fsp.unlink(fp).catch(() => {}); cleaned++; }
          }));
          return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle("🧹 Cleanup Complete")
              .setDescription(`📜 Removed **${deleted.deletedCount}** old log entries\n📁 Cleaned **${cleaned}** temp files`)
              .setFooter({ text: "Cleanup complete" }).setTimestamp()
            ]
          });
        }

        // ─── /inv ─────────────────────────────────────────────────────────────
        case "inv": {
          await interaction.deferReply({ flags: 64 });

          const searchQuery = (interaction.options.getString("search") ?? "").trim();
          const MAX_RESULTS = 8;

          // ── Invoker context ──────────────────────────────────────────────
          const invokerVC = interaction.member?.voice?.channel ?? null;
          const invokerId = interaction.user.id;

          // ── Permission check helper (uses cached data, no fetch) ─────────
          function memberCanJoinVC(member, vc) {
            try {
              const p = vc.permissionsFor(member);
              return !!(p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.Connect));
            } catch { return false; }
          }

          // ── Candidate pool: cached members only ──────────────────────────
          const cachePool = [...guild.members.cache.values()].filter(m => {
            if (m.user.bot)        return false;  // no bots
            if (m.id === invokerId) return false;  // no self
            if (!invokerVC)        return true;   // no VC filter when not in VC
            if (!memberCanJoinVC(m, invokerVC)) return false;   // must have VC access
            if (m.voice?.channelId === invokerVC.id) return false; // skip: already inside
            return true;
          });

          let candidates = [];

          if (searchQuery.length > 0) {
            // ── SEARCH MODE: name match against cache ────────────────────
            const q = searchQuery.toLowerCase();
            candidates = cachePool
              .filter(m =>
                m.user.username.toLowerCase().includes(q) ||
                (m.nickname ?? "").toLowerCase().includes(q) ||
                m.displayName.toLowerCase().includes(q)
              )
              .slice(0, MAX_RESULTS);
          } else {
            // ── DEFAULT MODE: rank by DB VC join frequency ───────────────
            const freqResults = await GuildLog.aggregate([
              { $match: { guildId: guild.id, type: "join" } },
              { $group: { _id: "$user", joinCount: { $sum: 1 } } },
              { $sort: { joinCount: -1 } },
              { $limit: MAX_RESULTS * 4 }
            ]).catch(() => []);

            const scoreMap = new Map(freqResults.map(r => [r._id, r.joinCount]));

            const scored = cachePool.map(m => ({
              member: m,
              score:  scoreMap.get(m.user.tag) ?? scoreMap.get(m.user.username) ?? 0
            }));
            scored.sort((a, b) => b.score - a.score);
            candidates = scored.map(s => s.member).slice(0, MAX_RESULTS);

            // Fallback: no DB scores yet → sort by most recent server join
            if (candidates.length === 0) {
              candidates = cachePool
                .sort((a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0))
                .slice(0, MAX_RESULTS);
            }
          }

          // ── Empty state ─────────────────────────────────────────────────
          if (candidates.length === 0) {
            const why = invokerVC
              ? `Everyone's already here, or no one is available to join **${invokerVC.name}**.`
              : searchQuery
                ? `Couldn't find anyone matching **"${searchQuery}"**.`
                : "No invite candidates found.\nTry searching by name with the `search` option.";
            return interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setColor(EmbedColors.WARNING)
                  .setAuthor({ name: sc("📡 ʀᴀᴅᴀʀ ᴇᴍᴘᴛʏ"), iconURL: client.user.displayAvatarURL() })
                  .setDescription(sc(`> ${why}`))
                  .setFooter({ text: sc(guild.name) })
                  .setTimestamp()
              ]
            });
          }

          // ── UI helpers ───────────────────────────────────────────────────
          const isSingleUser = candidates.length === 1;

          function presenceDot(member) {
            const s = member.presence?.status;
            return { online: "🟢", idle: "🟡", dnd: "🔴" }[s] ?? "⚫";
          }

          function currentLocationBadge(member) {
            const ch = member.voice?.channel;
            if (!ch || ch.id === invokerVC?.id) return null;
            return `*Currently in* **${ch.name}**`;
          }

          // ── Premium Layout Setup ─────────────────────────────────────────
          let descBody;
          if (isSingleUser) {
            const m   = candidates[0];
            const dot = presenceDot(m);
            const loc = currentLocationBadge(m);
            const statusLabel = { online: "Online", idle: "Idle", dnd: "Do Not Disturb" }[m.presence?.status] ?? "Offline";
            descBody = 
              `🎯 **${m.displayName}** ${dot}\n` +
              `> ${sc("sᴛᴀᴛᴜs:")} **${statusLabel}**\n` +
              (loc ? `> 📡 ${loc}` : `> ✨ *Ready to be invited*`);
          } else {
            // Multi-user layout: Sleek, scannable guest list
            const medals = ["🥇", "🥈", "🥉"];
            descBody = candidates.map((m, i) => {
              const rank = medals[i] ?? `\`${i + 1}.\``;
              const dot  = presenceDot(m);
              const loc  = currentLocationBadge(m);
              return `${rank} **${m.displayName}** ${dot}` + (loc ? `\n   └ 📡 ${loc}` : "");
            }).join("\n\n");
          }

          // ── VC context header ─────────────────────────────────────────────
          const headerLine = invokerVC
            ? `${sc("📍 ᴄᴜʀʀᴇɴᴛ ᴠᴄ:")} **${invokerVC.name}** 👥 \`${invokerVC.members.size} inside\``
            : `⚠️ ${sc("Join a voice channel first to send targeted invites.")}`;

          const invEmbed = new EmbedBuilder()
            .setColor(EmbedColors.VC_JOIN)
            .setAuthor({ name: sc("📨 ᴠᴏɪᴄᴇ ɪɴᴠɪᴛᴇ sʏsᴛᴇᴍ"), iconURL: client.user.displayAvatarURL() })
            .setDescription(
              `${headerLine}\n\n` +
              (isSingleUser
                ? `${sc("▼ sᴇʟᴇᴄᴛᴇᴅ ᴛᴀʀɢᴇᴛ:")}\n${descBody}`
                : `${sc("▼ ᴠɪᴘ ɢᴜᴇsᴛ ʟɪsᴛ:")}\n${descBody}`)
            )
            .setFooter({
              text: searchQuery
                ? sc(`search: "${searchQuery}" • ${guild.name}`)
                : sc(`top recommendations • ${guild.name}`)
            })
            .setTimestamp();

          // ── Invite buttons: Sleek styling ────────────────────────────────
          const buttonRows = [];
          if (invokerVC && candidates.length > 0) {
            const btnCandidates = candidates.slice(0, 5);
            const row = new ActionRowBuilder().addComponents(
              btnCandidates.map(m =>
                new ButtonBuilder()
                  .setCustomId(`inv_notify_${m.id}_${invokerVC.id}`)
                  .setLabel(isSingleUser ? sc("sᴇɴᴅ ɪɴᴠɪᴛᴇ") : m.displayName.slice(0, 25))
                  .setStyle(isSingleUser ? ButtonStyle.Success : ButtonStyle.Primary)
                  .setEmoji(isSingleUser ? "✨" : "📨")
              )
            );
            buttonRows.push(row);
          } else if (!invokerVC) {
            buttonRows.push(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId("inv_no_vc_info")
                  .setLabel(sc("ᴊᴏɪɴ ᴀ ᴠᴄ ᴛᴏ ɪɴᴠɪᴛᴇ"))
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(true)
              )
            );
          }

          return interaction.editReply({ embeds: [invEmbed], components: buttonRows });
        }


        // ─── /sound ───────────────────────────────────────
        case "sound": {
          const sub = interaction.options.getSubcommand();
          const q   = getSbQueue(guildId);

          if (sub === "add") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
              return interaction.reply({ embeds: [makeEmbed({ title: sc("❌ ᴘᴇʀᴍɪssɪᴏɴ"), description: sc("admins only"), color: EmbedColors.ERROR, guild })], flags: 64 });
            const name = interaction.options.getString("name");
            const file = interaction.options.getAttachment("file");
            if (!file) return interaction.reply({ embeds: [makeEmbed({ title: sc("⚠ ɴᴏ ғɪʟᴇ"), description: sc("attach an audio file"), color: EmbedColors.WARNING, guild })], flags: 64 });
            if (await Sound.exists({ guildId, name }))
              return interaction.reply({ embeds: [makeEmbed({ title: sc("⚠ ᴀʟʀᴇᴀᴅʏ ᴇxɪsᴛs"), description: sc(`**${name}** already exists`), color: EmbedColors.WARNING, guild })], flags: 64 });
            await interaction.deferReply({ flags: 64 });
            let storage = null;
            try { storage = await sbEnsureStorage(guild); } catch (e) { console.error("[sb storage]", e); }
            let uploadedUrl = file.url, storageMessageId = null;
            if (storage) {
              const m = await storage.send({ files: [file.url] }).catch(() => null);
              if (m) { uploadedUrl = m.attachments.first()?.url ?? uploadedUrl; storageMessageId = m.id; }
            }
            await Sound.create({ guildId, name, fileURL: uploadedUrl, storageMessageId, addedBy: interaction.user.id });
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("✅ sᴏᴜɴᴅ ᴀᴅᴅᴇᴅ")).setDescription(sc(`**${name}** added`)).setTimestamp()] });
          }

          if (sub === "play") {
            const name  = interaction.options.getString("name");
            const sound = await Sound.findOne({ guildId, name }).lean();
            if (!sound) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.ERROR).setTitle(sc("❌ ɴᴏᴛ ғᴏᴜɴᴅ")).setDescription(sc("sound not found")).setTimestamp()], flags: 64 });
            const res = await sbConnectToMember(interaction.member);
            if (res?.error) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(sc("🎧 ᴊᴏɪɴ ᴀ ᴠᴄ")).setDescription(sc("join a voice channel first")).setTimestamp()], flags: 64 });
            const isIdle = !q.now;
            q.list.push({ _id: sound._id, name: sound.name, fileURL: sound.fileURL, storageMessageId: sound.storageMessageId });
            if (isIdle) {
              await sbPlayNext(guild, interaction.channel);
              return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("▶️ ɴᴏᴡ ᴘʟᴀʏɪɴɢ")).setDescription(sc(`**${sound.name}**`)).setTimestamp()] });
            }
            sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(sc("🎶 ǫᴜᴇᴜᴇᴅ")).setDescription(sc(`**${sound.name}** at position #${q.list.length}`)).setTimestamp()] });
          }

          if (sub === "volume") {
            const level = interaction.options.getInteger("level");
            q.volume = level / 100;
            if (q.resource?.volume) q.resource.volume.setVolume(q.volume);
            sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("🔊 ᴠᴏʟᴜᴍᴇ sᴇᴛ")).setDescription(sc(`Volume: **${level}%**`)).setTimestamp()], flags: 64 });
          }

          if (sub === "top") {
            const docs = await Sound.find({ guildId }).select("name playCount").sort({ playCount: -1 }).limit(10).lean();
            if (!docs.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(sc("📜 ᴇᴍᴘᴛʏ")).setDescription(sc("no sounds played yet")).setTimestamp()], flags: 64 });
            const text = docs.map((s, i) => `${"🥇🥈🥉"[i] ?? `\`#${i+1}\``} **${s.name}** — ${s.playCount} plays`).join("\n");
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("🏆 ᴍᴏsᴛ ᴘᴏᴘᴜʟᴀʀ sᴏᴜɴᴅs")).setDescription(sc(text)).setTimestamp()], flags: 64 });
          }

          if (sub === "delete") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ embeds: [makeEmbed({ title: sc("❌ ᴘᴇʀᴍɪssɪᴏɴ"), description: sc("admins only"), color: EmbedColors.ERROR, guild })], flags: 64 });
            const name = interaction.options.getString("name");
            const doc  = await Sound.findOne({ guildId, name });
            if (!doc) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.ERROR).setTitle(sc("❌ ɴᴏᴛ ғᴏᴜɴᴅ")).setDescription(sc("sound not found")).setTimestamp()], flags: 64 });
            if (doc.storageMessageId) {
              const storageCh = guild.channels.cache.find(c => c.name === "soundboard-storage");
              if (storageCh) {
                const msg = await storageCh.messages.fetch(doc.storageMessageId).catch(() => null);
                if (msg) await msg.delete().catch(() => {});
              }
            }
            await doc.deleteOne();
            sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("🗑 sᴏᴜɴᴅ ʀᴇᴍᴏᴠᴇᴅ")).setDescription(sc(`**${name}** removed`)).setTimestamp()] });
          }

          if (sub === "list") {
            const docs = await Sound.find({ guildId }).select("name playCount").sort({ name: 1 }).lean();
            if (!docs.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(sc("📜 ᴇᴍᴘᴛʏ")).setDescription(sc("no sounds added")).setTimestamp()], flags: 64 });
            const text = docs.slice(0, 40).map((s, i) => `\`${i+1}.\` **${s.name}** (${s.playCount} plays)`).join("\n");
            const more = docs.length > 40 ? `\n…and ${docs.length - 40} more` : "";
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(sc("📜 sᴏᴜɴᴅ ʟɪsᴛ")).setDescription(sc(text + more)).setFooter({ text: sc(`${docs.length} sᴏᴜɴᴅs`) }).setTimestamp()], flags: 64 });
          }

          if (sub === "panel") {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ embeds: [makeEmbed({ title: sc("❌ ᴘᴇʀᴍɪssɪᴏɴ"), description: sc("admins only"), color: EmbedColors.ERROR, guild })], flags: 64 });
            const ui  = await buildSoundPanelEmbed(guild);
            const msg = await interaction.reply({ embeds: [ui.embed], components: ui.buttons, withResponse: true });
            sbPanels.set(guildId, { messageId: msg.id, channelId: msg.channelId });
            return;
          }

          if (sub === "skip") {
            if (!q.now) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(sc("⚠️ ɴᴏᴛ ᴘʟᴀʏɪɴɢ")).setDescription(sc("nothing is currently playing")).setTimestamp()], flags: 64 });
            try { q.player.stop(); } catch (_) {}
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("⏭️ sᴋɪᴘᴘᴇᴅ")).setDescription(sc(`skipped **${q.now.name}**`)).setTimestamp()] });
            sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return;
          }

          if (sub === "stop") {
            q.list = []; q.now = null;
            if (q.currentFile) { fsp.unlink(q.currentFile).catch(() => {}); q.currentFile = null; }
            if (q.prefetchFile) { fsp.unlink(q.prefetchFile).catch(() => {}); q.prefetchFile = null; q.prefetchTrack = null; }
            try { q.player.stop(true); } catch (_) {}
            const conn = getVoiceConnection(guildId);
            if (conn) conn.destroy();
            q.vcId = null;
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("⛔ sᴛᴏᴘᴘᴇᴅ")).setDescription(sc("playback stopped and queue cleared")).setTimestamp()] });
            sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return;
          }

          if (sub === "queue") {
            const now = q.now ? `**${q.now.name}**` : "—";
            const lines = q.list.slice(0, 15).map((s, idx) => `\`${idx+1}.\` **${s.name}**`).join("\n") || "queue is empty";
            const more = q.list.length > 15 ? `\n…and ${q.list.length - 15} more` : "";
            const embed = new EmbedBuilder().setColor(EmbedColors.INFO)
              .setTitle(sc("📜 sᴏᴜɴᴅ ǫᴜᴇᴜᴇ"))
              .setDescription(`${sc("▶️ **Now Playing:**")} ${now}\n\n${sc("⏳ **Up Next:**")}\n${lines}${more}`)
              .setFooter({ text: `${q.list.length} sounds in queue` })
              .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
          }

          if (sub === "shuffle") {
            if (q.list.length < 2) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(sc("⚠️ ɴᴏᴛ ᴇɴᴏᴜɢʜ sᴏᴜɴᴅs")).setDescription(sc("need at least 2 sounds to shuffle")).setTimestamp()], flags: 64 });
            for (let i = q.list.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [q.list[i], q.list[j]] = [q.list[j], q.list[i]];
            }
            sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.SUCCESS).setTitle(sc("🔀 sʜᴜꜰꜰʟᴇᴅ")).setDescription(sc(`shuffled **${q.list.length}** sounds`)).setTimestamp()] });
          }

          if (sub === "search") {
            const query = interaction.options.getString("query").toLowerCase();
            const docs  = await Sound.find({ guildId, name: { $regex: query, $options: "i" } }).limit(10).lean();
            if (!docs.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(sc("❌ ɴᴏ ʀᴇsᴜʟᴛs")).setDescription(sc("no sounds match your search")).setTimestamp()], flags: 64 });
            const text = docs.map((s, i) => `\`${i+1}.\` **${s.name}** (${s.playCount} plays)`).join("\n");
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(sc("🔍 sᴇᴀʀᴄʜ ʀᴇsᴜʟᴛs")).setDescription(sc(text)).setTimestamp()], flags: 64 });
          }

          return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.INFO).setTitle(sc("sound — usage")).setDescription(sc("/sound add|play|delete|list|panel|volume|top|skip|stop|queue|shuffle|search")).setTimestamp()], flags: 64 });
        }
      }
    }

    // ── Button Interactions ─────────────────────────────────────
    if (interaction.isButton()) {
      const { guild, guildId, member, customId } = interaction;
      if (!guild) return;

      try {
                // ── /inv notify button ────────────────────────────────────────────
        if (customId.startsWith("inv_notify_")) {
          const parts          = customId.split("_");
          const targetMemberId = parts[2];
          const vcId           = parts[3];

          // Resolve target from cache first; only fetch if not cached
          const targetMember = guild.members.cache.get(targetMemberId)
                            ?? await guild.members.fetch(targetMemberId).catch(() => null);
          // Resolve VC from cache
          const vc = guild.channels.cache.get(vcId);

          if (!targetMember) {
            return interaction.reply({ content: "❌ That user is no longer in this server.", flags: 64 });
          }
          if (!vc) {
            return interaction.reply({ content: "❌ That voice channel no longer exists.", flags: 64 });
          }

          // ── Validate invoker is still in the right VC ───────────────────
          const invokerVCNow = member.voice?.channel;
          if (!invokerVCNow || invokerVCNow.id !== vcId) {
            return interaction.reply({
              content: `⚠️ You're no longer in **${vc.name}**. Rejoin the channel and try again.`,
              flags: 64
            });
          }

          // ── Build the jump link ─────────────────────────────────────────
          const vcJumpLink = `https://discord.com/channels/${guild.id}/${vc.id}`;

          // ── DM embed: Make it feel like an exclusive invite ──────────────
          const dmEmbed = new EmbedBuilder()
            .setColor(EmbedColors.SUCCESS)
            .setAuthor({
              name: sc("✨ ʏᴏᴜ'ᴠᴇ ʙᴇᴇɴ ɪɴᴠɪᴛᴇᴅ!"),
              iconURL: member.user.displayAvatarURL({ dynamic: true })
            })
            .setDescription(
              `Hey <@${targetMember.id}>, **${member.displayName}** is calling you to join the vibes! 🎧\n\n` +
              `> ${sc("📍 ᴄʜᴀɴɴᴇʟ:")} **${vc.name}**\n` +
              `> ${sc("🌐 sᴇʀᴠᴇʀ:")} **${guild.name}**\n\n` +
              `*Tap the button below to jump straight into the action.* 🚀`
            )
            .setThumbnail(guild.iconURL({ dynamic: true }) ?? undefined)
            .setFooter({ text: sc("we're waiting for you...") })
            .setTimestamp();

          const joinRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel("🚀 Jump In")
              .setStyle(ButtonStyle.Link)
              .setURL(vcJumpLink)
          );

          // ── Attempt DM ─────────────────────────────────────────────────
          const dmSent = await targetMember.send({
            embeds:     [dmEmbed],
            components: [joinRow]
          }).then(() => true).catch(() => false);

          if (dmSent) {
            return interaction.reply({
              content: `✅ ${sc("ɪɴᴠɪᴛᴇ ᴅᴇʟɪᴠᴇʀᴇᴅ:")} **${targetMember.displayName}** has been summoned to your VC!`,
              flags: 64
            });
          }

          // ── DM failed: Sleek channel fallback mention ───────────────────
          const fallbackCh =
            invokerVCNow?.parent?.children?.cache?.find(c => c.isTextBased() && c.id !== vc.id) ??
            interaction.channel;

          if (fallbackCh?.isTextBased()) {
            const channelEmbed = new EmbedBuilder()
              .setColor(EmbedColors.VC_JOIN)
              .setAuthor({
                name: sc("✨ ᴠᴄ ɪɴᴠɪᴛᴇ"),
                iconURL: member.user.displayAvatarURL({ dynamic: true })
              })
              .setDescription(
                `Hey ${targetMember}! **${member.displayName}** wants you in **${vc.name}**.\n\n` +
                `> *Don't leave them hanging — tap below to join the vibes!* 🎧`
              )
              .setFooter({ text: sc(guild.name) })
              .setTimestamp();

            await fallbackCh.send({
              content: `${targetMember}`,
              embeds:  [channelEmbed],
              components: [joinRow]
            }).catch(() => {});

            return interaction.reply({
              content: `📣 ${sc("ᴅᴍs ᴄʟᴏsᴇᴅ:")} Tagged **${targetMember.displayName}** in the channel instead.`,
              flags: 64
            });
          }

          return interaction.reply({
            content: `⚠️ ${sc("ᴍɪssɪᴏɴ ғᴀɪʟᴇᴅ:")} Couldn't reach **${targetMember.displayName}** (DMs closed, no fallback channel).`,
            flags: 64
          });
        }

        // ── Soundboard buttons ────────────────────────────
        if (customId.startsWith("sb_")) {
          if (!await checkAdmin(interaction)) return;
          const q = getSbQueue(guildId);

          if (customId === "sb_refresh") { await sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {}); return interaction.deferUpdate(); }

          if (customId === "sb_connect") {
            const res = await sbConnectToMember(member);
            if (res?.error) return interaction.reply({ embeds: [new EmbedBuilder().setColor(EmbedColors.WARNING).setTitle(sc("🎧 join a vc first")).setDescription(sc("You need to be in a voice channel.")).setTimestamp()], flags: 64 });
            q.vcId = res.channel.id;
            if (q.timeout) { clearTimeout(q.timeout); q.timeout = null; }
            await sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return interaction.deferUpdate();
          }

          if (customId === "sb_skip")  { try { q.player.stop(); } catch (_) {} await sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {}); return interaction.deferUpdate(); }
          if (customId === "sb_stop")  {
            q.list = []; q.now = null;
            if (q.currentFile) { fsp.unlink(q.currentFile).catch(() => {}); q.currentFile = null; }
            try { q.player.stop(true); } catch (_) {}
            const conn = getVoiceConnection(guildId);
            if (conn) conn.destroy();
            q.vcId = null;
            await sbUpdatePanel(guild); sbPrefetchNext(guild).catch(() => {});
            return interaction.deferUpdate();
          }
          return interaction.deferUpdate();
        }

        // ── Settings panel buttons ────────────────────────
        if (!await checkAdmin(interaction)) return;
        let settings = await getGuildSettings(guildId);
        if (!settings) return interaction.reply({ content: "❌ Settings not found.", flags: 64 });

        let didChange = false;
        switch (customId) {
          case "toggleLeaveAlerts":    settings.leaveAlerts           = !settings.leaveAlerts;           didChange = true; break;
          case "toggleJoinAlerts":     settings.joinAlerts            = !settings.joinAlerts;            didChange = true; break;
          case "toggleOnlineAlerts":   settings.onlineAlerts          = !settings.onlineAlerts;          didChange = true; break;
          case "togglePrivateThreads": settings.privateThreadAlerts   = !settings.privateThreadAlerts;   didChange = true; break;
          case "toggleAutoDelete":     settings.autoDelete            = !settings.autoDelete;            didChange = true; break;
          case "toggleIgnoreRole":     settings.ignoreRoleEnabled     = !settings.ignoreRoleEnabled;     didChange = true; break;
          case "resetSettings": {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("confirmReset").setLabel("✅ Yes, Reset").setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId("cancelReset").setLabel("❌ No, Cancel").setStyle(ButtonStyle.Secondary)
            );
            return interaction.update({ embeds: [makeEmbed({ title: sc("⚠️ Confirm Reset"), description: sc("Reset all VC alert settings?"), color: EmbedColors.WARNING, guild })], components: [row] });
          }
          case "confirmReset": {
            await GuildSettings.deleteOne({ guildId });
            guildSettingsCache.delete(guildId);
            settings = await getGuildSettings(guildId);
            const panel = buildControlPanel(settings, guild);
            await interaction.update({ embeds: [panel.embed], components: panel.buttons });
            return interaction.followUp({ content: sc("🎉 Settings Reset!"), flags: 64 });
          }
          case "cancelReset": break;
          default: return;
        }

        if (didChange) {
          guildSettingsCache.delete(guildId);
          guildSettingsCache.set(guildId, settings);
          // Atomic $set — only changed fields
          GuildSettings.updateOne({ guildId }, {
            $set: {
              leaveAlerts: settings.leaveAlerts, joinAlerts: settings.joinAlerts,
              onlineAlerts: settings.onlineAlerts, privateThreadAlerts: settings.privateThreadAlerts,
              autoDelete: settings.autoDelete, ignoreRoleEnabled: settings.ignoreRoleEnabled
            }
          }).catch(e => console.error(`[Button DB] ${guildId}:`, e));
        }

        const updated = buildControlPanel(settings, guild);
        return interaction.update({ embeds: [updated.embed], components: updated.buttons });

      } catch (err) {
        console.error("[Button Error]", err);
        if (!interaction.replied && !interaction.deferred)
          return interaction.reply({ content: "❌ An error occurred.", flags: 64 });
      }
    }

    // ── Autocomplete ────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const focused = (interaction.options.getFocused() ?? "").toString().toLowerCase();

      if (interaction.commandName === "inv") {
        // Autocomplete: search cached members only — never fetches guild.members
        // VC-aware: prefer members who can access the invoker's current VC
        const invokerVC = interaction.member?.voice?.channel ?? null;

        const q = focused.toLowerCase();
        let pool = [...guild.members.cache.values()].filter(m => {
          if (m.user.bot || m.id === interaction.user.id) return false;
          if (!q) return true; // empty query: show all valid candidates
          return (
            m.user.username.toLowerCase().includes(q) ||
            (m.nickname ?? "").toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q)
          );
        });

        // Prefer members who can access the invoker's VC (sort to top, don't exclude)
        if (invokerVC) {
          pool.sort((a, b) => {
            const aAccess = canInviteToVC(a, invokerVC);
            const bAccess = canInviteToVC(b, invokerVC);
            if (aAccess && !bAccess) return -1;
            if (!aAccess && bAccess) return  1;
            return 0;
          });
        }

        pool = pool.slice(0, 25);

        return interaction.respond(
          pool.length
            ? pool.map(m => {
                const inVC  = m.voice?.channelId === invokerVC?.id;
                const badge = inVC ? " [already inside]" : "";
                return { name: `${m.displayName} (@${m.user.username})${badge}`, value: m.user.username };
              })
            : [{ name: "No users found", value: focused || " " }]
        );
      }

      if (interaction.commandName === "sound") {
        const sub    = interaction.options.getSubcommand();
        const sounds = await Sound.find({ guildId }).select("name").limit(100).lean().catch(() => []);
        const names  = sounds.map(s => s.name);
        if (sub === "add") {
          const existing = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
          return interaction.respond(existing.length ? existing.map(n => ({ name: sc("⚠ " + n + " (exists)"), value: n })) : [{ name: sc("✅ new name"), value: focused || "" }]);
        }
        const matches = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        return interaction.respond(matches.length ? matches.map(n => ({ name: sc("🎵 " + n), value: n })) : [{ name: sc("ɴᴏ ʀᴇsᴜʟᴛs"), value: "" }]);
      }
    }

  } catch (err) {
    console.error("[InteractionCreate]", err?.stack ?? err?.message ?? err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: sc("An error occurred. Please try again."), flags: 64 }); } catch (_) {}
  }
});

// ─── Voice Channel Alert System ───────────────────────────────
// IMPORTANT: store only threadId strings — never full thread objects.
// Full thread objects pin Discord.js internals in memory and prevent GC.
const activeVCThreads     = new Map();  // vcId → threadId (string)
const threadDeletion      = new Map();  // vcId → timeoutId
const threadLastActivity  = new Map();  // vcId → timestamp (ms)
const vcLocks             = new Map();  // vcId → Promise (mutex)

const THREAD_INACTIVITY   = 5 * 60_000;   // 5 min
const THREAD_CHECK_MS     = 30_000;        // 30 s

// Periodic inactivity check — fetches thread object only when it must delete it,
// keeping the long-lived Map free of Discord.js object references.
const threadCleanupInterval = setInterval(async () => {
  const now = Date.now();
  for (const [vcId, last] of threadLastActivity.entries()) {
    if (now - last >= THREAD_INACTIVITY) {
      const threadId = activeVCThreads.get(vcId);
      if (threadId) {
        // Fetch the thread object on-demand only for deletion
        for (const guild of client.guilds.cache.values()) {
          const ch = guild.channels.cache.find(c => c.isThread?.() && c.id === threadId)
                  ?? await guild.channels.fetch(threadId).catch(() => null);
          if (ch) { ch.delete().catch(() => {}); break; }
        }
      }
      activeVCThreads.delete(vcId);
      threadLastActivity.delete(vcId);
      const t = threadDeletion.get(vcId);
      if (t) clearTimeout(t);
      threadDeletion.delete(vcId);
    }
  }
}, THREAD_CHECK_MS);
threadCleanupInterval.unref();

function withVCLock(vcId, fn) {
  const prev = vcLocks.get(vcId) ?? Promise.resolve();
  const next = prev.then(() => fn()).finally(() => { if (vcLocks.get(vcId) === next) vcLocks.delete(vcId); });
  vcLocks.set(vcId, next);
  return next;
}

async function fetchTextChannel(guild, channelId) {
  const cached = guild.channels.cache.get(channelId);
  if (cached?.isTextBased()) return cached;
  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.isTextBased() ? fetched : null;
}

client.on("channelDelete", channel => {
  // Clean up thread tracking by vcId or by threadId match
  const t = threadDeletion.get(channel.id);
  if (t) { clearTimeout(t); threadDeletion.delete(channel.id); }
  activeVCThreads.delete(channel.id);
  threadLastActivity.delete(channel.id);
  // Also remove any entry where the stored threadId matches the deleted channel
  for (const [vcId, threadId] of activeVCThreads.entries()) {
    if (threadId === channel.id) {
      activeVCThreads.delete(vcId);
      threadLastActivity.delete(vcId);
      const t2 = threadDeletion.get(vcId);
      if (t2) { clearTimeout(t2); threadDeletion.delete(vcId); }
    }
  }
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
        .setAuthor({ name: `${user.username} just popped in! 🔊`, iconURL: avatar })
        .setDescription(`🎧 **${user.username}** joined **${vc.name}** — let the vibes begin!`)
        .setFooter({ text: "🎉 welcome to the voice party!", iconURL: botAvatar })
        .setTimestamp();
    } else {
      addLog("leave", user.tag, vc.name, guild);
      embed = new EmbedBuilder().setColor(EmbedColors.VC_LEAVE)
        .setAuthor({ name: `${user.username} dipped out! 🏃`, iconURL: avatar })
        .setDescription(`👋 **${user.username}** left **${vc.name}** — see ya next time!`)
        .setFooter({ text: "💨 gone but not forgotten.", iconURL: botAvatar })
        .setTimestamp();
    }

    await withVCLock(vc.id, async () => {
      const everyonePerms = vc.permissionsFor(guild.roles.everyone);
      const isPrivateVC   = everyonePerms && !everyonePerms.has(PermissionsBitField.Flags.ViewChannel);

      if (isPrivateVC && settings.privateThreadAlerts) {
        // Retrieve existing thread by stored ID — never store the object itself
        const existingThreadId = activeVCThreads.get(vc.id);
        let thread = null;
        if (existingThreadId) {
          thread = logChannel.threads.cache.get(existingThreadId)
                ?? await logChannel.threads.fetch(existingThreadId).catch(() => null);
          if (thread?.archived) thread = null; // treat archived threads as gone
        }

        if (!thread) {
          const shortName = vc.name.length > 80 ? vc.name.slice(0, 80) + "…" : vc.name;
          try {
            thread = await logChannel.threads.create({
              name: `🔊 ${shortName}`,
              type: ChannelType.PrivateThread,
              autoArchiveDuration: 1440,
              reason: `VC alert thread for ${vc.name}`
            });
            // Store only the thread ID — let Discord.js GC the full object
            activeVCThreads.set(vc.id, thread.id);
          } catch (err) { console.warn("[VC Thread] create failed:", err.message); return; }
        } else {
          // Update stored ID in case it changed after fetch
          activeVCThreads.set(vc.id, thread.id);
        }

        threadLastActivity.set(vc.id, Date.now());
        // Per-thread deletion timer (safety net on top of the interval)
        if (threadDeletion.has(vc.id)) clearTimeout(threadDeletion.get(vc.id));
        const t = setTimeout(async () => {
          const tid = activeVCThreads.get(vc.id);
          if (tid) {
            const th = logChannel.threads.cache.get(tid)
                    ?? await logChannel.threads.fetch(tid).catch(() => null);
            if (th) th.delete().catch(() => {});
          }
          activeVCThreads.delete(vc.id);
          threadDeletion.delete(vc.id);
          threadLastActivity.delete(vc.id);
        }, THREAD_INACTIVITY);
        t.unref();
        threadDeletion.set(vc.id, t);

        // Add only currently-cached members with VC view permission
        // Never calls guild.members.fetch() — uses only what is already in cache
        const memberIds = [...guild.members.cache.values()]
          .filter(m => !m.user.bot && vc.permissionsFor(m)?.has(PermissionsBitField.Flags.ViewChannel))
          .map(m => m.id);
        for (let i = 0; i < memberIds.length; i += 20) {
          await Promise.all(memberIds.slice(i, i + 20).map(id => thread.members.add(id).catch(() => {})));
          if (i + 20 < memberIds.length) await new Promise(r => setTimeout(r, 100));
        }
        const msg = await thread.send({ embeds: [embed] }).catch(() => null);
        if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref();
      } else {
        const msg = await logChannel.send({ embeds: [embed] }).catch(e => { console.warn("[VC Alert] send failed:", e?.message); return null; });
        if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref();
      }
    });
  } catch (err) { console.error("[voiceStateUpdate]", err); }
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
    addLog("online", member.user.tag, "-", member.guild);
    const embed = new EmbedBuilder().setColor(EmbedColors.ONLINE)
      .setAuthor({ name: `${member.user.username} just came online! 🟢`, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
      .setDescription(`👀 **${member.user.username}** is now online — something's cooking!`)
      .setFooter({ text: "✨ Ready to vibe!", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    const msg = await channel.send({ embeds: [embed] }).catch(e => { console.warn(`[Online Alert] failed for ${member.user.username}:`, e?.message); return null; });
    if (msg && settings.autoDelete) setTimeout(() => msg.delete().catch(() => {}), 30_000).unref();
  } catch (e) { console.error("[presenceUpdate]", e?.stack ?? e?.message ?? e); }
});

// ─── Gateway Event Handlers ───────────────────────────────────
client.on("warn",           info  => console.warn("[Discord Warn]", info));
client.on("error",          error => console.error("[Discord Error]", error));
client.on("shardError",     error => console.error("[Shard Error]", error));
client.on("shardReconnecting", id => { console.log(`🔄 Shard ${id} reconnecting…`); lastHeartbeat = Date.now(); });
client.on("shardResume",    (id, replayed) => { console.log(`✅ Shard ${id} resumed (${replayed} events)`); lastHeartbeat = Date.now(); reconnectAttempts = 0; });
client.on("shardDisconnect",(ev, id) => console.warn(`⚠️ Shard ${id} disconnected (${ev.code})`));
client.ws.on("HEARTBEAT",   () => { lastHeartbeat = Date.now(); });

// ─── MongoDB with retry ───────────────────────────────────────
let mongoRetries = 0;
async function connectMongoDB() {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "Discord-Alert-Bot",
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      maxPoolSize: 10,
      minPoolSize: 2,
      retryWrites: true,
      retryReads: true
    });
    console.log("✅ MongoDB connected");
    mongoRetries = 0;
  } catch (e) {
    console.error("❌ MongoDB error:", e?.message ?? e);
    if (mongoRetries < 5) {
      mongoRetries++;
      console.log(`🔄 Retry ${mongoRetries}/5 in 5 s…`);
      await new Promise(r => setTimeout(r, 5_000));
      return connectMongoDB();
    }
    console.error("❌ MongoDB failed after 5 retries. Exiting.");
    process.exit(1);
  }
}
mongoose.connection.on("error",        err  => console.error("[MongoDB]", err));
mongoose.connection.on("disconnected",  ()   => { console.warn("⚠️ MongoDB disconnected, reconnecting…"); connectMongoDB(); });
mongoose.connection.on("reconnected",   ()   => console.log("✅ MongoDB reconnected"));

// ─── Graceful shutdown ────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[Shutdown] ${signal}`);
  // Flush pending DB saves
  if (pendingSaveTimer) { clearTimeout(pendingSaveTimer); pendingSaveTimer = null; }
  if (pendingSaveQueue.size > 0) {
    const entries = [...pendingSaveQueue.entries()];
    pendingSaveQueue.clear();
    await Promise.all(entries.map(([gid, s]) =>
      GuildSettings.findOneAndUpdate({ guildId: gid }, s, { upsert: true, setDefaultsOnInsert: true })
        .exec().catch(e => console.error(`[Shutdown DB] ${gid}:`, e?.message ?? e))
    ));
  }
  // Clean temp dir
  const files = await fsp.readdir(TEMP_DIR).catch(() => []);
  await Promise.all(files.map(f => fsp.unlink(path.join(TEMP_DIR, f)).catch(() => {})));
  // Clear timers
  for (const t of threadDeletion.values()) clearTimeout(t);
  threadDeletion.clear(); activeVCThreads.clear(); threadLastActivity.clear();
  await mongoose.disconnect().catch(() => {});
  try { await client.destroy(); } catch (_) {}
  console.log("[Shutdown] Done.");
  process.exit(0);
}
process.on("SIGINT",              () => shutdown("SIGINT"));
process.on("SIGTERM",             () => shutdown("SIGTERM"));
process.on("uncaughtException",   err => { console.error("[uncaughtException]", err); shutdown("uncaughtException"); });
process.on("unhandledRejection",  reason => console.error("[unhandledRejection]", reason));

// ─── Start ────────────────────────────────────────────────────
(async () => {
  await connectMongoDB();
  if (!process.env.TOKEN) { console.error("❌ TOKEN not set"); process.exit(1); }
  console.log("🔐 Logging in to Discord…");
  await client.login(process.env.TOKEN).catch(err => { console.error("❌ Discord login failed:", err); process.exit(1); });
})();
