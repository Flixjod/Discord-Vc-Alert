FROM node:18

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Create app directory
WORKDIR /usr/src/app

# Copy files
COPY package*.json ./
RUN npm install

COPY . .

# Start the bot
CMD [ "npm", "start" ]
