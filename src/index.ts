import dotenv from 'dotenv';

// Load environment variables first, before importing other modules
dotenv.config();

import botManager from './botManager';
import './health'; // Start health check server
import { startUserMonitoring } from './utils/welcomeService';

console.log('🚀 Starting TaskMate service...');

// Start all bots for all organizations
const botsStarted = await botManager.startAllBots();

if (botsStarted) {
  console.log('✅ Successfully started organization-specific bots');
  console.log('📊 Initial bot status:', botManager.getBotStatus());
  
  // Start user monitoring for welcome messages
  const userMonitoring = await startUserMonitoring();
  if (userMonitoring) {
    console.log('✅ Successfully started user monitoring service for welcome messages');
  } else {
    console.warn('⚠️ Failed to start user monitoring service for welcome messages');
  }
} else {
  console.error('❌ Failed to start organization-specific bots');
  console.warn('⚠️ Continuing application execution despite bot startup failure');
  // Don't exit with error code to prevent PM2 restart loop
  // process.exit(1);
}

console.log('🎉 TaskMate services are running!');

// Handle graceful shutdown
async function handleShutdown(signal: string) {
  console.log(`\n📡 Received ${signal}, initiating graceful shutdown...`);

  try {
    await botManager.gracefulShutdown();
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  handleShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  handleShutdown('unhandledRejection');
});