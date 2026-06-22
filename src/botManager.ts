import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import * as slackBotModule from "./mastra/slackBot";
import { startBot as startTelegramBot } from "./mastra/telegramBot";
import teamsBotModule from "./mastra/teamsBot";
import { startBot as startWhatsappBot } from "./mastra/whatsappBot";

// Load environment variables
dotenv.config();

// Create TypeScript declarations for our globals
declare global {
  var db: any; // For the Supabase client
}

// Create Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Initialize global.db with the Supabase client for use in tools and agents
global.db = supabase;

// Interface for organization data
interface Organization {
  id: string;
  name: string;
  settings?: {
    slack?: {
      enabled: boolean;
      [key: string]: any;
    };
    telegram?: {
      enabled: boolean;
      [key: string]: any;
    };
    teams?: {
      enabled: boolean;
      adminEmail?: string;
      appId?: string;
      appPassword?: string;
      tenantId?: string;
      port?: number;
      [key: string]: any;
    };
    whatsapp?: {
      enabled: boolean;
      adminNumber?: string;
      apiKey?: string;
      instanceId?: string;
      securityToken?: string;
      webhookPort?: number;
      [key: string]: any;
    };
    [key: string]: any;
  };
}

// Interface for organization-specific configuration
interface OrgConfig {
  orgId: string;
  orgName: string;
  adminUsers: any[];
  settings: {
    [key: string]: any;
  };
}

// Store running bot instances with resource tracking
const runningBots: {
  [orgId: string]: {
    telegram?: boolean;
    slack?: boolean;
    teams?: boolean;
    whatsapp?: boolean;
    startTime?: Date;
    memoryUsage?: number;
    cpuUsage?: number;
    lastTokensHash?: string; // Hash of organization tokens for change detection
    [key: string]: any;
  };
} = {};

// Track if organization refresh is already in progress
let isRefreshingOrganizations = false;

// Store interval references for cleanup
let organizationRefreshInterval: NodeJS.Timeout | null = null;
let resourceMonitoringInterval: NodeJS.Timeout | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;

// Helper to check if a reminder has already been sent recently using database-based deduplication
// Enhanced to persist across application restarts and handle deadline-based reminder frequency with robust fixes
async function hasReminderBeenSentRecently(userId: string, taskId: string, message: string): Promise<boolean> {  try {
    console.log(`🔍 Checking database-based deduplication for user ${userId}, task ${taskId || 'notification'}`);
    
    // Extract the real task ID if it's in composite format
    let realTaskId = taskId;
    if (taskId && taskId.includes('_')) {
      const parts = taskId.split('_');
      if (parts.length >= 2 && parts[1].length > 30) {
        realTaskId = parts[0];
      } else if (taskId.startsWith('custom_') && parts.length >= 2) {
        realTaskId = `custom_${parts[1]}`;
      }
    }
    
    console.log(`🔑 Real task ID: ${realTaskId}, Original task ID: ${taskId}`);
    
    // Check if this is a deadline-related reminder (contains deadline-related keywords)
    const isDeadlineReminder = 
      message.toLowerCase().includes('deadline') || 
      message.toLowerCase().includes('due date') || 
      message.toLowerCase().includes('overdue') ||
      message.toLowerCase().includes('due tomorrow') ||
      message.toLowerCase().includes('due today');
    
    // Get task details if this is a task-related reminder
    let isOverdue = false;
    let isDueTomorrow = false;
    let timeWindow = 10 * 60 * 1000; // Default 10 minutes for regular reminders
    
    // If this is a task with a deadline, check if it's overdue or due tomorrow
    if (realTaskId && realTaskId !== 'notification' && !realTaskId.startsWith('custom_')) {
      try {
        // Fetch task details to check deadline
        const { data: taskData } = await supabase
          .from('tasks')
          .select('deadline, status')
          .eq('id', realTaskId)
          .single();
        
        if (taskData && taskData.deadline) {
          const deadline = new Date(taskData.deadline);
          const now = new Date();
          
          // If task is overdue, we'll allow hourly reminders
          isOverdue = now > deadline;
          
          if (isOverdue) {
            console.log(`📅 Task ${realTaskId} is overdue (deadline: ${deadline.toISOString()})`);
            // For overdue tasks, check for reminders in the last hour
            timeWindow = 60 * 60 * 1000; // 1 hour for overdue reminders
          } else {
            // For non-overdue tasks with deadlines, check if reminder was sent in the last day
            // This ensures we only remind once per day before the deadline
            const daysTillDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
            
            if (daysTillDeadline <= 1) {
              // If deadline is tomorrow or today, check for reminders in the last 24 hours
              console.log(`📅 Task ${realTaskId} deadline is ${daysTillDeadline === 0 ? 'today' : 'tomorrow'} (${deadline.toISOString()})`);
              isDueTomorrow = (daysTillDeadline === 1);
              timeWindow = 24 * 60 * 60 * 1000; // 24 hours for day-before-deadline reminders
            }
          }
        }
      } catch (taskError: any) {
        console.warn(`⚠️ Could not fetch task details for ${realTaskId}: ${taskError?.message || 'Unknown error'}`);
      }
    }
    
    // If this is explicitly a deadline reminder (message contains deadline terms), use day-before window
    if (isDeadlineReminder && !isOverdue) {
      timeWindow = 24 * 60 * 60 * 1000; // 24 hours for explicit deadline reminders
      console.log(`📅 Explicit deadline reminder detected - using 24-hour window`);
    }
    
    // Calculate time window based on reminder type and task state
    const timeWindowAgo = new Date(Date.now() - timeWindow).toISOString();
    console.log(`⏰ Checking for reminders since: ${timeWindowAgo} (${timeWindow/60000} minutes ago)`);
      const { data: existingNotifications, error } = await supabase
      .from('notification_logs')
      .select('id, created_at, message, title')
      .eq('entity_id', realTaskId || 'notification')
      .eq('user_id', userId)
      .eq('type', 'reminder')
      .gte('created_at', timeWindowAgo)
      .order('created_at', { ascending: false })
      .limit(10);
      if (error) {
      console.warn('Error checking notification_logs for duplicates:', error.message);
      return false; // If we can't check, allow the notification to be sent
    }
    
    // Enhance check for existing notifications using multiple matching strategies
    if (existingNotifications && existingNotifications.length > 0) {
      // Check if any of the recent notifications have the same message content or similar content
      for (const notification of existingNotifications) {
        // Skip comparison if this is an overdue reminder and the existing one was sent more than an hour ago
        if (isOverdue) {
          const timeDiff = Date.now() - new Date(notification.created_at).getTime();
          if (timeDiff > 60 * 60 * 1000) {
            console.log(`⏰ OVERDUE REMINDER: Existing reminder from ${Math.round(timeDiff/60000)} minutes ago - allowing hourly reminder`);
            continue; // Skip this comparison, check next notification
          }
        }
        
        // For "due tomorrow" reminders, only deduplicate within the same day (after midnight, allow new reminder)
        if (isDueTomorrow) {
          const existingDate = new Date(notification.created_at);
          const today = new Date();
          // If the existing reminder was from a different day (yesterday), allow the new reminder
          if (existingDate.getDate() !== today.getDate() || existingDate.getMonth() !== today.getMonth()) {
            console.log(`📅 DUE TOMORROW: Existing reminder was from a different day - allowing new day-before reminder`);
            continue; // Skip this comparison, check next notification
          }        }

        // Check if we have similar message content by comparing normalized versions
        const savedMessage = notification.message || '';
        
        // Also check for similar content without the prefix variations
        const normalizedMessage = message
          .replace(/^⏰\s*(TASK REMINDER|REMINDER):\s*⏰\s*/, '')
          .replace(/\[.*?\]/g, '') // Remove markdown link syntax
          .trim();
          
        const normalizedExisting = (notification.message || '')
          .replace(/^⏰\s*(TASK REMINDER|REMINDER):\s*⏰\s*/, '')
          .replace(/\[.*?\]/g, '') // Remove markdown link syntax
          .trim();
        
        // Also strip timestamps and dates that might vary between identical reminders
        const strippedMessage = normalizedMessage
          .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, '<TIME>')
          .replace(/\b(today|tomorrow|yesterday)\b/gi, '<DAY>')
          .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi, '<DATE>');
          
        const strippedExisting = normalizedExisting
          .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, '<TIME>')
          .replace(/\b(today|tomorrow|yesterday)\b/gi, '<DAY>')
          .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi, '<DATE>');
          // Check message similarity using content comparison since we don't have message_hash
        let messageIsSimilar = false;
        
        // Strategy 1: Normalized content matching
        if (normalizedMessage === normalizedExisting || strippedMessage === strippedExisting) {
          messageIsSimilar = true;
        }
        
        // Strategy 2: For task reminders, check if the task title appears in both
        else if (realTaskId && !realTaskId.startsWith('custom_')) {
          const taskTitlePattern = /^(.*?)(?:\s*[-:]\s*.*)$/i;
          const messageMatch = normalizedMessage.match(taskTitlePattern);
          const existingMatch = normalizedExisting.match(taskTitlePattern);
          
          if (messageMatch && existingMatch && messageMatch[1].trim() === existingMatch[1].trim()) {
            messageIsSimilar = true;
          }
        }
        
        // Skip duplicate check for overdue tasks if notification is old (allow hourly reminders)
        if (messageIsSimilar) {
          const timeDiff = Date.now() - new Date(notification.created_at).getTime();
          console.log(`⚠️ DATABASE DEDUPLICATION: Found duplicate reminder for user ${userId}, task ${realTaskId}: sent ${Math.round(timeDiff/1000)}s ago`);
          
          // Allow new reminders in special cases:
          
          // Case 1: For overdue tasks, allow hourly reminders
          if (isOverdue && timeDiff > 60 * 60 * 1000) {
            console.log(`⏰ OVERDUE REMINDER: Allowing hourly reminder for overdue task ${realTaskId}`);
            continue; // Skip this notification, check next one
          }
          
          // Case 2: For "due tomorrow" reminders, allow one per day
          if (isDueTomorrow) {
            const existingTime = new Date(notification.created_at);
            const today = new Date();
            if (existingTime.getDate() !== today.getDate() || existingTime.getMonth() !== today.getMonth()) {
              console.log(`📅 DUE TOMORROW REMINDER: Allowing new day-before reminder as previous was on different day`);
              continue; // Skip this notification, check next one
            }
          }
          
          // Default: This is a duplicate, prevent sending
          return true;
        }
      }
    }
    
    // Also check for task completion - don't send reminders for completed tasks
    if (realTaskId && realTaskId !== 'notification' && !realTaskId.startsWith('custom_')) {
      try {
        // Quick check if task is already completed or canceled
        const { data: taskStatus } = await supabase
          .from('tasks')
          .select('status')
          .eq('id', realTaskId)
          .single();
        
        if (taskStatus && ['completed', 'cancelled', 'canceled'].includes(taskStatus.status.toLowerCase())) {
          console.log(`🚫 Task ${realTaskId} is already ${taskStatus.status} - skipping reminder`);
          return true; // Skip reminder for completed tasks
        }
      } catch (err) {
        console.warn(`Could not check task status for ${realTaskId}`);
      }
    }
    
    console.log(`✅ DATABASE DEDUPLICATION PASSED: This is a new/unique reminder for user ${userId}, task ${realTaskId}`);
    return false; // No duplicate found
    
  } catch (error) {
    console.error('Error in database-based deduplication check:', error);
    return false; // If there's an error, allow the notification to be sent (fail open)
  }
}

