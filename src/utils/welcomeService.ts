import { sendTelegramNotification, sendTeamsNotification, sendWhatsAppNotification, sendSlackNotification } from '../botManager';
import { supabase } from '../utils/supabase';

// Welcome message template
const WELCOME_MESSAGE = `Welcome to TaskMate! 

I'm your personal task assistant. I'll help you manage your tasks, set reminders, and stay organized.

Here are the specific commands you can use:
- "create task" - Create a new task
- "update status" - Update status of your tasks
- "edit task" - Make changes to existing tasks
- "send remainder" - Send reminders (admin only)
- "show all tasks" - View all your tasks

Feel free to ask if you need any assistance!`;

// Track the last time we checked for new users
let lastCheckTimestamp: string | null = null;

/**
 * Start monitoring for new users using polling instead of real-time subscription
 */
export async function startUserMonitoring() {
  try {
    console.log('🔍 Starting user monitoring for welcome messages...');
    
    // First check for any existing users who haven't received a welcome message
    await checkForUnwelcomedUsers();
    
    // Set the initial timestamp
    lastCheckTimestamp = new Date().toISOString();
    console.log(`Initial timestamp set to: ${lastCheckTimestamp}`);
    
    // Set up polling to check for new users every minute
    console.log('Setting up polling to check for new users...');
    
    const pollingInterval = setInterval(async () => {
      try {
        console.log('Polling for new users...');
        await checkForNewUsers();
      } catch (error) {
        console.error('Error in polling interval:', error);
      }
    }, 60000); // Check every minute
    
    // Also run immediately
    await checkForNewUsers();
    
    console.log('✅ User monitoring started successfully');
    
    // Return the interval for cleanup
    return pollingInterval;
  } catch (error) {
    console.error('❌ Error starting user monitoring:', error);
    return null;
  }
}

/**
 * Check for new users added since the last check
 */
async function checkForNewUsers() {
  try {
    if (!lastCheckTimestamp) {
      lastCheckTimestamp = new Date().toISOString();
      return;
    }
    
    const currentTimestamp = new Date().toISOString();
    console.log(`Checking for users added between ${lastCheckTimestamp} and ${currentTimestamp}`);
    
    // Query for users created after the last check timestamp
    const { data: newUsers, error } = await supabase
      .from('users')
      .select('id, name, email')
      .gt('created_at', lastCheckTimestamp)
      .lt('created_at', currentTimestamp);
    
    if (error) {
      console.error('Error checking for new users:', error);
      return;
    }
    
    // Process any new users
    if (newUsers && newUsers.length > 0) {
      console.log(`Found ${newUsers.length} new users`);
      
      for (const newUser of newUsers) {
        console.log(`Processing new user: ${newUser.name || newUser.email || newUser.id}`);
        await processNewUser(newUser);
      }
    } else {
      console.log('No new users found');
    }
    
    // Update the timestamp for the next check
    lastCheckTimestamp = currentTimestamp;
  } catch (error) {
    console.error('Error checking for new users:', error);
  }
}

/**
 * Process a new user
 */
async function processNewUser(newUser: any) {
  try {
    // Check if this user already has a welcome message in the reminders table
    const { data: existingWelcomes, error: welcomeCheckError } = await supabase
      .from('reminders')
      .select('id')
      .eq('user_id', newUser.id)
      .eq('type', 'welcome')
      .limit(1);
    
    if (welcomeCheckError) {
      console.error('❌ Error checking for existing welcome messages:', welcomeCheckError);
    }
    
    // Only send welcome message if the user hasn't received one yet
    if (!existingWelcomes || existingWelcomes.length === 0) {
      console.log(`📨 Sending welcome message to new user ${newUser.id}`);
      await sendWelcomeMessage(newUser.id);
    } else {
      console.log(`⏭️ User ${newUser.id} already received a welcome message, skipping`);
    }
  } catch (error) {
    console.error('❌ Error processing new user:', error);
  }
}

/**
 * Handles new user events from the Supabase subscription
 */
