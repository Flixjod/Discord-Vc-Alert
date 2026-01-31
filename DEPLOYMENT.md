# 🚀 Discord VC Alert Bot - Deployment Guide

## 📋 Overview

This Discord bot can be deployed in multiple ways. Each method has its pros and cons:

| Method | Real-time Alerts | Soundboard | Cost | Latency | Setup Complexity |
|--------|-----------------|------------|------|---------|------------------|
| **Koyeb** | ✅ Yes | ✅ Yes | Free tier | ~0-2s | Easy |
| **Railway** | ✅ Yes | ✅ Yes | $5/mo | <1s | Easy |
| **Render** | ✅ Yes | ✅ Yes | Free tier | ~1-3s | Easy |
| **Cloudflare Workers** | ❌ No* | ❌ No* | Free | <100ms | Medium |
| **VPS (DigitalOcean)** | ✅ Yes | ✅ Yes | $6/mo | <500ms | Hard |

*Cloudflare Workers cannot maintain WebSocket connections required for real-time Discord events.

---

## ⚡ Why Delays Happen on Koyeb

### Root Causes of 1-2 Minute Delays:

1. **Cold Starts**: When inactive, Koyeb pauses containers. First request takes 30-60s to wake up.
2. **Database Latency**: MongoDB Atlas free tier has network latency (especially cross-region).
3. **Blocking Operations**: Awaiting database writes before sending alerts.
4. **Gateway Reconnections**: WebSocket disconnects cause event buffering.

### ✅ Fixes Applied:

