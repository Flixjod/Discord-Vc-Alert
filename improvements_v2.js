// ========== FIX 1: OWNER COMMAND - Allow in guilds, only show to real owner ==========
        case "owner": {
          // Check if user is the bot owner
          const OWNER_ID = process.env.OWNER_ID;
          if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
            return interaction.reply({ 
              embeds: [new EmbedBuilder()
                .setColor(EmbedColors.ERROR)
                .setTitle(toSmallCaps("🚫 unauthorized"))
                .setDescription(toSmallCaps("Only the bot owner can use this command."))
                .setTimestamp()
              ], 
              flags: 64 
            });
          }
          
          await interaction.deferReply({ flags: 64 });
          
          // Gather bot statistics
          const totalGuilds = client.guilds.cache.size;
          const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
          
          // Recent activity (last 24 hours)
          const oneDayAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
          const recentLogsCount = await GuildLog.countDocuments({ time: { $gte: oneDayAgo } }).catch(() => 0);
          
          // Memory usage
          const memUsage = process.memoryUsage();
          const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
          const memTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
          
          // Uptime
          const uptimeSecs = Math.floor(process.uptime());
          const days = Math.floor(uptimeSecs / 86400);
          const hours = Math.floor((uptimeSecs % 86400) / 3600);
          const minutes = Math.floor((uptimeSecs % 3600) / 60);
          const uptimeText = `${days}d ${hours}h ${minutes}m`;
          
          // WebSocket ping
          const wsPing = client.ws.ping;
          
          // Database stats
          const totalLogs = await GuildLog.countDocuments().catch(() => 0);
          const totalSounds = await Sound.countDocuments().catch(() => 0);
          
          // Top guilds by member count
          const topGuildsByMembers = client.guilds.cache
            .sort((a, b) => b.memberCount - a.memberCount)
            .first(10)
            .map((g, idx) => `${idx + 1}. **${g.name}** - ${g.memberCount} members`)
            .join("\n");
          
          // Most active guilds (last 24h)
          const guildActivity = await GuildLog.aggregate([
            { $match: { time: { $gte: oneDayAgo } } },
            { $group: { _id: "$guildId", count: { $sum: 1 }, name: { $first: "$guildName" } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ]).catch(() => []);
          
          const topActiveGuilds = guildActivity.length > 0
            ? guildActivity.map((g, idx) => `${idx + 1}. **${g.name}** - ${g.count} events`).join("\n")
            : "No activity recorded";
          
          const embed = new EmbedBuilder()
            .setColor(0x9b59b6) // Purple color for premium look
            .setAuthor({ 
              name: toSmallCaps("👑 bot owner dashboard"), 
              iconURL: client.user.displayAvatarURL() 
            })
            .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
            .setDescription(
              `╔════════════════════════════╗\n` +
              `║   **${client.user.username.toUpperCase()}**   ║\n` +
              `╚════════════════════════════╝\n\n` +
              `> 🟢 **Status:** Online & Running\n` +
              `> ⏱️ **Uptime:** ${uptimeText}\n` +
              `> 📡 **Ping:** ${wsPing}ms`
            )
            .addFields(
              {
                name: "📊 Global Statistics",
                value: 
                  `\`\`\`yaml\n` +
                  `Servers: ${totalGuilds}\n` +
                  `Members: ${totalMembers.toLocaleString()}\n` +
                  `24h Activity: ${recentLogsCount.toLocaleString()} events\n` +
                  `Total Logs: ${totalLogs.toLocaleString()}\n` +
                  `Total Sounds: ${totalSounds}\n` +
                  `\`\`\``,
                inline: false
              },
              {
                name: "💾 System Resources",
                value: 
                  `\`\`\`ini\n` +
                  `[Memory] ${memUsedMB}MB / ${memTotalMB}MB\n` +
                  `[Node] ${process.version}\n` +
                  `[Platform] ${process.platform} ${process.arch}\n` +
                  `\`\`\``,
                inline: false
              },
              {
                name: "🏆 Top 10 Servers (by Members)",
                value: topGuildsByMembers || "No servers",
                inline: false
              },
              {
                name: "⚡ Most Active Servers (24h)",
                value: topActiveGuilds,
                inline: false
              }
            )
            .setFooter({ text: `Owner: ${interaction.user.tag} • All times in IST` })
            .setTimestamp();
          
          return interaction.editReply({ embeds: [embed] });
        }

// ========== FIX 2: ENHANCED USERINFO COMMAND ==========
        case "userinfo": {
          await interaction.deferReply({ flags: 64 });
          
          const targetUser = interaction.options.getUser("user") || interaction.user;
          const member = await guild.members.fetch(targetUser.id).catch(() => null);
          
          if (!member) {
            return interaction.editReply({ 
              embeds: [makeEmbed({ 
                title: toSmallCaps("❌ user not found"), 
                description: toSmallCaps("This user is not in the server."), 
                color: EmbedColors.ERROR, 
                guild 
              })] 
            });
          }
          
          // Account creation date (IST)
          const createdDate = new Date(targetUser.createdTimestamp);
          const createdIST = new Date(createdDate.getTime() + (5.5 * 60 * 60 * 1000));
          const createdStr = createdIST.toLocaleDateString("en-IN", { 
            day: "2-digit", 
            month: "short", 
            year: "numeric", 
            timeZone: "Asia/Kolkata" 
          });
          const daysSinceCreation = Math.floor((Date.now() - targetUser.createdTimestamp) / (1000 * 60 * 60 * 24));
          
          // Server join date (IST)
          const joinedDate = member.joinedAt;
          const joinedIST = new Date(joinedDate.getTime() + (5.5 * 60 * 60 * 1000));
          const joinedStr = joinedIST.toLocaleDateString("en-IN", { 
            day: "2-digit", 
            month: "short", 
            year: "numeric", 
            timeZone: "Asia/Kolkata" 
          });
          const daysSinceJoin = Math.floor((Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24));
          
          // Roles (exclude @everyone)
          const roles = member.roles.cache
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`)
            .slice(0, 15);
          const roleText = roles.length > 0 ? roles.join(" ") : "No roles";
          const roleCount = member.roles.cache.size - 1;
          
          // Key permissions
          const keyPerms = [];
          if (member.permissions.has(PermissionFlagsBits.Administrator)) keyPerms.push("👑 Administrator");
          if (member.permissions.has(PermissionFlagsBits.ManageGuild)) keyPerms.push("🛠️ Manage Server");
          if (member.permissions.has(PermissionFlagsBits.ManageChannels)) keyPerms.push("📁 Manage Channels");
          if (member.permissions.has(PermissionFlagsBits.ManageRoles)) keyPerms.push("🎭 Manage Roles");
          if (member.permissions.has(PermissionFlagsBits.KickMembers)) keyPerms.push("🚪 Kick Members");
          if (member.permissions.has(PermissionFlagsBits.BanMembers)) keyPerms.push("🔨 Ban Members");
          const permsText = keyPerms.length > 0 ? keyPerms.join(", ") : "No special permissions";
          
          // Status and badges
          const status = member.presence?.status || "offline";
          const statusEmoji = status === "online" ? "🟢" : status === "idle" ? "🟡" : status === "dnd" ? "🔴" : "⚫";
          const statusText = status.charAt(0).toUpperCase() + status.slice(1);
          
          const badges = [];
          if (member.user.bot) badges.push("🤖 Bot");
          if (member.premiumSince) badges.push("💎 Server Booster");
          if (targetUser.id === guild.ownerId) badges.push("👑 Server Owner");
          const badgesText = badges.length > 0 ? badges.join(" • ") : "No badges";
          
          // Voice channel
          const voiceChannel = member.voice.channel;
          const voiceText = voiceChannel ? `🎧 ${voiceChannel.name}` : "Not in voice";
          
          // Account age badge
          let accountAgeBadge = "🆕 New Account";
          if (daysSinceCreation > 365) accountAgeBadge = "🏆 Veteran";
          else if (daysSinceCreation > 180) accountAgeBadge = "⭐ Regular";
          else if (daysSinceCreation > 30) accountAgeBadge = "📅 Member";
          
          const embed = new EmbedBuilder()
            .setColor(member.displayHexColor || 0x5865f2)
            .setAuthor({ 
              name: `${member.user.username}'s Profile`, 
              iconURL: targetUser.displayAvatarURL({ dynamic: true, size: 256 }) 
            })
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 512 }))
            .setDescription(
              `╔════════════════════════════╗\n` +
              `║     **USER INFORMATION**     ║\n` +
              `╚════════════════════════════╝\n\n` +
              `> 👤 **User:** ${targetUser}\n` +
              `> 📛 **Display Name:** ${member.displayName}\n` +
              `> 🆔 **User ID:** \`${targetUser.id}\`\n` +
              `> ${statusEmoji} **Status:** ${statusText}\n` +
              `> ${voiceText}\n` +
              `> ${accountAgeBadge}`
            )
            .addFields(
              {
                name: "📅 Account Created",
                value: `\`\`\`yaml\n${createdStr}\n(${daysSinceCreation} days ago)\`\`\``,
                inline: true
              },
              {
                name: "📥 Joined Server",
                value: `\`\`\`yaml\n${joinedStr}\n(${daysSinceJoin} days ago)\`\`\``,
                inline: true
              },
              {
                name: "🏅 Badges & Status",
                value: `\`\`\`\n${badgesText}\`\`\``,
                inline: false
              },
              {
                name: `🎭 Roles [${roleCount}]`,
                value: roleText,
                inline: false
              },
              {
                name: "🔑 Key Permissions",
                value: `\`\`\`\n${permsText}\`\`\``,
                inline: false
              }
            )
            .setImage(targetUser.bannerURL({ size: 1024 }) || null)
            .setFooter({ text: `Requested by ${interaction.user.tag} • All times in IST` })
            .setTimestamp();
          
          return interaction.editReply({ embeds: [embed] });
        }