/**
 * Store a notification log entry in the database for deduplication purposes
 * Enhanced to include more metadata for improved deduplication across restarts,
 * including better task status tracking and deadline awareness
 * 
 * @param userId The user ID who received the notification
 * @param taskId The task ID (will be processed to extract real task ID)
 * @param message The notification message content
 * @param platform The platform through which the notification was sent
 * @returns Promise<boolean> true if stored successfully, false otherwise
 */
async function storeNotificationLog(userId: string, taskId: string, message: string, platform?: string): Promise<boolean> {
  try {
    // Extract the real task ID if it's in composite format
    let realTaskId = taskId;
    if (taskId && taskId.includes('_')) {
      const parts = taskId.split('_');
      if (parts.length >= 2 && parts[1].length > 30) {
        realTaskId = parts[0];
      } else if (taskId.startsWith('custom_') && parts.length >= 2) {
        realTaskId = `custom_${parts[1]}`;
      }
    }    
    // Normalize the message for content comparison
    const normalizedMessage = message.replace(/\s+/g, ' ').trim();
    
    // Check if this is a deadline-related reminder with expanded detection
    const isDeadlineReminder = 
      message.toLowerCase().includes('deadline') || 
      message.toLowerCase().includes('due date') || 
      message.toLowerCase().includes('overdue') ||
      message.toLowerCase().includes('due tomorrow') ||
      message.toLowerCase().includes('due today');
    
    // Detect reminder type for better categorization
    let reminderType = 'general';
    if (isDeadlineReminder) {
      reminderType = 'deadline';
    } else if (message.toLowerCase().includes('overdue')) {
      reminderType = 'overdue';
    } else if (realTaskId && realTaskId !== 'notification' && !realTaskId.startsWith('custom_')) {
      reminderType = 'task';
    } else if (realTaskId && realTaskId.startsWith('custom_')) {
      reminderType = 'custom';
    }
      // Get task details for overdue/deadline checking (if it's a task)
    let isOverdue = false;
    let isDueTomorrow = false;
    
    if (realTaskId && realTaskId !== 'notification' && !realTaskId.startsWith('custom_')) {
      try {
        const { data: taskData } = await supabase
          .from('tasks')
          .select('title, status, deadline, priority, assigned_to')
          .eq('id', realTaskId)
          .single();
        
        if (taskData) {
          // Check if task is overdue or due tomorrow
          if (taskData.deadline) {
            const deadline = new Date(taskData.deadline);
            const now = new Date();
            
            isOverdue = now > deadline;
            
            if (!isOverdue) {
              const daysTillDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
              isDueTomorrow = (daysTillDeadline === 1);
            }
          }
        }
      } catch (error) {
        // Just continue if we can't get task data
        console.log(`⚠️ Could not fetch task metadata for ${realTaskId}, continuing without it`);
      }
    }
      // Current application instance ID to track restarts
    const appInstanceId = process.env.APP_INSTANCE_ID || 
                          process.env.PM2_INSTANCE_ID || 
                          `app-${new Date().toISOString().slice(0, 10)}`;
    
    // Insert into notification_logs table with correct schema fields
    const { error } = await supabase
      .from('notification_logs')
      .insert({
        entity_id: realTaskId || 'notification',
        entity_type: realTaskId && realTaskId !== 'notification' ? 'task' : 'notification',
        user_id: userId,
        type: 'reminder',
        title: `Task reminder for ${realTaskId || 'notification'}`,
        message: message,
        platform: platform || 'system',
        status: 'sent',
        delivery_status: 'delivered'
      });
    
    if (error) {
      console.error('Error storing notification log:', error.message);
      return false;
    }
    
    console.log(`📝 Stored notification log for user ${userId}, task ${realTaskId}, platform ${platform || 'system'}`);
    
    // Also update last_reminded_at in the tasks table if this is a task reminder
    if (realTaskId && realTaskId !== 'notification' && !realTaskId.startsWith('custom_')) {
      try {
        await supabase
          .from('tasks')
          .update({
            last_reminded_at: new Date().toISOString(),
            last_reminder_sent_by: userId,
            reminder_count: supabase.rpc('increment_reminder_count', { task_id: realTaskId })
          })
          .eq('id', realTaskId);
          
        console.log(`📊 Updated last_reminded_at for task ${realTaskId}`);
      } catch (updateError) {
        console.warn(`⚠️ Could not update last_reminded_at for task ${realTaskId}`, updateError);
        // Continue even if this fails - it's not critical
      }
    }
    
    return true;
    
  } catch (error) {
    console.error('Error in storeNotificationLog:', error);
    return false;
  }
}

/**
 * Generate a hash of organization's integration tokens for change detection
 */
function generateTokensHash(org: Organization): string {
  try {
    const tokenData = {
      telegram: org.settings?.telegram?.enabled || false,
      slack: org.settings?.slack?.enabled || false,
      teams: org.settings?.teams?.enabled || false,
      whatsapp: org.settings?.whatsapp?.enabled || false,
      settings: JSON.stringify(org.settings || {})
    };
    
    // Create a simple hash from the stringified token data
    return Buffer.from(JSON.stringify(tokenData)).toString('base64');
  } catch (error) {
    console.error(`Error generating tokens hash for organization ${org.id}:`, error);
    return '';
  }
}

/**
 * Check if organization tokens or settings have changed
 * Enhanced with null safety and detailed logging
 */
