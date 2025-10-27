const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
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

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const LOG_FILE_PATH = path.join(__dirname, "vc_logs.txt");
const MAX_RECENT_LOGS = 5000; // cap to avoid memory blow-ups
const LOG_ROTATE_SIZE_BYTES = 5 * 1024 * 1024; // rotate at ~5MB
const THREAD_INACTIVITY_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const RECENT_LOG_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- Simple web server ----------
const app = express();
app.get("/", (_, res) => res.status(200).json({ status: "✅ Bot is alive and vibing!" }));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// ---------- MongoDB schema & model ----------
const guildSettingsSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    alertsEnabled: { type: Boolean, default: false },
    textChannelId: { type: String, default: null },
    joinAlerts: { type: Boolean, default: true },
    leaveAlerts: { type: Boolean, default: true },
    onlineAlerts: { type: Boolean, default: true },
    privateThreadAlerts: { type: Boolean, default: true },
    autoDelete: { type: Boolean, default: true }, // Auto-delete individual messages (30s)
    ignoredRoleId: { type: String, default: null },
    ignoreRoleEnabled: { type: Boolean, default: false }
}, { timestamps: true });

const GuildSettings = mongoose.model("guildsettings", guildSettingsSchema);

// ---------- In-memory cache ----------
const guildSettingsCache = new Map();

// Debounced cache flush queue to reduce DB writes for frequent toggles
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
                // Use findOneAndUpdate with upsert to keep DB consistent
                await GuildSettings.findOneAndUpdate(
                    { guildId },
                    settings,
                    { upsert: true, setDefaultsOnInsert: true }
                ).exec();
            } catch (e) {
                console.error(`[DB SAVE] Failed to save settings for ${guildId}:`, e.message);
            }
        }));
    }, 700); // batch writes within 700ms window
}

