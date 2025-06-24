# Stage 1: Build environment with required tools
FROM node:20 AS build

# Install dependencies for building native modules
RUN apt-get update && apt-get install -y \
  build-essential \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Stage 2: Runtime (smaller final image)
FROM node:20-slim

# Install only runtime dependencies
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libsodium18 \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Copy installed node_modules and app from build stage
COPY --from=build /usr/src/app /usr/src/app

# Start the bot
CMD ["node", "bot.js"]