function hasOrganizationChanged(org: Organization, currentHash?: string): boolean {
  // Generate a hash from current organization settings
  const newHash = generateTokensHash(org);
  
  // Special case for initial startup - always consider as changed to ensure bots start
  if (!currentHash) {
    console.log(`Organization ${org.name} (${org.id}) has no previous hash - treating as changed`);
    return true;
  }
  
  // Compare hashes
  const hasChanged = currentHash !== newHash;
  
  // Log detailed information if there's a change
  if (hasChanged) {
    // Log which platform settings might have changed
    const platformChanges: string[] = [];
    
    if (org.settings?.telegram?.enabled) platformChanges.push('Telegram');
    if (org.settings?.slack?.enabled) platformChanges.push('Slack');
    if (org.settings?.teams?.enabled) platformChanges.push('Teams');
    if (org.settings?.whatsapp?.enabled) platformChanges.push('WhatsApp');
    
    console.log(`Organization ${org.name} (${org.id}) settings have changed`);
    console.log(`Enabled platforms: ${platformChanges.join(', ') || 'None'}`);
  }
  
  return hasChanged;
}

/**
 * Stop all bots for a specific organization
 */
async function stopOrganizationBots(orgId: string, orgName: string): Promise<void> {
  console.log(`🛑 Stopping all bots for organization: ${orgName} (${orgId})`);
  
  try {
    // Stop individual bot instances - we'll implement graceful shutdown later
    // For now, just mark them as stopped in our tracking
    if (runningBots[orgId]) {
      runningBots[orgId].telegram = false;
      runningBots[orgId].slack = false;
      runningBots[orgId].teams = false;
      runningBots[orgId].whatsapp = false;
      
      console.log(`✅ Marked all bots as stopped for organization: ${orgName}`);
    }
  } catch (error) {
    console.error(`Error stopping bots for organization ${orgName}:`, error);
  }
}

/**
 * Restart bots for a specific organization due to token changes
 */
async function restartOrganizationBots(org: Organization): Promise<boolean> {
  console.log(`🔄 Restarting bots for organization: ${org.name} due to configuration changes`);
  
  try {
    // Stop existing bots first
    await stopOrganizationBots(org.id, org.name);
    
    // Small delay to ensure cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Start bots with new configuration
    const results = await startBotsForOrganizations([org]);
    
    // Update the tokens hash
    const newHash = generateTokensHash(org);
    if (runningBots[org.id]) {
      runningBots[org.id].lastTokensHash = newHash;
    }
    
    console.log(`✅ Completed bot restart for organization: ${org.name}`);
    return results[0] || false;
  } catch (error) {
    console.error(`Error restarting bots for organization ${org.name}:`, error);
    return false;
  }
}

/**
 * Fetch all organizations from the database
 */
async function fetchOrganizations(): Promise<Organization[]> {
  try {
    console.log("Fetching all organizations from database...");

    const { data, error } = await supabase
      .from("organizations")
      .select("id, name, settings");

    if (error) {
      console.error("Error fetching organizations:", error);
      return [];
    }

    console.log(`Found ${data?.length || 0} organizations`);
    return data || [];
  } catch (error) {
    console.error("Error in fetchOrganizations:", error);
    return [];
  }
}

/**
 * Fetch organization-specific integration tokens
 */
async function fetchOrganizationTokens(orgId: string): Promise<Record<string, string>> {
  try {
    console.log(`Fetching integration tokens for organization: ${orgId}`);

    const { data, error } = await supabase
      .from("integration_tokens")
      .select("token_type, token_value")
      .eq("organization_id", orgId)
      .eq("is_active", true);

    if (error) {
      console.error(`Error fetching tokens for organization ${orgId}:`, error);
      return {};
    }

    // Convert to a map of token_type -> token_value
    const tokens: Record<string, string> = {};
    data?.forEach(token => {
      tokens[token.token_type] = token.token_value;
    });

    return tokens;
  } catch (error) {
    console.error(`Error in fetchOrganizationTokens for ${orgId}:`, error);
    return {};
  }
}

/**
 * Start a Telegram bot for a specific organization
 */
async function startOrgTelegramBot(org: Organization): Promise<boolean> {
  try {
    if (!org.settings?.telegram?.enabled) {
      console.log(`Telegram bot disabled for organization: ${org.name}`);
      return false;
    }

    console.log(`🔄 Starting Telegram bot for organization: ${org.name}`);

    // Create organization config
    const orgConfig: OrgConfig = {
      orgId: org.id,
      orgName: org.name,
      adminUsers: [], // Could fetch admin users if needed
      settings: {
        telegram: org.settings.telegram
      }
    };
    
    // Start the bot with organization config
    const result = await startTelegramBot(orgConfig);

    // Safe update of running bots tracking without interfering with other bots
    if (result) {
      console.log(`✅ Successfully started Telegram bot for organization: ${org.name}`);
      // Thread-safe update of the bot status
      if (runningBots[org.id]) {
        runningBots[org.id].telegram = true;
      } else {
        runningBots[org.id] = {
          startTime: new Date(),
          memoryUsage: 0,
          cpuUsage: 0,
          telegram: true,
          slack: false,
          teams: false,
          whatsapp: false
        };
      }
    } else {
      console.error(`❌ Failed to start Telegram bot for organization: ${org.name}`);
    }

    return result;
  } catch (error) {
    console.error(`Error starting Telegram bot for organization ${org.name}:`, error);
    return false;
  }
}

/**
 * Start a Slack bot for a specific organization
 */
async function startOrgSlackBot(org: Organization): Promise<boolean> {
  try {
    if (!org.settings?.slack?.enabled) {
      console.log(`Slack bot disabled for organization: ${org.name}`);
      return false;
    }

    console.log(`🔄 Starting Slack bot for organization: ${org.name}`);

    // Create organization config
    const orgConfig: OrgConfig = {
      orgId: org.id,
      orgName: org.name,
      adminUsers: [], // Could fetch admin users if needed
      settings: {
        slack: org.settings.slack
      }
    };
    
    // Start the bot with organization config
    const result = await slackBotModule.startBot(orgConfig);

    // Safe update of running bots tracking without interfering with other bots
    if (result) {
      console.log(`✅ Successfully started Slack bot for organization: ${org.name}`);
      // Thread-safe update of the bot status
      if (runningBots[org.id]) {
        runningBots[org.id].slack = true;
      } else {
        runningBots[org.id] = {
          startTime: new Date(),
          memoryUsage: 0,
          cpuUsage: 0,
          telegram: false,
          slack: true,
          teams: false,
          whatsapp: false
        };
      }
    } else {
      console.error(`❌ Failed to start Slack bot for organization: ${org.name}`);
    }

    return result;
  } catch (error) {
    console.error(`Error starting Slack bot for organization ${org.name}:`, error);
    return false;
  }
}

/**
 * Start a Teams bot for a specific organization
 */
async function startOrgTeamsBot(org: Organization): Promise<boolean> {
  try {
    if (!org.settings?.teams?.enabled) {
      console.log(`Teams bot disabled for organization: ${org.name}`);
      return false;
    }

    console.log(`🔄 Starting Teams bot for organization: ${org.name}`);

    // Create organization config
    const orgConfig: OrgConfig = {
      orgId: org.id,
      orgName: org.name,
      adminUsers: [], // Could fetch admin users if needed
      settings: {
        teams: org.settings.teams
      }
    };

    // Start the bot with organization config
    // Note: Teams bot uses shared server instance, so we just need to start it once
    const result = await teamsBotModule.startBot(orgConfig);

    // Safe update of running bots tracking without interfering with other bots
    if (result) {
      console.log(`✅ Successfully started Teams bot for organization: ${org.name}`);
      // Thread-safe update of the bot status
      if (runningBots[org.id]) {
        runningBots[org.id].teams = true;
      } else {
        runningBots[org.id] = {
          startTime: new Date(),
          memoryUsage: 0,
          cpuUsage: 0,
          telegram: false,
          slack: false,
          teams: true,
          whatsapp: false
        };
      }
    } else {
      console.error(`❌ Failed to start Teams bot for organization: ${org.name}`);
    }

    return result;
  } catch (error) {
    console.error(`Error starting Teams bot for organization ${org.name}:`, error);
    return false;
  }
}

/**
 * Start a WhatsApp bot for a specific organization
 */
async function startOrgWhatsappBot(org: Organization): Promise<boolean> {
  try {
    if (!org.settings?.whatsapp?.enabled) {
      console.log(`WhatsApp bot disabled for organization: ${org.name}`);
      return false;
    }

    console.log(`🔄 Starting WhatsApp bot for organization: ${org.name}`);

    // Create organization config
    const orgConfig: OrgConfig = {
      orgId: org.id,
      orgName: org.name,
      adminUsers: [], // Could fetch admin users if needed
      settings: {
        whatsapp: org.settings.whatsapp
      }
    };
    
    // Start the bot with organization config
    const result = await startWhatsappBot(orgConfig);

    // Safe update of running bots tracking without interfering with other bots
    if (result) {
      console.log(`✅ Successfully started WhatsApp bot for organization: ${org.name}`);
      // Thread-safe update of the bot status
      if (runningBots[org.id]) {
        runningBots[org.id].whatsapp = true;
      } else {
        runningBots[org.id] = {
          startTime: new Date(),
          memoryUsage: 0,
          cpuUsage: 0,
          telegram: false,
          slack: false,
          teams: false,
          whatsapp: true
        };
      }
    } else {
      console.error(`❌ Failed to start WhatsApp bot for organization: ${org.name}`);
    }

    return result;
  } catch (error) {
    console.error(`Error starting WhatsApp bot for organization ${org.name}:`, error);
    return false;
  }
}

