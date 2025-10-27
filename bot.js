const express = require("express");
const fs = require("fs");
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
    privateThreadAlerts: { type: Boolean, default: true },
    autoDelete: { type: Boolean, default: true }, // Auto-delete individual messages (30s)
    ignoredRoleId: { type: String, default: null },
    ignoreRoleEnabled: { type: Boolean, default: false }
});
const GuildSettings = mongoose.model("guildsettings", guildSettingsSchema);

// In-memory cache for guild settings to reduce DB reads
const guildSettingsCache = new Map();

// Helper to get guild settings, using cache first
async function getGuildSettings(guildId) {
    if (guildSettingsCache.has(guildId)) {
        return guildSettingsCache.get(guildId);
    }
    let settings = await GuildSettings.findOne({ guildId });
    if (!settings) {
        settings = new GuildSettings({ guildId });
        await settings.save(); // Save default settings if not found
    }
    guildSettingsCache.set(guildId, settings); // Cache the settings
    return settings;
}

// Helper to update and cache guild settings
async function updateGuildSettings(settings) {
    await settings.save();
    guildSettingsCache.set(settings.guildId, settings); // Update cache
}

// ====== VC LOG SYSTEM ======
const LOG_FILE_PATH = path.join(__dirname, "vc_logs.txt");
let recentLogs = [];

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

function addLog(type, user, channel = "-", guildName = "-") {
    const entry = { type, user, channel, guild: guildName, time: Date.now() };
    recentLogs.push(entry);
    fs.appendFileSync(
        LOG_FILE_PATH,
        `[${toISTString(entry.time)}] (${guildName}) ${type.toUpperCase()} - ${user} in ${channel}\n`
    );
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    recentLogs = recentLogs.filter(l => l.time >= cutoff);
}


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
        .setName("vclogs")
        .setDescription("📜 View the last 24 hours of activity logs.")

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

// Define Embed Colors for consistency and readability
const EmbedColors = {
    SUCCESS: 0x1abc9c,     // Green
    ERROR: 0xe74c3c,       // Red
    WARNING: 0xffcc00,     // Yellow
    INFO: 0x5865f2,        // Discord Blue
    VC_JOIN: 0x00ffcc,     // Bright Cyan
    VC_LEAVE: 0xff5e5e,    // Light Red
    ONLINE: 0x55ff55,      // Light Green
    RESET: 0x00ccff        // Light Blue
};

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

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.inGuild()) return;

    const guild = interaction.guild;
    const guildId = guild.id;

    let settings = await getGuildSettings(guildId);

    if (interaction.isChatInputCommand()) {
        if (!hasAdminPermission(interaction)) {
            return interaction.reply({
                embeds: [buildEmbedReply("🚫 No Permission", "You need **Manage Server** permission to use this command.", EmbedColors.ERROR, guild)],
                ephemeral: true
            });
        }

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

            const permissions = channel.permissionsFor(client.user);
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

        if (interaction.commandName === "vclogs") {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xff5555)
                            .setTitle("🚫 No Permission")
                            .setDescription("You need **Manage Server** permission to use `/vclogs`.")
                            .setTimestamp()
                    ],
                    ephemeral: true
                });
            }
        
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

    if (interaction.isButton()) {
        if (!hasAdminPermission(interaction)) {
            return interaction.reply({
                embeds: [buildEmbedReply("🚫 No Permission", "You need **Manage Server** permission to use these controls.", EmbedColors.ERROR, guild)],
                ephemeral: true
            });
        }

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
            case "togglePrivateThreads":
                settings.privateThreadAlerts = !settings.privateThreadAlerts;
                break;
            case "toggleAutoDelete":
                settings.autoDelete = !settings.autoDelete;
                break;
            case "toggleIgnoreRole":
                settings.ignoreRoleEnabled = !settings.ignoreRoleEnabled;
                break;
            case "resetSettings":
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirmReset").setLabel("✅ Confirm Reset").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("cancelReset").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
                );

                return interaction.update({
                    embeds: [buildEmbedReply("⚠️ Confirm Settings Reset", "Are you sure you want to reset all VC alert settings to default?", EmbedColors.WARNING, interaction.guild)],
                    components: [confirmRow]
                });

            case "confirmReset":
                await GuildSettings.deleteOne({ guildId });
                guildSettingsCache.delete(guildId);

                settings = await getGuildSettings(guildId);

                await interaction.followUp({
                    embeds: [buildEmbedReply("✅ Settings Reset", "All settings have been restored to default. 🎯", EmbedColors.RESET, guild)],
                    ephemeral: true
                });

                const newPanel = buildControlPanel(settings, guild);
                return interaction.message.edit({ embeds: [newPanel.embed], components: newPanel.buttons });


            case "cancelReset":
                const cancelPanel = buildControlPanel(settings, guild);
                return interaction.update({
                    embeds: [cancelPanel.embed],
                    components: cancelPanel.buttons
                });
        }

        await updateGuildSettings(settings);
        const updatedPanel = buildControlPanel(settings, guild);
        return interaction.update({ embeds: [updatedPanel.embed], components: updatedPanel.buttons });
    }
});

