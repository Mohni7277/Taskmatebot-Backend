// filepath: c:\Users\hp\Desktop\taskmate new\taskmatebot-backend\src\health.ts
import { config } from 'dotenv';
config(); // Load environment variables from .env file

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createClient } from '@supabase/supabase-js';
import { format, addDays, parseISO, isAfter, isBefore, differenceInDays } from 'date-fns';
import * as cron from 'node-cron';
import { createHash } from 'crypto';

const app = new Hono();
const PORT = process.env.HEALTH_CHECK_PORT || 3000;

// Create Supabase client for database operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

// Validate environment variables and provide helpful messages
if (!supabaseUrl) {
  console.error('\n=================================================================');
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL environment variable is not set');
  console.error('Please check your .env file and ensure it has the correct format:');
  console.error('NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co');
  console.error('=================================================================\n');
  throw new Error('NEXT_PUBLIC_SUPABASE_URL environment variable is not set');
}

if (!supabaseServiceKey) {
  console.error('\n=================================================================');
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY environment variable is not set');
  console.error('Please check your .env file and ensure it has the correct format:');
  console.error('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=your-service-role-key');
  console.error('=================================================================\n');
  throw new Error('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY environment variable is not set');
}

// Create client with validated values
try {
  var supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log('✅ Supabase client initialized successfully');
} catch (error) {
  console.error('\n=================================================================');
  console.error('❌ Failed to initialize Supabase client:');
  console.error(error);
  console.error('\nPlease check that your Supabase URL and service role key are correctly formatted');
  console.error('=================================================================\n');
  throw error;
}

// Check for task reminders during business hours only (9 AM - 8 PM)
const REMINDER_CRON_SCHEDULE = process.env.REMINDER_CRON_SCHEDULE || '0 9-20 * * *'; // Default: Every hour from 9 AM to 8 PM

// Simple health check endpoint (always returns healthy if server is running)
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'taskmate-bot',
    version: '1.0.0',
    uptime: process.uptime()
  }, 200);
});

