// Script to start the Teams bot
import dotenv from 'dotenv';
import path from 'path';
import { startBot, startTeamsServer } from './src/mastra/teamsBot.ts';

// Load environment variables
const env = process.env.NODE_ENV || 'dev';

// Build the path to the correct .env file
const envFile = path.resolve(__dirname, `../.env.${env}`);

// Load the environment variables from the selected file
dotenv.config({ path: envFile });

console.log('Starting Teams bot...');

// Set port explicitly to 3000 to avoid port 8080 conflict
// process.env.PORT = '4321';
// const port = '4321';
// console.log(`Teams bot will run on port ${port}`);

// Start the bot with specific organization ID that's failing
const targetOrgId = 'd642be72-9f53-4000-854a-cf54afa87d62'; // The org ID from the error logs

// Start the Teams bot with the specific organization configuration
async function startTeamsBot() {
  try {
    // Start the default bot first to properly initialize the adapter and agent
    // console.log('Starting default Teams bot configuration...');
    // await startBot();
    
    // Then start the Teams server
    console.log('Starting Teams server...');
    await startTeamsServer();
    
    console.log('Teams bot started successfully');
    console.log(`Teams bot should be listening on port ${process.env.PORT}`);
  } catch (error) {
    console.error('Failed to start Teams bot:', error);
    process.exit(1);
  }
}

// Start the Teams bot
startTeamsBot()
  .then(() => {
    console.log('Teams bot system initialized successfully');
  })
  .catch((error) => {
    console.error('Failed to initialize Teams bot system:', error);
    process.exit(1);
  });
