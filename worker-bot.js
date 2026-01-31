/**
 * CLOUDFLARE WORKER VERSION - Discord VC Alert Bot
 * 
 * NOTE: Cloudflare Workers have limitations for Discord bots:
 * 1. Cannot maintain persistent WebSocket connections (required for Discord Gateway)
 * 2. Cannot use @discordjs/voice for audio playback
 * 3. Best suited for webhook-based interactions only
 * 
 * RECOMMENDATION: Use this for slash commands via interactions endpoint
 * For real-time voice state updates, use the original bot.js on a persistent server
 */

import { Router } from 'itty-router';
import { verifyKey } from 'discord-interactions';

const router = Router();

// Environment variables needed:
// - DISCORD_PUBLIC_KEY
// - DISCORD_TOKEN
// - MONGO_URI (use MongoDB Atlas with Data API or Cloudflare D1)

/**
 * Main Discord Interactions Endpoint
 */
router.post('/interactions', async (request, env) => {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  // Verify Discord signature
  const isValidRequest = verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!isValidRequest) {
    return new Response('Invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(body);

  // Handle Discord PING
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Handle slash commands
  if (interaction.type === 2) {
    return handleCommand(interaction, env);
  }

  // Handle button interactions
  if (interaction.type === 3) {
    return handleComponent(interaction, env);
  }

  return new Response('Unknown interaction type', { status: 400 });
});

/**
 * Health check endpoint
 */
router.get('/', () => {
  return new Response(JSON.stringify({ status: '✅ Worker is alive and vibing' }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

/**
 * Handle slash commands
 */
async function handleCommand(interaction, env) {
  const { name, options } = interaction.data;
  
  // Example: /settings command
  if (name === 'settings') {
    return new Response(JSON.stringify({
      type: 4,
      data: {
        embeds: [{
          title: '⚙️ Settings',
          description: 'Voice activity alerts configuration panel',
          color: 0x5865f2
        }]
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({
    type: 4,
    data: {
      content: 'Command not implemented in Worker version',
      flags: 64
    }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Handle component interactions (buttons, select menus)
 */
async function handleComponent(interaction, env) {
  const customId = interaction.data.custom_id;
  
  return new Response(JSON.stringify({
    type: 4,
    data: {
      content: 'Button interaction received',
      flags: 64
    }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Worker entry point
 */
export default {
  fetch: async (request, env, ctx) => {
    return router.handle(request, env, ctx).catch(err => {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    });
  }
};