// ========== NEW COMMANDS ==========

// 1. SERVER INFO COMMAND
        case "serverinfo": {
          await interaction.deferReply({ flags: 64 });
          
          // Fetch full guild data
          await guild.members.fetch();
          await guild.channels.fetch();
          
          const owner = await guild.fetchOwner();
          const createdDate = new Date(guild.createdTimestamp);
          const createdIST = new Date(createdDate.getTime() + (5.5 * 60 * 60 * 1000));
          const createdStr = createdIST.toLocaleDateString("en-IN", { 
            day: "2-digit", 
            month: "short", 
            year: "numeric",
            timeZone: "Asia/Kolkata"
          });
          const daysSinceCreation = Math.floor((Date.now() - guild.createdTimestamp) / (1000 * 60 * 60 * 24));
          
          // Channel counts
          const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
          const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
          const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
          const threads = guild.channels.cache.filter(c => c.isThread()).size;
          
          // Member stats
          const totalMembers = guild.memberCount;
          const humans = guild.members.cache.filter(m => !m.user.bot).size;
          const bots = guild.members.cache.filter(m => m.user.bot).size;
          const online = guild.members.cache.filter(m => m.presence?.status === 'online').size;
          
          // Boost info
          const boostLevel = guild.premiumTier;
          const boostCount = guild.premiumSubscriptionCount || 0;
          const boostEmoji = boostLevel === 3 ? "💎💎💎" : boostLevel === 2 ? "💎💎" : boostLevel === 1 ? "💎" : "⚪";
          
          // Role count
          const roleCount = guild.roles.cache.size - 1;
          
          // Emoji count
          const emojiCount = guild.emojis.cache.size;
          const staticEmojis = guild.emojis.cache.filter(e => !e.animated).size;
          const animatedEmojis = guild.emojis.cache.filter(e => e.animated).size;
          
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({ 
              name: `${guild.name}`, 
              iconURL: guild.iconURL({ dynamic: true, size: 256 }) 
            })
            .setThumbnail(guild.iconURL({ dynamic: true, size: 512 }))
            .setDescription(
              `╔════════════════════════════╗\n` +
              `║   **SERVER INFORMATION**   ║\n` +
              `╚════════════════════════════╝\n\n` +
              `> 👑 **Owner:** ${owner.user.tag}\n` +
              `> 🆔 **Server ID:** \`${guild.id}\`\n` +
              `> ${boostEmoji} **Boost Level:** ${boostLevel} (${boostCount} boosts)\n` +
              `> 📅 **Created:** ${createdStr} (${daysSinceCreation} days ago)`
            )
            .addFields(
              {
                name: "👥 Members",
                value: 
                  `\`\`\`yaml\n` +
                  `Total: ${totalMembers}\n` +
                  `Humans: ${humans}\n` +
                  `Bots: ${bots}\n` +
                  `Online: ${online}\n` +
                  `\`\`\``,
                inline: true
              },
              {
                name: "📁 Channels",
                value: 
                  `\`\`\`yaml\n` +
                  `Text: ${textChannels}\n` +
                  `Voice: ${voiceChannels}\n` +
                  `Categories: ${categories}\n` +
                  `Threads: ${threads}\n` +
                  `\`\`\``,
                inline: true
              },
              {
                name: "🎭 Roles & Emojis",
                value: 
                  `\`\`\`yaml\n` +
                  `Roles: ${roleCount}\n` +
                  `Emojis: ${emojiCount}\n` +
                  `Static: ${staticEmojis}\n` +
                  `Animated: ${animatedEmojis}\n` +
                  `\`\`\``,
                inline: true
              }
            )
            .setImage(guild.bannerURL({ size: 1024 }) || null)
            .setFooter({ text: `Requested by ${interaction.user.tag} • All times in IST` })
            .setTimestamp();
          
          return interaction.editReply({ embeds: [embed] });
        }