/**
 * Refresh organizations and restart bots as needed
 * This function ensures we have the latest organization data
 * especially after application restarts or when tokens are updated
 * Enhanced to detect and handle new organizations effectively and prevent
 * duplicate reminders across restarts or configuration changes
 */
async function refreshOrganizations(): Promise<boolean> {
  // Prevent concurrent refreshes with timeout
  if (isRefreshingOrganizations) {
    console.log("Organization refresh already in progress, skipping...");
    return true;
  }
  
  // Add a guard timeout to prevent a stuck refresh state
  let refreshTimeout: NodeJS.Timeout | null = null;
  
  try {
    isRefreshingOrganizations = true;
    
    // Set a 5-minute timeout to reset the refreshing flag if something gets stuck
    refreshTimeout = setTimeout(() => {
      if (isRefreshingOrganizations) {
        console.warn("⚠️ Organization refresh has been running for too long (>5 minutes). Resetting lock.");
        isRefreshingOrganizations = false;
      }
    }, 5 * 60 * 1000);
    
    // Log start of refresh with timestamp
    const startTime = Date.now();
    console.log(`🔄 Refreshing organizations and checking for token changes... (${new Date().toISOString()})`);
    resourceManager.logResourceUsage();

    // Fetch all organizations with fresh data
    const organizations = await fetchOrganizations();

    if (organizations.length === 0) {
      console.warn("⚠️ No organizations found in the database during refresh");
      isRefreshingOrganizations = false;
      if (refreshTimeout) clearTimeout(refreshTimeout);
      return false;
    }

    // Check for new organizations - enhanced to ensure we catch all new orgs
    const currentOrgIds = Object.keys(runningBots);
    console.log(`Current running organizations: ${currentOrgIds.length}`);
    console.log(`Total organizations in database: ${organizations.length}`);
    
    // Create tracking sets/arrays for better organization
    // 1. New organizations that need to be started
    const newOrgs = organizations.filter(org => !currentOrgIds.includes(org.id));
    
    // 2. Organizations that have configuration changes and need restart
    const changedOrgs: Organization[] = [];
    
    // 3. Organizations that exist but are not running properly (need repair)
    const repairOrgs: Organization[] = [];
    
    // Analyze each organization's current state
    for (const org of organizations) {
      if (currentOrgIds.includes(org.id)) {
        // Check if this organization's configuration has changed
        const currentTokensHash = runningBots[org.id]?.lastTokensHash;
        
        if (hasOrganizationChanged(org, currentTokensHash)) {
          console.log(`🔍 Detected configuration changes for organization: ${org.name} (${org.id})`);
          changedOrgs.push(org);
        }
        
        // Check if any bots that should be running aren't running
        const botStatus = runningBots[org.id];
        
        // If any bot should be running but isn't, add to repair list
        if (
          (org.settings?.telegram?.enabled && !botStatus.telegram) ||
          (org.settings?.slack?.enabled && !botStatus.slack) ||
          (org.settings?.teams?.enabled && !botStatus.teams) ||
          (org.settings?.whatsapp?.enabled && !botStatus.whatsapp)
        ) {
          console.log(`🔧 Found organization with mismatched bot state: ${org.name} (${org.id})`);
          repairOrgs.push(org);
        }
      }
    }
    
    // 4. Organizations that should be removed (no longer in database)
    const removedOrgIds = currentOrgIds.filter(orgId => 
      !organizations.some(org => org.id === orgId)
    );
    
    // Log organization changes for better debugging
    if (newOrgs.length > 0) {
      console.log(`📦 Found ${newOrgs.length} new organizations: `, newOrgs.map(o => o.name).join(', '));
    }
    if (changedOrgs.length > 0) {
      console.log(`🔄 Found ${changedOrgs.length} organizations with config changes: `, changedOrgs.map(o => o.name).join(', '));
    }
    if (repairOrgs.length > 0) {
      console.log(`🔧 Found ${repairOrgs.length} organizations needing repair: `, repairOrgs.map(o => o.name).join(', '));
    }
    if (removedOrgIds.length > 0) {
      console.log(`🗑️ Found ${removedOrgIds.length} organizations to remove: `, removedOrgIds.join(', '));
    }
    
    // STEP 1: Stop bots for removed organizations
    if (removedOrgIds.length > 0) {
      console.log(`🛑 Stopping bots for ${removedOrgIds.length} removed organizations...`);
      
      // Process removals in sequence to avoid conflicts
      for (const orgId of removedOrgIds) {
        try {
          console.log(`Stopping bots for removed organization: ${orgId}`);
          await stopOrganizationBots(orgId, orgId);
          
          // Small delay to ensure clean shutdown
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Remove from tracking only after shutdown complete
          delete runningBots[orgId]; 
          console.log(`✅ Successfully removed organization: ${orgId}`);
        } catch (error) {
          console.error(`Error stopping bots for removed organization ${orgId}:`, error);
        }
      }
    }
    
    // STEP 2: Start bots for new organizations
    if (newOrgs.length > 0) {
      console.log(`📦 Starting bots for ${newOrgs.length} new organizations...`);
      
      // Process new organizations in batches to prevent overwhelming the system
      const batchSize = resourceManager.shouldThrottleNewBots() ? 2 : 3;
      
      for (let i = 0; i < newOrgs.length; i += batchSize) {
        const batch = newOrgs.slice(i, i + batchSize);
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(newOrgs.length / batchSize)} of new organizations (${batch.length} orgs)`);
        
        const newOrgResults = await startBotsForOrganizations(batch);
      
        // Set initial tokens hash for new organizations
        batch.forEach((org, index) => {
          if (runningBots[org.id]) {
            // Always update the hash regardless of start result to prevent repeated attempts
            runningBots[org.id].lastTokensHash = generateTokensHash(org);
          }
        });
        
        // Small delay between batches
        if (i + batchSize < newOrgs.length) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    
    // STEP 3: Restart bots for organizations with changed tokens/settings
    if (changedOrgs.length > 0) {
      console.log(`🔄 Restarting bots for ${changedOrgs.length} organizations with configuration changes...`);
      
      // Process changed organizations with controlled concurrency
      const batchSize = resourceManager.shouldThrottleNewBots() ? 1 : 2;
      
      for (let i = 0; i < changedOrgs.length; i += batchSize) {
        const batch = changedOrgs.slice(i, i + batchSize);
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(changedOrgs.length / batchSize)} of updated organizations (${batch.length} orgs)`);
        
        // Process each org in the batch in parallel
        await Promise.all(
          batch.map(async (org) => {
            try {
              await restartOrganizationBots(org);
              console.log(`✅ Successfully restarted bots for ${org.name} (${org.id})`);
            } catch (error) {
              console.error(`Error restarting bots for organization ${org.name}:`, error);
            }
          })
        );
        
        // Small delay between batches
        if (i + batchSize < changedOrgs.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // STEP 4: Repair organizations with incomplete bot states
    if (repairOrgs.length > 0) {
      console.log(`🔧 Repairing ${repairOrgs.length} organizations with inconsistent bot states...`);
      
      // Process repair one at a time to avoid conflicts
      for (const org of repairOrgs) {
        try {
          const botStatus = runningBots[org.id];
          console.log(`Repairing organization ${org.name} (${org.id}): Current state:`, {
            telegram: botStatus.telegram ? '✅' : '❌',
            slack: botStatus.slack ? '✅' : '❌',
            teams: botStatus.teams ? '✅' : '❌',
            whatsapp: botStatus.whatsapp ? '✅' : '❌',
          });
          
          // Restart all bots for this organization
          await restartOrganizationBots(org);
          console.log(`✅ Successfully repaired bots for ${org.name} (${org.id})`);
          
          // Small delay to prevent system overload
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Error repairing bots for organization ${org.name}:`, error);
        }
      }
    }
    
    // Log summary of actions taken
    if (newOrgs.length === 0 && changedOrgs.length === 0 && repairOrgs.length === 0 && removedOrgIds.length === 0) {
      console.log("ℹ️ No organization changes detected");
    } else {
      // Calculate time taken
      const timeTaken = (Date.now() - startTime) / 1000;
      
      console.log(`✅ Refresh complete in ${timeTaken.toFixed(2)}s`);
      console.log(`   New: ${newOrgs.length}, Updated: ${changedOrgs.length}, Repaired: ${repairOrgs.length}, Removed: ${removedOrgIds.length}`);
      console.log(`   Total organizations: ${organizations.length}`);
    }
    
    // Store the last refresh time
    const completionTime = new Date().toISOString();
    process.env.LAST_ORG_REFRESH = completionTime;
    
    // Store refresh metrics in the database for monitoring
    try {
      await supabase.from('system_operations_log').insert({
        operation_type: 'organization_refresh',
        details: {
          new_orgs: newOrgs.length,
          changed_orgs: changedOrgs.length,
          repaired_orgs: repairOrgs.length,
          removed_orgs: removedOrgIds.length,
          total_orgs: organizations.length,
          time_taken_seconds: (Date.now() - startTime) / 1000
        },
        created_at: completionTime,
        status: 'success'
      });
    } catch (logError) {
      // Non-critical, just log and continue
      console.warn("Could not store refresh metrics:", logError);
    }

    // Clear timeout and reset flag
    if (refreshTimeout) clearTimeout(refreshTimeout);
    isRefreshingOrganizations = false;
    return true;
  } catch (error) {
    console.error("Error in refreshOrganizations:", error);
      // Log the error to the database for monitoring
    try {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      await supabase.from('system_operations_log').insert({
        operation_type: 'organization_refresh',
        details: {
          error: errorMessage,
          stack: errorStack
        },
        created_at: new Date().toISOString(),
        status: 'error'
      });
    } catch (logError) {
      // Non-critical, just log and continue
      console.warn("Could not store refresh error metrics:", logError);
    }
    
    // Clear timeout and reset flag
    if (refreshTimeout) clearTimeout(refreshTimeout);
    isRefreshingOrganizations = false;
    return false;
  }
}

/**
 * Start bots for a specific list of organizations
 * Extracted from startAllBots to be reusable for refreshes
 */
async function startBotsForOrganizations(organizations: Organization[]): Promise<boolean[]> {
  // Check system resources before starting
  if (resourceManager.shouldThrottleNewBots()) {
    console.warn("⚠️ System resources are high, implementing throttling...");
  }

  // Start bots with controlled concurrency to manage resources
  const batchSize = resourceManager.shouldThrottleNewBots() ? 2 : 5;
  const results: boolean[] = [];

  for (let i = 0; i < organizations.length; i += batchSize) {
    const batch = organizations.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (org) => {
        console.log(`\n=== Processing organization: ${org.name} (${org.id}) ===`);
        console.log(`   - Telegram: ${org.settings?.telegram?.enabled ? '✅' : '❌'}`);
        console.log(`   - Slack: ${org.settings?.slack?.enabled ? '✅' : '❌'}`);
        console.log(`   - Teams: ${org.settings?.teams?.enabled ? '✅' : '❌'}`);
        console.log(`   - WhatsApp: ${org.settings?.whatsapp?.enabled ? '✅' : '❌'}`);        // Initialize tracking for this organization
        runningBots[org.id] = {
          startTime: new Date(),
          memoryUsage: 0,
          cpuUsage: 0,
          telegram: false,  // Initialize all bots as not running
          slack: false,
          teams: false,
          whatsapp: false,
          lastTokensHash: generateTokensHash(org) // Store initial tokens hash
        };// Setup function to start a bot with timeout
        const startBotWithTimeout = async (
          botName: string,
          startFunc: (org: Organization) => Promise<boolean>,
          enabled: boolean
        ): Promise<boolean> => {
          if (!enabled) {
            console.log(`${botName} bot disabled for organization: ${org.name}`);
            return false;
          }
          
          console.log(`🔄 Attempting to start ${botName} bot for ${org.name}...`);
          
          try {
            // Create a timeout promise
            const timeoutPromise = new Promise<boolean>((_, reject) => {
              setTimeout(() => reject(new Error(`${botName} bot startup timed out after 10 seconds`)), 10000);
            });
            
            // Start bot with timeout
            const result = await Promise.race([
              startFunc(org),
              timeoutPromise
            ]);
            
            if (result) {
              console.log(`✅ ${botName} bot started successfully for ${org.name}`);
            } else {
              console.error(`❌ ${botName} bot failed to start for ${org.name}`);
            }
            
            return result;
          } catch (error) {
            console.error(`❌ Error starting ${botName} bot for ${org.name}:`, error);
            return false;
          }
        };

        // Start all bots in parallel, truly independent of each other
        const botStartPromises = [
          startBotWithTimeout('Telegram', startOrgTelegramBot, !!org.settings?.telegram?.enabled),
          startBotWithTimeout('Slack', startOrgSlackBot, !!org.settings?.slack?.enabled),
          startBotWithTimeout('Teams', startOrgTeamsBot, !!org.settings?.teams?.enabled),
          startBotWithTimeout('WhatsApp', startOrgWhatsappBot, !!org.settings?.whatsapp?.enabled)
        ];
        
        // Wait for all bots to finish starting
        const [telegramResult, slackResult, teamsResult, whatsappResult] = await Promise.all(botStartPromises);

        console.log(`=== Finished processing organization: ${org.name} (${org.id}) ===`);
        console.log(`   - Telegram: ${telegramResult ? '✅' : '❌'}`);
        console.log(`   - Slack: ${slackResult ? '✅' : '❌'}`);
        console.log(`   - Teams: ${teamsResult ? '✅' : '❌'}`);
        console.log(`   - WhatsApp: ${whatsappResult ? '✅' : '❌'}`);

        // Log resource usage after starting this org's bots
        resourceManager.logResourceUsage();

        // Consider the organization successful if any bot was started
        const anyBotStarted = telegramResult || slackResult || teamsResult || whatsappResult;        // If no bots were started but the organization has bots configured, log a warning
        if (!anyBotStarted && (org.settings?.telegram?.enabled || org.settings?.slack?.enabled || 
            org.settings?.teams?.enabled || org.settings?.whatsapp?.enabled)) {
          console.warn(`⚠️ No bots were successfully started for organization: ${org.name} (${org.id})`);
          console.warn('This may be due to configuration issues or conflicts with existing bot instances.');
          
          // Log more detailed diagnostic information
          console.warn('Diagnostic information:');
          if (org.settings?.telegram?.enabled && !telegramResult) {
            console.warn('- Telegram bot was enabled but failed to start');
          }
          if (org.settings?.slack?.enabled && !slackResult) {
            console.warn('- Slack bot was enabled but failed to start');
          }
          if (org.settings?.teams?.enabled && !teamsResult) {
            console.warn('- Teams bot was enabled but failed to start');
          }
          if (org.settings?.whatsapp?.enabled && !whatsappResult) {
            console.warn('- WhatsApp bot was enabled but failed to start');
          }
          
          // Log environment info
          console.warn('Environment information:');
          console.warn(`- Node.js version: ${process.version}`);
          console.warn(`- Platform: ${process.platform}`);
          console.warn(`- Memory usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
        } else if (anyBotStarted) {
          // Log which bots were started successfully
          console.log(`✅ Bots started for ${org.name} (${org.id}):`);
          if (telegramResult) console.log('- Telegram bot started successfully');
          if (slackResult) console.log('- Slack bot started successfully');
          if (teamsResult) console.log('- Teams bot started successfully');
          if (whatsappResult) console.log('- WhatsApp bot started successfully');
        }

        // Return true regardless to prevent the application from failing
        return true;
      })
    );

    results.push(...batchResults);

    // Small delay between batches to prevent resource spikes
    if (i + batchSize < organizations.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

/**
 * Start all bots for all organizations with resource management
 */
export async function startAllBots(): Promise<boolean> {
  try {
    console.log("🚀 Starting all bots for all organizations...");
    resourceManager.logResourceUsage();

    // Fetch all organizations
    const organizations = await fetchOrganizations();

    if (organizations.length === 0) {
      console.warn("No organizations found in the database");
      return false;
    }

    // Use the shared function to start bots for all organizations
    const results = await startBotsForOrganizations(organizations);

  // Start resource monitoring
    startResourceMonitoring();
    
    // Set up periodic organization refresh with improved reliability
    if (!organizationRefreshInterval) {
      console.log("📅 Setting up periodic organization refresh (every 2 minutes)...");
      
      // Initial refresh to ensure we have the latest data after startup
      // Use setTimeout to allow the initial bot startup to complete first
      setTimeout(async () => {
        console.log("🔄 Running initial organization refresh after startup...");
        try {
          await refreshOrganizations();
        } catch (error) {
          console.error("Error during initial organization refresh:", error);
        }
      }, 15000); // Wait 15 seconds after startup before first refresh
      
      // Then set up the regular interval
      organizationRefreshInterval = setInterval(async () => {
        try {
          await refreshOrganizations();
        } catch (error) {
          console.error("Error during periodic organization refresh:", error);
        }
      }, 2 * 60 * 1000); // Check every 2 minutes
    }

    const successfulOrgs = results.filter(r => r).length;
    console.log(`🎉 Bot startup complete. ${successfulOrgs}/${organizations.length} organizations have active bots.`);
    
    // Always return true to prevent the application from failing completely
    // This ensures PM2 doesn't restart in a loop
    return true;
  } catch (error) {
    console.error("Error in startAllBots:", error);
    console.warn("⚠️ Continuing application execution despite bot startup error");
    // Return true even when there's an error to prevent PM2 restart loop
    return true;
  }
}

/**
 * Resource monitoring and optimization
 */
class ResourceManager {
  private static instance: ResourceManager;
  private memoryThreshold = 0.8; // 80% memory threshold
  private cpuThreshold = 0.7; // 70% CPU threshold
  private lastUserTime = 0;
  private lastSystemTime = 0;
  private lastCPUCheckTime = 0;

  static getInstance(): ResourceManager {
    if (!ResourceManager.instance) {
      ResourceManager.instance = new ResourceManager();
    }
    return ResourceManager.instance;
  }

  getSystemResources() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const now = Date.now();
    
    // Calculate CPU usage since last check
    let userPercent = 0;
    let systemPercent = 0;
    
    if (this.lastCPUCheckTime > 0) {
      const timeDiff = now - this.lastCPUCheckTime;
      userPercent = (cpuUsage.user - this.lastUserTime) / (timeDiff * 1000);
      systemPercent = (cpuUsage.system - this.lastSystemTime) / (timeDiff * 1000);
    }
    
    // Update last usage values
    this.lastUserTime = cpuUsage.user;
    this.lastSystemTime = cpuUsage.system;
    this.lastCPUCheckTime = now;

    return {
      memory: {
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        rss: memUsage.rss,
        total: memUsage.rss * 1.5, // Estimate total based on RSS
        used: memUsage.heapUsed,
        percentage: memUsage.heapUsed / (memUsage.rss * 1.5)
      },
      cpu: {
        user: userPercent,
        system: systemPercent,
        total: userPercent + systemPercent
      }
    };
  }

  shouldThrottleNewBots(): boolean {
    const resources = this.getSystemResources();
    return resources.memory.percentage > this.memoryThreshold || 
           (resources.cpu.total > this.cpuThreshold);
  }

  logResourceUsage() {
    const resources = this.getSystemResources();
    console.log(`📊 System Resources - Memory: ${(resources.memory.percentage * 100).toFixed(2)}% | CPU: ${(resources.cpu.total * 100).toFixed(2)}%`);
  }
}

// Create singleton instance of ResourceManager
const resourceManager = ResourceManager.getInstance();

/**
 * Start resource monitoring
 */
function startResourceMonitoring() {
  // Clear any existing intervals to prevent duplicates
  if (resourceMonitoringInterval) {
    clearInterval(resourceMonitoringInterval);
  }
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  // Monitor resources every 30 seconds
  resourceMonitoringInterval = setInterval(() => {
    resourceManager.logResourceUsage();

    // Update memory usage for each organization
    const resources = resourceManager.getSystemResources();
    Object.keys(runningBots).forEach(orgId => {
      if (runningBots[orgId]) {
        runningBots[orgId].memoryUsage = resources.memory.used;
        runningBots[orgId].cpuUsage = resources.cpu.user + resources.cpu.system;
      }
    });

    // Trigger garbage collection if memory usage is high
    if (resources.memory.percentage > 0.85 && global.gc) {
      console.log("🧹 Triggering garbage collection due to high memory usage");
      global.gc();
    }
  }, 30000);

  // Health check endpoint data
  healthCheckInterval = setInterval(() => {
    const activeOrgs = Object.keys(runningBots).length;
    const activeBots = Object.values(runningBots).reduce((count, org) => {
      return count +
        (org.telegram ? 1 : 0) +
        (org.slack ? 1 : 0) +
        (org.teams ? 1 : 0) +
        (org.whatsapp ? 1 : 0);
    }, 0);

    console.log(`📈 Health Check - Organizations: ${activeOrgs}, Active Bots: ${activeBots}`);
  }, 60000);
  
  console.log("📊 Resource monitoring started");
}

/**
 * Get the status of all running bots with enhanced metrics
 */
export function getBotStatus(): Record<string, any> {
  const resources = resourceManager.getSystemResources();

  return {
    system: {
      memory: {
        used: `${(resources.memory.used / 1024 / 1024).toFixed(2)}MB`,
        total: `${(resources.memory.total / 1024 / 1024).toFixed(2)}MB`,
        percentage: `${(resources.memory.percentage * 100).toFixed(2)}%`
      },
      uptime: `${(process.uptime() / 60).toFixed(2)} minutes`,
      nodeVersion: process.version,
      platform: process.platform
    },
    organizations: runningBots,
    summary: {
      totalOrganizations: Object.keys(runningBots).length,
      totalActiveBots: Object.values(runningBots).reduce((count, org) => {
        return count +
          (org.telegram ? 1 : 0) +
          (org.slack ? 1 : 0) +
          (org.teams ? 1 : 0) +
          (org.whatsapp ? 1 : 0);
      }, 0)
    }
  };
}

/**
 * Graceful shutdown function
 */
export async function gracefulShutdown(): Promise<void> {
  console.log("🛑 Initiating graceful shutdown...");

  // Stop all bots gracefully
  const shutdownPromises = Object.keys(runningBots).map(async (orgId) => {
    try {
      console.log(`Shutting down bots for organization: ${orgId}`);
      // Add specific shutdown logic for each bot type if needed
      delete runningBots[orgId];
    } catch (error) {
      console.error(`Error shutting down bots for organization ${orgId}:`, error);
    }
  });
  
  await Promise.all(shutdownPromises);
  console.log("✅ All bots shut down gracefully");

  // Stop resource monitoring
  if (resourceMonitoringInterval) {
    clearInterval(resourceMonitoringInterval);
    resourceMonitoringInterval = null;
    console.log("📊 Resource monitoring stopped");
  }
  
  // Stop health check interval
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log("📈 Health check monitoring stopped");
  }
  
  // Stop organization refresh interval
  if (organizationRefreshInterval) {
    clearInterval(organizationRefreshInterval);
    organizationRefreshInterval = null;
    console.log("🔄 Organization refresh stopped");
  }

  console.log("🛑 All bots have been gracefully shut down");
}

/**
 * Manual refresh function that can be called when tokens are updated
 * This provides immediate refresh without waiting for the periodic check
 * Enhanced with better error handling and timeout protection
 */
async function manualRefreshOrganizations(): Promise<boolean> {
  console.log("🚀 Manual organization refresh triggered");
  
  // If a refresh is already in progress, wait briefly and try again
  if (isRefreshingOrganizations) {
    console.log("⏳ Another refresh is in progress. Waiting briefly to try again...");
    
    // Wait for existing refresh to complete (up to 5 seconds)
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!isRefreshingOrganizations) {
        break;
      }
    }
    
    // If still refreshing after waiting, return false
    if (isRefreshingOrganizations) {
      console.log("⚠️ Could not trigger manual refresh - another refresh is still in progress");
      return false;
    }
  }
  
  try {
    // Now try to run the refresh
    return await refreshOrganizations();
  } catch (error) {
    console.error("❌ Error during manual organization refresh:", error);
    return false;
  }
}