// ---------- Utilities ----------
function toISTString(timestamp) {
    return new Date(timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const sec = Math.floor(diff / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}h ${min % 60}m ago`;
    if (min > 0) return `${min}m ${sec % 60}s ago`;
    return `${sec}s ago`;
}

async function safeAppendLogLine(line) {
    try {
        // rotate file if needed
        try {
            const stats = await fsp.stat(LOG_FILE_PATH).catch(() => null);
            if (stats && stats.size >= LOG_ROTATE_SIZE_BYTES) {
                const rotated = `${LOG_FILE_PATH}.${Date.now()}`;
                await fsp.rename(LOG_FILE_PATH, rotated).catch(() => {});
            }
        } catch (e) {
            // ignore rotation failures
        }
        await fsp.appendFile(LOG_FILE_PATH, line, { encoding: 'utf8' });
    } catch (err) {
        console.error("[LOG WRITE] Failed to write log:", err.message);
    }
}

// ---------- Logging memory store (recent 24h) ----------
let recentLogs = [];

function trimRecentLogs() {
    const cutoff = Date.now() - RECENT_LOG_RETENTION_MS;
    recentLogs = recentLogs.filter(l => l.time >= cutoff);
    if (recentLogs.length > MAX_RECENT_LOGS) {
        recentLogs = recentLogs.slice(-MAX_RECENT_LOGS);
    }
}

function addLog(type, user, channel = "-", guildName = "-") {
    const entry = { type, user, channel, guild: guildName, time: Date.now() };
    recentLogs.push(entry);
    // Keep recent logs trimmed
    trimRecentLogs();

    // Async append to file; keep same text format exactly as original
    const line = `[${toISTString(entry.time)}] (${guildName}) ${type.toUpperCase()} - ${user} in ${channel}\n`;
    safeAppendLogLine(line);
}

// ---------- MongoDB connection ----------
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.error("❌ MongoDB error:", err.message));


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

// ---------- Embed colors ----------
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

// ---------- Helpers for settings (cache-first) ----------
async function getGuildSettings(guildId) {
    // Try cache
    const cached = guildSettingsCache.get(guildId);
    if (cached) return cached;

    // Try DB
    let settings = await GuildSettings.findOne({ guildId }).lean().exec().catch(() => null);
    if (!settings) {
        // create default object (do not save immediately; save when update happens)
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
        // Save default to DB now (to preserve behavior of original)
        try {
            await new GuildSettings(settings).save();
        } catch (e) {
            // ignore duplicate or other save errors
            if (e.code !== 11000) console.error(`[DB] Failed to save default settings for ${guildId}:`, e.message);
        }
    }
    // Put mutable copy into cache (use plain object to avoid Mongoose documents)
    guildSettingsCache.set(guildId, settings);
    return settings;
}

// Update cache and schedule DB save (debounced)
async function updateGuildSettings(settings) {
    if (!settings || !settings.guildId) return;
    // Put into cache
    guildSettingsCache.set(settings.guildId, settings);
    // Queue to save (debounced)
    pendingSaveQueue.set(settings.guildId, settings);
    schedulePendingSaves();
}

// ---------- Control panel builder (preserve exact text) ----------
const buildControlPanel = (settings, guild) => {
    const embed = new EmbedBuilder()
        .setColor(settings.alertsEnabled ? EmbedColors.SUCCESS : EmbedColors.ERROR)
        .setAuthor({
            name: "🎛️ VC Alert Control Panel",
            iconURL: client.user.displayAvatarURL()
        })
        .setDescription(
            `**Your Central Hub for Voice Chat Alerts!** ✨\n\n` +
            `> 📢 **Alerts Channel:** ${settings.textChannelId ? `<#${settings.textChannelId}>` : "Not set — *assign one below!*"}\n` +
            `> 🔔 **Status:** ${settings.alertsEnabled ? "🟢 **Active!** (All systems go)" : "🔴 **Disabled** (Peace & quiet)"}\n` +
            `> 👋 **Join Alerts:** ${settings.joinAlerts ? "✅ On" : "❌ Off"}\n` +
            `> 🏃‍♂️ **Leave Alerts:** ${settings.leaveAlerts ? "✅ On" : "❌ Off"}\n` +
            `> 🟢 **Online Alerts:** ${settings.onlineAlerts ? "✅ On" : "❌ Off"}\n` +
            `> 🪪 **Private Alerts:** ${settings.privateThreadAlerts ? "✅ On" : "❌ Off"}\n` +
            `> 🙈 **Ignored Role:** ${settings.ignoredRoleId ? `<@&${settings.ignoredRoleId}> (${settings.ignoreRoleEnabled ? "✅ Active" : "❌ Inactive"})` : "None set"}\n` +
            `> 🧹 **Auto-Delete:** ${settings.autoDelete ? "✅ On (30s)" : "❌ Off"}\n\n` +
            `*Use the buttons below to fine-tune your settings instantly!* ⚙️`
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
            .setCustomId('togglePrivateThreads')
            .setLabel('🪪 Private Alerts')
            .setStyle(settings.privateThreadAlerts ? ButtonStyle.Success : ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('toggleIgnoreRole')
            .setLabel('🙈 Ignore Alerts')
            .setStyle(settings.ignoreRoleEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('toggleAutoDelete')
            .setLabel('🧹 Auto-Delete')
            .setStyle(settings.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('resetSettings')
            .setLabel('♻️ Reset Settings')
            .setStyle(ButtonStyle.Danger),
    );

    return { embed, buttons: [row1, row2] };
};

function buildEmbedReply(title, description, color, guild) {
    return new EmbedBuilder()
        .setColor(color || EmbedColors.INFO)
        .setAuthor({ name: title, iconURL: client.user.displayAvatarURL() })
        .setDescription(description)
        .setFooter({
            text: "VC Alert Control Panel",
            iconURL: guild.iconURL({ dynamic: true }) || client.user.displayAvatarURL()
        })
        .setTimestamp();
}

// ---------- Commands registration ----------
const commands = [
    new SlashCommandBuilder()
        .setName("settings")
        .setDescription("📡 View and control VC/online alerts."),
    new SlashCommandBuilder()
        .setName("activate")
        .setDescription("🚀 Enable voice join/leave alerts.")
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Channel for VC alerts")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName("deactivate")
        .setDescription("🛑 Disable all alerts."),
    new SlashCommandBuilder()
        .setName("setignorerole")
        .setDescription("🙈 Set a role to be ignored from VC/online alerts")
        .addRoleOption(option =>
            option.setName("role")
                .setDescription("The role to ignore from alerts")
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName("resetignorerole")
        .setDescription("♻️ Reset the ignored role"),
    new SlashCommandBuilder()
        .setName("logs")
        .setDescription("📜 View the last 24 hours of activity logs.")
].map(cmd => cmd.toJSON());


// ---------- Ready & register commands ----------
client.once("ready", async () => {
    console.log(`🤖 Logged in as ${client.user.tag}`);

    try {
        client.user.setActivity("the VC vibes unfold 🎧✨", { type: "WATCHING" });
    } catch (e) { /* ignore activity errors */ }

    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("✅ Slash commands registered.");
    } catch (err) {
        console.error("❌ Command registration error:", err);
    }
});

// ---------- Button & command interaction handler ----------
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (!interaction.inGuild()) return;

        const guild = interaction.guild;
        const guildId = guild.id;

        let settings = await getGuildSettings(guildId);

        if (interaction.isChatInputCommand()) {
            if (!await checkAdmin(interaction)) return;

            if (interaction.commandName === "settings") {
                const panel = buildControlPanel(settings, guild);
                return interaction.reply({ embeds: [panel.embed], components: panel.buttons, ephemeral: true });
            }

            if (interaction.commandName === "activate") {
                const selectedChannel = interaction.options.getChannel("channel");
                let channel = null;

                if (selectedChannel) {
                    channel = selectedChannel;
                } else if (settings.textChannelId) {
                    channel = guild.channels.cache.get(settings.textChannelId);
                    if (!channel) {
                        channel = await guild.channels.fetch(settings.textChannelId).catch(() => null);
                    }
                } else {
                    channel = interaction.channel;
                }

                if (!channel || channel.type !== ChannelType.GuildText) {
                    return interaction.reply({
                        embeds: [buildEmbedReply(
                            "❌ Channel Missing",
                            `Hmm... I couldn't find a valid text channel to send alerts to.\n\nTry using:\n• \`/activate #your-channel\` to specify one\n• Or make sure the saved one still exists.`,
                            EmbedColors.ERROR,
                            guild
                        )],
                        ephemeral: true
                    });
                }

                // permission checks (more robust)
                const botMember = await guild.members.fetchMe().catch(() => null);
                const permissions = channel.permissionsFor(botMember);
                if (!permissions?.has("ViewChannel") || !permissions.has("SendMessages")) {
                    return interaction.reply({
                        embeds: [buildEmbedReply(
                            "🚫 No Permission",
                            `I can’t post in <#${channel.id}>. Please make sure I have **View Channel** and **Send Messages** permission there.`,
                            EmbedColors.ERROR,
                            guild
                        )],
                        ephemeral: true
                    });
                }

                if (settings.alertsEnabled && settings.textChannelId === channel.id) {
                    return interaction.reply({
                        embeds: [buildEmbedReply(
                            "⚠️ Already On",
                            `VC alerts are **already active** in <#${channel.id}> 🔊\n\nUse \`/settings\` to manage join, leave, and online alerts. Or change the channel with \`/activate #new-channel\`.`,
                            EmbedColors.WARNING,
                            guild
                        )],
                        ephemeral: true
                    });
                }

                settings.alertsEnabled = true;
                settings.textChannelId = channel.id;
                await updateGuildSettings(settings);

                return interaction.reply({
                    embeds: [buildEmbedReply(
                        "✅ VC Alerts Enabled",
                        `You're all set! I’ll now post voice activity in <#${channel.id}> 🎙️\n\nUse \`/settings\` anytime to tweak the vibe — join, leave, and online alerts are all customizable. ✨`,
                        EmbedColors.SUCCESS,
                        guild
                    )],
                    ephemeral: true
                });
            }

            if (interaction.commandName === "deactivate") {
                if (!settings.alertsEnabled) {
                    return interaction.reply({
                        embeds: [buildEmbedReply("⚠️ Already Disabled", "VC alerts are already turned off. 🌙", EmbedColors.WARNING, guild)],
                        ephemeral: true
                    });
                }

                settings.alertsEnabled = false;
                await updateGuildSettings(settings);

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(EmbedColors.ERROR)
                            .setAuthor({ name: "VC Alerts Powered Down 🔕", iconURL: client.user.displayAvatarURL() })
                            .setDescription("🚫 No more **join**, **leave**, or **online** alerts.\nUse `/activate` to re-enable anytime!")
                            .setFooter({ text: "🔧 VC Alert Control Panel", iconURL: client.user.displayAvatarURL() })
                            .setTimestamp()
                    ],
                    ephemeral: true
                });
            }

            if (interaction.commandName === "setignorerole") {
                const role = interaction.options.getRole("role");

                settings.ignoredRoleId = role.id;
                settings.ignoreRoleEnabled = true;
                await updateGuildSettings(settings);

                return interaction.reply({
                    embeds: [buildEmbedReply(
                        "✅ Ignored Role Set",
                        `Members with the role ${role} will now be ignored from VC and online alerts.`,
                        EmbedColors.RESET,
                        interaction.guild
                    )],
                    ephemeral: true
                });
            }

            if (interaction.commandName === "resetignorerole") {
                settings.ignoredRoleId = null;
                settings.ignoreRoleEnabled = false;
                await updateGuildSettings(settings);

                return interaction.reply({
                    embeds: [buildEmbedReply(
                        "♻️ Ignored Role Reset",
                        "The ignored role has been removed. All members will now be included in alerts.",
                        EmbedColors.RESET,
                        interaction.guild
                    )],
                    ephemeral: true
                });
            }

            if (interaction.commandName === "logs") {
    
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                const logs24h = recentLogs.filter(l => l.time >= cutoff);

                if (logs24h.length === 0) {
                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0x5865f2)
                                .setTitle("📭 No Logs Found")
                                .setDescription("No VC or online activity recorded in the last 24 hours.")
                                .setTimestamp()
                        ],
                        ephemeral: true
                    });
                }

                const summary = logs24h
                    .slice(-20)
                    .reverse()
                    .map(l => `• **${l.type.toUpperCase()}** — ${l.user} (${l.channel}) • 🕒 ${timeAgo(l.time)} (${toISTString(l.time)})`)
                    .join("\n");

                const embed = new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setAuthor({ name: "📜 VC Activity Logs (Last 24h)" })
                    .setDescription(summary)
                    .setFooter({ text: "Showing latest 20 entries" })
                    .setTimestamp();

                if (fs.existsSync(LOG_FILE_PATH)) {
                    return interaction.reply({
                        embeds: [embed],
                        files: [{ attachment: LOG_FILE_PATH, name: "vc_logs.txt" }],
                        ephemeral: true
                    });
                } else {
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }
            }
        }

        // Button interactions
        if (interaction.isButton()) {
            if (!await checkAdmin(interaction)) return;


            // We re-fetch settings from cache to apply changes
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
                        new ButtonBuilder().setCustomId("confirmReset").setLabel("✅ Confirm Reset").setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId("cancelReset").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
                    );

                    return interaction.update({
                        embeds: [buildEmbedReply("⚠️ Confirm Settings Reset", "Are you sure you want to reset all VC alert settings to default?", EmbedColors.WARNING, interaction.guild)],
                        components: [confirmRow]
                    });
                }

                case "confirmReset": {
                    await GuildSettings.deleteOne({ guildId }).catch(e => console.error(`[DB] Reset delete failed for ${guildId}:`, e.message));
                    guildSettingsCache.delete(guildId);
                    settingsToUpdate = await getGuildSettings(guildId);

                    await interaction.followUp({
                        embeds: [buildEmbedReply("✅ Settings Reset", "All settings have been restored to default. 🎯", EmbedColors.RESET, guild)],
                        ephemeral: true
                    });

                    const newPanel = buildControlPanel(settingsToUpdate, guild);
                    return interaction.message.edit({ embeds: [newPanel.embed], components: newPanel.buttons });
                }

                case "cancelReset": {
                    const cancelPanel = buildControlPanel(settingsToUpdate, guild);
                    return interaction.update({
                        embeds: [cancelPanel.embed],
                        components: cancelPanel.buttons
                    });
                }

                default:
                    break;
            }

            // Save new settings (debounced)
            await updateGuildSettings(settingsToUpdate);

            const updatedPanel = buildControlPanel(settingsToUpdate, guild);
            return interaction.update({ embeds: [updatedPanel.embed], components: updatedPanel.buttons });
        }
    } catch (err) {
        console.error("[Interaction Handler] Error:", err?.stack || err?.message || err);
        // If possible, respond with ephemeral error to user
        try {
            if (interaction && !interaction.replied && interaction.deferred) {
                await interaction.followUp({ content: "An error occurred while processing your request.", ephemeral: true });
            } else if (interaction && !interaction.replied) {
                await interaction.reply({ content: "An error occurred while processing your request.", ephemeral: true });
            }
        } catch (_) { /* ignore reply failures */ }
    }
});

