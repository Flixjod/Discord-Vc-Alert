FROM node:20

# Install build tools required for native module compilation
RUN apt-get update && apt-get install -y build-essential python3

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Start your bot
CMD ["node", "index.js"]