/**
 * Get detailed information about bot configurations and token status
 */
function getOrganizationStatus(): Record<string, any> {
  const orgStatuses: Record<string, any> = {};
  
  for (const [orgId, botInfo] of Object.entries(runningBots)) {
    orgStatuses[orgId] = {
      ...botInfo,
      hasTokensHash: !!botInfo.lastTokensHash,
      uptime: botInfo.startTime ? Date.now() - botInfo.startTime.getTime() : 0
    };
  }
  
  return {
    organizations: orgStatuses,
    totalOrganizations: Object.keys(runningBots).length,
    refreshInfo: {
      isRefreshing: isRefreshingOrganizations,
      lastRefreshTime: new Date().toISOString()
    }
  };
}

/**
 * Send a notification to a user across all their integrated platforms
 * @param userId The user ID to send notifications to
 * @param message The message to send
 * @param taskId Optional task ID if this notification is related to a task
 * @param storeReminder Whether to store the reminder in the database (default: true)
 */
async function sendUserNotificationToAllPlatforms(userId: string, message: string, taskId?: string, storeReminder: boolean = true): Promise<boolean> {
  try {
    console.log(`\n📨 Sending notification to user ${userId} across all platforms`);
    console.log(`📋 Task ID: ${taskId || 'N/A'}, Store Reminder: ${storeReminder}`);
    console.log(`💬 Message preview: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
    
    // For targeted reminders (taskId_userId format), extract the original parts
    let originalTaskId = taskId;
    let targetUserId = undefined;
    
    if (taskId && taskId.includes('_') && taskId.split('_').length === 2) {
      const parts = taskId.split('_');
      if (parts[1].length > 30) { // Looks like a UUID
        originalTaskId = parts[0];
        targetUserId = parts[1];
        console.log(`📝 Found targeted reminder format: taskId=${originalTaskId}, targetUserId=${targetUserId}`);
        
        // Verify the target user matches the user we're sending to
        if (targetUserId !== userId) {
          console.warn(`⚠️ Warning: Target user ID (${targetUserId}) doesn't match current user (${userId})`);
        }
      }
    }      // Check if this reminder was recently sent to prevent duplicates
    const isDuplicate = await hasReminderBeenSentRecently(userId, taskId || 'notification', message);
    if (isDuplicate) {
      console.log(`⚠️ DUPLICATE DETECTED: Skipping duplicate notification to user ${userId} - already sent recently`);
      console.log(`🔍 Task ID: ${taskId || 'notification'}, Message: ${message.substring(0, 50)}...`);
      return true; // Return true to prevent further retries
    }
    
    console.log(`✅ DEDUPLICATION PASSED: This is a new/legitimate reminder for user ${userId}`);
    
    // First, get user's organization, email, and all contact methods
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('organization_id, email, name, telegram_id, slack_email, teams_email, whatsapp_number')
      .eq('id', userId)
      .single();
  
    if (userError || !userData) {
      console.error(`Could not find organization for user ${userId}`);
      return false;
    }

    // Get all the organization's integrations
    const { data: integrations, error } = await supabase
      .from('integration_tokens')
      .select('token_type, token_value')
      .eq('organization_id', userData.organization_id)
      .eq('is_active', true);
    
    if (error) {
      console.error(`Error fetching integrations for user ${userId}:`, error);
      return false;
    }
    
    if (!integrations || integrations.length === 0) {
      console.log(`No integrations found for user ${userId}`);
      return false;
    }
    
    console.log(`Found ${integrations.length} integration(s) for user ${userId}`);
    
    // Check which contact methods are available for this user
    const contactMethods = {
      telegram: userData.telegram_id ? true : false,
      slack: userData.slack_email ? true : false,
      teams: userData.teams_email ? true : false,
      whatsapp: userData.whatsapp_number ? true : false
    };
    
    // Log available contact methods
    console.log(`Available contact methods for ${userData.name || userData.email || userId}:`);
    console.log(`   - Telegram: ${contactMethods.telegram ? '✅' : '❌'}`);
    console.log(`   - Slack: ${contactMethods.slack ? '✅' : '❌'}`);
    console.log(`   - Teams: ${contactMethods.teams ? '✅' : '❌'}`);
    console.log(`   - WhatsApp: ${contactMethods.whatsapp ? '✅' : '❌'}`);    // Track if any notification was sent and which platforms were successful
    let anyNotificationSent = false;
    let successfulPlatforms: string[] = [];
    let failedPlatforms: string[] = [];
    
    // Define platform priority order (Teams -> Slack -> Telegram -> WhatsApp)
    const platformPriority = [
      { 
        type: 'teams', 
        tokens: ['MICROSOFT_APP_PASSWORD', 'MICROSOFT_APP_ID', 'MICROSOFT_APP_TENANT_ID'],
        available: contactMethods.teams,
        sender: sendTeamsNotification
      },
      { 
        type: 'slack', 
        tokens: ['SLACK_BOT', 'SLACK_APP'],
        available: contactMethods.slack,
        sender: sendSlackNotification
      },
      { 
        type: 'telegram', 
        tokens: ['TELEGRAM_BOT'],
        available: contactMethods.telegram,
        sender: sendTelegramNotification
      },
      { 
        type: 'whatsapp', 
        tokens: ['WHATSAPP_API', 'WHATSAPP_INSTANCE_ID', 'WHATSAPP_SECURITY_TOKEN'],
        available: contactMethods.whatsapp,
        sender: sendWhatsAppNotification
      }
    ];
    
    // Send to ALL available platforms (not just the first one)
    for (const platform of platformPriority) {
      if (!platform.available) {
        console.log(`⏭️ Skipping ${platform.type} - user has no contact method configured`);
        continue;
      }
      
      // Check if organization has this integration enabled
      const hasIntegration = integrations.some(integration => 
        platform.tokens.includes(integration.token_type)
      );
      
      if (!hasIntegration) {
        console.log(`⏭️ Skipping ${platform.type} - organization doesn't have this integration enabled`);
        continue;
      }
      
      try {
        console.log(`🎯 Attempting to send notification via ${platform.type}`);
        const result = await platform.sender(userId, message);
        
        if (result) {
          anyNotificationSent = true;
          successfulPlatforms.push(platform.type);
          console.log(`✅ Successfully sent notification via ${platform.type}`);
          
          // Store notification log for deduplication
          await storeNotificationLog(userId, taskId || 'notification', message, platform.type);
        } else {
          failedPlatforms.push(platform.type);
          console.log(`❌ Failed to send notification via ${platform.type}`);
        }
      } catch (error) {
        failedPlatforms.push(platform.type);
        console.error(`Error sending notification via ${platform.type}:`, error);
      }
    }
      // If no notifications were sent
    if (!anyNotificationSent) {
      console.warn(`⚠️ No reminders sent to ${userData.name || userData.email || userId} - no working platforms available`);
      if (failedPlatforms.length > 0) {
        console.warn(`⚠️ Failed platforms: ${failedPlatforms.join(', ')}`);
      }
    } else {
      console.log(`📨 Notification sent successfully to ${userData.name || userData.email || userId} via: ${successfulPlatforms.join(', ')}`);
      if (failedPlatforms.length > 0) {
        console.warn(`⚠️ Some platforms failed: ${failedPlatforms.join(', ')}`);
      }
    }
    
    // Always store the reminder in the database if requested, even if no notifications were sent
    if (storeReminder) {
      try {
        console.log(`Storing reminder in database for user ${userId}`);
        await storeReminderInDatabase(userId, message, taskId);
      } catch (error) {
        console.error(`Error storing reminder in database:`, error);
        // Continue even if storing the reminder fails
      }
    }
    
    // Return true if the reminder was stored, even if no notifications were sent
    // This prevents the system from considering it a failure when contact methods aren't configured
    return storeReminder || anyNotificationSent;
  } catch (error) {
    console.error(`Error in sendUserNotificationToAllPlatforms:`, error);
    return false;
  }
}