// Test endpoint for Teams reminders
app.get('/test-teams-reminder', async (c) => {
  try {
    const userId = c.req.query('userId');
    const message = c.req.query('message') || 'This is a test reminder';
    const taskId = c.req.query('taskId');

    if (!userId || !taskId) {
      return c.json({
        status: 'error',
        message: 'Missing required parameters: userId and taskId are required'
      }, 400);
    }

    // Get user details
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, name, email, teams_email')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return c.json({
        status: 'error',
        message: `User not found: ${userId}`,
        error: userError?.message
      }, 404);
    }

    // Verify task exists
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('id, title')
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      return c.json({
        status: 'error',
        message: `Task not found: ${taskId}`,
        error: taskError?.message
      }, 404);
    }

    console.log(`🧪 TEST: Sending Teams reminder to ${user.name} (${user.teams_email}) for task "${task.title}"`);

    // Import and call Teams bot reminder function
    const { default: teamsBot } = await import('./mastra/teamsBot');
    await teamsBot.sendReminder({
      taskId: taskId,
      message: message
    });

    return c.json({
      status: 'success',
      message: `Teams reminder sent to ${user.name} (${user.teams_email})`,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        teams_email: user.teams_email
      },
      task: {
        id: task.id,
        title: task.title
      }
    });
  } catch (error) {
    console.error('❌ Error in test-teams-reminder:', error);
    return c.json({
      status: 'error',
      message: 'Failed to send test Teams reminder',
      error: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// Basic readiness check endpoint
app.get('/ready', (c) => {
  // Check if required environment variables are set
  const hasSupabaseUrl = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasSupabaseKey = !!process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
  const isReady = hasSupabaseUrl && hasSupabaseKey;

  return c.json({
    status: isReady ? 'ready' : 'not ready',
    timestamp: new Date().toISOString(),
    checks: {
      supabaseUrl: hasSupabaseUrl,
      supabaseKey: hasSupabaseKey
    }
  }, isReady ? 200 : 503);
});

// Advanced status endpoint (only works if bot manager is available)
app.get('/status', async (c) => {
  try {
    // Dynamically import to avoid startup issues
    const { getBotStatus } = await import('./botManager');
    const status = getBotStatus();

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...status
    }, 200);
  } catch (error) {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Bot manager not available',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 503);
  }
});

// Manual refresh endpoint for organizations and tokens
app.post('/refresh-organizations', async (c) => {
  try {
    console.log("🔄 Manual organization refresh requested via API");
    
    // Dynamically import to avoid startup issues
    const { manualRefreshOrganizations } = await import('./botManager');
    const result = await manualRefreshOrganizations();

    return c.json({
      status: result ? 'success' : 'partial',
      timestamp: new Date().toISOString(),
      message: result ? 'Organizations refreshed successfully' : 'Refresh completed with some issues',
      refreshed: true
    }, 200);
  } catch (error) {
    console.error('❌ Error in manual organization refresh:', error);
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      message: 'Failed to refresh organizations',
      error: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// Organization status endpoint
app.get('/organizations', async (c) => {
  try {
    // Dynamically import to avoid startup issues
    const { getOrganizationStatus } = await import('./botManager');
    const orgStatus = getOrganizationStatus();

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...orgStatus
    }, 200);
  } catch (error) {
    return c.json({
      status: 'error',
      timestamp: new Date().toISOString(),
      message: 'Organization status not available',
      error: error instanceof Error ? error.message : String(error)
    }, 503);
  }
});

// Metrics endpoint for Prometheus
app.get('/metrics', async (c) => {
  try {
    // Try to get bot status if available
    const { getBotStatus } = await import('./botManager');
    const status = getBotStatus();

    const metrics = `
# HELP taskmate_organizations_total Total number of organizations
# TYPE taskmate_organizations_total gauge
taskmate_organizations_total ${status.summary.totalOrganizations}

# HELP taskmate_active_bots_total Total number of active bots
# TYPE taskmate_active_bots_total gauge
taskmate_active_bots_total ${status.summary.totalActiveBots}

# HELP taskmate_memory_usage_bytes Memory usage in bytes
# TYPE taskmate_memory_usage_bytes gauge
taskmate_memory_usage_bytes ${status.system.memory.used.replace('MB', '') * 1024 * 1024}

# HELP taskmate_uptime_seconds Uptime in seconds
# TYPE taskmate_uptime_seconds gauge
taskmate_uptime_seconds ${process.uptime()}
`;

    return c.text(metrics.trim(), 200, {
      'Content-Type': 'text/plain'
    });
  } catch (error) {
    // Fallback metrics if bot manager is not available
    const memUsage = process.memoryUsage();
    const metrics = `
# HELP taskmate_uptime_seconds Uptime in seconds
# TYPE taskmate_uptime_seconds gauge
taskmate_uptime_seconds ${process.uptime()}

# HELP taskmate_memory_usage_bytes Memory usage in bytes
# TYPE taskmate_memory_usage_bytes gauge
taskmate_memory_usage_bytes ${memUsage.heapUsed}

# HELP taskmate_service_status Service status (1 = running, 0 = error)
# TYPE taskmate_service_status gauge
taskmate_service_status 1
`;

    return c.text(metrics.trim(), 200, {
      'Content-Type': 'text/plain'
    });
  }
});

// Webhook endpoint for token updates (can be called by external systems)
app.post('/webhook/token-updated', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { organizationId, tokenType, action } = body;
    
    console.log(`🔗 Token update webhook received:`, {
      organizationId: organizationId || 'unknown',
      tokenType: tokenType || 'unknown',
      action: action || 'unknown',
      timestamp: new Date().toISOString()
    });
    
    // Trigger immediate organization refresh
    const { manualRefreshOrganizations } = await import('./botManager');
    const result = await manualRefreshOrganizations();
    
    return c.json({
      status: 'success',
      message: 'Token update processed and organizations refreshed',
      timestamp: new Date().toISOString(),
      refreshResult: result,
      processedData: {
        organizationId: organizationId || 'not specified',
        tokenType: tokenType || 'not specified',
        action: action || 'not specified'
      }
    }, 200);
  } catch (error) {
    console.error('❌ Error processing token update webhook:', error);
    return c.json({
      status: 'error',
      message: 'Failed to process token update webhook',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }, 500);
  }
});