// Map to store active thread objects, keyed by VC ID
const activeVCThreads = new Map();
// Map to store thread deletion timeouts, keyed by VC ID
const threadDeletionTimeouts = new Map();

// VC join/leave alert
client.on('voiceStateUpdate', async (oldState, newState) => {
    const user = newState.member?.user || oldState.member?.user;
    if (!user || user.bot) return;

    const guild = newState.guild || oldState.guild;
    const settings = await getGuildSettings(guild.id);
    if (!settings || !settings.alertsEnabled || !settings.textChannelId) return;

    const member = newState.member || oldState.member;
    if (
        settings.ignoreRoleEnabled &&
        settings.ignoredRoleId &&
        member?.roles.cache.has(settings.ignoredRoleId)
    ) {
        return;
    }

    // Ignore VC switch events (move between channels) - only process actual joins/leaves
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        return;
    }

    let logChannel = guild.channels.cache.get(settings.textChannelId);
    if (!logChannel || !logChannel.isTextBased()) {
        try {
            logChannel = await guild.channels.fetch(settings.textChannelId);
        } catch (e) {
            console.error(`[VC Alert] Failed to fetch log channel ${settings.textChannelId} for guild ${guild.id}:`, e.message);
            return;
        }
        if (!logChannel?.isTextBased()) return;
    }

    const avatar = user.displayAvatarURL({ dynamic: true });
    let embed;

    if (!oldState.channelId && newState.channelId && settings.joinAlerts) { // User joined a VC
        addLog("join", user.tag, newState.channel.name, guild.name);
        embed = new EmbedBuilder()
            .setColor(EmbedColors.VC_JOIN)
            .setAuthor({ name: `${user.username} just popped in! 🔊`, iconURL: avatar })
            .setDescription(`🎧 **${user.username}** joined **${newState.channel.name}** — Let the vibes begin!`)
            .setFooter({ text: "🎉 Welcome to the voice party!", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();
    } else if (oldState.channelId && !newState.channelId && settings.leaveAlerts) { // User left a VC
        addLog("leave", user.tag, oldState.channel.name, guild.name);

        embed = new EmbedBuilder()
            .setColor(EmbedColors.VC_LEAVE)
            .setAuthor({ name: `${user.username} dipped out! 🏃‍♂️`, iconURL: avatar })
            .setDescription(`👋 **${user.username}** left **${oldState.channel.name}** — See ya next time!`)
            .setFooter({ text: "💨 Gone but not forgotten.", iconURL: client.user.displayAvatarURL() })
            .setTimestamp();
    } else {
        return; // Not a relevant join/leave event or not enabled
    }

    const vc = newState.channel || oldState.channel;
    if (!vc) return;

    const everyoneRole = vc.guild.roles.everyone;
    // Determine if it's a "private" VC (i.e., @everyone cannot view)
    const isPrivateVC = !vc.permissionsFor(everyoneRole).has(PermissionsBitField.Flags.ViewChannel);

    // Private VC Alert Logic
    if (isPrivateVC && settings.privateThreadAlerts) {
        let thread = activeVCThreads.get(vc.id);

        // Define the desired thread lifetime for inactivity (10 minutes)
        const THREAD_INACTIVITY_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes in milliseconds

        // Step 1: Check if the thread exists and is usable. If not, create it.
        if (!thread || thread.archived || !logChannel.threads.cache.has(thread.id)) {
            // Clear any previous timeout associated with this VC, as we're creating a new thread
            if (threadDeletionTimeouts.has(vc.id)) {
                clearTimeout(threadDeletionTimeouts.get(vc.id));
                threadDeletionTimeouts.delete(vc.id);
            }
            
            try {
                // Create a new private thread
                thread = await logChannel.threads.create({
                    name: `🔊 VC Alert (${vc.name})`,
                    // Use Discord's minimum archive duration (60 mins) for private threads.
                    // We'll manage actual deletion with setTimeout.
                    autoArchiveDuration: 60,
                    type: ChannelType.PrivateThread, // Ensure it's a private thread
                    reason: `Private VC alert for ${vc.name}`,
                });
                activeVCThreads.set(vc.id, thread); // Store the new thread object
                console.log(`[VC Thread] Created new private thread for ${vc.name}: ${thread.name}`);

            } catch (err) {
                console.error(`[VC Alert] Failed to create private thread for ${vc.name}:`, err.message);
                activeVCThreads.delete(vc.id); // Clean up from map if creation failed
                return;
            }
        } else {
             // If the thread exists and is active, ensure we fetch the latest state
             // This can prevent issues if the thread object in our map becomes stale
             try {
                thread = await logChannel.threads.fetch(thread.id);
             } catch (err) {
                console.error(`[VC Alert] Failed to fetch existing private thread ${thread.id} for ${vc.name}:`, err.message);
                activeVCThreads.delete(vc.id); // Remove stale reference
                return; // Can't proceed without a valid thread object
             }
        }

        // Step 2: Reset the thread's deletion timer on new activity
        if (threadDeletionTimeouts.has(vc.id)) {
            clearTimeout(threadDeletionTimeouts.get(vc.id)); // Clear old timeout
        }
        const timeoutId = setTimeout(async () => {
            await thread.delete().catch(err => console.error(`Failed to auto-delete private thread ${thread.id}:`, err.message));
            activeVCThreads.delete(vc.id); // Remove from active map
            threadDeletionTimeouts.delete(vc.id); // Remove timeout reference
            console.log(`[VC Thread] Auto-deleted private thread for ${vc.name} due to inactivity.`);
        }, THREAD_INACTIVITY_LIFETIME_MS);
        threadDeletionTimeouts.set(vc.id, timeoutId); // Store new timeout ID

        // Step 3: Add/Update Members in the Thread
        // This ensures anyone who can view the VC is added to the thread.
        const allMembers = await vc.guild.members.fetch();
        const membersToAddPromises = allMembers.filter(m =>
            !m.user.bot && // Exclude bots
            vc.permissionsFor(m).has(PermissionsBitField.Flags.ViewChannel) // Check if member can view the VC
        ).map(m => thread.members.add(m.id).catch(e => { /* console.warn(`Failed to add ${m.user.tag} to private thread: ${e.message}`); */ })); // Suppress common 'already in thread' warnings

        await Promise.allSettled(membersToAddPromises); // Wait for all add operations to complete

        // Step 4: Send the alert message to the thread
        const msg = await thread.send({ embeds: [embed] }).catch((e) => console.warn(`Failed to send embed in private thread for ${vc.name}: ${e.message}`));
        if (msg && settings.autoDelete) {
            // Auto-delete individual alert messages within the thread after 30 seconds (if enabled)
            setTimeout(() => msg.delete().catch(() => {}), 30_000);
        }

    } else { // Public VC Alert Logic (no threads involved)
        const msg = await logChannel.send({ embeds: [embed] }).catch((e) => console.warn(`Failed to send embed in public channel for ${vc.name}: ${e.message}`));
        if (msg && settings.autoDelete) {
            setTimeout(() => msg.delete().catch(() => {}), 30_000);
        }
    }
});

// Online alert (no changes needed here as it doesn't involve threads)
client.on("presenceUpdate", async (oldPresence, newPresence) => {
    const member = newPresence.member;
    if (!member || member.user.bot || newPresence.status !== "online" || oldPresence?.status === "online") return;

    const settings = await getGuildSettings(member.guild.id);
    if (!settings?.alertsEnabled || !settings.onlineAlerts || !settings.textChannelId) return;

    if (settings.ignoreRoleEnabled && settings.ignoredRoleId && member.roles.cache.has(settings.ignoredRoleId)) {
        return;
    }

    let channel = member.guild.channels.cache.get(settings.textChannelId);
    if (!channel || !channel.isTextBased()) {
        try {
            channel = await member.guild.channels.fetch(settings.textChannelId);
        } catch (e) {
            console.error(`[Online Alert] Failed to fetch log channel ${settings.textChannelId} for guild ${member.guild.id}:`, e.message);
            return;
        }
        if (!channel?.isTextBased()) return;
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
});

function hasAdminPermission(interaction) {
    return interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild);
}

client.login(process.env.TOKEN).catch(err => console.error("❌ Login failed:", err));