// 2. AVATAR COMMAND
        case "avatar": {
          await interaction.deferReply({ flags: 64 });
          
          const targetUser = interaction.options.getUser("user") || interaction.user;
          
          const avatarURL = targetUser.displayAvatarURL({ dynamic: true, size: 4096 });
          const formats = ['webp', 'png', 'jpg'];
          if (targetUser.avatar && targetUser.avatar.startsWith('a_')) {
            formats.push('gif');
          }
          
          const links = formats.map(format => 
            `[${format.toUpperCase()}](${targetUser.displayAvatarURL({ extension: format, size: 4096 })})`
          ).join(' • ');
          
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({ 
              name: `${targetUser.username}'s Avatar`, 
              iconURL: avatarURL 
            })
            .setDescription(
              `╔════════════════════════════╗\n` +
              `║    **AVATAR DOWNLOADS**    ║\n` +
              `╚════════════════════════════╝\n\n` +
              `**Available Formats:**\n${links}`
            )
            .setImage(avatarURL)
            .setFooter({ text: `Requested by ${interaction.user.tag}` })
            .setTimestamp();
          
          return interaction.editReply({ embeds: [embed] });
        }

// 3. BANNER COMMAND
        case "banner": {
          await interaction.deferReply({ flags: 64 });
          
          const targetUser = interaction.options.getUser("user") || interaction.user;
          const fetchedUser = await client.users.fetch(targetUser.id, { force: true });
          
          const bannerURL = fetchedUser.bannerURL({ size: 4096, dynamic: true });
          
          if (!bannerURL) {
            return interaction.editReply({ 
              embeds: [makeEmbed({ 
                title: toSmallCaps("❌ no banner"), 
                description: toSmallCaps(`${targetUser.username} doesn't have a banner set.`), 
                color: EmbedColors.ERROR, 
                guild 
              })] 
            });
          }
          
          const formats = ['webp', 'png', 'jpg'];
          if (fetchedUser.banner && fetchedUser.banner.startsWith('a_')) {
            formats.push('gif');
          }
          
          const links = formats.map(format => 
            `[${format.toUpperCase()}](${fetchedUser.bannerURL({ extension: format, size: 4096 })})`
          ).join(' • ');
          
          const embed = new EmbedBuilder()
            .setColor(fetchedUser.accentColor || 0x5865f2)
            .setAuthor({ 
              name: `${targetUser.username}'s Banner`, 
              iconURL: targetUser.displayAvatarURL({ dynamic: true }) 
            })
            .setDescription(
              `╔════════════════════════════╗\n` +
              `║    **BANNER DOWNLOADS**    ║\n` +
              `╚════════════════════════════╝\n\n` +
              `**Available Formats:**\n${links}`
            )
            .setImage(bannerURL)
            .setFooter({ text: `Requested by ${interaction.user.tag}` })
            .setTimestamp();
          
          return interaction.editReply({ embeds: [embed] });
        }