/**
 * Task reminder function that checks for:
 * 1. Tasks that are due tomorrow (1 day warning)
 * 2. Tasks that are overdue
 * Note: Newly assigned tasks are handled immediately upon creation, not via cron
 */
async function checkAndSendTaskReminders() {
  try {
    const cronRunTime = new Date();
    console.log(`🔔 Running task reminder check at ${cronRunTime.toISOString()}...`);
    console.log(`⏰ Cron schedule: ${REMINDER_CRON_SCHEDULE} (Business hours: 9 AM - 8 PM)`);
    
    const now = new Date();
    const tomorrow = addDays(now, 1);
    
    // Format dates for database queries
    const todayISOString = now.toISOString();
    const tomorrowISOString = tomorrow.toISOString();
    
    // 1. Check for tasks due tomorrow (upcoming deadline)
    await checkUpcomingDeadlines(todayISOString, tomorrowISOString);
    
    // 2. Check for overdue tasks
    await checkOverdueTasks(todayISOString);
    
    // NOTE: Newly assigned tasks are now handled immediately upon creation
    
    console.log(`✅ Task reminder check completed at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('❌ Error in task reminder check:', error);
  }
}

/**
 * Check for tasks with deadlines approaching in the next 24 hours
 * FIXED: Updated to handle assigned_to as an array of user IDs
 */
async function checkUpcomingDeadlines(todayISOString: string, tomorrowISOString: string) {
  try {
    // Find tasks where the deadline is tomorrow
    const { data: upcomingTasks, error } = await supabase
      .from('tasks')
      .select('*') // Get all fields from tasks
      .gte('deadline', todayISOString)
      .lt('deadline', tomorrowISOString)
      .neq('status', 'completed');
    
    if (error) {
      throw error;
    }
    
    console.log(`Found ${upcomingTasks?.length || 0} tasks due in the next 24 hours`);
    
    // Process each upcoming task
    for (const task of upcomingTasks || []) {
      // Check if assigned_to is an array and has values
      if (!task.assigned_to || !Array.isArray(task.assigned_to) || task.assigned_to.length === 0) {
        console.log(`⚠️  Skipping upcoming task "${task.title}" - no assigned users found`);
        continue;
      }
      
      // Process each assigned user
      for (const assignedUserId of task.assigned_to) {
        if (!assignedUserId) {
          console.log(`⚠️  Skipping invalid assignee for task "${task.title}"`);
          continue;
        }
        
        // Get user details for each assignee
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('id, name, email, organization_id')
          .eq('id', assignedUserId)
          .single();
          
        if (userError || !userData) {
          console.log(`⚠️  Skipping upcoming task "${task.title}" for user ${assignedUserId} - user data not found`);
          continue;
        }
        
        const userId = userData.id;
        // Log user details
        const assignedUserName = userData.name || 'Unknown';
        const assignedUserEmail = userData.email || 'No email';
        console.log(`👤 Checking upcoming deadline for user: ${assignedUserName} (${assignedUserEmail}) - Task: "${task.title}"`);
          // Check if we've already sent a reminder for this task's upcoming deadline to this specific user
        const alreadySent = await hasReminderBeenSent(task.id, 'upcoming_deadline', userId);
        
        if (!alreadySent) {
          // Format the deadline for the message
          const deadlineDate = parseISO(task.deadline);
          const formattedDeadline = format(deadlineDate, 'MMM dd, yyyy');
          
          // Prepare reminder message
          const message = `⏰ **Reminder:** Task "${task.title}" is due tomorrow (${formattedDeadline}). Please complete it soon!`;
          
          // Send reminder to the user via all their integrated bots
          // Using the actual task ID (not a concatenated string) to avoid UUID errors
          await sendReminderToUser(userId, message, task.id, 'upcoming_deadline');
          console.log(`✅ Sent upcoming deadline reminder to ${assignedUserName} (${assignedUserEmail})`);
        } else {
          console.log(`ℹ️  Skipping upcoming task "${task.title}" - reminder already sent to ${assignedUserName} (${assignedUserEmail})`);
        }
      }
    }
  } catch (error) {
    console.error('Error checking upcoming deadlines:', error);
  }
}

/**
 * Check for tasks that are already overdue
 * FIXED: Updated to handle assigned_to as an array of user IDs
 */
async function checkOverdueTasks(nowISOString: string) {
  try {
    // Find tasks where the deadline has passed
    const { data: overdueTasks, error } = await supabase
      .from('tasks')
      .select('*') // Get all fields from tasks
      .lt('deadline', nowISOString)
      .neq('status', 'completed');
    
    if (error) {
      throw error;
    }
    
    console.log(`Found ${overdueTasks?.length || 0} overdue tasks`);
    
    // Process each overdue task
    for (const task of overdueTasks || []) {
      // Check if assigned_to is an array and has values
      if (!task.assigned_to || !Array.isArray(task.assigned_to) || task.assigned_to.length === 0) {
        console.log(`⚠️  Skipping overdue task "${task.title}" - no assigned users found`);
        continue;
      }
      
      // Process each assigned user
      for (const assignedUserId of task.assigned_to) {
        if (!assignedUserId) {
          console.log(`⚠️  Skipping invalid assignee for task "${task.title}"`);
          continue;
        }
        
        // Get user details for each assignee
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('id, name, email, organization_id')
          .eq('id', assignedUserId)
          .single();
          
        if (userError || !userData) {
          console.log(`⚠️  Skipping overdue task "${task.title}" for user ${assignedUserId} - user data not found`);
          continue;
        }
        
        const userId = userData.id;
        // Log user details
        const assignedUserName = userData.name || 'Unknown';
        const assignedUserEmail = userData.email || 'No email';
        console.log(`👤 Checking overdue task for user: ${assignedUserName} (${assignedUserEmail}) - Task: "${task.title}"`);
          // Check if we've already sent an overdue reminder for this task to this specific user today
        const alreadySent = await hasReminderBeenSent(task.id, 'overdue', userId);
        
        if (!alreadySent) {
          // Format the deadline for the message
          const deadlineDate = parseISO(task.deadline);
          const formattedDeadline = format(deadlineDate, 'MMM dd, yyyy');
          const currentDate = new Date();
          const daysPast = differenceInDays(currentDate, deadlineDate);
          
          // Prepare reminder message
          const message = `⚠️ **Alert:** Task "${task.title}" is overdue! It was due on ${formattedDeadline} (${daysPast} day${daysPast === 1 ? '' : 's'} ago). Please complete it as soon as possible.`;
          
          // Send reminder to the user via all their integrated bots
          // Using the actual task ID to avoid UUID errors
          await sendReminderToUser(userId, message, task.id, 'overdue');
          console.log(`✅ Sent overdue reminder to ${assignedUserName} (${assignedUserEmail})`);
        } else {
          console.log(`ℹ️  Skipping overdue task "${task.title}" - reminder already sent to ${assignedUserName} (${assignedUserEmail})`);
        }
      }
    }
  } catch (error) {
    console.error('Error checking overdue tasks:', error);
  }
}

/**
 * Send immediate notification for newly assigned task
 * This function is called directly when a task is created, not via cron
 */
export async function sendNewTaskAssignmentNotification(taskId: string, assignedToData: string | string[], creatorName: string = 'Someone') {
  try {
    // Convert assignedToData to array if it's not already
    const assignedUserIds = Array.isArray(assignedToData) ? assignedToData : [assignedToData];
    
    console.log(`📋 Sending immediate new task assignment notification for task ${taskId} to users: ${JSON.stringify(assignedUserIds)}`);
    
    // Get task details - add error handling to prevent crashes
    let task;
    try {
      const { data, error } = await supabase
        .from('tasks')
        .select(`
          *
        `)
        .eq('id', taskId)
        .single();
        
      if (error) {
        console.error(`❌ Error fetching task: ${taskId}`, error.message);
        return;
      }
      
      if (!data) {
        console.error(`❌ Task not found: ${taskId}`);
        return;
      }
      
      task = data;
    } catch (taskError) {
      console.error(`❌ Exception while fetching task: ${taskId}`, taskError);
      return;
    }
    
    // Process each assigned user
    for (const assignedUserId of assignedUserIds) {
      if (!assignedUserId) {
        console.log(`⚠️  Skipping invalid assignee for task "${task.title}"`);
        continue;
      }
      
      // Get user details for the specific assignee we're notifying
      let userData;
      try {
        const { data, error } = await supabase
          .from('users')
          .select('id, name, email, organization_id')
          .eq('id', assignedUserId)
          .single();
          
        if (error) {
          console.error(`❌ Error fetching user: ${assignedUserId}`, error.message);
          continue;
        }
        
        if (!data) {
          console.error(`❌ User not found: ${assignedUserId}`);
          continue;
        }
        
        userData = data;
      } catch (userError) {
        console.error(`❌ Exception while fetching user: ${assignedUserId}`, userError);
        continue;
      }
      
      const userId = userData.id;
      if (!userId) {
        console.log(`⚠️  Skipping task "${task.title}" - invalid user ID`);
        continue;
      }
        // Check if we've already sent a notification for this specific user assignment
      let alreadySent = false;
      try {
        // Check if notification was already sent to this specific user for this task today
        alreadySent = await hasReminderBeenSent(task.id, 'new_assignment', userId);
        if (alreadySent) {
          console.log(`⚠️ DUPLICATE PREVENTION: New assignment notification already sent for task "${task.title}" to user ${userId} today - skipping`);
          continue;
        }
          // Additional check: Record this notification immediately to prevent race conditions
        try {
          const insertResult = await supabase
            .from('notification_logs')
            .insert({
              entity_id: task.id,
              type: 'new_assignment',
              user_id: userId,
              message: `Task assignment notification for "${task.title}"`,
              created_at: new Date().toISOString()
            });
          
          if (insertResult.error) {
            // Check if this is a duplicate key error (which means notification was already sent)
            if (insertResult.error.message.includes('duplicate') || insertResult.error.code === '23505') {
              console.log(`⚠️ DUPLICATE KEY PREVENTION: Notification already exists for task ${task.id}, user ${userId} - skipping`);
              continue;
            } else {
              console.error('Error recording notification log:', insertResult.error);
            }
          } else {
            console.log(`📝 Recorded notification log for task ${task.id} to user ${userId}`);
          }
        } catch (logError) {
          console.error('Error recording notification log:', logError);
          // Continue anyway - the main deduplication check above should handle most cases
        }
      } catch (reminderError) {
        console.error('Error checking for previous reminders:', reminderError);
        // Continue anyway - better to potentially send duplicate than no notification
      }
      
      // Prepare notification message
      let message = `📋 **New Task Assigned:** "${task.title}" has been assigned to you by ${creatorName}.`;
      
      // Add deadline info if available
      if (task.deadline) {
        try {
          const deadlineDate = parseISO(task.deadline);
          const formattedDeadline = format(deadlineDate, 'MMM dd, yyyy');
          message += ` Due date: ${formattedDeadline}`;
        } catch (dateError) {
          console.error('Error formatting deadline date:', dateError);
          // Continue without the formatted date
        }
      }
      
      try {
        // Send notification to the user via all their integrated bots
        // Using the task ID directly to avoid UUID errors
        await sendReminderToUser(userId, message, task.id, 'new_assignment');
        
        const assignedUserName = userData.name || 'Unknown';
        const assignedUserEmail = userData.email || 'No email';
        console.log(`✅ Sent immediate new assignment notification to ${assignedUserName} (${assignedUserEmail}) for task "${task.title}"`);
      } catch (sendError) {
        console.error('❌ Error sending reminder to user:', sendError);
        // Critical error logging for debugging
        console.error('Error details:', {
          userId,
          taskId,
          message: message.substring(0, 100) + '...',
          type: 'new_assignment'
        });
      }
    }
  } catch (error) {
    console.error('❌ Error sending new task assignment notification:', error);
  }
}

/**
 * Check for tasks that were newly assigned in the last check interval
 * NOTE: This function is kept for backward compatibility but is no longer used in the cron job
 * New task assignments are now handled immediately via sendNewTaskAssignmentNotification()
 * FIXED: Updated to handle assigned_to as an array of user IDs
 */
async function checkNewlyAssignedTasks() {
  try {
    // Get the last check time (or default to 1 hour ago)
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);
    const lastCheckISOString = oneHourAgo.toISOString();
    
    // Find tasks assigned within the last hour
    const { data: newlyAssignedTasks, error } = await supabase
      .from('tasks')
      .select(`
        *,
        created_by:created_by (id, name, email)
      `)
      .gte('created_at', lastCheckISOString);
      
    if (error) {
      throw error;
    }
    
    console.log(`Found ${newlyAssignedTasks?.length || 0} newly assigned tasks in the last hour`);
    
    // Process each newly assigned task
    for (const task of newlyAssignedTasks || []) {
      // Skip if no assignees
      if (!task.assigned_to || !Array.isArray(task.assigned_to) || task.assigned_to.length === 0) {
        console.log(`⚠️  Skipping task "${task.title}" - no assigned users found`);
        continue;
      }
      
      // Get creator name for notification
      const assignerName = task.created_by?.name || 'Someone';
      
      // Process each assigned user
      for (const assignedUserId of task.assigned_to) {
        if (!assignedUserId) {
          console.log(`⚠️  Skipping invalid assignee for task "${task.title}"`);
          continue;
        }
        
        // Get user details for each assignee
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('id, name, email')
          .eq('id', assignedUserId)
          .single();
          
        if (userError || !userData) {
          console.log(`⚠️  Skipping task "${task.title}" for user ${assignedUserId} - user data not found`);
          continue;
        }
        
        const userId = userData.id;
        const assignedUserName = userData.name || 'Unknown';
        const assignedUserEmail = userData.email || 'No email';
        console.log(`👤 Processing new assignment for user: ${assignedUserName} (${assignedUserEmail}) - Task: "${task.title}"`);        // Check if we've already sent a notification for this new assignment to this user
        const alreadySent = await hasReminderBeenSent(task.id, 'new_assignment', userId);
        
        if (!alreadySent) {
          // Prepare notification message
          let message = `📋 **New Task Assigned:** "${task.title}" has been assigned to you by ${assignerName}.`;
          
          // Add deadline info if available
          if (task.deadline) {
            const deadlineDate = parseISO(task.deadline);
            const formattedDeadline = format(deadlineDate, 'MMM dd, yyyy');
            message += ` Due date: ${formattedDeadline}`;
          }
          
          // Send notification to the user via all their integrated bots
          // Using the task ID directly to avoid UUID errors
          await sendReminderToUser(userId, message, task.id, 'new_assignment');
          console.log(`✅ Sent new assignment notification to ${assignedUserName} (${assignedUserEmail})`);
        } else {
          console.log(`ℹ️  Skipping task "${task.title}" - notification already sent to ${assignedUserName} (${assignedUserEmail})`);
        }
      }
    }
  } catch (error) {
    console.error('Error checking newly assigned tasks:', error);
  }
}

/**
 * Send a reminder directly to a specific user using the centralized notification system
 * FIXED: Use the centralized botManager system to prevent duplicate reminders
 */
async function sendReminderToUser(userId: string, message: string, taskId: string, reminderType: string) {
  try {
    // IMMEDIATE DEDUPLICATION CHECK: Prevent sending multiple reminders for the same task within 5 minutes
    const cacheKey = `${userId}_${taskId}_${reminderType}`;
    const now = Date.now();
    
    // Use a simple in-memory cache for immediate deduplication
    const globalObject = global as any;
    if (!globalObject.reminderDedupeCache) {
      globalObject.reminderDedupeCache = new Map<string, number>();
    }
    
    // Create normalized cache key that ignores message prefix variations
    const normalizedMessage = message.replace(/^⏰\s*(TASK REMINDER|REMINDER):\s*⏰\s*/, '').trim();
    const messageFingerprint = createHash('md5').update(normalizedMessage).digest('hex').substring(0, 8);
    const normalizedCacheKey = `${userId}_${taskId}_${reminderType}_${messageFingerprint}`;
    
    // Check both the original cache key and the normalized one
    const lastSentTimeOriginal = globalObject.reminderDedupeCache.get(cacheKey);
    const lastSentTimeNormalized = globalObject.reminderDedupeCache.get(normalizedCacheKey);
    const lastSentTime = Math.max(lastSentTimeOriginal || 0, lastSentTimeNormalized || 0);
    
    if (lastSentTime && (now - lastSentTime) < 300000) { // 5 minutes
      console.log(`⚠️ IMMEDIATE DUPLICATE PREVENTION: Skipping reminder for user ${userId}, task ${taskId} - sent ${Math.round((now - lastSentTime)/1000)}s ago`);
      return;
    }
    
    // Mark both cache keys as being sent
    globalObject.reminderDedupeCache.set(cacheKey, now);
    globalObject.reminderDedupeCache.set(normalizedCacheKey, now);
    
    // Clean up old cache entries periodically
    if (globalObject.reminderDedupeCache.size > 1000) {
      const cutoffTime = now - 300000; // 5 minutes ago
      for (const [key, time] of globalObject.reminderDedupeCache.entries()) {
        if (time < cutoffTime) {
          globalObject.reminderDedupeCache.delete(key);
        }
      }
    }
    
    // Get the user's details
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', userId)
      .single();
      
    if (userError || !user) {
      console.error(`❌ User not found: ${userId}`, userError?.message);
      return;
    }

    const userName = user.name || 'Unknown User';
    const userEmail = user.email || 'No email';
    console.log(`📤 Sending ${reminderType} reminder directly to user: ${userName} (${userEmail})`);

    // Use the centralized notification system from botManager
    // Create a targeted reminder ID to ensure this goes to the specific user
    const targetedTaskId = `${taskId}_${userId}`;
    
    // Import and use the sendUserNotificationToAllPlatforms function
    const { sendUserNotificationToAllPlatforms } = await import('./botManager');
    
    // Send notification through the centralized system (which handles deduplication)
    const success = await sendUserNotificationToAllPlatforms(
      userId, 
      message, 
      targetedTaskId, 
      false // Don't store reminder in database as we'll log it separately
    );
    
    if (success) {
      // Log the notification for tracking
      await logNotification(taskId, userId, reminderType);
      console.log(`📝 Logged ${reminderType} notification for task ${taskId} to ${userName} (${userEmail})`);
      console.log(`✅ Successfully sent ${reminderType} reminder to ${userName} (${userEmail}) via Telegram, Slack, WhatsApp, Teams`);
    } else {
      console.log(`⚠️ Failed to send ${reminderType} reminder to ${userName} (${userEmail}) - no working platforms available`);
    }
    
  } catch (error) {
    console.error(`❌ Error in sendReminderToUser for ${userId}:`, error);
  }
}

/**
 * Send notifications to everyone in the organization (kept for potential future use)
 * This function is currently not used for individual user reminders
 */
async function sendToOrganization(organizationId: string, message: string, taskId: string, reminderType: string) {
  console.log(`ℹ️  sendToOrganization called but not used for individual user reminders`);
  // Function kept for potential future organization-wide announcements
}

/**
 * Check if a reminder has already been sent for this task and type
 * FIXED: Updated to handle task/user combinations properly without concatenating IDs
 */
async function hasReminderBeenSent(taskIdOrCombo: string, reminderType: string, userId?: string) {
  try {
    // Extract the real taskId if it's a combined string (for backward compatibility)
    let taskId = taskIdOrCombo;
    const isComboId = taskIdOrCombo.includes('_');
    
    if (isComboId) {
      // If it's a combined ID like "taskId_userId", just extract the taskId part
      const parts = taskIdOrCombo.split('_');
      taskId = parts[0]; // Use only the task ID part
      // If userId isn't explicitly provided, extract it from the combo
      if (!userId && parts.length > 1) {
        userId = parts[1];
      }
    }
    
    // Get the current time minus 30 seconds for more strict deduplication
    const recentTime = new Date(Date.now() - 30000); // 30 seconds ago
    const recentTimeISOString = recentTime.toISOString();
    
    // First query condition - task and reminder type within last 30 seconds
    let query = supabase
      .from('notification_logs')
      .select('*')
      .eq('entity_id', taskId)
      .eq('type', reminderType)
      .gte('created_at', recentTimeISOString);
    
    // Add user_id condition if provided
    if (userId) {
      query = query.eq('user_id', userId);
    }
    
    const { data: existingNotifications, error } = await query.limit(1);
    
    if (error) {
      console.warn('Error checking notification_logs table:', error.message);
      return false; // Assume no notification was sent if we can't check
    }
    
    const hasRecent = existingNotifications && existingNotifications.length > 0;
    if (hasRecent) {
      console.log(`🔍 Found recent notification for task ${taskId}, type ${reminderType}, user ${userId || 'any'} within last 30 seconds`);
    }
    
    return hasRecent;
  } catch (error) {
    console.error('Error checking previous notifications:', error);
    return false; // If there's an error, assume we haven't sent it
  }
}

/**
 * Log a notification to prevent duplicate reminders
 * FIXED: Updated to use correct column names based on your table schema
 */
async function logNotification(taskId: string, userId: string, notificationType: string) {
  try {
    // Get user details for logging
    const { data: user } = await supabase
      .from('users')
      .select('name, email')
      .eq('id', userId)
      .single();
      
    const userName = user?.name || 'Unknown User';
    const userEmail = user?.email || 'No email';

    // FIXED: Use correct column names based on your table schema
    const { error } = await supabase
      .from('notification_logs')
      .insert({
        entity_id: taskId,              // FIXED: Changed from task_id
        user_id: userId,
        type: notificationType,         // FIXED: Changed from notification_type
        title: `Task Reminder`,         // Added title field
        message: `Sent ${notificationType} notification for task ${taskId} to ${userName} (${userEmail})`,
        entity_type: 'task',           // Added entity_type field
        created_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('❌ Error logging notification:', error.message);
      return;
    }
    
    console.log(`📝 Logged ${notificationType} notification for task ${taskId} to ${userName} (${userEmail})`);
  } catch (error) {
    console.error('❌ Error logging notification:', error);
  }
}

// Start the cron job for task reminders
if (process.env.NODE_ENV !== 'test') {
  // Schedule the reminder check according to the cron schedule
  cron.schedule(REMINDER_CRON_SCHEDULE, () => {
    checkAndSendTaskReminders();
  });
  
  console.log(`🔔 Task reminder service scheduled with cron: ${REMINDER_CRON_SCHEDULE} (Business hours: 9 AM - 8 PM)`);
  
  // Run an initial check when the server starts
  setTimeout(() => {
    checkAndSendTaskReminders();
  }, 5000); // Wait 5 seconds after startup
}

// Start health check server only if not in test environment
if (process.env.NODE_ENV !== 'test') {
  serve({
    fetch: app.fetch,
    port: Number(PORT),
  });
  console.log(`🏥 Health check server running on port ${PORT}`);
}

export default app;