/**
 * Store reminder in the custom_reminder table (correct table)
 * @param userId The user ID the reminder was sent to
 * @param message The message content of the reminder
 * @param taskId Optional task ID if this reminder is related to a task
 */
async function storeReminderInDatabase(userId: string, message: string, taskId?: string): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    
    // Get user's organization and email
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('organization_id, email')
      .eq('id', userId)
      .single();
  
    if (userError || !userData) {
      console.error(`Could not find organization for user ${userId}`);
      return false;
    }
    
    // Check if this is a targeted reminder (taskId_userId format)
    // If so, store the original taskId part only
    let taskIdToStore = taskId;
    let reminderType = 'notification';
    
    if (taskId && taskId.includes('_') && taskId.split('_').length === 2 && taskId.split('_')[1].length > 30) {
      console.log(`📝 Storing targeted reminder with original task ID part only`);
      taskIdToStore = taskId.split('_')[0];
      reminderType = 'task';
    } else if (taskId && taskId !== 'notification') {
      reminderType = 'task';
    }
    
    // Prepare reminder data for custom_reminder table
    const reminderData: any = {
      user_id: userId,
      message: message,
      type: reminderType, // 'task' or 'custom' or 'notification'
      sent: true,
      sent_at: now,
      created_at: now,
      scheduled_for: now,
      reminder_time: now,
      organization_id: userData.organization_id
    };
    
    // Add user_email if available
    if (userData.email) {
      reminderData.user_email = userData.email;
    }
    
    console.log(`📝 Storing reminder in custom_reminder table:`, {
      user_id: userId,
      type: reminderType,
      message_preview: message.substring(0, 50) + '...',
      organization_id: userData.organization_id
    });
      
    const { error: reminderError } = await supabase
      .from('custom_reminder')
      .insert(reminderData);
    
    if (reminderError) {
      console.error(`Error storing reminder for user ${userId}:`, reminderError);
      return false;
    }
    
    // Also store in notification_logs for deduplication consistency
    const logStored = await storeNotificationLog(userId, taskId || 'notification', message, 'stored');
    if (!logStored) {
      console.warn(`Warning: Reminder stored but notification log failed for user ${userId}`);
    }
    
    console.log(`✅ Successfully stored reminder for user ${userId} in the custom_reminder table`);
    return true;
  } catch (error) {
    console.error(`Error in storeReminderInDatabase for user ${userId}:`, error);
    return false;
  }
}

