// Script to start the WhatsApp bot
import { startBot } from './src/mastra/whatsappBot.ts';

console.log('Starting WhatsApp bot...');

// Start the bot with default configuration
startBot()
  .then(() => {
    console.log('WhatsApp bot started successfully');
  })
  .catch((error) => {
    console.error('Failed to start WhatsApp bot:', error);
    process.exit(1);
  });
