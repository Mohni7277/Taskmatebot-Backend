// // index.ts
// import dotenv from 'dotenv';

// // import { startAPI } from './app/api/telegram.ts';
// import { startBot } from './slackBot';
// // import { startReminderService } from './utils/reminderService';
// // import { startAPI } from './app/api/telegram';
// import { startBot as startTelegramBot } from './telegramBot';
// import { startBot as startTeamsBot } from './teamsBot';
// // import { startReminderService } from './utils/reminderService';
// // import { startBot as startwhatsappBot } from './whatsappBot';

// // Load environment variables
// dotenv.config();

// console.log('Starting TaskMate services...');
// // startAPI()

// // Start the Telegram bot
// startTelegramBot();

// // startwhatsappBot();

// // Start the Teams bot
// // startTeamsBot();

// // startBot();

// // Start the reminder service
// // startReminderService();

// console.log('TaskMate services are running!');

// // Handle graceful shutdown
// process.on('SIGINT', () => {
//   console.log('Shutting down...');
//   process.exit(0);
// });

// process.on('SIGTERM', () => {
//   console.log('Shutting down...');
//   process.exit(0);
// });


import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';

// Import all bot agents
import { slackBotAgent } from './agents/slackBotAgent';
import { teamsBotAgent } from './agents/teamsBotAgent';
import { whatsappBotAgent } from './agents/whatsappBotAgent';
import { telegramBotAgent } from './agents/telegramBotAgent';

// import { startServer } from './api'; // Import the startServer function

// Import Supabase types for proper typing
import { SupabaseClient } from '@supabase/supabase-js';

// Declare global db variable with proper typing to fix TypeScript errors
declare global {
  var db: SupabaseClient | any;
}

export const mastra = new Mastra({
  // storage: new LibSQLStore({
  //   // stores telemetry, evals, ... into memory storage using a persistent file
  //   url: "file:../mastra.db",
  // }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  agents: {
    slackBot: slackBotAgent,
    teamsBot: teamsBotAgent,
    whatsappBot: whatsappBotAgent,
    telegramBot: telegramBotAgent
  }
});