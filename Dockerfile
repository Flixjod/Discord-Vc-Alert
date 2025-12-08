# Use official Node.js 20 image
FROM node:20

# 1. Install System Dependencies
# - ffmpeg: Required to play music/audio
# - python3, make, g++: Required to build 'sodium-native' (encryption)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your bot code
COPY . .

# 2. Fix Port Exposure
# Your index.js uses port 8000, so we must expose 8000
EXPOSE 8000

# Start the bot
CMD ["npm", "start"]