// Export functions for use in other modules
const botManager = {
  startAllBots,
  getBotStatus,
  gracefulShutdown,
  sendUserNotificationToAllPlatforms,
  storeReminderInDatabase,
  refreshOrganizations,
  manualRefreshOrganizations,
  getOrganizationStatus
};

/**
 * Send a notification to a user via Telegram
 * @param userId The user ID to send notification to
 * @param message The message to send
 */
async function sendTelegramNotification(userId: string, message: string): Promise<boolean> {
  try {
    console.log(`Starting Telegram notification for user ${userId}`);
    
    // Get user's Telegram ID (using telegram_id instead of telegram_chat_id)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('telegram_id, organization_id, name, email')
      .eq('id', userId)
      .single();
    
    if (userError) {
      console.error(`Error fetching user data for Telegram notification: ${userId}`, userError);
      return false;
    }
    
    if (!userData) {
      console.error(`No user data found for Telegram notification: ${userId}`);
      return false;
    }
    
    if (!userData.telegram_id) {
      console.info(`ℹ️ No telegram_id found for user ${userData.name || userData.email || userId}`);
      return false;
    }
    
    console.log(`Found Telegram ID for user ${userId}: ${userData.telegram_id}`);
    
    // Get organization's Telegram token
    const { data: telegramToken, error: tokenError } = await supabase
      .from('integration_tokens')
      .select('token_value')
      .eq('organization_id', userData.organization_id)
      .eq('token_type', 'TELEGRAM_BOT')
      .eq('is_active', true)
      .single();
    
    if (tokenError) {
      console.error(`Error fetching Telegram token for org ${userData.organization_id}:`, tokenError);
      return false;
    }
    
    if (!telegramToken || !telegramToken.token_value) {
      console.error(`No active Telegram token found for organization ${userData.organization_id}`);
      return false;
    }
    
    console.log(`Found Telegram token for organization ${userData.organization_id}`);
    
    // Use the direct approach using the Telegram API to avoid lint errors
    try {
      // Direct approach using the Telegram API
      const axios = await import('axios');
      const token = telegramToken.token_value;
      
      const chatId = userData.telegram_id; // Using telegram_id instead of telegram_chat_id
      const userName = userData.name || userData.email || userId;
      
      console.log(`Sending Telegram message directly via API to chat ID ${chatId}`);
      
      await axios.default.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        }
      );
      
      console.log(`✅ Successfully sent Telegram notification to ${userName}`);
      return true;
    } catch (sendError) {
      console.error(`Error in Telegram message sending:`, sendError);
      return false;
    }
    
  } catch (error) {
    console.error(`❌ Error sending Telegram notification:`, error);
    return false;
  }
}