// 4. UPTIME COMMAND
        case "uptime": {
          await interaction.deferReply({ flags: 64 });
          
          const uptimeSecs = Math.floor(process.uptime());
          const days = Math.floor(uptimeSecs / 86400);
          const hours = Math.floor((uptimeSecs % 86400) / 3600);
          const minutes = Math.floor((uptimeSecs % 3600) / 60);
          const seconds = uptimeSecs % 60;
          
          const totalGuilds = client.guilds.cache.size;
          const totalMembers = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);
          
          const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setAuthor({ 
              name: toSmallCaps("⏱️ bot uptime"), 
              iconURL: client.user.displayAvatarURL() 
            })
            .setDescription(
              `╔════════════════════════════╗\n` +
              `║      **BOT STATISTICS**    ║\n` +
              `╚════════════════════════════╝\n\n` +
              `> 🟢 **Status:** Online\n` +
              `> ⏱️ **Uptime:** ${days}d ${hours}h ${minutes}m ${seconds}s\n` +
              `> 🌐 **Servers:** ${totalGuilds}\n` +
              `> 👥 **Total Members:** ${totalMembers.toLocaleString()}\n` +
              `> 📡 **Ping:** ${client.ws.ping}ms`
            )
            .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: `${client.user.username} is running smoothly!` })
            .setTimestamp();
          
          return interaction.editReply({ embeds: [embed] });
        }