1. **Non-blocking Logs**: `addLog()` is now fire-and-forget (doesn't block alerts)
2. **Faster Cache Flush**: Reduced from 700ms to 300ms
3. **Optimized Queries**: Added indexes and `.lean()` for faster DB reads
4. **Connection Pooling**: MongoDB reuses connections

---

## 🎯 Recommended: Optimized Koyeb Deployment

### Step 1: Create `koyeb.yaml`

```yaml
services:
  - name: discord-vc-alert-bot
    type: web
    instance_type: nano
    regions:
      - was # Washington (choose closest to your MongoDB region)
    env:
      - key: TOKEN
        value: YOUR_DISCORD_BOT_TOKEN
      - key: MONGO_URI
        value: YOUR_MONGODB_CONNECTION_STRING
      - key: PORT
        value: 8000
      - key: NODE_ENV
        value: production
    ports:
      - port: 8000
        protocol: http
    health_checks:
      - http:
          path: /
          port: 8000
    routes:
      - path: /
        port: 8000
    autoscaling:
      min: 1
      max: 1
    docker:
      dockerfile: Dockerfile
```

### Step 2: Optimize MongoDB Connection

In your MongoDB Atlas:
1. Go to **Network Access** → Add `0.0.0.0/0` (or Koyeb IPs)
2. Enable **Connection Pooling** in driver settings
3. Choose **region closest to Koyeb** (e.g., `us-east-1` for Washington)

### Step 3: Deploy to Koyeb

```bash
# Install Koyeb CLI
curl -fsSL https://cli.koyeb.com/install.sh | sh

# Login
koyeb login

# Deploy
koyeb app create discord-bot --git github.com/YOUR_USERNAME/Discord-Vc-Alert

# Or use Docker Hub
koyeb service create discord-bot \
  --docker YOUR_DOCKERHUB_USERNAME/discord-bot:latest \
  --ports 8000:http \
  --routes /:8000 \
  --env TOKEN=YOUR_TOKEN \
  --env MONGO_URI=YOUR_MONGO_URI
```

### Step 4: Keep Bot Alive (Prevent Cold Starts)

Create a **UptimeRobot** monitor:
- URL: `https://your-koyeb-app.koyeb.app/`
- Interval: Every 5 minutes
- Type: HTTP(s)

This pings your bot every 5 minutes, preventing cold starts.

---

## 🚂 Alternative: Railway (Fastest, Most Reliable)

Railway has the best performance for Discord bots:

### Setup:

1. Go to [railway.app](https://railway.app)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Connect your GitHub repo
4. Add environment variables:
   - `TOKEN` = Your Discord bot token
   - `MONGO_URI` = Your MongoDB connection string
5. Deploy!

**Advantages**:
- ✅ No cold starts
- ✅ Always-on instances
- ✅ <500ms latency
- ✅ Free $5/month credit (then $5/mo)

---

## 🌐 Cloudflare Workers (Limited Features)

⚠️ **IMPORTANT**: Cloudflare Workers **CANNOT** run full Discord bots because:
- Discord requires persistent WebSocket connections (Gateway API)
- Workers are stateless and request-based (max 30s execution)
- Voice features require persistent connections

### What CAN Work on Workers:
- Slash command responses via Interactions Endpoint
- Button/select menu interactions
- Basic HTTP-based commands

### What CANNOT Work:
- ❌ Real-time voice state updates (join/leave alerts)
- ❌ Presence updates (online alerts)
- ❌ Soundboard with voice playback
- ❌ Live event monitoring

### If You Still Want to Try:

1. Create `wrangler.toml`:

```toml
name = "discord-bot-worker"
main = "worker-bot.js"
compatibility_date = "2024-01-01"

[vars]
DISCORD_PUBLIC_KEY = "your_public_key_here"

[env.production]
name = "discord-bot-worker"
```

2. Deploy:

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

3. In Discord Developer Portal:
   - Go to **General Information** → Copy **Public Key**
   - Go to **General Information** → Set **Interactions Endpoint URL** to:
     `https://discord-bot-worker.YOUR_SUBDOMAIN.workers.dev/interactions`

**Verdict**: ❌ Not recommended for this bot. Use Koyeb/Railway instead.

---

## 🐳 Docker Deployment (VPS)

For full control, deploy to any VPS:

### DigitalOcean / Linode / Vultr:

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Clone your repo
git clone https://github.com/YOUR_USERNAME/Discord-Vc-Alert.git
cd Discord-Vc-Alert

# Create .env file
cat > .env << EOF
TOKEN=your_discord_token
MONGO_URI=your_mongodb_uri
PORT=8000
EOF

# Build and run
docker build -t discord-bot .
docker run -d --name discord-bot --restart unless-stopped -p 8000:8000 --env-file .env discord-bot

# Check logs
docker logs -f discord-bot
```

---

## 📊 Performance Comparison

| Metric | Koyeb (Optimized) | Railway | Cloudflare Workers | VPS |
|--------|-------------------|---------|-------------------|-----|
| **Alert Latency** | 0.5-2s | 0.2-0.5s | ❌ N/A | 0.1-0.5s |
| **Cold Start** | 30-60s (with UptimeRobot: 0s) | None | None | None |
| **Uptime** | 99.5% | 99.9% | 99.99% | 99.5% |
| **Cost (Monthly)** | Free | $5 | Free* | $6+ |
| **Setup Time** | 10 min | 5 min | 30 min | 60 min |

*Workers are free but can't run this bot properly.

---

## 🎯 Final Recommendation

### For Best Performance & Reliability:
**Use Railway** ($5/month) - Zero cold starts, <500ms latency

### For Free Hosting:
**Use Koyeb** with optimizations:
1. Deploy the optimized `bot.js` (non-blocking logs)
2. Set up UptimeRobot for ping monitoring
3. Choose MongoDB region close to Koyeb region
4. Enable connection pooling

### For Learning/Testing:
**Run locally** or use **Render's free tier**

---

## 🔧 Monitoring & Debugging

### Check Bot Status:
```bash
# Health check
curl https://your-app.koyeb.app/

# Should return:
{"status":"✅ ʙᴏᴛ ɪs ᴀʟɪᴠᴇ ᴀɴᴅ ᴠɪʙɪɴɢ"}
```

### View Logs:
- **Koyeb**: Dashboard → Service → Logs
- **Railway**: Dashboard → Deployments → Logs
- **Docker**: `docker logs -f discord-bot`

### Common Issues:

1. **Slow alerts**: 
   - Check MongoDB region (should match app region)
   - Verify UptimeRobot is pinging

2. **Bot offline**:
   - Check logs for errors
   - Verify TOKEN is correct
   - Ensure bot has Gateway intents enabled

3. **Database errors**:
   - Check MONGO_URI format
   - Verify IP whitelist in MongoDB Atlas
   - Test connection with `mongosh`

---

## 📞 Support

If you experience persistent delays >2 seconds:
1. Share your deployment platform
2. Share region (app + MongoDB)
3. Check if UptimeRobot is configured
4. Verify bot logs for errors

Happy deploying! 🚀