async function handleNewUser(payload: any) {
  try {
    console.log('Received payload:', JSON.stringify(payload, null, 2));
    
    // Extract the new user data
    const newUser = payload.new;
    if (!newUser || !newUser.id) {
      console.error('❌ Invalid user data in payload');
      return;
    }
    
    console.log(`🆕 New user detected: ${newUser.name || newUser.email || newUser.id}`);
    
    // Check if this user already has a welcome message in the reminders table
    const { data: existingWelcomes, error: welcomeCheckError } = await supabase
      .from('reminders')
      .select('id')
      .eq('user_id', newUser.id)
      .eq('type', 'welcome')
      .limit(1);
    
    if (welcomeCheckError) {
      console.error('❌ Error checking for existing welcome messages:', welcomeCheckError);
    }
    
    // Only send welcome message if the user hasn't received one yet
    if (!existingWelcomes || existingWelcomes.length === 0) {
      console.log(`📨 Sending welcome message to new user ${newUser.id}`);
      await sendWelcomeMessage(newUser.id);
    } else {
      console.log(`⏭️ User ${newUser.id} already received a welcome message, skipping`);
    }
  } catch (error) {
    console.error('❌ Error handling new user event:', error);
  }
}

/**
 * Checks for users who haven't received welcome messages yet
 */
async function checkForUnwelcomedUsers() {
  try {
    // First get all users who have received welcome messages
    const { data: welcomedUsers, error: welcomedError } = await supabase
      .from('reminders')
      .select('user_id')
      .eq('type', 'welcome');
    
    if (welcomedError) {
      console.error('❌ Error fetching welcomed users:', welcomedError);
      return;
    }
    
    // Extract user IDs who have already received welcome messages
    const welcomedUserIds = welcomedUsers?.map(record => record.user_id) || [];
    
    // Get all users
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email');
    
    if (error) {
      console.error('❌ Error fetching all users:', error);
      return;
    }
    
    // Filter users who haven't received welcome messages
    const unwelcomedUsers = users?.filter(user => !welcomedUserIds.includes(user.id)) || [];
    
    if (unwelcomedUsers.length > 0) {
      console.log(`🔔 Found ${unwelcomedUsers.length} users who haven't received welcome messages`);
      
      for (const user of unwelcomedUsers) {
        await sendWelcomeMessage(user.id);
      }
    }
  } catch (error) {
    console.error('❌ Error checking for unwelcomed users:', error);
  }
}

/**
 * Sends a welcome message to a user and records it in the reminders table
 * @param userId The ID of the user to send the welcome message to
 */
