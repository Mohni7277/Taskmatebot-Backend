// WhatsApp Bot Entry Point for Cloud Run Deployment
import { startBot, startReminderService } from './mastra/whatsappBot';
import dotenv from 'dotenv';

// Load .env file if present (primarily for local development)
dotenv.config();

async function main() {
  console.log('🚀 Initializing WhatsApp Bot for Cloud Run...');
  
  // Set default port for Cloud Run if not provided
  const port = process.env.PORT || process.env.WEBHOOK_PORT || '8080';
  process.env.WEBHOOK_PORT = port;
  
  console.log(`📱 WhatsApp Bot will listen on port: ${port}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  try {
    // startBot will internally ensure the Hono server starts and listens on the correct port
    const success = await startBot();
    
    if (success) {
      console.log('✅ WhatsApp Bot started successfully');
      
      // Start the reminder service if enabled
      if (process.env.START_REMINDER_SERVICE === 'true' || process.env.NODE_ENV === 'production') {
        startReminderService();
        console.log('⏰ WhatsApp Reminder Service started');
      }
      
      // Keep the process alive
      process.on('SIGINT', () => {
        console.log('🛑 Received SIGINT, shutting down gracefully...');
        process.exit(0);
      });
      
      process.on('SIGTERM', () => {
        console.log('🛑 Received SIGTERM, shutting down gracefully...');
        process.exit(0);
      });
      
      console.log('🎯 WhatsApp Bot is ready to receive messages');
    } else {
      throw new Error('Failed to start WhatsApp Bot');
    }
  } catch (error) {
    console.error('❌ Failed to start WhatsApp Bot:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

main().catch(error => {
  console.error('❌ Failed to start WhatsApp Bot:', error);
  process.exit(1);
});
