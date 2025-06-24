# -------- STAGE 1: Build native modules --------
FROM node:20-slim as build

# Install build tools for native dependencies
RUN apt-get update && apt-get install -y \
  build-essential \
  python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy and install dependencies (builds @discordjs/opus from source if needed)
COPY package*.json ./
RUN npm install

# Copy rest of the bot code
COPY . .

# -------- STAGE 2: Runtime (smaller image) --------
FROM node:20-slim

# Install only necessary runtime deps (ffmpeg & sodium)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libsodium18 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy everything from build stage
COPY --from=build /usr/src/app /usr/src/app

# Start your bot
CMD ["node", "bot.js"]