async function sendWelcomeMessage(userId: string) {
  try {
    console.log(`📨 Sending welcome message to user ${userId}`);
    
    // Get user details
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, name, email, organization_id, slack_email, telegram_id, whatsapp_number, teams_email')
      .eq('id', userId)
      .single();
    
    if (userError || !user) {
      console.error(`❌ Error fetching user data for user ${userId}:`, userError);
      return false;
    }
    
    // First store the welcome message in the reminders table
    // This ensures we have a record even if sending fails
    const now = new Date().toISOString();
    const { error: reminderError } = await supabase
      .from('reminders')
      .insert({
        user_id: userId,
        message: WELCOME_MESSAGE,
        type: 'welcome',
        sent: true,
        sent_at: now,
        created_at: now,
        scheduled_for: now,
        reminder_time: now, // Add reminder_time field to satisfy not-null constraint
        organization_id: user.organization_id,
        user_email: user.email // Store the user's email in the reminders table
      });
    
    if (reminderError) {
      console.error(`❌ Error recording welcome message for user ${userId}:`, reminderError);
      // Continue anyway to try sending the message
    } else {
      console.log(`✅ Recorded welcome message in reminders table for user ${userId}`);
    }
    
    // Get the user's organization integrations
    let integrations: { token_type: string, token_value: string }[] = [];
    
    if (user.organization_id) {
      const { data: orgIntegrations, error: integrationsError } = await supabase
        .from('integration_tokens')
        .select('token_type, token_value')
        .eq('organization_id', user.organization_id)
        .eq('is_active', true);
      
      if (integrationsError) {
        console.error(`❌ Error fetching integrations for organization ${user.organization_id}:`, integrationsError);
      } else if (orgIntegrations && orgIntegrations.length > 0) {
        integrations = orgIntegrations;
      }
    }
    
    if (integrations.length === 0) {
      console.warn(`⚠️ No active integrations found for user ${userId}${user.organization_id ? ` (organization ${user.organization_id})` : ' (no organization)'}`);
      console.log(`✅ Welcome message recorded in database. Will try direct messaging if user has contact info.`);
      
      // Even without organization integrations, we can try to send welcome messages 
      // directly based on the user contact info we already fetched
    }
    
    console.log(`Found ${integrations.length} active integrations for user ${userId}`);
    
    // Send welcome message to each platform
    let successCount = 0;
    
    // Try sending to Telegram
    try {
      const hasTelegramIntegration = integrations.some(i => i.token_type === 'TELEGRAM_BOT');
      if (hasTelegramIntegration || user.telegram_id) {
        console.log(`Sending Telegram welcome message to user ${userId}`);
        const telegramSuccess = await sendTelegramNotification(userId, WELCOME_MESSAGE);
        if (telegramSuccess) {
          successCount++;
          console.log(`✅ Successfully sent Telegram welcome message to user ${userId}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error sending Telegram welcome message:`, error);
    }
    
    // Try sending to Slack
    try {
      const hasSlackIntegration = integrations.some(i => ['SLACK_BOT', 'SLACK_APP'].includes(i.token_type));
      if (hasSlackIntegration || user.slack_email) {
        console.log(`Sending Slack welcome message to user ${userId}`);
        
        // For Slack, we'll use the welcome message but ensure it goes through direct message channel
        const slackSuccess = await sendSlackNotification(userId, WELCOME_MESSAGE);
        
        if (slackSuccess) {
          successCount++;
          console.log(`✅ Successfully sent Slack welcome message to user ${userId}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error sending Slack welcome message:`, error);
    }
    
    // Try sending to Teams
    try {
      const hasTeamsIntegration = integrations.some(i => ['MICROSOFT_APP_PASSWORD', 'MICROSOFT_APP_ID', 'MICROSOFT_APP_TENANT_ID'].includes(i.token_type));
      if (hasTeamsIntegration || user.teams_email) {
        console.log(`Sending Teams welcome message to user ${userId}`);
        const teamsSuccess = await sendTeamsNotification(userId, WELCOME_MESSAGE);
        if (teamsSuccess) {
          successCount++;
          console.log(`✅ Successfully sent Teams welcome message to user ${userId}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error sending Teams welcome message:`, error);
    }
    
    // Try sending to WhatsApp
    try {
      const hasWhatsAppIntegration = integrations.some(i => ['WHATSAPP_API', 'WHATSAPP_INSTANCE_ID', 'WHATSAPP_SECURITY_TOKEN'].includes(i.token_type));
      if (hasWhatsAppIntegration || user.whatsapp_number) {
        console.log(`Sending WhatsApp welcome message to user ${userId}`);
        const whatsappSuccess = await sendWhatsAppNotification(userId, WELCOME_MESSAGE);
        if (whatsappSuccess) {
          successCount++;
          console.log(`✅ Successfully sent WhatsApp welcome message to user ${userId}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error sending WhatsApp welcome message:`, error);
    }
    
    const success = successCount > 0;
    if (success) {
      console.log(`✅ Successfully sent welcome messages to ${user.name || user.email} on ${successCount} platform(s)`);
    } else {
      console.log(`⚠️ Welcome message recorded in database, but couldn't send to any platform for user ${userId}`);
      // Still consider this a success since we recorded the message
      return true;
    }
    
    return success;
  } catch (error) {
    console.error(`❌ Error in sendWelcomeMessage for user ${userId}:`, error);
    return false;
  }
}