// ---------- Thread & VC management ----------
const activeVCThreads = new Map(); // vcId -> thread object
const threadDeletionTimeouts = new Map(); // vcId -> timeoutId

// Helper: safely fetch channel and ensure it's text-based
async function fetchTextChannel(guild, channelId) {
    try {
        let ch = guild.channels.cache.get(channelId);
        if (!ch) ch = await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) return null;
        return ch;
    } catch (e) {
        return null;
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const user = newState.member?.user || oldState.member?.user;
        if (!user || user.bot) return;

        const guild = newState.guild || oldState.guild;
        if (!guild) return;

        const settings = await getGuildSettings(guild.id);
        if (!settings || !settings.alertsEnabled || !settings.textChannelId) return;

        const member = newState.member || oldState.member;

        if (
            settings.ignoreRoleEnabled &&
            settings.ignoredRoleId &&
            member?.roles?.cache?.has && member.roles.cache.has(settings.ignoredRoleId)
        ) {
            return;
        }

        // Ignore VC move events (channel -> channel)
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            return;
        }

        let logChannel = await fetchTextChannel(guild, settings.textChannelId);
        if (!logChannel) {
            console.error(`[VC Alert] Failed to fetch log channel ${settings.textChannelId} for guild ${guild.id}`);
            return;
        }

        const avatar = user.displayAvatarURL ? user.displayAvatarURL({ dynamic: true }) : null;
        let embed;

        if (!oldState.channelId && newState.channelId && settings.joinAlerts) { // joined
            addLog("join", user.tag, newState.channel?.name || "-", guild.name);
            embed = new EmbedBuilder()
                .setColor(EmbedColors.VC_JOIN)
                .setAuthor({ name: `${user.username} just popped in! 🔊`, iconURL: avatar })
                .setDescription(`🎧 **${user.username}** joined **${newState.channel.name}** — Let the vibes begin!`)
                .setFooter({ text: "🎉 Welcome to the voice party!", iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
        } else if (oldState.channelId && !newState.channelId && settings.leaveAlerts) { // left
            addLog("leave", user.tag, oldState.channel?.name || "-", guild.name);
            embed = new EmbedBuilder()
                .setColor(EmbedColors.VC_LEAVE)
                .setAuthor({ name: `${user.username} dipped out! 🏃‍♂️`, iconURL: avatar })
                .setDescription(`👋 **${user.username}** left **${oldState.channel.name}** — See ya next time!`)
                .setFooter({ text: "💨 Gone but not forgotten.", iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
        } else {
            return;
        }

        const vc = newState.channel || oldState.channel;
        if (!vc) return;

        // Determine if it's a "private" VC (i.e., @everyone cannot view)
        let everyoneRole;
        try {
            everyoneRole = vc.guild.roles.everyone;
        } catch (e) {
            everyoneRole = null;
        }
        const isPrivateVC = everyoneRole ? !vc.permissionsFor(everyoneRole).has(PermissionsBitField.Flags.ViewChannel) : false;

        if (isPrivateVC && settings.privateThreadAlerts) {
            // THREAD MANAGEMENT
            let thread = activeVCThreads.get(vc.id);

            // Clean up stale thread references if needed
            if (thread && (!thread.id || (thread.archived && !thread.joinable))) {
                activeVCThreads.delete(vc.id);
                thread = null;
            }

            // Clear old deletion timeout
            if (threadDeletionTimeouts.has(vc.id)) {
                clearTimeout(threadDeletionTimeouts.get(vc.id));
                threadDeletionTimeouts.delete(vc.id);
            }

            if (!thread) {
                // Create a private thread
                try {
                    thread = await logChannel.threads.create({
                        name: `🔊 VC Alert (${vc.name})`,
                        autoArchiveDuration: 60,
                        type: ChannelType.PrivateThread,
                        reason: `Private VC alert for ${vc.name}`,
                    });
                    activeVCThreads.set(vc.id, thread);
                    console.log(`[VC Thread] Created new private thread for ${vc.name}: ${thread.name}`);
                } catch (err) {
                    console.error(`[VC Alert] Failed to create private thread for ${vc.name}:`, err.message);
                    activeVCThreads.delete(vc.id);
                    return;
                }
            } else {
                // refresh thread object
                try {
                    thread = await logChannel.threads.fetch(thread.id);
                    activeVCThreads.set(vc.id, thread);
                } catch (err) {
                    console.error(`[VC Alert] Failed to fetch existing private thread ${thread.id} for ${vc.name}:`, err.message);
                    activeVCThreads.delete(vc.id);
                    return;
                }
            }

            // reset the deletion timer on new activity
            const timeoutId = setTimeout(async () => {
                try {
                    await thread.delete().catch(err => console.error(`Failed to auto-delete private thread ${thread.id}:`, err.message));
                } catch (e) { /* ignore */ }
                activeVCThreads.delete(vc.id);
                threadDeletionTimeouts.delete(vc.id);
                console.log(`[VC Thread] Auto-deleted private thread for ${vc.name} due to inactivity.`);
            }, THREAD_INACTIVITY_LIFETIME_MS);
            threadDeletionTimeouts.set(vc.id, timeoutId);

            // Add members who can view the VC to the thread (concurrently)
            try {
                const allMembers = await vc.guild.members.fetch();
                const membersToAdd = allMembers.filter(m =>
                    !m.user.bot &&
                    vc.permissionsFor(m).has(PermissionsBitField.Flags.ViewChannel)
                );

                // Add in batches to avoid rate limits
                const batches = [];
                const ids = membersToAdd.map(m => m.id);
                for (let i = 0; i < ids.length; i += 50) {
                    batches.push(ids.slice(i, i + 50));
                }
                for (const batch of batches) {
                    await Promise.allSettled(batch.map(id => thread.members.add(id).catch(() => {})));
                    // small pause to be gentle to API (non-blocking yield)
                    await new Promise(res => setTimeout(res, 150));
                }
            } catch (e) {
                // best-effort; ignore member add failures
            }

            // Send the embed in the thread
            const msg = await thread.send({ embeds: [embed] }).catch((e) => console.warn(`Failed to send embed in private thread for ${vc.name}: ${e.message}`));
            if (msg && settings.autoDelete) {
                setTimeout(() => msg.delete().catch(() => {}), 30_000);
            }
        } else {
            // Public VC alerts
            const msg = await logChannel.send({ embeds: [embed] }).catch((e) => console.warn(`Failed to send embed in public channel for ${vc.name}: ${e.message}`));
            if (msg && settings.autoDelete) {
                setTimeout(() => msg.delete().catch(() => {}), 30_000);
            }
        }

    } catch (e) {
        console.error("[voiceStateUpdate] Handler error:", e?.stack || e?.message || e);
    }
});

// ---------- Presence (online) handler ----------
client.on("presenceUpdate", async (oldPresence, newPresence) => {
    try {
        const member = newPresence.member;
        if (!member || member.user.bot || newPresence.status !== "online" || oldPresence?.status === "online") return;

        const settings = await getGuildSettings(member.guild.id);
        if (!settings?.alertsEnabled || !settings.onlineAlerts || !settings.textChannelId) return;

        if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member.roles.cache.has(settings.ignoredRoleId)) {
            return;
        }

        let channel = await fetchTextChannel(member.guild, settings.textChannelId);
        if (!channel) {
            console.error(`[Online Alert] Failed to fetch log channel ${settings.textChannelId} for guild ${member.guild.id}`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(EmbedColors.ONLINE)
            .setAuthor({ name: `${member.user.username} just came online! 🟢`, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
            .setDescription(`👀 **${member.user.username}** is now online — something's cooking!`)
            .setFooter({ text: "✨ Ready to vibe!", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        addLog("online", member.user.tag, "-", member.guild.name);

        const msg = await channel.send({ embeds: [embed] }).catch((e) => console.warn(`Failed to send online alert for ${member.user.username}: ${e.message}`));
        if (msg && settings.autoDelete) {
            setTimeout(() => msg.delete().catch(() => {}), 30_000);
        }
    } catch (e) {
        console.error("[presenceUpdate] Handler error:", e?.stack || e?.message || e);
    }
});

// ---------- Permission helper ----------
async function checkAdmin(interaction) {
    const guild = interaction.guild;
    const member = interaction.member;

    // Check if user has Administrator or Manage Guild permission
    const hasPermission =
        member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
        member?.permissions?.has(PermissionsBitField.Flags.ManageGuild);

    if (!hasPermission) {
        await interaction.reply({
            embeds: [
                buildEmbedReply(
                    "🚫 No Permission",
                    "You need **Administrator** or **Manage Server** permission to use this command.",
                    EmbedColors.ERROR,
                    guild
                )
            ],
            ephemeral: true
        });
        return false;
    }
    return true;
}



// ---------- Graceful shutdown ----------
async function shutdown(signal) {
    try {
        console.log(`[Shutdown] Received ${signal}. Cleaning up...`);
        // flush pending saves immediately
        if (pendingSaveTimer) {
            clearTimeout(pendingSaveTimer);
            pendingSaveTimer = null;
        }
        if (pendingSaveQueue.size > 0) {
            const entries = Array.from(pendingSaveQueue.entries());
            pendingSaveQueue.clear();
            await Promise.all(entries.map(([guildId, settings]) =>
                GuildSettings.findOneAndUpdate({ guildId }, settings, { upsert: true, setDefaultsOnInsert: true }).exec().catch(e => console.error(`[DB] Shutdown save failed for ${guildId}:`, e.message))
            ));
        }
        // try to delete any thread timers and clear maps
        for (const [vcId, t] of threadDeletionTimeouts.entries()) {
            clearTimeout(t);
        }
        threadDeletionTimeouts.clear();
        activeVCThreads.clear();
        // close DB
        await mongoose.disconnect().catch(() => {});
        // destroy client
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

// ---------- Start bot ----------
client.login(process.env.TOKEN).catch(err => console.error("❌ Login failed:", err));





