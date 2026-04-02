<div align="center">

<img src="https://img.shields.io/badge/Discord-Bot-5865F2?style=for-the-badge&logo=discord&logoColor=white" />
<img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white" />
<img src="https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white" />
<img src="https://img.shields.io/badge/discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white" />

# 🎧 VC Alert Bot

> **The ultimate Voice Channel monitor for Discord — real-time alerts, invite tools, soundboard & more.**

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔔 **VC Alerts** | Real-time join, leave & online alerts in your chosen channel |
| 📨 **Smart Invite** | Invite frequent VC users or search by name with access lookup |
| 🎛️ **Control Panel** | Beautiful button-based settings dashboard |
| 🎵 **Soundboard** | Upload, queue & play audio clips in voice channels |
| 📊 **Stats & Logs** | Activity statistics with charts, logs & file export |
| 🙈 **Ignore Roles** | Skip alerts for specific roles (staff, bots, etc.) |
| 🧵 **Private Threads** | Auto-creates private threads for private VC alerts |
| 👑 **Owner Dashboard** | Full bot analytics in DM — servers, logs, memory & more |
| 🧹 **Auto-Cleanup** | Auto-delete old messages & temp files |

---

## 🚀 Commands

### 🎙️ Voice Channel Alerts

| Command | Description |
|---|---|
| `/activate [channel]` | Enable VC alerts in the selected channel |
| `/deactivate` | Disable all VC alerts |
| `/settings` | Open the interactive settings control panel |

### 📨 Invite

| Command | Description |
|---|---|
| `/inv` | Shows top **10 frequent VC users** with live status |
| `/inv search:<name>` | Search a member and see which VCs they have access to |
| `/inv limit:<n>` | Show up to 25 results instead of the default 10 |

> **How `/inv` works:**
> - **Default mode** → pulls the most frequent VC joiners from your logs (top 10), shows their current status & which channel they're in
> - **Search mode** → finds members by username/nickname and lists every VC they can connect to
> - Autocomplete support for member names

### 🙈 Ignore Role

| Command | Description |
|---|---|
| `/ignorerole action:set role:@Role` | Set a role to be ignored in alerts |
| `/ignorerole action:view` | View current ignore role settings |
| `/ignorerole action:toggle` | Toggle the ignore feature on/off |
| `/ignorerole action:reset` | Remove the ignored role |

### 📊 Logs & Stats

| Command | Description |
|---|---|
| `/logs [range] [user]` | View activity logs (Today / Yesterday / 7d / 30d) |
| `/stats [period]` | Server activity stats with top users & channels |

### 🎵 Soundboard

| Command | Description |
|---|---|
| `/sound add <name> <file>` | Upload an audio file to the soundboard |
| `/sound play <name>` | Play a sound in your current VC |
| `/sound list` | List all available sounds |
| `/sound delete <name>` | Remove a sound |
| `/sound top` | See the 10 most played sounds |
| `/sound volume <0-100>` | Set playback volume |
| `/sound panel` | Open the live soundboard control panel |

### 🛠️ Utility

| Command | Description |
|---|---|
| `/userinfo [user]` | View detailed profile: roles, join date, permissions, VC status |
| `/ping` | Check bot latency and uptime |
| `/cleanup` | Remove old logs and temp files |

### 👑 Owner Only

| Command | Description |
|---|---|
| `/owner` | In a server → shows quick stats + tip to DM for full dashboard<br>In DMs → full analytics: servers, members, logs, memory, top guilds |

---

## ⚙️ Setup

### Prerequisites

- Node.js **v18+**
- MongoDB database (Atlas or local)
- Discord bot token with the following intents:
  - `GUILDS`, `GUILD_MESSAGES`, `GUILD_VOICE_STATES`, `GUILD_MEMBERS`, `GUILD_PRESENCES`

### Installation

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd vc-alert-bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your values

# 4. Start the bot
node bot.js
```

### Environment Variables

```env
TOKEN=your_discord_bot_token
MONGO_URI=mongodb+srv://...
OWNER_ID=your_discord_user_id
PORT=8000
```

> Get your `TOKEN` from the [Discord Developer Portal](https://discord.com/developers/applications)

---

## 🔐 Permissions Required

The bot needs these permissions in your server:

- ✅ View Channels
- ✅ Send Messages
- ✅ Embed Links
- ✅ Attach Files
- ✅ Manage Channels *(for creating soundboard storage & private threads)*
- ✅ Connect & Speak *(for soundboard playback)*
- ✅ Read Message History

---

## 🏗️ Project Structure

```
vc-alert-bot/
├── bot.js          # Main bot file (all commands + event handlers)
├── .env.example    # Environment variable template
├── package.json    # Node.js dependencies
├── Dockerfile      # Docker container configuration
├── temp/           # Temporary audio files (auto-cleaned)
└── logs/           # Activity log exports
```

---

## 📦 Dependencies

| Package | Version | Purpose |
|---|---|---|
| `discord.js` | v14 | Discord API client |
| `@discordjs/voice` | latest | Voice channel audio |
| `mongoose` | latest | MongoDB ODM |
| `axios` | latest | HTTP requests |
| `express` | latest | Health check endpoint |
| `dotenv` | latest | Environment config |

---

## 🐳 Docker

```bash
# Build image
docker build -t vc-alert-bot .

# Run container
docker run -d \
  -e TOKEN=your_token \
  -e MONGO_URI=your_mongo_uri \
  -e OWNER_ID=your_owner_id \
  --name vc-alert-bot \
  vc-alert-bot
```

---

## 📸 How It Looks

### `/settings` — Control Panel
> A fully interactive embed with toggle buttons for every alert type. One glance, full control.

### `/inv` — Invite Panel
> Shows the top frequent VC members with their live status (🟢 online / 🟡 idle / 🔴 dnd / ⚫ offline) and which channel they're currently in.

### `/sound panel` — Soundboard Dashboard
> Live-updating panel showing now playing, queue, and control buttons (Connect / Skip / Stop).

### `/owner` — Owner Dashboard (DM)
> Full analytics panel: server count, member count, 24h join/leave/online breakdown, memory usage, top guilds, and most active servers.

---

## 🧠 Smart Features

- **Debounced DB writes** — settings are cached in memory and batch-saved every 300ms
- **Auto log TTL** — logs expire after 30 days automatically via MongoDB TTL index
- **Connection recovery** — voice connections auto-reconnect on disconnect
- **Thread management** — private VC threads auto-delete after 5 minutes of inactivity
- **Download → Play → Delete** — soundboard files are streamed, played, then deleted
- **Heartbeat monitoring** — reconnects if Discord gateway goes silent for 60+ seconds

---

## 💡 Tips

- Use `/inv` without any options to instantly see your most active VC members
- Use `/inv search:username` to check if a specific person can join your VC
- Run `/owner` in your DMs with the bot for the full admin analytics panel
- Set up a private #vc-alerts channel and use `/activate #channel` to keep things organized
- Use `/ignorerole action:set role:@Mods` to prevent staff from appearing in alerts

---

<div align="center">

Made with 💜 for Discord communities

*If you find this bot useful, consider giving the repo a ⭐*

</div>