/**
 * Send a notification to a user via Teams
 * @param userId The user ID to send notification to
 * @param message The message to send
 */
async function sendTeamsNotification(userId: string, message: string): Promise<boolean> {
  try {
    // Import the Teams bot message sending function
    const teamsBotModule = await import('./mastra/teamsBot');
    
    // Get user's Teams email address and name
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('teams_email, name, email, organization_id')
      .eq('id', userId)
      .single();
    
    if (userError) {
      console.error(`Error fetching user data for Teams notification: ${userId}`, userError);
      return false;
    }
    
    if (!userData) {
      console.error(`No user data found for Teams notification: ${userId}`);
      return false;
    }
    
    if (!userData.teams_email) {
      console.info(`ℹ️ No teams_email found for user ${userData.name || userData.email || userId}`);
      return false;
    }
    
    // Check if Teams bot is initialized for this organization
    if (!teamsBotModule.sendDirectMessage) {
      console.error(`Teams bot module not properly initialized for organization ${userData.organization_id}`);
      return false;
    }
    
    // Send direct message to user with organization ID
    await teamsBotModule.sendDirectMessage({
      teamsEmail: userData.teams_email,
      message: message,
      taskId: 'notification', // using a placeholder as it's just a notification
      orgId: userData.organization_id // Pass the organization ID to use org-specific adapter
    });
    
    console.log(`✅ Successfully sent Teams notification to ${userData.name || userData.email || userId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending Teams notification:`, error);
    return false;
  }
}

/**
 * Send a notification to a user via WhatsApp
 * @param userId The user ID to send notification to
 * @param message The message to send
 */
async function sendWhatsAppNotification(userId: string, message: string): Promise<boolean> {
  try {
    // Get user's WhatsApp number
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('whatsapp_number, name, email')
      .eq('id', userId)
      .single();
    
    if (userError) {
      console.error(`Error fetching user data for WhatsApp notification: ${userId}`, userError);
      return false;
    }
    
    if (!userData) {
      console.error(`No user data found for WhatsApp notification: ${userId}`);
      return false;
    }
    
    if (!userData.whatsapp_number) {
      console.info(`ℹ️ No whatsapp_number found for user ${userData.name || userData.email || userId}`);
      return false;
    }
    
    // Import the WhatsApp module
    const whatsappBot = await import('./mastra/whatsappBot');
      // Use sendReminder instead of sendMessage to ensure proper formatting and delivery
    if (!whatsappBot.sendReminder) {
      console.error(`WhatsApp bot module sendReminder function not properly initialized`);
      return false;
    }
    
    // Send message using the sendReminder function with a custom taskId format
    const success = await whatsappBot.sendReminder({
      taskId: `custom_${userId}`,
      message: message
    });
    
    console.log(`✅ Successfully sent WhatsApp notification to ${userData.name || userData.email || userId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending WhatsApp notification:`, error);
    return false;
  }
}

/**
 * Send a notification to a user via Slack
 * @param userId The user ID to send notification to
 * @param message The message to send
 */
async function sendSlackNotification(userId: string, message: string): Promise<boolean> {
  try {
    // Get user's Slack email
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('slack_email, organization_id, name, email')
      .eq('id', userId)
      .single();
    
    if (userError) {
      console.error(`Error fetching user data for Slack notification: ${userId}`, userError);
      return false;
    }
    
    if (!userData) {
      console.error(`No user data found for Slack notification: ${userId}`);
      return false;
    }
    
    if (!userData.slack_email) {
      console.info(`ℹ️ No slack_email found for user ${userData.name || userData.email || userId}`);
      return false;
    }
      // Import the Slack bot module
    const slackBot = await import('./mastra/slackBot');
    
    // For welcome and general notifications, use sendDirectSlackReminder instead of sendReminder
    // This avoids the UUID parsing error with non-task messages
    if (slackBot.sendDirectSlackReminder) {
      console.log(`Using direct slack reminder approach for user ${userId}`);
      await slackBot.sendDirectSlackReminder({
        id: 'welcome_notification', 
        task_id: 'welcome_' + userId, // Use user ID with prefix to avoid UUID parsing issue
        message: message,
        user_id: userId
      });
    } else if (slackBot.sendReminder) {
      // Fallback to sendReminder only if sendDirectSlackReminder is not available
      console.warn(`Falling back to sendReminder (not recommended for welcome messages)`);
      await slackBot.sendReminder({
        id: 'welcome_notification',
        task_id: 'custom_' + userId, // Use custom_ prefix to avoid task lookup
        message: message,
        user_id: userId
      });
    } else {
      console.error(`Slack bot module not properly initialized`);
      return false;
    }
    
    console.log(`✅ Successfully sent Slack notification to ${userData.name || userData.email || userId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending Slack notification:`, error);
    return false;
  }
}

// Export specific functions for direct imports
export { 
  sendUserNotificationToAllPlatforms,
  sendTelegramNotification,
  sendTeamsNotification,
  sendWhatsAppNotification,
  sendSlackNotification,
  refreshOrganizations,
  manualRefreshOrganizations,
  getOrganizationStatus,
  startBotsForOrganizations,
  storeNotificationLog,
  hasReminderBeenSentRecently
};

export default botManager;
