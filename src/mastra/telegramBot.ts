import { Telegraf, Context } from "telegraf"
import { message } from "telegraf/filters"
import dotenv from "dotenv"
import { telegramBotAgent } from "./agents/telegramBotAgent"
import { getWeekDateRange } from "../utils/dateUtils"
import { createClient } from "@supabase/supabase-js"
import { sendNewTaskAssignmentNotification } from "../health"
import { sendUserNotificationToAllPlatforms } from "../botManager"
import { storeTokenUsage, TokenUsageData } from "../utils/tokenUsage"

dotenv.config()

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Helper function to escape markdown special characters
function escapeMarkdown(text: string | undefined): string {
  if (!text) return "";
  
  // Escape markdown special characters: * _ ` [ ] ( ) ~ > # + - = | { } . !
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}

// Add session state interface for task creation and editing
interface TaskFormState {
  step: 'title' | 'description' | 'project' | 'team' | 'priority' | 'deadline' | 'assignee' | 'confirm' | 'edit_task' | 'edit_title' | 'edit_description' | 'edit_priority' | 'edit_deadline' | 'edit_project' | 'edit_assignee' | 'edit_status' | 'edit_before_create' | 'edit_session_title' | 'edit_session_description' | 'edit_session_priority' | 'edit_session_deadline' | 'edit_session_project' | 'edit_session_assignee' | 'reminder_type' | 'reminder_user' | 'reminder_task' | 'reminder_custom_message' | 'reminder_schedule' | 'reminder_confirm';
  taskData: {
    title?: string;
    description?: string;
    projectId?: string;
    projectName?: string;
    teamId?: string;
    teamName?: string;
    priority?: string;
    deadline?: string;
    assigneeId?: string; // For backward compatibility
    assigneeName?: string; // For backward compatibility
    assigneeEmail?: string; // For backward compatibility
    assigneeIds?: string[]; // Multiple assignee IDs
    assigneeNames?: string[]; // Multiple assignee names
    assigneeEmails?: string[]; // Multiple assignee emails
    status?: string;
    multiAssigneeMode?: boolean; // Flag to track if in multiple assignee mode    // Reminder-specific fields
    reminderType?: 'task' | 'custom';
    reminderUserId?: string;
    reminderUserName?: string;
    reminderUserEmail?: string;
    reminderUserOrgId?: string;
    reminderTaskId?: string;    reminderTaskTitle?: string;
    reminderCustomMessage?: string;
    reminderSchedule?: string;
    createdAt?: string; // Timestamp for session creation
  };
  messageId?: number; // ID of the form message to update
  formMessageId?: number; // Alternative name for form message ID
  editingTaskId?: string; // ID of the task being edited
}

// Store user session data
const userSessions: Record<string, TaskFormState> = {};

// Store user ID mappings to work around Telegram's 64-byte callback_data limit
const userIdMappings: Record<string, { shortId: string; fullId: string; telegramId: string; expiresAt: number }> = {};
let shortIdCounter = 1;

// Helper function to generate a short ID for a full UUID
function generateShortUserIdForCallback(fullUserId: string, telegramId: string): string {
  console.log(`🔍 Generating short ID for user ${fullUserId} with Telegram ID: ${telegramId}`);
  
  // Check if we already have a mapping for this user
  const existing = Object.values(userIdMappings).find(
    mapping => mapping.fullId === fullUserId && mapping.telegramId === telegramId
  );
  
  if (existing && existing.expiresAt > Date.now()) {
    console.log(`🔍 Using existing short ID: ${existing.shortId} for mapping key: ${telegramId}_${existing.shortId}`);
    return existing.shortId;
  }
  
  // Generate new short ID
  const shortId = `u${shortIdCounter++}`;
  const mappingKey = `${telegramId}_${shortId}`;
  
  // Store mapping with 1-hour expiration
  userIdMappings[mappingKey] = {
    shortId,
    fullId: fullUserId,
    telegramId,
    expiresAt: Date.now() + (60 * 60 * 1000) // 1 hour
  };
  
  console.log(`🔍 Created new mapping - Key: ${mappingKey}, Short ID: ${shortId}, Full ID: ${fullUserId}`);
  
  return shortId;
}

// Helper function to resolve a short ID back to full UUID
function resolveShortUserIdFromCallback(telegramId: string, shortId: string): string | null {
  const mappingKey = `${telegramId}_${shortId}`;
  const mapping = userIdMappings[mappingKey];
  
  console.log(`🔍 Resolving short ID: ${shortId} for Telegram ID: ${telegramId}`);
  console.log(`🔍 Looking for mapping key: ${mappingKey}`);
  console.log(`🔍 Available mappings:`, Object.keys(userIdMappings));
  console.log(`🔍 Found mapping:`, mapping ? `Yes - Full ID: ${mapping.fullId}, Expires: ${new Date(mapping.expiresAt)}` : 'No');
  
  if (!mapping || mapping.expiresAt <= Date.now()) {
    if (mapping && mapping.expiresAt <= Date.now()) {
      console.log(`🔍 Mapping expired at ${new Date(mapping.expiresAt)}, current time: ${new Date()}`);
    }
    return null;
  }
  
  console.log(`🔍 Successfully resolved ${shortId} to ${mapping.fullId}`);
  return mapping.fullId;
}

// Cleanup expired mappings periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(userIdMappings).forEach(key => {
    if (userIdMappings[key].expiresAt <= now) {
      delete userIdMappings[key];
    }
  });
}, 5 * 60 * 1000); // Clean up every 5 minutes

// Function to get Telegram bot token from Supabase
async function getTelegramBotToken() {
  try {
    // Query the integration_tokens table for an active TELEGRAM_BOT token
    const { data, error } = await supabase
      .from("integration_tokens")
      .select("token_value")
      .eq("token_type", "TELEGRAM_BOT")
      .eq("is_active", true)
      .single();

    if (error) {
      console.error("Error fetching TELEGRAM_BOT token from database:", error);
      throw error;
    }

    if (!data || !data.token_value) {
      console.error("No active TELEGRAM_BOT token found in integration_tokens table");
      throw new Error("Telegram bot token not found");
    }

    console.log("Successfully retrieved Telegram bot token from database");
    return data.token_value;
  } catch (error) {
    console.error("Failed to get Telegram bot token:", error);
    throw error;
  }
}

// Organization-specific configuration interface
interface OrgConfig {
  orgId: string;
  orgName: string;
  adminUsers: any[]; // Includes both admin and manager roles
  managerUsers: any[]; // Added for explicitly storing manager users if needed
  settings: {
    telegram?: {
      enabled: boolean;
      adminUsername?: string;
      botToken?: string;
      webhookUrl?: string;
    };
    [key: string]: any;
  };
}

// Initialize bot as null and set it later
let bot: Telegraf<Context> | null = null;
let isBotRunning = false;
let isReminderServiceRunning = false;
let agent: any = null;

// Store organization-specific configurations
let orgConfigs: OrgConfig[] = [];

// Store organization-specific bots
const orgBots: Record<string, Telegraf<Context>> = {};

// Store organization-specific agents
const orgAgents: Record<string, any> = {};

// Helper function to stream agent responses and update a message
async function streamAndUpdateMessage(
  ctx: any, // Telegraf context
  messageToUpdate: any, // Message object from initial ctx.reply()
  textStream: AsyncIterable<string>,
  options: {
    prefix?: string;
    suffix?: string;
    emptyResponseText?: string;
  } = {}
): Promise<string> { // Returns the core agent-generated text
  const {
    prefix = "",
    suffix = "",
    emptyResponseText = "No further information available.", // Default for empty stream
  } = options;

  let agentGeneratedText = "";
  const chatId = messageToUpdate.chat.id;
  const messageId = messageToUpdate.message_id;

  let lastEditAttemptTime = Date.now();
  const MIN_EDIT_INTERVAL = 750; // milliseconds

  let lastAgentTextSentForEdit = ""; // Tracks the agent text part of the last successful/attempted edit

  for await (const chunk of textStream) {
    agentGeneratedText += chunk;
    const now = Date.now();

    if (agentGeneratedText.trim() === "" && lastAgentTextSentForEdit.trim() === "") continue;

    if (now - lastEditAttemptTime >= MIN_EDIT_INTERVAL || lastAgentTextSentForEdit === "") {
      if (agentGeneratedText !== lastAgentTextSentForEdit) {
        try {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, prefix + agentGeneratedText + suffix);
          lastAgentTextSentForEdit = agentGeneratedText;
          lastEditAttemptTime = now;
        } catch (e: any) {
          if (e.description && e.description.includes("message is not modified")) {
            lastAgentTextSentForEdit = agentGeneratedText;
            lastEditAttemptTime = now;
          } else {
            console.warn(`Telegram stream edit error: ${e.description || e.message}`);
          }
        }
      }
    }
  }

  const finalAgentText = agentGeneratedText.trim() === "" ? emptyResponseText : agentGeneratedText;

  if (finalAgentText !== lastAgentTextSentForEdit || (prefix + finalAgentText + suffix) !== (prefix + lastAgentTextSentForEdit + suffix)) {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, prefix + finalAgentText + suffix);
    } catch (e: any) {
      if (!(e.description && e.description.includes("message is not modified"))) {
        console.error(`Telegram stream final edit error: ${e.description || e.message}`);
      }
    }
  }
  return finalAgentText;
}

// Helper function to get user by Telegram ID
async function getUserByTelegramId(telegramId: string) {
  try {
    console.log(`getUserByTelegramId: Searching for Telegram ID: ${telegramId}`)

    // First check if the user exists directly in the users table with telegram_id
    const { data: directUser, error: directUserError } = await supabase
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single()

    if (!directUserError && directUser) {
      console.log(`getUserByTelegramId: Found user directly with telegram_id: ${directUser.name} (${directUser.email})`)
      return directUser
    }

    // If not found directly, check integration_settings as fallback
    const { data: integration, error: integrationError } = await supabase
      .from("integration_settings")
      .select("user_id")
      .eq("integration_type", "telegram")
      .eq("integration_id", telegramId)
      .single()

    if (integrationError || !integration) {
      console.log(`getUserByTelegramId: No user or integration found for Telegram ID: ${telegramId}`)
      return null
    }

    console.log(`getUserByTelegramId: Found integration, user_id: ${integration?.user_id}`)

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", integration.user_id)
      .single()

    if (userError || !user) {
      console.log(`getUserByTelegramId: No user found for integration user_id: ${integration.user_id}`)
      return null
    }

    console.log(`getUserByTelegramId: Found user: ${user?.name} (${user?.email})`)
    return user
  } catch (error) {
    console.error("Error getting user by Telegram ID:", error)
    return null
  }
}

// Helper function to create Telegram integration
async function createTelegramIntegration(userId: string, telegramData: any) {
  try {
    const integrationData = {
      user_id: userId,
      integration_type: "telegram",
      integration_id: telegramData.id.toString(),
      integration_data: {
        chat_id: telegramData.id.toString(),
        username: telegramData.username || null,
        first_name: telegramData.first_name,
        last_name: telegramData.last_name || null,
        verified_at: new Date().toISOString(),
      },
      is_active: true,
    }

    const { data, error } = await supabase.from("integration_settings").insert(integrationData).select().single()

    if (error) throw error
    return data
  } catch (error) {
    console.error("Error creating Telegram integration:", error)
    throw error
  }
}

// Helper function to find tasks by name
async function findTasksByName(userId: string, taskName: string) {
  try {    const { data, error } = await supabase
      .from("tasks")      .select("id, title")
      .filter('assigned_to', 'cs', `["${userId}"]`) // Fix: properly format user ID for JSONB containment
      .ilike("title", `%${taskName}%`)

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("Error finding tasks by name:", error)
    return []
  }
}

// Helper function to get available projects
async function getAvailableProjects(organizationId?: string) {
  try {
    // Build query for projects, filtering by organization if provided
    let query = supabase
      .from("projects")
      .select("id, name, team_id, organization_id")
      .order("name");

    // Filter by organization if provided
    if (organizationId) {
      console.log(`Filtering projects by organization ID: ${organizationId}`);
      query = query.eq("organization_id", organizationId);
    }

    const { data, error } = await query;

    if (error) throw error;

    return data || [];
  } catch (error) {
    console.error("Error fetching projects:", error);
    return [];
  }
}

// Helper function to get available teams
async function getAvailableTeams(organizationId?: string) {
  try {
    // Build query for teams, filtering by organization if provided
    let query = supabase
      .from("teams")
      .select("id, name, organization_id")
      .order("name");

    // Filter by organization if provided
    if (organizationId) {
      console.log(`Filtering teams by organization ID: ${organizationId}`);
      query = query.eq("organization_id", organizationId);
    }

    const { data, error } = await query;

    if (error) throw error;

    return data || [];
  } catch (error) {
    console.error("Error fetching teams:", error);
    return [];
  }
}


// Helper function to check if user is team lead
async function isUserTeamLead(userId: string, teamId?: string) {
  try {
    // If no team specified, check if user is lead for any team
    if (!teamId) {/* ... */}

    // Check if user is lead for specific team
    const { data, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("user_id", userId)
      .eq("team_id", teamId)
      .eq("role", "team_lead");

    return !error && data && data.length > 0;
  } catch (error) {
    console.error("Error checking team lead status:", error);
    return false;
  }
}

// Helper function to handle thread validation errors
async function handleThreadValidationError(error: any, user: any, ctx: any, threadId: string, resourceId: string, prompt: string, agentInstance: any = agent) {
  // Check if this is a thread validation error
  if (error.message && error.message.includes("Thread with id") && error.message.includes("is for resource with id")) {
    console.log(`Thread validation error detected for user ${user.name} (${user.email})`);

    // Create a new thread ID with a timestamp to ensure uniqueness
    const newThreadId = `${threadId}_${Date.now()}`;
    console.log(`Created new thread ID: ${newThreadId}`);

    // Try again with the new thread ID
    return await agentInstance.stream(prompt, {
      threadId: newThreadId,
      resourceId,
      instructions: `Context: My name is ${user.name}, my email is ${user.email}, my Telegram ID is ${ctx.from.id}, my username is ${ctx.from.username || "not provided"}, my timezone is ${user.timezone || "not provided"}, my phone number is ${user.phone_number || "not provided"}`,
      onFinish: ({
        steps,
        text,
        finishReason,
        usage,
        reasoningDetails,
        providerMetadata,
        response
      }: {
        steps: any[];
        text?: string;
        finishReason?: string;
        usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
        reasoningDetails?: any;
        providerMetadata?: { openai?: { model?: string | any } };
        response?: any;
      }) => {
        console.log("Stream complete (error handler):", {
          totalSteps: steps.length,
          finishReason,
          providerMetadata,
          usage
        });
        
        // Store token usage data in the database
        if (usage && user) {
          const tokenUsageData: TokenUsageData = {
            user_id: user.id,
            platform_type: 'telegram',
            prompt_tokens: usage.promptTokens || 0,
            completion_tokens: usage.completionTokens || 0,
            total_tokens: usage.totalTokens || 0,
            finish_reason: finishReason,
            model: providerMetadata?.openai?.model ? String(providerMetadata.openai.model) : undefined,
            organization_id: user.organization_id
          };
          
          storeTokenUsage(supabase, tokenUsageData)
            .then(success => {
              if (success) {
                console.log(`✅ Token usage data stored for user ${user.id} on telegram (error handler)`);
              }
            })
            .catch(err => {
              console.error("Error storing token usage data:", err);
            });
        }
      },
    });
  } else {
    // Re-throw other errors
    throw error;
  }
}

// Helper function to create priority options for inline keyboard
function createPriorityOptions() {
  return [
    [
      { text: "🟢 Low", callback_data: "priority_low" },
      { text: "🟡 Medium", callback_data: "priority_medium" }
    ],
    [
      { text: "🟠 High", callback_data: "priority_high" },
      { text: "🔴 Urgent", callback_data: "priority_urgent" }
    ]
  ];
}

// Helper function to create date options for inline keyboard
function createDateOptions() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  return [
    [
      { text: "Today", callback_data: `date_${today.toISOString().split('T')[0]}` },
      { text: "Tomorrow", callback_data: `date_${tomorrow.toISOString().split('T')[0]}` }
    ],
    [
      { text: "Next Week", callback_data: `date_${nextWeek.toISOString().split('T')[0]}` },
      { text: "Custom Date", callback_data: "date_custom" }
    ]
  ];
}

// Function to start task creation form
async function startTaskCreationForm(ctx: Context) {
  try {
    if (!ctx.from) {
      console.error('No sender information in context');
      return;
    }

    const telegramId = ctx.from.id.toString();
    const user = ctx.state.authenticatedUser;
    
    if (!user) {
      console.log(`Security: Rejected task creation from unauthenticated user: ${telegramId}`);
      await ctx.reply('⚠️ Authentication required. Please authenticate first.');
      return;
    }

    // Initialize task form state with proper cleanup of any existing session
    if (userSessions[telegramId]) {
      // Clean up any existing session
      delete userSessions[telegramId];
    }

    userSessions[telegramId] = {
      step: 'title',
      taskData: {}
    };

    // Start with asking for task title
    const message = await ctx.reply(
      "Let's create a new task! 📝\n\nPlease enter a title for your task:",
      { reply_markup: { force_reply: true } }
    );

    // Store message ID for later updates
    userSessions[telegramId].messageId = message.message_id;
    
  } catch (error) {
    console.error('Error in startTaskCreationForm:', error);
    await ctx.reply('❌ An error occurred while starting task creation. Please try again.');
    
    // Clean up session on error
    if (ctx.from) {
      delete userSessions[ctx.from.id.toString()];
    }
  }
}

// Enhanced task creation form that supports pre-filled title
async function startTaskCreationFormWithTitle(ctx: Context, prefilledTitle?: string) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();

  // Initialize task form state
  userSessions[telegramId] = {
    step: prefilledTitle ? 'project' : 'title',
    taskData: prefilledTitle ? { title: prefilledTitle } : {}
  };

  if (prefilledTitle) {
    // If we have a pre-filled title, skip to project selection
    await ctx.reply(`Creating task: *${prefilledTitle}*\n\nNow let's select a project for this task.`, { parse_mode: 'Markdown' });
    await showProjectSelectionForm(ctx);
  } else {
    // Start with asking for task title
    const message = await ctx.reply(
      "Let's create a new task! 📝\n\nPlease enter a title for your task:",
      { reply_markup: { force_reply: true } }
    );

    // Store the message ID for potential updates
    userSessions[telegramId].messageId = message.message_id;
  }
}

// Show task status update form
async function showTaskStatusUpdateForm(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  
  // Use the authenticated user from middleware
  const user = ctx.state.authenticatedUser;
  if (!user) {
    console.log(`Security: Rejected task update form request from unauthenticated user: ${telegramId}`);
    return;
  }
  try {
    // Debug info for troubleshooting
    console.log(`Debug: Fetching tasks for user ID: ${user.id}`);
    console.log(`Debug: User ID type: ${typeof user.id}`);
    console.log(`Debug: User ID length: ${user.id.length}`);
    
    // Get user's tasks
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select(`
        id,
        title,
        status,
        deadline,
        priority,
        assigned_to,
        projects (
          id,
          name,
          team_id
        )
      `)      // Fix: properly format the user ID for JSONB containment
      .filter('assigned_to', 'cs', `["${user.id}"]`)
      .neq("status", "completed")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("Error fetching user tasks:", error);
      await ctx.reply("❌ Error fetching your tasks. Please try again later.");
      return;
    }

    if (!tasks || tasks.length === 0) {
      await ctx.reply("You have no active tasks to update. 🎉");
      return;
    }    // Create inline keyboard for task selection
    const keyboard = tasks.map((task: any) => {
      const statusEmojiMap: Record<string, string> = {
        'pending': '⏳',
        'in_progress': '🚧',
        'completed': '✅',
        'cancelled': '❌'
      };
      const statusEmoji = statusEmojiMap[task.status as keyof typeof statusEmojiMap] || '📝';

      return [{ 
        text: `${statusEmoji} ${task.title}`, 
        callback_data: `update_task_${task.id}` 
      }];
    });

    // Add cancel option
    keyboard.push([{ text: "❌ Cancel", callback_data: "cancel_task_update" }]);

    await ctx.reply(
      "📋 *Select a task to update its status:*",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );

  } catch (error) {
    console.error("Error in showTaskStatusUpdateForm:", error);
    await ctx.reply("❌ An error occurred while fetching your tasks. Please try again later.");
  }
}

// Comprehensive task editing form
async function showTaskEditForm(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Use the authenticated user from middleware
  const user = ctx.state.authenticatedUser;
  if (!user) {
    console.log(`Security: Rejected task edit form request from unauthenticated user: ${telegramId}`);
    return;
  }

  try {
    // Get user's tasks
    const { data: tasks, error } = await supabase
      .from("tasks")      .select(`
        id,
        title,
        description,
        status,
        deadline,
        priority,
        assigned_to,
        projects (
          id,
          name,
          team_id        )
      `)      .filter('assigned_to', 'cs', `["${user.id}"]`)
      .neq("status", "completed")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("Error fetching user tasks:", error);
      await ctx.reply("❌ Error fetching your tasks. Please try again later.");
      return;
    }

    if (!tasks || tasks.length === 0) {
      await ctx.reply("You have no active tasks to edit. 🎉");
      return;
    }

    // Create inline keyboard for task selection
    const keyboard = tasks.map((task: any) => {
      const priorityEmoji = {
        'low': '🟢',
        'medium': '🟡', 
        'high': '🟠',
        'urgent': '🔴'
      }[task.priority as string] || '📝';

      const projectInfo = task.projects?.name ? ` (${task.projects.name})` : '';
      
      return [{ 
        text: `${priorityEmoji} ${task.title}${projectInfo}`, 
        callback_data: `edit_task_${task.id}` 
      }];
    });

    // Add cancel option
    keyboard.push([{ text: "❌ Cancel", callback_data: "cancel_edit" }]);

    await ctx.reply(
      "🔧 *Edit Task*\n\nSelect a task to edit:",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );

  } catch (error) {
    console.error("Error in showTaskEditForm:", error);
    await ctx.reply("❌ An error occurred while fetching your tasks. Please try again later.");
  }
}

// Function to show task edit options after task is selected
async function showTaskEditOptions(ctx: Context, taskId: string) {
  const user = ctx.state.authenticatedUser;
  if (!user) return;

  try {    // Get the specific task details
    const { data: task, error } = await supabase
      .from("tasks")      .select(`
        id,
        title,
        description,
        status,
        deadline,
        priority,
        project_id,
        projects (
          id,
          name
        ),
        assigned_to
      `)      .eq("id", taskId)
      .filter('assigned_to', 'cs', `["${user.id}"]`) // Security: fixed JSONB format
      .single();

    if (error || !task) {
      await ctx.reply("❌ Task not found or you don't have permission to edit it.");
      return;
    }    // Store the task ID in session for editing
    const telegramId = ctx.from?.id.toString();
    if (telegramId) {
      const projects = task.projects as any;
      // Handle assigned_to as JSONB array
      const assignedToIds = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to];
      const assigneeId = assignedToIds[0]; // Use first assignee for editing
      
      // Only initialize session if it doesn't exist or if we're starting fresh
      if (!userSessions[telegramId] || 
          !('editingTaskId' in userSessions[telegramId]) || 
          (userSessions[telegramId] as TaskFormState).editingTaskId !== taskId) {
        userSessions[telegramId] = {
          step: 'edit_task',
          editingTaskId: taskId,
          taskData: {
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            deadline: task.deadline,
            projectId: task.project_id,
            projectName: Array.isArray(projects) ? projects[0]?.name : projects?.name,
            assigneeId: assigneeId,
            assigneeName: "Current User", // Will need to fetch from users table if needed
            assigneeEmail: user.email, // Default to current user's email
          }
        };
      } else {
        // Just update the step, keep the modified taskData
        userSessions[telegramId].step = 'edit_task';
      }
    }    // Get current session data for display (to show modified values)
    const currentSession = telegramId ? userSessions[telegramId] : undefined;
    const currentTaskData = currentSession?.taskData;
    
    // Use session data if available, fallback to database values
    const displayTitle = currentTaskData?.title || task.title;
    const displayDescription = currentTaskData?.description || task.description || "No description";
    const displayStatus = currentTaskData?.status || task.status;
    const displayPriority = currentTaskData?.priority || task.priority;
    
    const displayDeadline = (() => {
      if (currentTaskData?.deadline) {
        // If it's in DD/MM/YYYY format, display as-is
        if (currentTaskData.deadline.includes('/')) {
          return currentTaskData.deadline;
        }
        // If it's ISO format, convert to DD/MM/YYYY
        return new Date(currentTaskData.deadline).toLocaleDateString('en-GB');
      }
      if (task.deadline) {
        return new Date(task.deadline).toLocaleDateString('en-GB');
      }
      return "No deadline";
    })();    const projects = task.projects as any;
    
    const displayProjectName = currentTaskData?.projectName || 
      (Array.isArray(projects) ? projects[0]?.name : projects?.name) || 
      "No project";
    
    // Get assignee names from assigned_to JSONB array
    let displayAssigneeName = "Unknown";
    if (currentTaskData?.assigneeName) {
      displayAssigneeName = currentTaskData.assigneeName;
    } else if (task.assigned_to) {
      // For JSONB array format, we'd need to fetch user names
      // For now, show user IDs or count
      const assignedTo = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to];      if (assignedTo.length === 1) {
        displayAssigneeName = `User ${assignedTo[0]}`;
      } else if (assignedTo.length > 1) {
        displayAssigneeName = `${assignedTo.length} users`;
      }
    }const taskInfo = `📋 *Editing Task:* ${escapeMarkdown(displayTitle)}\n\n` +
      `📝 *Description:* ${escapeMarkdown(displayDescription)}\n` +
      `🔹 *Status:* ${escapeMarkdown(displayStatus)}\n` +
      `⭐ *Priority:* ${escapeMarkdown(displayPriority)}\n` +
      `📅 *Deadline:* ${escapeMarkdown(displayDeadline)}\n` +
      `📂 *Project:* ${escapeMarkdown(displayProjectName)}\n` +
      `👤 *Assigned to:* ${escapeMarkdown(displayAssigneeName)}\n\n` +
      `Select what you want to edit:`;

    const keyboard = [
      [
        { text: "📝 Title", callback_data: `edit_field_title_${taskId}` },
        { text: "📄 Description", callback_data: `edit_field_description_${taskId}` }
      ],
      [
        { text: "⭐ Priority", callback_data: `edit_field_priority_${taskId}` },
        { text: "📅 Deadline", callback_data: `edit_field_deadline_${taskId}` }
      ],
      [
        { text: "📂 Project", callback_data: `edit_field_project_${taskId}` },
        { text: "👤 Assignee", callback_data: `edit_field_assignee_${taskId}` }
      ],
      [
        { text: "🔄 Status", callback_data: `edit_field_status_${taskId}` }
      ],
      [
        { text: "✅ Done Editing", callback_data: "finish_edit" },
        { text: "❌ Cancel", callback_data: "cancel_edit" }
      ]
    ];

    await ctx.reply(taskInfo, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });

  } catch (error) {
    console.error("Error in showTaskEditOptions:", error);
    await ctx.reply("❌ An error occurred. Please try again later.");
  }
}

// Function to display project selection form - UPDATED
async function showProjectSelectionForm(ctx: Context) {
  try {
    if (!ctx.from) {
      console.error('No sender information in context');
      return;
    }

    const telegramId = ctx.from.id.toString();
    const session = userSessions[telegramId];
    const user = ctx.state.authenticatedUser;

    if (!session) {
      console.error(`No session found for user ${telegramId}`);
      await ctx.reply('❌ Session expired. Please start over by creating a new task.');
      return;
    }

    if (!user) {
      console.log(`Security: Rejected project selection from unauthenticated user: ${telegramId}`);
      await ctx.reply('⚠️ Authentication required. Please authenticate first.');
      return;
    }
  
    // Check if this is a TaskFormState before accessing taskData
    if (!('taskData' in session)) {
      await ctx.reply("❌ Invalid session state. Please start over by creating a new task.");
      delete userSessions[telegramId];
      return;
    }

    // Update session state
    session.step = 'project';

    try {      // Get available projects for this user's organization
      const projects = await getAvailableProjects(user.organization_id);

      if (!projects || projects.length === 0) {
        // Handle case when no projects are available
        // isAdmin will be true for both admin and manager roles
        const isAdmin = await isUserAdmin(user.id);
        const message = isAdmin ? 
          "No projects found. You can create a new project using the button below." :
          "No projects found. Please contact an admin or manager to create a project.";

        // Create inline keyboard
        const keyboard = [];
        if (isAdmin) {
          keyboard.push([{ text: "➕ Create New Project", callback_data: "project_new" }]);
        }
        keyboard.push([{ text: "❌ Cancel Task Creation", callback_data: "cancel_task_creation" }]);

        await ctx.reply(message, {
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }

      // Create inline keyboard with projects
      const projectButtons = projects.reduce((buttons: any[], project, index) => {
        // Create rows with 2 buttons each
        if (index % 2 === 0) {
          buttons.push([{ text: project.name, callback_data: `project_${project.id}` }]);
        } else {
          buttons[buttons.length - 1].push({ text: project.name, callback_data: `project_${project.id}` });
        }
        return buttons;
      }, []);      // Add "Create New Project" button only for admins or managers
      const isAdmin = await isUserAdmin(user.id);
      if (isAdmin) {
        projectButtons.push([{ text: "➕ Create New Project", callback_data: "project_new" }]);
      }

      // Show project selection
      await ctx.reply(
        `*Task:* ${escapeMarkdown(session.taskData.title)}\n\nPlease select a project for this task:${!isAdmin ? "\n\n(Note: Only admins and managers can create new projects)" : ""}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: projectButtons
          }
        }
      );
    } catch (dbError) {
      console.error('Error fetching projects:', dbError);
      await ctx.reply('❌ Failed to load projects. Please try again later.');
      return;
    }
  } catch (error) {
    console.error('Error in showProjectSelectionForm:', error);
    await ctx.reply('❌ An error occurred. Please try again later.');
    
    // Clean up session on error
    if (ctx.from) {
      delete userSessions[ctx.from.id.toString()];
    }
  }
}

// Function to display team selection form - UPDATED
async function showTeamSelectionForm(ctx: Context) {
  try {
    if (!ctx.from) {
      console.error('No sender information in context');
      return;
    }

    const telegramId = ctx.from.id.toString();
    const session = userSessions[telegramId];
    const user = ctx.state.authenticatedUser;

    if (!session) {
      console.error(`No session found for user ${telegramId}`);
      await ctx.reply('❌ Session expired. Please start over by creating a new task.');
      return;
    }

    if (!user) {
      console.log(`Security: Rejected team selection from unauthenticated user: ${telegramId}`);
      await ctx.reply('⚠️ Authentication required. Please authenticate first.');
      return;
    }

    // Update session state
    session.step = 'team';

    try {
      // Get available teams for this user's organization
      const { data: teams, error: teamsError } = await supabase
        .from("teams")
        .select("id, name")
        .eq('organization_id', user.organization_id)
        .order('name');

      if (teamsError) {
        throw new Error(`Error fetching teams: ${teamsError.message}`);
      }

      // Create inline keyboard with teams
      const teamButtons = (teams || []).reduce((buttons: any[], team, index) => {
        // Create rows with 2 buttons each
        if (index % 2 === 0) {
          buttons.push([{ text: team.name, callback_data: `team_${team.id}` }]);
        } else {
          buttons[buttons.length - 1].push({ text: team.name, callback_data: `team_${team.id}` });
        }
        return buttons;
      }, []);

      // Add "No Team" option
      teamButtons.push([{ text: "No Team", callback_data: "team_none" }]);      // Add "Create New Team" button only for admins, managers and team leads
      const isAdmin = await isUserAdmin(user.id); // isAdmin is true for both admin and manager roles
      const isTeamLead = await isUserTeamLead(user.id);

      if (isAdmin || isTeamLead) {
        teamButtons.push([{ text: "➕ Create New Team", callback_data: "team_new" }]);
      }

      // Add cancel option
      teamButtons.push([{ text: "❌ Cancel", callback_data: "cancel_task_creation" }]);

      // Show team selection with current task info
      await ctx.reply(
        `*Task:* ${escapeMarkdown(session.taskData.title)}\n*Project:* ${escapeMarkdown(session.taskData.projectName || "Not specified")}\n\nPlease select a team:${(!isAdmin && !isTeamLead) ? "\n\n(Note: Only admins, managers, and team leads can create new teams)" : ""}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: teamButtons
          }
        }
      );
    } catch (dbError) {
      console.error('Error fetching teams:', dbError);
      await ctx.reply('❌ Failed to load teams. Please try again later.');
      return;
    }
  } catch (error) {
    console.error('Error in showTeamSelectionForm:', error);
    await ctx.reply('❌ An error occurred. Please try again later.');
    
    // Clean up session on error
    if (ctx.from) {
      delete userSessions[ctx.from.id.toString()];
    }
  }
}

// Function to display priority selection form with enhanced validation
async function showPrioritySelectionForm(ctx: Context) {
  try {
    if (!ctx.from) {
      console.error('No sender information in context');
      return;
    }

    const telegramId = ctx.from.id.toString();
    const session = userSessions[telegramId];
    const user = ctx.state.authenticatedUser;

    if (!session) {
      console.error(`No session found for user ${telegramId}`);
      await ctx.reply('❌ Session expired. Please start over by creating a new task.');
      return;
    }

    if (!user) {
      console.log(`Security: Rejected priority selection from unauthenticated user: ${telegramId}`);
      await ctx.reply('⚠️ Authentication required. Please authenticate first.');
      return;
    }

    // Validate required previous steps
    if (!session.taskData.title) {
      await ctx.reply('❌ Task title is required before setting priority. Please start over.');
      delete userSessions[telegramId];
      return;
    }

    // Update session state
    session.step = 'priority';

    // Show priority selection with complete task info
    await ctx.reply(
      `*Current Task Details*\n\n` +
      `*Task:* ${escapeMarkdown(session.taskData.title)}\n` +
      `*Project:* ${escapeMarkdown(session.taskData.projectName || "Not specified")}\n` +
      `*Team:* ${escapeMarkdown(session.taskData.teamName || "No Team")}\n\n` +
      `Please select a priority:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: createPriorityOptions()
        }
      }
    );
  } catch (error) {
    console.error('Error in showPrioritySelectionForm:', error);
    await ctx.reply('❌ An error occurred. Please try again later.');
    
    // Clean up session on error
    if (ctx.from) {
      delete userSessions[ctx.from.id.toString()];
    }
  }
}

// Function to display deadline selection form
async function showDeadlineSelectionForm(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const session = userSessions[telegramId];

  if (!session) return;

  // Update session state
  session.step = 'deadline';
  // Show deadline selection
  await ctx.reply(
    `*Task:* ${escapeMarkdown(session.taskData.title)}\n*Project:* ${escapeMarkdown(session.taskData.projectName || "Not specified")}\n*Team:* ${escapeMarkdown(session.taskData.teamName || "No Team")}\n*Priority:* ${escapeMarkdown(session.taskData.priority || "Not specified")}\n\nPlease select a deadline:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: createDateOptions()
      }
    }
  );
}

// Function to ask for description
async function askForDescription(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const session = userSessions[telegramId];

  if (!session) return;

  // Update session state
  session.step = 'description';

  // Ask for description with force reply
  await ctx.reply(
    `Please enter a description for the task "${session.taskData.title}" (or type "skip" to skip):`,
    { reply_markup: { force_reply: true } }
  );
}

// Function to ask for assignee - UPDATED for multiple assignees with organization filtering and pagination
async function askForAssignee(ctx: Context, page: number = 0) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const session = userSessions[telegramId];
  const user = ctx.state.authenticatedUser;

  if (!session || !user) return;

  // Update session state
  session.step = 'assignee';
  
  // Initialize assignee list if not exists
  if (!session.taskData.assigneeIds) {
    session.taskData.assigneeIds = [];
    session.taskData.assigneeNames = [];
    session.taskData.assigneeEmails = [];
  }

  // Check user permissions
  // isAdmin now returns true for both 'admin' and 'manager' roles
  const isAdmin = await isUserAdmin(user.id);
  const isTeamLead = session.taskData.teamId ?
    await isUserTeamLead(user.id, session.taskData.teamId) :
    await isUserTeamLead(user.id);

  // If not admin/manager or team lead, automatically assign to self
  if (!isAdmin && !isTeamLead) {
    session.taskData.assigneeIds = [user.id];
    session.taskData.assigneeNames = [user.name];
    session.taskData.assigneeEmails = [user.email];
    
    // For backward compatibility
    session.taskData.assigneeId = user.id;
    session.taskData.assigneeName = user.name;
    session.taskData.assigneeEmail = user.email;

    await ctx.reply(
      `As a regular user, you can only create tasks assigned to yourself. This task will be assigned to you (${user.name}).`
    );

    // Continue to task confirmation
    await showTaskConfirmation(ctx);
    return;
  }

  // Pagination settings
  const pageSize = 8; // Reduced to accommodate pagination buttons
  const offset = page * pageSize;

  // Get available users for assignment - FILTERED BY ORGANIZATION
  const { data: users, error } = await supabase
    .from("users")
    .select("id, name, email")
    .eq("organization_id", user.organization_id) // Filter by organization
    .order("name")
    .range(offset, offset + pageSize - 1);

  if (error) {
    console.error("Error fetching users:", error);
    await ctx.reply("❌ Error fetching users. Please try again.");
    return;
  }

  // Get total count for pagination
  const { count: totalUsers } = await supabase
    .from("users")
    .select("id", { count: 'exact' })
    .eq("organization_id", user.organization_id);

  const totalPages = Math.ceil((totalUsers || 0) / pageSize);

  // Create buttons for users
  const userButtons = (users || []).reduce((buttons: any[], userItem) => {
    // Create rows with 1 button each due to potentially long names
    buttons.push([{
      text: `${userItem.name} (${userItem.email})`,
      callback_data: `assignee_${userItem.id}`
    }]);
    return buttons;
  }, []);

  // Add "Assign to me" button at the top
  userButtons.unshift([{
    text: `✅ Assign to me (${user.name})`,
    callback_data: `assignee_${user.id}`
  }]);
  
  // Add "Multiple assignees" and "Done selecting" buttons
  userButtons.unshift([{
    text: "➕ Add multiple assignees",
    callback_data: "multi_assignees"
  }]);
  
  if (session.taskData.assigneeIds.length > 0) {
    userButtons.unshift([{
      text: "✅ Done selecting assignees",
      callback_data: "done_selecting_assignees"
    }]);
  }

  // Add pagination buttons if needed
  if (totalPages > 1) {
    const paginationButtons = [];
    
    if (page > 0) {
      paginationButtons.push({
        text: "◀ Previous",
        callback_data: `assignee_page_${page - 1}`
      });
    }
    
    // Show current page info
    paginationButtons.push({
      text: `${page + 1}/${totalPages}`,
      callback_data: "page_info" // Non-functional button for display
    });
    
    if (page < totalPages - 1) {
      paginationButtons.push({
        text: "Next ▶",
        callback_data: `assignee_page_${page + 1}`
      });
    }
    
    userButtons.push(paginationButtons);
  }

  // Show assignee selection
  await ctx.reply(
    `*Task:* ${escapeMarkdown(session.taskData.title)}\n*Project:* ${escapeMarkdown(session.taskData.projectName || "Not specified")}\n*Team:* ${escapeMarkdown(session.taskData.teamName || "No Team")}\n*Priority:* ${escapeMarkdown(session.taskData.priority || "Not specified")}\n*Deadline:* ${escapeMarkdown(session.taskData.deadline || "Not specified")}\n\n👥 Select who to assign this task to:\n${totalPages > 1 ? `\n📄 Page ${page + 1} of ${totalPages} (${totalUsers} users in your organization)` : `\n👥 ${users?.length || 0} users in your organization`}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: userButtons
      }
    }
  );
}

// Function to show task confirmation
async function showTaskConfirmation(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const session = userSessions[telegramId];

  if (!session) return;

  // Check if this is a TaskFormState
  if (!('taskData' in session)) {
    await ctx.reply("❌ Invalid session state for task confirmation.");
    return;
  }
  // Update session state
  session.step = 'confirm';
  // Build confirmation message
  let confirmationMessage = "*Task Summary*\n\n";
  confirmationMessage += `*Title:* ${escapeMarkdown(session.taskData.title)}\n`;
  confirmationMessage += `*Description:* ${escapeMarkdown(session.taskData.description || "None provided")}\n`;
  confirmationMessage += `*Project:* ${escapeMarkdown(session.taskData.projectName || "Not specified")}\n`;
  confirmationMessage += `*Team:* ${escapeMarkdown(session.taskData.teamName || "No Team")}\n`;
  confirmationMessage += `*Priority:* ${escapeMarkdown(session.taskData.priority || "Medium")}\n`;
  confirmationMessage += `*Deadline:* ${escapeMarkdown(session.taskData.deadline || "Not specified")}\n`;
  
  // Display assignee(s)
  if (session.taskData.assigneeIds && session.taskData.assigneeIds.length > 1 && 
      session.taskData.assigneeNames && session.taskData.assigneeNames.length > 0) {
    // Multiple assignees
    confirmationMessage += `*Assigned to:* ${session.taskData.assigneeNames.length} people\n`;
    for (let i = 0; i < session.taskData.assigneeNames.length; i++) {
      const name = session.taskData.assigneeNames[i] || "Unknown";
      const email = session.taskData.assigneeEmails && session.taskData.assigneeEmails[i] ? 
                    ` (${session.taskData.assigneeEmails[i]})` : "";
      confirmationMessage += `  ${i+1}. ${escapeMarkdown(name)}${escapeMarkdown(email)}\n`;
    }
  } else {
    // Single assignee (backward compatibility)
    confirmationMessage += `*Assigned to:* ${escapeMarkdown(session.taskData.assigneeName || "Not assigned")}\n`;
    if (session.taskData.assigneeEmail) {
      confirmationMessage += `*Email:* ${escapeMarkdown(session.taskData.assigneeEmail)}\n`;
    }
  }
  // Show confirmation
  await ctx.reply(
    confirmationMessage,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Create Task", callback_data: "confirm_create" },
            { text: "✏️ Edit", callback_data: "edit_before_create" }
          ],
          [
            { text: "❌ Cancel", callback_data: "confirm_cancel" }
          ]
        ]
      }
    }
  );
}

// Function to create task in database - UPDATED
async function createTaskFromForm(ctx: Context, user: any) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const session = userSessions[telegramId];

  if (!session) return;

  try {
    // Validate project exists if specified
    if (session.taskData.projectName && !session.taskData.projectId) {
      // Check if this is a newly created project by an admin, or just a non-existent project
      const isAdmin = await isUserAdmin(user.id);
      if (!isAdmin) {
        const projects = await getAvailableProjects(user.organization_id);
        const projectsList = projects.map(p => `- ${p.name}`).join('\n');

        await ctx.reply(
          `⚠️ Error: The project "${session.taskData.projectName}" does not exist, and only admins and managers can create new projects.\n\nAvailable projects:\n${projectsList || "No projects found."}`
        );
        delete userSessions[telegramId];
        return false;
      }
    }

    // Validate team exists if specified
    if (session.taskData.teamName && !session.taskData.teamId && session.taskData.teamName !== "No Team") {
      // Check if this is a newly created team by an admin, or just a non-existent team
      const isAdmin = await isUserAdmin(user.id);
      if (!isAdmin) {
        const teams = await getAvailableTeams(user.organization_id);
        const teamsList = teams.map(t => `- ${t.name}`).join('\n');

        await ctx.reply(
          `⚠️ Error: The team "${session.taskData.teamName}" does not exist, and only admins and managers can create new teams.\n\nAvailable teams:\n${teamsList || "No teams found."}`
        );
        delete userSessions[telegramId];
        return false;
      }
    }

    // Verify assignee permissions
    if (session.taskData.assigneeId && session.taskData.assigneeId !== user.id) {
      const isAdmin = await isUserAdmin(user.id);
      const isTeamLead = session.taskData.teamId ?
        await isUserTeamLead(user.id, session.taskData.teamId) :
        await isUserTeamLead(user.id);

      if (!isAdmin && !isTeamLead) {
        await ctx.reply(
          "⚠️ Error: As a regular user, you can only create tasks assigned to yourself. Only admins and team leads can assign tasks to others."
        );
        delete userSessions[telegramId];
        return false;
      }
    }    // Prepare task data
    const assigneeIds = session.taskData.assigneeIds && session.taskData.assigneeIds.length > 0 
        ? session.taskData.assigneeIds 
        : [session.taskData.assigneeId || user.id];
        
    const taskData = {
      title: session.taskData.title || "New Task",
      description: session.taskData.description || session.taskData.title || "New Task",
      assigned_to: assigneeIds, // Store as JSONB array
      project_id: session.taskData.projectId || null,
      status: "pending",
      priority: session.taskData.priority?.toLowerCase() || "medium",
      deadline: session.taskData.deadline ? new Date(session.taskData.deadline).toISOString() : null,
      created_at: new Date().toISOString(),
      organization_id: user.organization_id,
      created_by: user.id // Add the creator's ID
    };

    console.log("Creating task with data:", taskData);    const { data: newTask, error: taskError } = await supabase
      .from("tasks")
      .insert(taskData)
      .select()
      .single();

    if (taskError) {
      console.error("Error creating task:", taskError);
      await ctx.reply(`Error creating task: ${taskError.message}`);
      return false;
    }    // Send immediate notification to each assignee
    try {
      const creatorName = user.name || user.email || 'Someone';
      
      // Send notifications to all assignees
      for (const assigneeId of assigneeIds) {
        await sendNewTaskAssignmentNotification(newTask.id, assigneeId, creatorName);
      }
      
      console.log(`✅ Task assignment notifications sent to ${assigneeIds.length} user(s) successfully`);
    } catch (notificationError) {
      console.error("❌ Error sending task assignment notifications:", notificationError);
      // Don't fail task creation if notifications fail
    }    // Format success message
    let responseText = `✅ Task created successfully!\n\n`;
    responseText += `Task: ${newTask.title}\n`;
    
    // Display assignee(s) information
    if (session.taskData.assigneeIds && session.taskData.assigneeIds.length > 1 && 
        session.taskData.assigneeNames && session.taskData.assigneeNames.length > 0) {
      // Multiple assignees
      responseText += `Assigned to: ${session.taskData.assigneeNames.length} people\n`;
      for (let i = 0; i < session.taskData.assigneeNames.length; i++) {
        const name = session.taskData.assigneeNames[i] || "Unknown";
        const email = session.taskData.assigneeEmails && session.taskData.assigneeEmails[i] ? 
                      ` (${session.taskData.assigneeEmails[i]})` : "";
        responseText += `  ${i+1}. ${name}${email}\n`;
      }
    } else {
      // Single assignee (backward compatibility)
      responseText += `Assigned to: ${session.taskData.assigneeName || user.name}\n`;
      responseText += `Email: ${session.taskData.assigneeEmail || user.email}\n`;
    }
    
    responseText += `Project: ${session.taskData.projectName || "No Project"}\n`;
    responseText += `Team: ${session.taskData.teamName || "No Team"}\n`;

    if (session.taskData.deadline) {
      responseText += `Due: ${new Date(session.taskData.deadline).toLocaleDateString()}\n`;
    } else {
      responseText += "Due: No deadline set\n";
    }

    // Send success message with action buttons including edit option
    await ctx.reply(responseText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✏️ Edit This Task", callback_data: `edit_task_${newTask.id}` },
            { text: "➕ Create Another Task", callback_data: "action_create_another_task" }
          ]
        ]
      }
    });

    // Clear session
    delete userSessions[telegramId];

    return true;
  } catch (error) {
    console.error("Error in final task creation:", error);
    await ctx.reply("Sorry, there was an error creating the task. Please try again.");
    return false;
  }
}

// Initialize all bot handlers
function initializeHandlers(botInstance: Telegraf<Context>, agentInstance: any, orgId?: string) {
  try {
    if (!botInstance) {
      console.error("Bot instance is not provided");
      return;
    }

    // Store the organization ID in the bot's context for later use
    const botOrgId = orgId || null;

  // Middleware to check if user exists and reject if not registered
  botInstance.use(async (ctx, next) => {
    try {
      if (!ctx.from) return next();

      const telegramId = ctx.from.id.toString();
      console.log(`Authenticating user with Telegram ID: ${telegramId}`);

      const user = await getUserByTelegramId(telegramId);

      // If user is not found in the database, reject the message
      if (!user) {
        console.log(`Security: Rejected message from unregistered Telegram ID: ${telegramId}`);
        await ctx.reply("⚠️ Access denied. Your Telegram ID is not registered in our system. Please contact an administrator or manager to get access.");
        return; // Do not proceed to next middleware
      }

      // Check if the user belongs to the correct organization
      if (botOrgId && user.organization_id && user.organization_id !== botOrgId) {
        console.log(`Security: Rejected message from user ${user.name} (${user.email}) with Telegram ID: ${telegramId} - user belongs to organization ${user.organization_id} but bot is for organization ${botOrgId}`);
        await ctx.reply("⚠️ Access denied. You are not authorized to use this bot instance. Please contact your administrator.");
        return; // Do not proceed to next middleware
      }

      // If we reach here, the user is authenticated
      console.log(`Security: Authenticated user ${user.name} (${user.email}) with Telegram ID: ${telegramId}`);

      // Store the authenticated user in context for later use
      ctx.state.authenticatedUser = user;

      await next();
    } catch (error) {
      console.error("Error in authentication middleware:", error);
      await ctx.reply("❌ An error occurred during authentication. Please try again later.");
    } finally {
      // Cleanup any temporary authentication data if needed
      if (ctx.state.tempAuthData) {
        delete ctx.state.tempAuthData;
      }
    }
  })

  // Start command handler
  botInstance.start(async (ctx) => {
    if (!ctx.from) return;

    // Use the authenticated user from middleware
    const user = ctx.state.authenticatedUser;
    if (!user) {
      console.log(`Security: Attempted to use /start command with unauthenticated user: ${ctx.from.id}`);
      return;
    }

    // Create memory thread ID based on user's Telegram ID
    const threadId = `telegram_${ctx.from.id}`;
    // Use user's database ID as the resource ID
    const resourceId = user.id;

    console.log(`Processing /start command for authenticated user: ${user.name} (${user.email}) with Telegram ID: ${ctx.from.id}`);

    // Send welcome message with memory
    let streamResponse;

    try {
      streamResponse = await agentInstance.stream(
        "Hi! I'm TaskMate. Please introduce yourself and tell me how I can help you manage your tasks today.",
        {
          threadId,
          resourceId,
        }
      );
    } catch (error: any) {
      try {
        // Use the helper function to handle thread validation errors
        const welcomeMessage = "Hi! I'm TaskMate. Please introduce yourself and tell me how I can help you manage your tasks today.";
        streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, welcomeMessage, agentInstance);
      } catch (innerError) {
        // Re-throw other errors
        throw innerError;
      }
    }

    const staticSuffix = "\n\n" +
      "Here are some examples of what you can do:\n\n" +
      "📝 Creating Tasks:\n" +
      '• "Create a task to review the project proposal"\n' +
      '• "I need to prepare a presentation for next week"\n' +
      "📋 Viewing Tasks:\n" +
      '• "Show my tasks"\n' +
      '• "What tasks do I have pending?"\n\n' +
      "✅ Updating Tasks:\n" +
      '• "Mark the review task as done"\n' +
      '• "I finished the presentation"\n\n' +
      "⏰ Setting Reminders:\n" +
      '• "Remind me about the meeting at 3pm"\n' +
      '• "Set a reminder for the project review on Friday"\n\n' +
      "Just chat with me naturally and I'll help you manage your tasks!";

    const initialMessage = await ctx.reply("👋 Getting things ready...");
    await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream, {
      suffix: staticSuffix,
      emptyResponseText: "Welcome to TaskMate! How can I assist you today?" // Custom empty text for start
    });
  })

  // Projects command handler
  botInstance.command("projects", async (ctx) => {
    if (!ctx.from) return;

    const telegramId = ctx.from.id.toString();
    let threadId = `telegram_${telegramId}`;

    try {
      // Use the authenticated user from middleware
      const user = ctx.state.authenticatedUser;
      if (!user) {
        console.log(`Security: Attempted to use /projects command with unauthenticated user: ${telegramId}`);
        return;
      }

      console.log(`Processing /projects command for authenticated user: ${user.name} (${user.email}) with Telegram ID: ${telegramId}`);

      // Create memory thread ID based on user's Telegram ID
      threadId = `telegram_${telegramId}`;
      // Use user's database ID as the resource ID
      const resourceId = user.id;

      const projects = await getAvailableProjects(user.organization_id)
      const teams = await getAvailableTeams(user.organization_id)

      // Create a map of team IDs to team names
      const teamMap = teams.reduce(
        (map, team) => {
          map[team.id] = team.name
          return map
        },
        {} as Record<string, string>,
      )

      if (!projects || projects.length === 0) {
        // Use agent with memory to respond
        let streamResponse;
        try {
          streamResponse = await agentInstance.stream(
            "The user is asking about projects, but there are no projects in the system yet. Please explain how they can create a project.",
            {
              threadId,
              resourceId,
            }
          );
        } catch (error: any) {
          try {
            // Use the helper function to handle thread validation errors
            const prompt = "The user is asking about projects, but there are no projects in the system yet. Please explain how they can create a project.";
            streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, prompt, agentInstance);
          } catch (innerError) {
            // Re-throw other errors
            throw innerError;
          }
        }
        const initialMessage = await ctx.reply("⏳");
        await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream);
        return;
      }

      let projectsList = "📁 Available Projects:\n\n"
      projects.forEach((project, index) => {
        const teamName = project.team_id && teamMap[project.team_id] ? ` (Team: ${teamMap[project.team_id]})` : ""
        projectsList += `${index + 1}. ${project.name}${teamName}\n`
      })

      projectsList += "\nYou can reference these projects when creating tasks."

      // Use agent with memory to respond
      let streamResponse;
      try {
        streamResponse = await agentInstance.stream(
          `The user is asking about projects. Here's the list of available projects: ${projectsList}`,
          {
            threadId,
            resourceId,
          }
        );
      } catch (error: any) {
        try {
          // Use the helper function to handle thread validation errors
          const prompt = `The user is asking about projects. Here's the list of available projects: ${projectsList}`;
          streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, prompt, agentInstance);
        } catch (innerError) {
          // Re-throw other errors
          throw innerError;
        }
      }

      const initialMessage = await ctx.reply("⏳");
      await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream);
    } catch (error) {
      console.error("Error fetching projects:", error)
      await ctx.reply("Sorry, there was an error fetching the projects. Please try again later.")
    }
  })

  // Teams command handler
  botInstance.command("teams", async (ctx) => {
    try {
      if (!ctx.from) return;

      // Use the authenticated user from middleware
      const user = ctx.state.authenticatedUser;
      if (!user) {
        console.log(`Security: Attempted to use /teams command with unauthenticated user: ${ctx.from.id}`);
        return;
      }

      console.log(`Processing /teams command for authenticated user: ${user.name} (${user.email}) with Telegram ID: ${ctx.from.id}`);

      // Create memory thread ID based on user's Telegram ID
      const threadId = `telegram_${ctx.from.id}`;
      // Use user's database ID as the resource ID
      const resourceId = user.id;

      const teams = await getAvailableTeams()

      if (!teams || teams.length === 0) {
        // Use agent with memory to respond
        let streamResponse;
        try {
          streamResponse = await agentInstance.stream(
            "The user is asking about teams, but there are no teams in the system yet. Please explain how they can create a team.",
            {
              threadId,
              resourceId,
            }
          );
        } catch (error: any) {
          try {
            // Use the helper function to handle thread validation errors
            const prompt = "The user is asking about teams, but there are no teams in the system yet. Please explain how they can create a team.";
            streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, prompt, agentInstance);
          } catch (innerError) {
            // Re-throw other errors
            throw innerError;
          }
        }
        const initialMessage = await ctx.reply("⏳");
        await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream);
        return;
      }

      let teamsList = "👥 Available Teams:\n\n"
      teams.forEach((team, index) => {
        teamsList += `${index + 1}. ${team.name}\n`
      })

      teamsList += "\nYou can specify a team when creating a project."

      // Use agent with memory to respond
      let streamResponse;
      try {
        streamResponse = await agentInstance.stream(
          `The user is asking about teams. Here's the list of available teams: ${teamsList}`,
          {
            threadId,
            resourceId,
          }
        );
      } catch (error: any) {
        try {
          // Use the helper function to handle thread validation errors
          const prompt = `The user is asking about teams. Here's the list of available teams: ${teamsList}`;
          streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, prompt, agentInstance);
        } catch (innerError) {
          // Re-throw other errors
          throw innerError;
        }
      }
      const initialMessage = await ctx.reply("⏳");
      await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream);
    } catch (error) {
      console.error("Error fetching teams:", error)
      await ctx.reply("Sorry, there was an error fetching the teams. Please try again later.")
    }
  })

  // Week command handler to explain week date ranges
  botInstance.command("weeks", async (ctx) => {
    try {
      if (!ctx.from) return;

      // Use the authenticated user from middleware
      const user = ctx.state.authenticatedUser;
      if (!user) {
        console.log(`Security: Attempted to use /weeks command with unauthenticated user: ${ctx.from.id}`);
        return;
      }

      console.log(`Processing /weeks command for authenticated user: ${user.name} (${user.email}) with Telegram ID: ${ctx.from.id}`);

      // Create memory thread ID based on user's Telegram ID
      const threadId = `telegram_${ctx.from.id}`;
      // Use user's database ID as the resource ID
      const resourceId = user.id;

      const thisWeek = getWeekDateRange("this week")
      const nextWeek = getWeekDateRange("next week")
      const lastWeek = getWeekDateRange("last week")

      const weekInfo =
        "📅 Week Date Ranges:\n\n" +
        `This week: ${thisWeek.startDate} to ${thisWeek.endDate}\n` +
        `Next week: ${nextWeek.startDate} to ${nextWeek.endDate}\n` +
        `Last week: ${lastWeek.startDate} to ${lastWeek.endDate}\n\n` +
        "You can use these terms when creating tasks with due dates.";

      // Use agent with memory to respond
      let streamResponse;
      try {
        streamResponse = await agentInstance.stream(
          `The user is asking about week date ranges. Here's the information: ${weekInfo}. Please explain how they can use these date ranges when creating tasks.`,
          {
            threadId,
            resourceId,
          }
        );
      } catch (error: any) {
        try {
          // Use the helper function to handle thread validation errors
          const prompt = `The user is asking about week date ranges. Here's the information: ${weekInfo}. Please explain how they can use these date ranges when creating tasks.`;
          streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, prompt, agentInstance);
        } catch (innerError) {
          // Re-throw other errors
          throw innerError;
        }
      }
      const initialMessage = await ctx.reply("⏳");
      await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream);    } catch (error) {
      console.error("Error calculating week dates:", error)
      await ctx.reply("Sorry, there was an error calculating the week dates. Please try again later.")
    }
  })

  // Edit task command handler
  botInstance.command("edit", async (ctx) => {
    try {
      if (!ctx.from) return;

      // Use the authenticated user from middleware
      const user = ctx.state.authenticatedUser;
      if (!user) {
        console.log(`Security: Attempted to use /edit command with unauthenticated user: ${ctx.from.id}`);
        return;
      }

      console.log(`Processing /edit command for authenticated user: ${user.name} (${user.email}) with Telegram ID: ${ctx.from.id}`);

      await showTaskEditForm(ctx);
    } catch (error) {
      console.error("Error in edit command:", error);
      await ctx.reply("❌ An error occurred while loading the task editor. Please try again later.");
    }
  })

  // Handle all callback queries (button clicks)  try {
    botInstance.on('callback_query', async (ctx) => {
      if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

      const telegramId = ctx.from.id.toString();
      const data = ctx.callbackQuery.data;
      const user = ctx.state.authenticatedUser;

    if (!user) {
      console.log(`Security: Rejected callback query from unauthenticated user: ${telegramId}`);
      await ctx.answerCbQuery("Authentication required");
      return;
    }    // Acknowledge the callback to stop loading indicator
    await ctx.answerCbQuery();
    console.log(`Processing callback from user ${user.name}: ${data}`);

    try {
      // New enhanced UI callback handlers
      if (data === "start_task_creation") {
        await startTaskCreationForm(ctx);
        return;
      }
      
      if (data === "show_update_task_form") {
      await showTaskStatusUpdateForm(ctx);
      return;
    }

    if (data === "show_task_edit_form") {
      await showTaskEditForm(ctx);
      return;
    }

    if (data === "cancel_edit") {
      // Clear any editing session
      delete userSessions[telegramId];
      await ctx.reply("Task editing cancelled.");
      return;
    }

    if (data === "show_task_filters") {
      // TODO: Implement task filtering UI
      await ctx.reply("📊 Task filtering options coming soon! For now, you can view all tasks or update task status.", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 Show All Tasks", callback_data: "show_all_tasks" },
              { text: "🔄 Update Task Status", callback_data: "show_update_task_form" }
            ]
          ]
        }
      });
      return;
    }

    if (data === "search_tasks") {
      // TODO: Implement task search UI
      await ctx.reply("🔍 Task search feature coming soon! For now, you can view all tasks or update task status.", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 Show All Tasks", callback_data: "show_all_tasks" },
              { text: "🔄 Update Task Status", callback_data: "show_update_task_form" }
            ]
          ]
        }
      });
      return;
    }

    if (data === "show_all_tasks") {
      // Trigger the getUserTasks tool through the agent
      try {
        const threadId = `telegram_${ctx.from.id}`;
        const resourceId = user.id;
        
        const streamResponse = await agentInstance.stream("Show me all my tasks", {
          threadId,
          resourceId,
        });
        
        const initialMessage = await ctx.reply("⏳ Fetching your tasks...");
        await streamAndUpdateMessage(ctx, initialMessage, streamResponse.textStream);
      } catch (error) {
        console.error("Error fetching tasks:", error);
        await ctx.reply("❌ Error fetching tasks. Please try again.");
      }
      return;
    }

    if (data === "cancel_task_update") {
      await ctx.reply("Task update cancelled.");
      return;
    }

    // Send reminder form
    if (data === "send_reminder_form") {
      await startSendReminderForm(ctx);
      return;
    }    // Reminder type selection
    if (data === "reminder_type_task" || data === "reminder_type_custom") {
      await handleReminderTypeSelection(ctx, data);
      return;
    }// Handle user selection for reminders
    if (data.startsWith("reminder_user_")) {
      const shortUserId = data.replace("reminder_user_", "");
      console.log(`🔍 Trying to resolve short ID: ${shortUserId} for Telegram ID: ${telegramId}`);
      console.log(`🔍 Looking for mapping key: ${telegramId}_${shortUserId}`);
      console.log(`🔍 Available mappings:`, Object.keys(userIdMappings));
      
      const userId = resolveShortUserIdFromCallback(telegramId, shortUserId);
      console.log(`🔍 Resolved user ID: ${userId}`);
      
      if (!userId) {
        await ctx.reply("❌ User selection expired. Please start over.");
        return;
      }
      
      const session = userSessions[telegramId];

      if (!session) {
        await ctx.reply("❌ Session expired. Please start over.");
        return;
      }      // Get user details
      const { data: selectedUser, error: userError } = await supabase
        .from("users")
        .select("id, name, email, organization_id")
        .eq("id", userId)
        .single();

      if (userError || !selectedUser) {
        await ctx.reply("❌ User not found. Please try again.");
        return;
      }      // Save selected user
      session.taskData.reminderUserId = userId;
      session.taskData.reminderUserName = selectedUser.name;
      session.taskData.reminderUserEmail = selectedUser.email;
      session.taskData.reminderUserOrgId = selectedUser.organization_id;// Next step depends on reminder type
      if (session.taskData.reminderType === 'task') {        // Show ALL tasks for the selected user (not just pending ones)
        session.step = 'reminder_task';        // Use the correct approach for checking assigned_to JSONB array field
        const { data: tasksData, error: tasksError } = await supabase
          .from("tasks")
          .select("id, title, status, deadline")
          .filter('assigned_to', 'cs', `["${userId}"]`) // Fix: properly format user ID for JSONB containment
          .order("created_at", { ascending: false })
          .limit(20);

        let userTasks = tasksData;        if (tasksError) {
          console.error(`Error fetching tasks for user ${selectedUser.name}:`, tasksError);
          await ctx.reply(`❌ Error fetching tasks. Please try again.`);
          return;
        }
        
        if (!userTasks || userTasks.length === 0) {
          await ctx.reply(`❌ No tasks found for ${selectedUser.name}. They might not have any tasks assigned.`);
          return;
        }

        // Show task selection with status indicators
        const taskKeyboard = userTasks.map((task: any) => {
          const statusEmojiMap: Record<string, string> = {
            'pending': '⏳',
            'in_progress': '🚧',
            'completed': '✅',
            'cancelled': '❌'
          };
          const statusEmoji = statusEmojiMap[task.status as string] || '📝';
          
          const deadlineText = task.deadline ? ` (Due: ${new Date(task.deadline).toLocaleDateString()})` : '';
          
          return [{
            text: `${statusEmoji} ${task.title}${deadlineText}`,
            callback_data: `reminder_task_${task.id}`
          }];
        });
        
        taskKeyboard.push([{ text: "❌ Cancel", callback_data: "cancel_send_reminder" }]);

        await ctx.reply(`Select a task to remind ${selectedUser.name} about:`, {
          reply_markup: { inline_keyboard: taskKeyboard }
        });
      } else if (session.taskData.reminderType === 'custom') {
        // Ask for custom message
        session.step = 'reminder_custom_message';
        await ctx.reply(`Please enter a custom reminder message for ${selectedUser.name}:`);
      }
      return;
    }

    // Handle task selection for reminders
    if (data.startsWith("reminder_task_")) {
      const taskId = data.replace("reminder_task_", "");
      const session = userSessions[telegramId];

      if (!session || !session.taskData.reminderUserId) {
        await ctx.reply("❌ Session expired. Please start over.");
        return;
      }

      // Get task details
      const { data: selectedTask, error: taskError } = await supabase
        .from("tasks")
        .select("id, title, description, deadline")
        .eq("id", taskId)
        .single();

      if (taskError || !selectedTask) {
        await ctx.reply("❌ Task not found. Please try again.");
        return;
      }

      // Save selected task
      session.taskData.reminderTaskId = taskId;
      session.taskData.reminderTaskTitle = selectedTask.title;

      // Send the reminder immediately (for now)
      const reminderMessage = `Don't forget about your task: "${selectedTask.title}"`;
        try {
        // For targeted reminders, create a composite task ID (taskId_userId)
        const targetUserId = session.taskData.reminderUserId;
        const compositeTaskId = `${taskId}_${targetUserId}`;
        console.log(`📝 Creating targeted reminder with composite task ID: ${compositeTaskId}`);
        
        // Create reminder in database
        await supabase
          .from("reminders")
          .insert({
            user_id: session.taskData.reminderUserId,
            task_id: compositeTaskId, // Use composite ID for targeted delivery
            original_task_id: taskId, // Store the original task ID for reference
            message: reminderMessage,
            scheduled_for: new Date().toISOString(),
            sent: false,
            type: 'task',
            created_at: new Date().toISOString()
          });

        // Send reminder using the sendReminder function with the composite ID
        await sendReminder({
          taskId: compositeTaskId, // Use the composite ID for targeted delivery
          message: reminderMessage
        });

        await ctx.reply(`✅ Reminder sent to ${session.taskData.reminderUserName} about task "${selectedTask.title}"`);
        
        // Clear session
        delete userSessions[telegramId];
      } catch (error) {
        console.error("Error sending reminder:", error);
        await ctx.reply("❌ Error sending reminder. Please try again.");
      }
      return;
    }

    // Handle cancel reminder
    if (data === "cancel_send_reminder") {
      delete userSessions[telegramId];
      await ctx.reply("❌ Reminder cancelled.");
      return;
    }

    // Existing callback handlers
    // Create Another Task action
    if (data === "action_create_another_task") {
      await startTaskCreationForm(ctx);
      return;
    }

    // Task form flow callbacks
    if (data.startsWith("project_")) {
      const projectId = data.replace("project_", "");
      const session = userSessions[telegramId];

      if (!session) return;

      if (projectId === "new") {
        // Handle new project creation
        session.taskData.projectName = "New Project";
        await ctx.reply("Please send the name for the new project:");
        return;
      }

      // Get project name
      const { data: project } = await supabase
        .from("projects")
        .select("name")
        .eq("id", projectId)
        .single();

      session.taskData.projectId = projectId;
      session.taskData.projectName = project?.name || "Unknown Project";

      // Move to team selection
      await showTeamSelectionForm(ctx);
      return;
    }

    if (data.startsWith("team_")) {
      const teamId = data.replace("team_", "");
      const session = userSessions[telegramId];

      if (!session) return;

      if (teamId === "new") {
        // Handle new team creation
        session.taskData.teamName = "New Team";
        await ctx.reply("Please send the name for the new team:");
        return;
      }

      if (teamId === "none") {
        session.taskData.teamId = undefined;
        session.taskData.teamName = "No Team";
      } else {
        // Get team name
        const { data: team } = await supabase
          .from("teams")
          .select("name")
          .eq("id", teamId)
          .single();

        session.taskData.teamId = teamId;
        session.taskData.teamName = team?.name || "Unknown Team";
      }

      // Move to priority selection
      await showPrioritySelectionForm(ctx);
      return;
    }
    if (data.startsWith("priority_")) {
      const priority = data.replace("priority_", "");
      const session = userSessions[telegramId];

      if (!session) return;

      // Map priority values to display text
      const priorityMap: Record<string, string> = {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "urgent": "Urgent"
      };

      session.taskData.priority = priorityMap[priority] || priority;

      // Move to deadline selection
      await showDeadlineSelectionForm(ctx);
      return;
    }

    if (data.startsWith("date_")) {
      const dateValue = data.replace("date_", "");
      const session = userSessions[telegramId];

      if (!session) return;

      if (dateValue === "custom") {
        // Handle custom date input
        await ctx.reply("Please enter a deadline in YYYY-MM-DD format:");
        return;
      }

      // Validate date by creating a Date object (will throw if invalid)
      new Date(dateValue);

      session.taskData.deadline = dateValue;      // Ask for description
      await askForDescription(ctx);
      return;
    }
    
    if (data === "multi_assignees") {
      const session = userSessions[telegramId];
      if (!session) return;
      
      // Set multi-assignee mode
      session.taskData.multiAssigneeMode = true;
      
      // Initialize arrays if they don't exist
      if (!session.taskData.assigneeIds) session.taskData.assigneeIds = [];
      if (!session.taskData.assigneeNames) session.taskData.assigneeNames = [];
      if (!session.taskData.assigneeEmails) session.taskData.assigneeEmails = [];
      
      await ctx.reply(
        "✅ Multi-assignee mode enabled. Select each user one by one. When done, click 'Done selecting assignees'."
      );
      
      // Show assignee selection again
      await askForAssignee(ctx);
      return;
    }
      if (data === "done_selecting_assignees") {
      const session = userSessions[telegramId];
      if (!session) {
        await ctx.reply("Session expired or invalid. Please start over.");
        return;
      }

      // This button is typically shown when session.taskData.assigneeIds.length > 0.
      if (session.taskData.assigneeIds && session.taskData.assigneeIds.length > 0) {
        // Reset multi-assignee mode if it was active
        if (session.taskData.multiAssigneeMode) {
          session.taskData.multiAssigneeMode = false;
        }
        await showTaskConfirmation(ctx);
      } else {
        // Fallback, though ideally this state isn't reached due to UI logic
        await ctx.reply("No assignees were selected. Please select at least one assignee or cancel.");
        await askForAssignee(ctx); // Re-prompt
      }
      return;
    }    // Handle assignee pagination
    if (data.startsWith("assignee_page_")) {
      const page = parseInt(data.replace("assignee_page_", ""));
      if (!isNaN(page)) {
        await askForAssignee(ctx, page);
      }
      return;
    }

    // Handle reminder user pagination
    if (data.startsWith("reminder_user_page_")) {
      const page = parseInt(data.replace("reminder_user_page_", ""));
      if (!isNaN(page)) {
        await showReminderUserSelection(ctx, page);
      }
      return;
    }

    // Handle page info button (non-functional, just acknowledge)
    if (data === "page_info") {
      await ctx.answerCbQuery("Page information");
      return;
    }    // Handle assignee selection for task creation (but not pagination)
    if (data.startsWith("assignee_") && !data.startsWith("assignee_page_")) {
      const assigneeId = data.replace("assignee_", "");
      const session = userSessions[telegramId];

      if (!session || !('taskData' in session)) {
        await ctx.reply("❌ Session expired or invalid. Please start task creation again.");
        return;
      }

      try {
        // Get user details for the selected assignee
        const { data: selectedUser, error: userError } = await supabase
          .from("users")
          .select("id, name, email")
          .eq("id", assigneeId)
          .single();

        if (userError || !selectedUser) {
          await ctx.reply("❌ User not found. Please try again.");
          return;
        }

        // Initialize arrays if they don't exist
        if (!session.taskData.assigneeIds) session.taskData.assigneeIds = [];
        if (!session.taskData.assigneeNames) session.taskData.assigneeNames = [];
        if (!session.taskData.assigneeEmails) session.taskData.assigneeEmails = [];

        // Check if user is already assigned (prevent duplicates)
        if (session.taskData.assigneeIds.includes(assigneeId)) {
          await ctx.reply(`${selectedUser.name} is already assigned to this task.`);
          return;
        }

        // Add assignee to arrays
        session.taskData.assigneeIds.push(assigneeId);
        session.taskData.assigneeNames.push(selectedUser.name);
        session.taskData.assigneeEmails.push(selectedUser.email);

        // For backward compatibility, also set single assignee fields
        session.taskData.assigneeId = assigneeId;
        session.taskData.assigneeName = selectedUser.name;
        session.taskData.assigneeEmail = selectedUser.email;

        // If multi-assignee mode is enabled, show updated assignee list and allow more selections
        if (session.taskData.multiAssigneeMode) {
          let assigneeList = "**Current Assignees:**\n";
          for (let i = 0; i < session.taskData.assigneeNames.length; i++) {
            assigneeList += `${i + 1}. ${session.taskData.assigneeNames[i]} (${session.taskData.assigneeEmails[i]})\n`;
          }

          await ctx.reply(`✅ Added ${selectedUser.name} to the task!\n\n${assigneeList}\nYou can select more assignees or click "Done selecting assignees" to continue.`, {
            parse_mode: 'Markdown'
          });

          // Show assignee selection again for multi-assignee mode
          await askForAssignee(ctx);
        } else {
          // Single assignee mode - proceed directly to confirmation
          await ctx.reply(`✅ Task assigned to ${selectedUser.name}.`);
          await showTaskConfirmation(ctx);
        }      } catch (error) {
        console.error("Error in assignee selection:", error);
        await ctx.reply("❌ Error processing assignee selection. Please try again.");
      }
      return;
    }

    // Handle task confirmation callbacks
    if (data === "confirm_create") {
      const session = userSessions[telegramId];
      if (!session || !('taskData' in session)) {
        await ctx.reply("❌ Session expired or invalid. Please start task creation again.");
        return;
      }

      try {
        // Create the task using the existing function
        const success = await createTaskFromForm(ctx, user);
        if (!success) {
          await ctx.reply("❌ Failed to create task. Please try again.");
        }
        // Note: createTaskFromForm handles success response and session cleanup
      } catch (error) {
        console.error("Error in confirm_create:", error);
        await ctx.reply("❌ An error occurred while creating the task. Please try again.");
      }
      return;
    }

    if (data === "confirm_cancel") {
      const session = userSessions[telegramId];
      if (session) {
        delete userSessions[telegramId];
      }
      await ctx.reply("❌ Task creation cancelled.");
      return;
    }

    if (data === "edit_before_create") {
      const session = userSessions[telegramId];
      if (!session || !('taskData' in session)) {
        await ctx.reply("❌ Session expired or invalid. Please start task creation again.");
        return;
      }

      try {
        // Show edit form for current session data
        await showTaskEditFormFromSession(ctx, session);
      } catch (error) {
        console.error("Error in edit_before_create:", error);
        await ctx.reply("❌ An error occurred. Please try again.");
      }
      return;
    }

    if (data.startsWith("set_status_")) {
      const parts = data.replace("set_status_", "").split("_");
      const taskId = parts[0];
      const newStatus = parts.slice(1).join("_");
      
      try {
        // Debug info for troubleshooting

        console.log(`Debug: Updating task status for user ID: ${user.id}`);
        console.log(`Debug: User ID type: ${typeof user.id}`);
        
        // Update task status in database - fix JSON format for JSONB containment
        const { error } = await supabase
          .from("tasks")
          .update({ 
            status: newStatus,
            updated_at: new Date().toISOString()
          })
          .eq("id", taskId)
          .filter('assigned_to', 'cs', `["${user.id}"]`); // Security: fixed JSONB format

        if (error) {
          console.error("Error updating task status:", error);
          await ctx.reply("❌ Error updating task status. Please try again.");
          return;
               }

        // Get task details for confirmation
        const { data: task } = await supabase
          .from("tasks")
          .select("title")
          .eq("id", taskId)
          .single();

        const statusEmojis = {
          'pending': '⏳',
          'in_progress': '🚧',
          'completed': '✅',
          'cancelled': '❌'
        };        const emoji = statusEmojis[newStatus as keyof typeof statusEmojis] || '📝';
        const statusText = newStatus.replace("_", " ").toUpperCase();
        
        // Use regular text for message (no Markdown)
        await ctx.reply(`${emoji} Task "${task?.title || 'Unknown'}" status updated to ${statusText}!`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Update Another Task", callback_data: "show_update_task_form" },
                { text: "➕ Create New Task", callback_data: "start_task_creation" }
              ]
            ]
          }
        });

      } catch (error) {
        console.error("Error in task status update:", error);
        await ctx.reply("❌ An error occurred while updating the task. Please try again.");
      }      return;
    }

    // Handle task selection for status update - MISSING HANDLER ADDED
    if (data.startsWith("update_task_")) {
      const taskId = data.replace("update_task_", "");
      
      try {
        // Get task details to verify user has permission and show task info
        const { data: task, error } = await supabase
          .from("tasks")
          .select(`
            id,
            title,
            status,
            priority,
            deadline,
            projects (name)
          `)
          .eq("id", taskId)
          .filter('assigned_to', 'cs', `["${user.id}"]`) // Security: ensure user can update this task
          .single();

        if (error || !task) {
          await ctx.reply("❌ Task not found or you don't have permission to update it.");
          return;
        }        // Show current task info and status options
        const projectInfo = task.projects && task.projects.length > 0 ? ` (${task.projects[0].name})` : '';
        const deadlineInfo = task.deadline ? ` - Due: ${new Date(task.deadline).toLocaleDateString()}` : '';
        
        const priorityEmoji = {
          'low': '🟢',
          'medium': '🟡', 
          'high': '🟠',
          'urgent': '🔴'
        }[task.priority as string] || '📝';

        const currentStatusEmoji = {
          'pending': '⏳',
          'in_progress': '🚧',
          'completed': '✅',
          'cancelled': '❌'
        }[task.status as string] || '📝';        const taskInfo = `${priorityEmoji} **${task.title}**${projectInfo}${deadlineInfo}\n\n` +
                        `Current Status: ${currentStatusEmoji} ${task.status.replace('_', ' ').toUpperCase()}\n\n` +
                        `Select new status:`;

        // Create status selection keyboard - show all status options
        const statusOptions = [
          { status: 'pending', emoji: '⏳', label: 'Pending' },
          { status: 'in_progress', emoji: '🚧', label: 'In Progress' },
          { status: 'completed', emoji: '✅', label: 'Completed' },
          { status: 'cancelled', emoji: '❌', label: 'Cancelled' }
        ];

        const keyboard = statusOptions
          .map(option => [{
            text: `${option.emoji} ${option.label}`,
            callback_data: `set_status_${taskId}_${option.status}`
          }]);

        // Add cancel option
        keyboard.push([{ text: "❌ Cancel", callback_data: "cancel_task_update" }]);

        await ctx.reply(taskInfo, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: keyboard
          }
        });

      } catch (error) {
        console.error("Error in update_task_ handler:", error);
        await ctx.reply("❌ An error occurred while loading task status options. Please try again.");
      }
      return;
    }

    // Task editing handlers
    if (data.startsWith("edit_task_")) {
      const taskId = data.replace("edit_task_", "");
      await showTaskEditOptions(ctx, taskId);
      return;
    }

    // Field editing handlers
    if (data.startsWith("edit_field_")) {
      const fieldEditData = data.replace("edit_field_", "").split("_");
      const fieldName = fieldEditData[0];
      const taskId = fieldEditData[1];

      const session = userSessions[telegramId];      if (!session || session.step !== 'edit_task' || session.editingTaskId !== taskId) {
        await ctx.reply("❌ You are not in the task editing mode. Please select a task to edit first.");
        return;
      }
      
      // Update session state for the specific field
      // Handle field clearing based on field name
      switch(fieldName) {
        case 'title':
          session.taskData.title = undefined;
          break;
        case 'description':
          session.taskData.description = undefined;
          break;
        case 'project':
          session.taskData.projectId = undefined;
          session.taskData.projectName = undefined;
          break;
        case 'team':
          session.taskData.teamId = undefined;
          session.taskData.teamName = undefined;
          break;
        case 'deadline':
          session.taskData.deadline = undefined;
          break;
        case 'priority':
          session.taskData.priority = undefined;
          break;
        case 'assignee':
          session.taskData.assigneeId = undefined;
          session.taskData.assigneeName = undefined;
          session.taskData.assigneeEmail = undefined;
          break;
      }
      
      session.step = `edit_${fieldName}` as TaskFormState['step']; // Ask for the new value
      let prompt = `Please enter the new ${fieldName.replace("_", " ")}:`;
      if (fieldName === "deadline") {
        prompt += "\nFormat: DD/MM/YYYY or just day number (e.g., '12' for 12th of this month)";
      } else if (fieldName === "priority") {
        prompt += "\nOptions: low, medium, high, urgent";
      }

      await ctx.reply(prompt);
      return;
    }

    // Finish editing handler
    if (data === "finish_edit") {
      const session = userSessions[telegramId];      if (!session || session.step !== 'edit_task') {
        await ctx.reply("❌ You are not in the task editing mode. Please select a task to edit first.");
        return;
      }

      // Update the task in the database using proper update logic
      try {
        console.log(`🔧 Updating task ${session.editingTaskId} with data:`, session.taskData);
        
        const updateData: any = {
          updated_at: new Date().toISOString()
        };
        
        // Only update fields that have been provided in the session
        if (session.taskData.title) {
          updateData.title = session.taskData.title;
        }
        if (session.taskData.description) {
          updateData.description = session.taskData.description;
        }
        if (session.taskData.status) {
          updateData.status = session.taskData.status;
        }
        if (session.taskData.priority) {
          updateData.priority = session.taskData.priority.toLowerCase();
        }        if (session.taskData.deadline) {
          // Handle deadline formatting properly - convert DD/MM/YYYY to ISO
          try {
            let deadlineDate;
            if (session.taskData.deadline.includes('/')) {
              // DD/MM/YYYY format
              const [day, month, year] = session.taskData.deadline.split('/').map(num => parseInt(num));
              deadlineDate = new Date(year, month - 1, day); // month is 0-based
            } else {
              // Fallback to standard Date parsing
              deadlineDate = new Date(session.taskData.deadline);
            }
            
            if (!isNaN(deadlineDate.getTime())) {
              updateData.deadline = deadlineDate.toISOString();
            }
          } catch (e) {
            console.error("Error parsing deadline:", e);
          }
        }        if (session.taskData.assigneeId) {
          updateData.assigned_to = [session.taskData.assigneeId];
        }
        if (session.taskData.projectId) {
          updateData.project_id = session.taskData.projectId;
        }

        console.log("Final update data:", updateData);

        // Perform the update with proper error handling
        const { data: updatedTask, error } = await supabase
          .from("tasks")
          .update(updateData)
          .eq("id", session.editingTaskId!)          .select(`
            id,
            title,
            description,
            status,
            priority,
            deadline,
            projects (name),
            assigned_to
          `)
          .single();

        if (error) {
          console.error("Error updating task:", error);
          await ctx.reply(`❌ Error updating task: ${error.message}\nPlease try again.`);
          return;
        }

        if (!updatedTask) {
          console.error("No task returned after update");
          await ctx.reply("❌ Task update failed. Please try again.");
          return;
        }

        console.log("✅ Task updated successfully:", updatedTask);
          // Build success message with updated task details - properly escape markdown characters
        let successMessage = "✅ Task updated successfully!\n\n";
        successMessage += `*Title:* ${escapeMarkdown(updatedTask.title)}\n`;
        if (updatedTask.description) {
          successMessage += `*Description:* ${escapeMarkdown(updatedTask.description)}\n`;
        }
        successMessage += `*Status:* ${escapeMarkdown(updatedTask.status)}\n`;
        successMessage += `*Priority:* ${escapeMarkdown(updatedTask.priority)}\n`;        if (updatedTask.deadline) {
          const deadlineDate = new Date(updatedTask.deadline);
          const formattedDate = `${deadlineDate.getDate().toString().padStart(2, '0')}/${(deadlineDate.getMonth() + 1).toString().padStart(2, '0')}/${deadlineDate.getFullYear()}`;
          successMessage += `*Deadline:* ${escapeMarkdown(formattedDate)}\n`;
        }
          // Handle project name - properly escape markdown
        if (updatedTask.projects && Array.isArray(updatedTask.projects) && updatedTask.projects.length > 0) {
          successMessage += `*Project:* ${escapeMarkdown(updatedTask.projects[0].name)}\n`;
        } else if (updatedTask.projects && typeof updatedTask.projects === 'object' && 'name' in updatedTask.projects) {
          successMessage += `*Project:* ${escapeMarkdown((updatedTask.projects as any).name || 'Unknown Project')}\n`;
        }// Handle assigned_to as JSONB array - get user info from session data
        if (updatedTask.assigned_to && session && session.taskData) {
          if (session.taskData.assigneeName) {
            successMessage += `*Assigned to:* ${escapeMarkdown(session.taskData.assigneeName)}\n`;
          } else {
            // Fallback to showing the user ID(s)
            const assignedToIds = Array.isArray(updatedTask.assigned_to) ? updatedTask.assigned_to : [updatedTask.assigned_to];
            successMessage += `*Assigned to:* ${assignedToIds.length} user(s)\n`;
          }
        }

        await ctx.reply(successMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Edit Another Task", callback_data: "showTaskEditForm" }],
              [{ text: "➕ Create New Task", callback_data: "start_task_creation" }]
            ]
          }
        });

        // Clear session
        delete userSessions[telegramId];

      } catch (error) {
        console.error("Error in task update:", error);
        await ctx.reply("❌ An error occurred while updating the task. Please try again.");
      }
      return;
    }    // Session editing handlers (for editing during task creation)
    if (data.startsWith("edit_session_")) {
      const fieldName = data.replace("edit_session_", "");
      const session = userSessions[telegramId];
      
      if (!session || session.step !== 'edit_before_create') {
        await ctx.reply("❌ You are not in task editing mode. Please try again.");
        return;
      }

      // Update session state for the specific field
      session.step = `edit_session_${fieldName}` as any;

      // Ask for the new value based on the field
      switch (fieldName) {
        case 'title':
          await ctx.reply("Please enter the new task title:", { reply_markup: { force_reply: true } });
          break;
        case 'description':
          await ctx.reply("Please enter the new task description:", { reply_markup: { force_reply: true } });
          break;
        case 'priority':
          await showPrioritySelectionForm(ctx);
          break;
        case 'deadline':
          await showDeadlineSelectionForm(ctx);
          break;
        case 'project':
          await showProjectSelectionForm(ctx);
          break;
        case 'assignee':
          await askForAssignee(ctx);
          break;
        default:
          await ctx.reply("❌ Invalid field selected.");
      }
      return;
    }

    if (data === "finish_edit_session") {
      const session = userSessions[telegramId];
      if (session && session.taskData) {
        // Go back to task confirmation
        await showTaskConfirmation(ctx);
      }
      return;
    }

    if (data === "cancel_edit_session") {
      const session = userSessions[telegramId];
      if (session && session.taskData) {
        // Go back to task confirmation
        await showTaskConfirmation(ctx);
      }
      return;
    }    if (data === "cancel_edit") {
      delete userSessions[telegramId];
      await ctx.reply("Task editing cancelled.");
      return;
    }  } catch (error) {
    console.error("Error processing callback query:", error);
    await ctx.reply("❌ An error occurred while processing your request. Please try again.");
  } finally {
    // Cleanup if needed
  }
}); // This closes botInstance.on('callback_query', ...)

// Handle text messages - UPDATED for project/team checking with proper error handling
  botInstance.on(message("text"), async (ctx) => {
    if (!ctx.from) return

      const text = ctx.message.text
      const telegramId = ctx.from.id.toString()

      // Skip if it's a command (starts with /)
      if (text.startsWith("/")) return

    // Use the authenticated user from middleware
    const user = ctx.state.authenticatedUser
    if (!user) {
      console.log(`Security: Rejected text message from unauthenticated user: ${telegramId}`)
      return
    }

    try {
      // Check if user is in the middle of task creation flow
      const session = userSessions[telegramId];
    if (session) {
      // Handle input based on current step
      if (session.step === 'title') {
        session.taskData.title = text;
        // Move to project selection
        await showProjectSelectionForm(ctx);
        return;
      }

      if (session.step === 'description') {
        if (text.toLowerCase() !== "skip") {
          session.taskData.description = text;
        }
        // Move to assignee selection
        await askForAssignee(ctx);
        return;
      }

      // Handle custom date input
      if (session.step === 'deadline' && !session.taskData.deadline) {
        try {
          // Validate date format (YYYY-MM-DD)
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          if (dateRegex.test(text)) {
            session.taskData.deadline = text;
            await askForDescription(ctx);
          } else {
            await ctx.reply("Please enter a valid date in YYYY-MM-DD format:");
          }
        } catch (error) {
          await ctx.reply("Invalid date format. Please enter in YYYY-MM-DD format:");
        }
        return;
      }

      // Handle new project name input
      if (session.step === 'project' && session.taskData.projectName === "New Project") {
        // Create the new project in the database
        const { data: newProject, error } = await supabase
          .from("projects")
          .insert({
            name: text,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            organization_id: user.organization_id // Add organization ID
          })
          .select()
          .single();

        if (error) {
          await ctx.reply(`Error creating project: ${error.message}`);
          return;
        }

        session.taskData.projectId = newProject.id;
        session.taskData.projectName = newProject.name;

        // Move to team selection
        await showTeamSelectionForm(ctx);
        return;
      }      // Handle new team name input
      if (session.step === 'team' && session.taskData.teamName === "New Team") {
        // Create the new team in the database
        const { data: newTeam, error } = await supabase
          .from("teams")
          .insert({
            name: text,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            organization_id: user.organization_id // Add organization ID
          })
          .select()
          .single();

        if (error) {
          await ctx.reply(`Error creating team: ${error.message}`);
          return;
        }

        session.taskData.teamId = newTeam.id;
        session.taskData.teamName = newTeam.name;

        // Move to priority selection
        await showPrioritySelectionForm(ctx);
        return;
      }

      // Handle edit field inputs
      if (session.step === 'edit_title') {
        session.taskData.title = text;
        await ctx.reply("✅ Title updated! Use the menu to edit more fields or click 'Done Editing'.");
        await showTaskEditOptions(ctx, session.editingTaskId!);
        return;
      }

      if (session.step === 'edit_description') {
        session.taskData.description = text;
        await ctx.reply("✅ Description updated! Use the menu to edit more fields or click 'Done Editing'.");
        await showTaskEditOptions(ctx, session.editingTaskId!);
        return;
      }

      if (session.step === 'edit_priority') {
        const validPriorities = ['low', 'medium', 'high', 'urgent'];
        if (validPriorities.includes(text.toLowerCase())) {
          session.taskData.priority = text.toLowerCase();
          await ctx.reply("✅ Priority updated! Use the menu to edit more fields or click 'Done Editing'.");
          await showTaskEditOptions(ctx, session.editingTaskId!);
        } else {
          await ctx.reply("❌ Invalid priority. Please enter: low, medium, high, or urgent");
        }
        return;
      }      if (session.step === 'edit_deadline') {
        let finalDate = "";
        
        // Handle different date input formats
        if (/^\d{1,2}$/.test(text)) {
          // Just a day number (e.g., "12") - use current month/year
          const day = parseInt(text);
          const now = new Date();
          const currentMonth = now.getMonth(); // 0-based
          const currentYear = now.getFullYear();
          
          if (day >= 1 && day <= 31) {
            const targetDate = new Date(currentYear, currentMonth, day);
            finalDate = `${targetDate.getDate().toString().padStart(2, '0')}/${(targetDate.getMonth() + 1).toString().padStart(2, '0')}/${targetDate.getFullYear()}`;
          }
        } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
          // DD/MM/YYYY format
          finalDate = text;
        } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(text)) {
          // DD-MM-YYYY format, convert to DD/MM/YYYY
          finalDate = text.replace(/-/g, '/');
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          // YYYY-MM-DD format, convert to DD/MM/YYYY
          const [year, month, day] = text.split('-');
          finalDate = `${day}/${month}/${year}`;
        } else if (text.toLowerCase().includes('tomorrow')) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          finalDate = `${tomorrow.getDate().toString().padStart(2, '0')}/${(tomorrow.getMonth() + 1).toString().padStart(2, '0')}/${tomorrow.getFullYear()}`;
        } else if (text.toLowerCase().includes('today')) {
          const today = new Date();
          finalDate = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
        }
        
        if (finalDate) {
          // Validate the date
          const [day, month, year] = finalDate.split('/').map(num => parseInt(num));
          const dateObj = new Date(year, month - 1, day); // month is 0-based in Date constructor
          
          if (dateObj.getDate() === day && dateObj.getMonth() === month - 1 && dateObj.getFullYear() === year) {
            session.taskData.deadline = finalDate;
            await ctx.reply(`✅ Deadline updated to ${finalDate}! Use the menu to edit more fields or click 'Done Editing'.`);
            await showTaskEditOptions(ctx, session.editingTaskId!);
          } else {
            await ctx.reply("❌ Invalid date. Please enter a valid date in DD/MM/YYYY format, or just the day number (e.g., '12' for 12th of this month).");
          }        } else {
          await ctx.reply("❌ Invalid date format. Please enter:\n- Day number (e.g., '12' for 12th of this month)\n- DD/MM/YYYY format\n- 'today' or 'tomorrow'");
        }
        return;
      }

      if (session.step === 'edit_status') {
        const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
        if (validStatuses.includes(text.toLowerCase())) {
          session.taskData.status = text.toLowerCase();
          await ctx.reply("✅ Status updated! Use the menu to edit more fields or click 'Done Editing'.");
          await showTaskEditOptions(ctx, session.editingTaskId!);
        } else {
          await ctx.reply("❌ Invalid status. Please enter: pending, in_progress, completed, or cancelled");
        }
        return;
      }

      // Handle session editing (during task creation) text inputs
      if (session.step === 'edit_session_title') {
        session.taskData.title = text;
        session.step = 'edit_before_create';
        await ctx.reply("✅ Title updated!");
        await showTaskEditFormFromSession(ctx, session);
        return;
      }      if (session.step === 'edit_session_description') {
        session.taskData.description = text;
        session.step = 'edit_before_create';
        await ctx.reply("✅ Description updated!");
        await showTaskEditFormFromSession(ctx, session);
        return;
      }

      // Handle custom reminder message input
      if (session.step === 'reminder_custom_message') {
        const customMessage = text.trim();
        
        if (!customMessage || customMessage.length < 5) {
          await ctx.reply("❌ Please enter a longer reminder message (at least 5 characters):");
          return;
        }

        if (customMessage.length > 500) {
          await ctx.reply("❌ Reminder message is too long. Please keep it under 500 characters:");
          return;
        }        try {
          // Validate required fields before proceeding
          if (!session.taskData.reminderUserId) {
            console.error("Missing required user ID for custom reminder");
            await ctx.reply("❌ Error: User information is missing. Please try again.");
            return;
          }
            // Make sure to store the raw user ID without any prefix and resolve short IDs
          const rawUserId = session.taskData.reminderUserId 
            ? (session.taskData.reminderUserId.startsWith('reminder_user_')
              ? (() => {
                  const shortId = session.taskData.reminderUserId.replace('reminder_user_', '');
                  return resolveShortUserIdFromCallback(telegramId, shortId) || shortId;
                })()
              : session.taskData.reminderUserId)
            : null;
          
          if (!rawUserId) {
            console.error("Failed to extract a valid user ID for custom reminder");
            await ctx.reply("❌ Error: Could not process user information. Please try again.");
            return;
          }          console.log(`Creating custom reminder for user ID: ${rawUserId}`);
          
          // Debug logging for organization IDs
          console.log("Session reminderUserOrgId:", session.taskData.reminderUserOrgId);
          console.log("Current user organization_id:", user.organization_id);
          
          // Ensure we have organization_id - fallback to current user's org if target user's org is not available
          const organizationId = session.taskData.reminderUserOrgId || user.organization_id;
          
          if (!organizationId) {
            console.error("Missing organization_id for custom reminder");
            await ctx.reply("❌ Error: Organization information is missing. Please contact support.");
            return;
          }
          
          // Prepare reminder data
          const reminderData = {
            user_id: rawUserId, // Store the raw user ID without prefix
            message: customMessage,
            scheduled_for: new Date().toISOString(),
            sent: false,
            created_at: new Date().toISOString(),
            reminder_time: new Date().toISOString(),
            type: 'custom', // Add required type field for custom reminders
            organization_id: organizationId, // Ensure this is never null
            user_email: session.taskData.reminderUserEmail || null
          };
            // Insert into database with detailed error handling
          console.log("Inserting custom reminder data:", JSON.stringify(reminderData, null, 2));
          const { error: reminderError } = await supabase
            .from("custom_reminder")
            .insert(reminderData);

          if (reminderError) {
            console.error("Error creating custom reminder:", reminderError);
            console.error("Reminder data that failed:", JSON.stringify(reminderData, null, 2));
            await ctx.reply(`❌ Error creating reminder: ${reminderError.message || "Database error"}. Please try again.`);
            return;
          }
          
          console.log(`Successfully created custom reminder in database for user: ${rawUserId}`)// Send the custom reminder immediately
          const { sendReminder: sendTelegramReminder } = await import('./telegramBot');
            // For custom reminders, use the raw userId without prefix          // Make sure to remove any reminder_user_ prefix and resolve short IDs
          const customUserId = session.taskData.reminderUserId 
            ? (session.taskData.reminderUserId.startsWith('reminder_user_')
              ? (() => {
                  const shortId = session.taskData.reminderUserId.replace('reminder_user_', '');
                  return resolveShortUserIdFromCallback(telegramId, shortId) || shortId;
                })()
              : session.taskData.reminderUserId)
            : null;
            
          await sendTelegramReminder({
            taskId: `custom_${customUserId}`,
            message: customMessage
          });

          await ctx.reply(`✅ Custom reminder sent to ${session.taskData.reminderUserName}!`);
          
          // Clear session
          delete userSessions[telegramId];
        } catch (error) {
          console.error("Error sending custom reminder:", error);
          await ctx.reply("❌ Error sending reminder. Please try again.");
        }
        return;
      }
    }
    } catch (sessionError: any) {
      console.error("Error handling session data:", sessionError);
      await ctx.reply("Sorry, I encountered an error processing your session data. Please try again.");
      
      // Clear the problematic session if it exists
      if (ctx.from) {
        delete userSessions[ctx.from.id.toString()];
      }
      return;
    }    // Special handling for "create task" or similar phrases
    if (
      text.toLowerCase().includes("create task") ||
      text.toLowerCase().includes("new task") ||
      text.toLowerCase().includes("add task")
    ) {
      // Start the task creation form UI flow
      await startTaskCreationForm(ctx);
      return;
    }
    
    // Special handling for "edit task" or similar phrases
    if (
      text.toLowerCase() === "edit task" || 
      text.toLowerCase() === "edit a task" ||
      text.toLowerCase() === "modify task" ||
      text.toLowerCase() === "modify a task" ||
      text.toLowerCase() === "update task" ||
      text.toLowerCase() === "change task"
    ) {
      console.log(`📝 Direct Edit Task request detected: "${text}"`);
      // Start token tracking - estimate token values
      const inputTokens = text.split(/\s+/).length; // Count words as rough token estimate
      const outputTokens = 150; // Estimate for UI form
      console.log(`📊 Token Usage - Edit Task UI Direct Trigger: Input ${inputTokens}, Output ${outputTokens}`);
      
      // Show task editing form
      await showTaskEditForm(ctx);
      return;
    }// Special handling for admin reminder phrases - HIGHEST PRIORITY
    const lowerText = text.toLowerCase().trim();
    console.log(`🔍 Checking reminder intent for text: "${lowerText}"`);
    
    // Advanced keyword pattern matching for reminder intent detection
    const reminderKeywords = [
      "remind", "reminder", "send reminder", "create reminder", "admin reminder",
      "send a reminder", "set reminder", "reminder to", "remind user", "notify",
      "notification", "notification to", "send notif", "send notification"
    ];
    
    // Check exact matches
    if (
      lowerText === "remind" ||
      lowerText === "reminder" ||
      lowerText === "reminders" ||
      lowerText === "notifications" ||
      lowerText === "notification"
    ) {
      console.log(`✅ REMINDER INTENT DETECTED (exact match) - Triggering startSendReminderForm for: "${lowerText}"`);
      await startSendReminderForm(ctx);
      return;
    }
    
    // Check starts with patterns
    if (
      lowerText.startsWith("remind ") ||
      lowerText.startsWith("reminder ") ||
      lowerText.startsWith("send reminder") ||
      lowerText.startsWith("create reminder") ||
      lowerText.startsWith("set reminder") ||
      lowerText.startsWith("send a reminder") ||
      lowerText.startsWith("how to remind") ||
      lowerText.startsWith("how to send reminder") ||
      lowerText.startsWith("i want to remind") ||
      lowerText.startsWith("i need to remind") ||
      lowerText.startsWith("notify ")
    ) {
      console.log(`✅ REMINDER INTENT DETECTED (starts with) - Triggering startSendReminderForm for: "${lowerText}"`);
      await startSendReminderForm(ctx);
      return;
    }
    
    // Check includes patterns
    for (const keyword of reminderKeywords) {
      if (lowerText.includes(keyword)) {
        console.log(`✅ REMINDER INTENT DETECTED (keyword: ${keyword}) - Triggering startSendReminderForm for: "${lowerText}"`);
        await startSendReminderForm(ctx);
        return;
      }
    }
    
    // Check for common phrases
    if (
      lowerText.includes("send") && (lowerText.includes("notification") || lowerText.includes("notif")) ||
      lowerText.includes("send") && lowerText.includes("rem") ||
      lowerText.includes("create") && lowerText.includes("rem") ||
      lowerText.includes("about reminder") ||
      lowerText.includes("about sending reminder") ||
      lowerText.includes("remind someone") ||
      lowerText.includes("i want to remind") || 
      lowerText.includes("need to remind") ||
      lowerText.includes("want to send a reminder") ||
      lowerText.includes("want to create a reminder")
    ) {
      console.log(`✅ REMINDER INTENT DETECTED (phrase match) - Triggering startSendReminderForm for: "${lowerText}"`);
      await startSendReminderForm(ctx);
      return;
    }

    console.log(`Processing text message from authenticated user: ${user.name} (${user.email}) with Telegram ID: ${telegramId}`)

    // Verify that the user's telegram_id matches the sender's ID for extra security
    if (user.telegram_id && user.telegram_id !== telegramId) {
      console.log(`Security: Telegram ID mismatch. Message from ${telegramId} but user record has ${user.telegram_id}`)
      await ctx.reply("⚠️ Security alert: Your Telegram ID doesn't match our records. Please contact an administrator or manager.")
      return
    }

    try {
      // Show typing indicator
      await ctx.telegram.sendChatAction(ctx.chat.id, "typing")

      // Create memory thread ID based on user's Telegram ID
      const threadId = `telegram_${ctx.from.id}`
      // Use user's database ID as the resource ID
      const resourceId = user.id

      // Generate response with memory
      let streamResponse;
      let initialMessage;
      let agentResponseText;      try {
        // SECURITY: Sanitize user message to prevent identity spoofing
        let sanitizedText = text;
        
        // Remove any attempts to claim admin privileges or different identities
        const securityPatterns = [
          /i am admin/gi,
          /i'm admin/gi,
          /i am an admin/gi,
          /i'm an admin/gi,
          /as admin/gi,
          /i am manager/gi,
          /i'm manager/gi,
          /i am a manager/gi,
          /i'm a manager/gi,
          /as manager/gi,
          /i am finstreets@gmail\.com/gi,
          /i'm finstreets@gmail\.com/gi,
          /my email is finstreets@gmail\.com/gi,
          /my email address is finstreets@gmail\.com/gi,
          /as you know i am [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
          /my name is [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
          /i am [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
          /i'm [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi
        ];
        
        for (const pattern of securityPatterns) {
          sanitizedText = sanitizedText.replace(pattern, '[SECURITY: Identity claim removed]');
        }
        
        // Log security filtering if any changes were made
        if (sanitizedText !== text) {
          console.log(`🚨 SECURITY: Filtered potentially malicious content from user message`);
          console.log(`Original length: ${text.length}, Sanitized length: ${sanitizedText.length}`);
        }

        const instructions = `${sanitizedText}\n\nContext: My name is ${user.name}, my email is ${user.email}, my Telegram ID is ${ctx.from.id}, my username is ${ctx.from.username || "not provided"}, my timezone is ${user.timezone || "not provided"}, my phone number is ${user.phone_number || "not provided"}`;        streamResponse = await agentInstance.stream(sanitizedText, {
          threadId,
          resourceId,
          instructions,
          // SECURITY: Pass authenticated user details in a way that cannot be overridden
          AUTHENTICATED_USER_EMAIL: user.email,
          AUTHENTICATED_USER_NAME: user.name,
          AUTHENTICATED_USER_ID: user.id,
          AUTHENTICATED_USER_ORG_ID: user.organization_id,
          // Traditional context (but tools should use AUTHENTICATED_* values)
          userName: user.name,
          userEmail: user.email,
          actualUserEmail: user.email,
          CreatedBy: user.name,
          CreatedByEmail: user.email,
          onFinish: ({
            steps,
            text,
            finishReason,
            usage,
            reasoningDetails,
            providerMetadata,
            response
          }: {
            steps: any[];
            text?: string;
            finishReason?: string;
            usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
            reasoningDetails?: any;
            providerMetadata?: { openai?: { model?: string | any } };
            response?: any;
          }) => {
            console.log("Stream complete:", {
              totalSteps: steps.length,
              finishReason,
              providerMetadata,
              usage
            });
            
            // Store token usage data in the database
            if (usage) {
              const tokenUsageData: TokenUsageData = {
                user_id: user.id,
                platform_type: 'telegram',
                prompt_tokens: usage.promptTokens || 0,
                completion_tokens: usage.completionTokens || 0,
                total_tokens: usage.totalTokens || 0,
                finish_reason: finishReason,
                model: providerMetadata?.openai?.model ? String(providerMetadata.openai.model) : undefined,
                organization_id: user.organization_id
              };
              
              storeTokenUsage(supabase, tokenUsageData)
                .then(success => {
                  if (success) {
                    console.log(`✅ Token usage data stored for user ${user.id} on telegram`);
                  }
                })
                .catch(error => {
                  console.error("Error storing token usage data:", error);
                });
            }
          },
        });

        initialMessage = await ctx.reply("⏳");
        agentResponseText = await streamAndUpdateMessage(
          ctx,
          initialMessage,
          streamResponse.textStream
        );
      } catch (error: any) {
        try {
          // Use the helper function to handle thread validation errors
          streamResponse = await handleThreadValidationError(error, user, ctx, threadId, resourceId, text, agentInstance);

          initialMessage = await ctx.reply("⏳");
          agentResponseText = await streamAndUpdateMessage(
            ctx,
            initialMessage,
            streamResponse.textStream
          );        } catch (innerError) {
          // Re-throw other errors
          throw innerError;
        }
      }

      const toolCalls = await streamResponse.toolCalls;

      // Process AI response for intent detection and UI form automation
      const wasHandledByUI = await processAIResponse(agentResponseText, toolCalls, user, ctx);
      
      // If the response was handled by UI forms, we're done
      if (wasHandledByUI) {
        return;
      }

      let finalReplyText = agentResponseText;

      // Check if the response is asking for assignee information but doesn't explicitly mention email address
      if (
        agentResponseText.toLowerCase().includes("assign") &&
        agentResponseText.toLowerCase().includes("who") &&
        !agentResponseText.toLowerCase().includes("email address")
      ) {
        // Replace with a clearer message
        finalReplyText =
          agentResponseText + "\n\nPlease make sure to provide BOTH the name AND email address of the assignee."
      }
      // Check if the response is asking for project information but doesn't explicitly mention team
      else if (agentResponseText.toLowerCase().includes("project") && !agentResponseText.toLowerCase().includes("team")) {
        // Add a reminder about team information
        finalReplyText = agentResponseText + "\n\nPlease also specify which team this project belongs to."
      }

      if (finalReplyText !== agentResponseText) {
        try {
          await ctx.telegram.editMessageText(initialMessage.chat.id, initialMessage.message_id, undefined, finalReplyText);
        } catch (e: any) {
          if (!(e.description && e.description.includes("message is not modified"))) {
            console.error(`Telegram final clarification edit error: ${e.description || e.message}`);
          }
        }
      }

      // Check if a tool was used
      if (toolCalls && toolCalls.length > 0) {
        const toolCall = toolCalls[0]

        // Handle task creation
        if (toolCall.toolName === "create_task") {
          const taskData = toolCall.args as any

          // Validate project existence for non-admins
          if (taskData.project && !taskData.projectCreated) {
            const projectExists = await doesProjectExist(taskData.project, user.organization_id);
            const isAdmin = await isUserAdmin(user.id);

            if (!projectExists && !isAdmin) {
              const projects = await getAvailableProjects(user.organization_id);
              const projectsList = projects.map(p => `- ${p.name}`).join('\n');

              await ctx.reply(
                `⚠️ Error: The project "${taskData.project}" does not exist, and only admins and managers can create new projects.\n\nAvailable projects:\n${projectsList || "No projects found."}`
              );
              return;
            }
          }

          // Validate team existence for non-admins
          if (taskData.team && !taskData.teamCreated) {
            const teamExists = await doesTeamExist(taskData.team, user.organization_id);
            const isAdmin = await isUserAdmin(user.id);

            if (!teamExists && !isAdmin) {
              const teams = await getAvailableTeams(user.organization_id);
              const teamsList = teams.map(t => `- ${t.name}`).join('\n');

              await ctx.reply(
                `⚠️ Error: The team "${taskData.team}" does not exist, and only admins and managers can create new teams.\n\nAvailable teams:\n${teamsList || "No teams found."}`
              );
              return;
            }
          }

          // Validate assignment permissions
          if (taskData.assignedTo && taskData.emailAddress &&
            (taskData.emailAddress !== user.email || taskData.assignedTo !== user.name)) {
            const isAdmin = await isUserAdmin(user.id);
            let isTeamLead = false;

            // If team is specified, check if user is lead for that team
            if (taskData.team) {
              const { data } = await supabase
                .from("teams")
                .select("id")
                .ilike("name", taskData.team)
                .single();

              if (data) {
                isTeamLead = await isUserTeamLead(user.id, data.id);
              }
            } else {
              isTeamLead = await isUserTeamLead(user.id);
            }

            if (!isAdmin && !isTeamLead) {
              await ctx.reply(
                "⚠️ Error: As a regular user, you can only create tasks assigned to yourself. Only admins and team leads can assign tasks to others."
              );
              return;
            }
          }

          // Continue with task creation if validations pass
          if (taskData.success) {
            let responseMessage =
              `✅ Task created successfully!\n\n` +
              `Task: ${taskData.taskName}\n` +
              `Assigned to: ${taskData.assignedTo}\n` +
              `Email: ${taskData.emailAddress}\n`

            if (taskData.dueDate) {
              responseMessage += `Due: ${new Date(taskData.dueDate).toLocaleDateString()}\n`
            } else {
              responseMessage += `Due: No deadline set\n`
            }

            if (taskData.priority) {
              responseMessage += `Priority: ${taskData.priority}\n`
            }

            if (taskData.project) {
              responseMessage += `Project: ${taskData.project}${taskData.projectCreated ? " (newly created)" : ""}\n`
            }

            if (taskData.team) {
              responseMessage += `Team: ${taskData.team}${taskData.teamCreated ? " (newly created)" : ""}\n`
            }

            if (taskData.userCreated) {
              responseMessage += `\nNote: Created a new user for ${taskData.assignedTo} with the provided email address.`
            }

            if (taskData.projectCreated) {
              responseMessage += `\nNote: Created a new project "${taskData.project}".`
            }            if (taskData.teamCreated) {
              responseMessage += `\nNote: Created a new team "${taskData.team}".`
            }

            await ctx.reply(responseMessage, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✏️ Edit This Task", callback_data: `edit_task_${taskData.taskId || 'latest'}` },
                    { text: "➕ Create Another Task", callback_data: "action_create_another_task" }
                  ]
                ]
              }
            });
            return
          } else {
            await ctx.reply(`Error creating task: ${taskData.message || "Unknown error"}`)
            return
          }
        }

        // Handle project creation
        if (toolCall.toolName === "create_project") {
          const projectData = toolCall.args as any;
          if (projectData.success) {
            let responseMessage = ""

            if (projectData.teamCreated) {
              responseMessage += `✅ Team "${projectData.teamName}" created successfully!\n`
            }

            if (projectData.created) {
              responseMessage += `✅ Project "${projectData.projectName}" created successfully!`
            } else {
              responseMessage += `Project "${projectData.projectName}" already exists.`
            }

            await ctx.reply(responseMessage)
            return
          } else {
            await ctx.reply(`Error creating project: ${projectData.message || "Unknown error"}`)
            return
          }
        }

        // Handle status update
        if (toolCall.toolName === "update_status") {
          const statusData = toolCall.args as any;
          if (statusData.success) {
            await ctx.reply(`✅ Task "${statusData.taskName}" marked as ${statusData.status}!`)
            return
          } else {
            await ctx.reply(`Error updating task: ${statusData.message || "Unknown error"}`)
            return
          }
        }

        // Handle reminder creation
        if (toolCall.toolName === "create_reminder") {
          const reminderData = toolCall.args as any

          if (reminderData.success) {
            await ctx.reply(
              `⏰ Reminder set for task "${reminderData.taskName}" at ${new Date(reminderData.scheduledFor).toLocaleString()}`,
            )
            return
          } else {
            await ctx.reply(`Error setting reminder: ${reminderData.message || "Unknown error"}`)
            return
          }
        }

        // Handle attendance tool
        if (toolCall.toolName === "attendance_tool") {
          const attendanceData = toolCall.args as any

          if (attendanceData.success) {
            const emoji = attendanceData.action === "check_in" ? "✅" : "❌";
            const actionText = attendanceData.action === "check_in" ? "Check-in" : "Check-out";
            
            let responseMessage = `${emoji} *${actionText} Successful!*\n`;
            responseMessage += `Time: ${new Date(attendanceData.timestamp).toLocaleTimeString()}\n`;
            responseMessage += `Status: ${attendanceData.status}\n`;
            
            if (attendanceData.location) {
              responseMessage += `Location: ${attendanceData.location}\n`;
            }
            
            if (attendanceData.work_hours) {
              responseMessage += `Work Hours: ${attendanceData.work_hours}\n`;
            }
            
            if (attendanceData.notes) {
              responseMessage += `Notes: ${attendanceData.notes}`;
            }

            await ctx.reply(responseMessage, { parse_mode: 'Markdown' });
            return
          } else {
            await ctx.reply(`Error processing attendance: ${attendanceData.message || "Unknown error"}`)
            return
          }
        }

        // Handle attendance status tool
        if (toolCall.toolName === "attendance_status_tool") {
          const statusData = toolCall.args as any

          if (statusData.success) {
            let responseMessage = `📊 *Attendance Status:*\n\n`;
            
            if (statusData.current_status) {
              responseMessage += `Current: ${statusData.current_status}\n`;
            }
            
            if (statusData.today_hours) {
              responseMessage += `Today's Hours: ${statusData.today_hours}\n`;
            }
            
            if (statusData.week_hours) {
              responseMessage += `This Week: ${statusData.week_hours}\n`;
            }
            
            if (statusData.month_hours) {
              responseMessage += `This Month: ${statusData.month_hours}\n`;
            }            if (statusData.recent_records && statusData.recent_records.length > 0) {
              responseMessage += `\n*Recent Records:*\n`;
              statusData.recent_records.forEach((record: any, index: number) => {
                const date = new Date(record.date).toLocaleDateString();
                const checkIn = record.check_in_time ? new Date(record.check_in_time).toLocaleTimeString() : 'N/A';
                const checkOut = record.check_out_time ? new Date(record.check_out_time).toLocaleTimeString() : 'N/A';
                responseMessage += `${index + 1}. ${date}: ${checkIn} - ${checkOut}\n`;
              });
            }            await ctx.reply(responseMessage, { parse_mode: 'Markdown' });
            return;
          } else {
            await ctx.reply(`Error fetching attendance status: ${statusData.message || "Unknown error"}`);
            return;          }
        }
      }      
      // If no tool calls and no special intent, the message is already as intended by streamAndUpdateMessage.
      // No explicit ctx.reply(responseText) is needed here if no tool calls were made and no clarifications applied,
      // as streamAndUpdateMessage handles updating the message.
    } catch (error: any) {
      console.error("Error processing AI request:", error);
      await ctx.reply("Sorry, I encountered an error processing your message. Please try again.");

      // Cleanup session data if needed
      if (ctx.from && error instanceof Error && error.message.includes('session expired')) {
        delete userSessions[ctx.from.id.toString()];
      }
    }  }); // Close text message handler
  } catch (error) {
    console.error("Error initializing handlers:", error);
    throw error;
  }
} // Close initializeHandlers function

// Admin: Start send reminder UI form - ENHANCED WITH ERROR HANDLING
async function startSendReminderForm(ctx: Context) {
  console.log(`🎯 startSendReminderForm called - ${new Date().toISOString()}`);
  
  try {
    if (!ctx.from) {
      console.log(`❌ No ctx.from found - Cannot proceed with reminder form`);
      await ctx.reply("Sorry, I couldn't identify your account. Please try again.");
      return;
    }
    
    const telegramId = ctx.from.id.toString();
    console.log(`📱 User Telegram ID: ${telegramId}`);
    
    // Getting user from context state
    const user = ctx.state.authenticatedUser;
    if (!user) {
      console.log(`❌ No authenticated user found in context state - Cannot proceed`);
      await ctx.reply("You need to be authenticated to use this feature. Please contact an administrator or manager.");
      return;
    }
    
    console.log(`👤 User details: ${user.name} (${user.email}) - Role: ${user.role || 'unknown'} - ID: ${user.id}`);
    
    // Only allow admins
    console.log(`🔐 Checking if user ${user.name} (${user.id}) is admin...`);
    const isAdmin = await isUserAdmin(user.id);
    console.log(`🔐 Admin check completed - Result: ${isAdmin ? 'IS ADMIN ✓' : 'NOT ADMIN ✗'}`);
    
    if (!isAdmin) {
      console.log(`❌ User ${user.name} is not admin - Access denied to reminder form`);
      await ctx.reply("❌ Only admins and managers can send reminders. If you need this feature, please contact your administrator.");
      return;
    }
    
    console.log(`✅ Admin verified - Preparing reminder form UI...`);
    
    // Clear any existing session for this user
    if (userSessions[telegramId]) {
      console.log(`🧹 Clearing existing session for user ${telegramId}`);
      delete userSessions[telegramId];
    }
    
    // Setup new session
    userSessions[telegramId] = {
      step: 'reminder_type',
      taskData: {
        createdAt: new Date().toISOString()
      }
    };
    
    console.log(`📝 Session created: ${JSON.stringify(userSessions[telegramId])}`);
    
    // Step 1: Choose reminder type with enhanced UI
    const replyMessage = await ctx.reply(
      "📬 *Send Reminder*\n\nWhat type of reminder do you want to send?",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 Task Reminder", callback_data: "reminder_type_task" },
              { text: "✏️ Custom Reminder", callback_data: "reminder_type_custom" }
            ],
            [
              { text: "❌ Cancel", callback_data: "cancel_send_reminder" }
            ]
          ]
        }
      }
    );
    
    console.log(`✅ Reminder form UI displayed successfully (message ID: ${replyMessage.message_id})`);
    
    // Store the message ID in session for potential cleanup later
    userSessions[telegramId].formMessageId = replyMessage.message_id;
    
    console.log(`✅ Reminder form initiated successfully for admin user ${user.name} (${user.email})`);
    
  } catch (error) {
    console.error(`❌ ERROR in startSendReminderForm:`, error);
    await ctx.reply("Sorry, there was an error setting up the reminder form. Please try again later.");
  }
}

// Handler for reminder type selection
async function handleReminderTypeSelection(ctx: Context, data: string) {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      console.log("No telegram ID found in context");
      return;
    }
    
    const session = userSessions[telegramId];
    const user = ctx.state.authenticatedUser;
    
    if (!session || !user) {
      console.log("No active session or user found for user", telegramId);
      return;
    }

    // Save reminder type
    if (data === "reminder_type_task") {
      session.taskData.reminderType = 'task';
    } else if (data === "reminder_type_custom") {
      session.taskData.reminderType = 'custom';
    } else {
      await ctx.reply("❌ Invalid reminder type.");
      return;
    }
    session.step = 'reminder_user';

    // Show reminder user selection with organization filtering and pagination
    await showReminderUserSelection(ctx, 0);
  } catch (error) {
    console.error("Error handling reminder type selection:", error);
    await ctx.reply("❌ Sorry, there was an error processing your selection. Please try again.");
  }
}

// Helper function to show reminder user selection with pagination
async function showReminderUserSelection(ctx: Context, page: number = 0) {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;
    
    const user = ctx.state.authenticatedUser;
    if (!user) return;

    // Pagination settings
    const pageSize = 8;
    const offset = page * pageSize;

    // Fetch users from the same organization with pagination
    const { data: users, error } = await supabase
      .from("users")
      .select("id, name, email")
      .eq("organization_id", user.organization_id) // Filter by organization
      .order("name")
      .range(offset, offset + pageSize - 1);
    
    if (error || !users || users.length === 0) {
      await ctx.reply("❌ No users found in your organization.");
      return;
    }

    // Get total count for pagination
    const { count: totalUsers } = await supabase
      .from("users")
      .select("id", { count: 'exact' })
      .eq("organization_id", user.organization_id);

    const totalPages = Math.ceil((totalUsers || 0) / pageSize);

    // Show user selection with short IDs to avoid Telegram's 64-byte limit
    const keyboard = users.map((u: any) => {
      const shortId = generateShortUserIdForCallback(u.id, telegramId);
      return [{
        text: `${u.name} (${u.email})`,
        callback_data: `reminder_user_${shortId}`
      }];
    });

    // Add pagination buttons if needed
    if (totalPages > 1) {
      const paginationButtons = [];
      
      if (page > 0) {
        paginationButtons.push({
          text: "◀ Previous",
          callback_data: `reminder_user_page_${page - 1}`
        });
      }
      
      // Show current page info
      paginationButtons.push({
        text: `${page + 1}/${totalPages}`,
        callback_data: "page_info" // Non-functional button for display
      });
      
      if (page < totalPages - 1) {
        paginationButtons.push({
          text: "Next ▶",
          callback_data: `reminder_user_page_${page + 1}`
        });
      }
      
      keyboard.push(paginationButtons);
    }
    
    keyboard.push([{ text: "❌ Cancel", callback_data: "cancel_send_reminder" }]);

    await ctx.reply(
      `Select the user to send the reminder to:\n${totalPages > 1 ? `\n📄 Page ${page + 1} of ${totalPages} (${totalUsers} users in your organization)` : `\n👥 ${users.length} users in your organization`}`,
      {
        reply_markup: { inline_keyboard: keyboard }
      }
    );  } catch (error) {
    console.error("Error showing reminder user selection:", error);
    await ctx.reply("❌ Sorry, there was an error loading users. Please try again.");
  }
}

// End of initializeHandlers function

/**
 * Function to send reminders to users for their tasks
 */
// Import the cross-platform notification function from botManager

export async function sendReminder(reminder: { taskId: string; message: string }) {
  let task: any;
  let atLeastOneNotificationSent = false;
  
  try {
    console.log(`Processing reminder for task ID: ${reminder.taskId}`);
    
    // Check if this is a custom reminder (format: custom_${userId})
    if (reminder.taskId.startsWith('custom_')) {
      let userId = reminder.taskId.replace('custom_', '');
      
      // Remove any "reminder_user_" prefix if it exists
      if (userId.startsWith('reminder_user_')) {
        const shortId = userId.replace('reminder_user_', '');
        // For custom reminders, the short ID should have been resolved when creating the reminder
        // If we still have a short ID here, it means the mapping might have expired
        // In this case, we'll log a warning and use the short ID as-is
        if (shortId.startsWith('u') && shortId.length < 10) {
          console.warn(`Warning: Custom reminder contains unresolved short ID: ${shortId}. The mapping may have expired.`);
        }
        userId = shortId;
      }
      console.log(`Processing custom reminder for user ID: ${userId}`);
      
      // Get user details to log who we're sending to
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("name, email")
        .eq("id", userId)
        .single();

      if (userError || !user) {
        console.error(`Error fetching user ${userId} for custom reminder:`, userError);
        return;
      }

      console.log(`Sending custom reminder to: ${user.name} (${user.email}) across all platforms`);
      
      // Use the cross-platform notification function
      const notificationSent = await sendUserNotificationToAllPlatforms(
        userId,
        `⏰ CUSTOM REMINDER: ${reminder.message}\n\nFrom: Admin`,
        undefined, // No task ID for custom reminders
        false // Don't store in reminders table as it's already there
      );
      
      if (notificationSent) {
        console.log(`✅ Successfully sent cross-platform custom reminder to ${user.name} (${user.email})`);
        atLeastOneNotificationSent = true;
        
        // Mark custom reminder as sent
        await supabase
          .from("custom_reminder")
          .update({
            sent: true,
            sent_at: new Date().toISOString(),
          })
          .or(`user_id.eq.${userId},user_id.eq.reminder_user_${userId}`)
          .eq("sent", false);
        
        console.log(`✅ Marked custom reminder as sent for user ${userId}`);
      } else {
        console.error(`❌ Failed to send cross-platform custom reminder to ${user.name} (${user.email})`);
      }
      
      return; // Exit early for custom reminders
    }
    
    // Handle regular task reminders
    // Extract the real taskId if it's a combined ID like "taskId_userId"
    const taskIdParts = reminder.taskId.split('_');
    const realTaskId = taskIdParts[0]; // Use only the task ID part
    
    console.log(`Using task ID: ${realTaskId} from original ID: ${reminder.taskId}`)
    
    // Get task details using Supabase - Don't filter by status, get any task
    const { data: taskData, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, assigned_to, project_id, status, deadline")
      .eq("id", realTaskId)
      .single();

    if (taskError || !taskData) {
      console.error("❌ Error fetching task:", taskError);
      return;
    }

    task = taskData;
    console.log(`📋 Found task: "${task.title}" (Status: ${task.status})`);

    // Get project details if available
    let projectName = "No project";
    let teamName = "No team";

    if (task.project_id) {
      const { data: project } = await supabase
        .from("projects")
        .select("name, team_id")
        .eq("id", task.project_id)
        .single();

      if (project) {
        projectName = project.name;

        // Get team details if available
        if (project.team_id) {
          const { data: team } = await supabase
            .from("teams")
            .select("name")
            .eq("id", project.team_id)
            .single();
            
          if (team) {
            teamName = team.name;
          }
        }
      }
    }    // Handle the case where assigned_to might be an array or a single value
    const assignedToIds = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to];
    console.log(`📊 Task has ${assignedToIds.length} assignees`);
      
    // Check if this is a targeted reminder (format: taskId_userId)
    let usersToNotify = [];
    let isTargetedReminder = false;
    
    if (taskIdParts.length > 1 && taskIdParts[1].length > 30) {
      // If taskId has the format "taskId_userId", extract the userId part and only notify that specific user
      const targetUserId = taskIdParts[1];
      isTargetedReminder = true;
      console.log(`📝 Extracted target user ID from composite task ID: ${targetUserId}`);
      
      // For targeted reminders, ONLY notify the specific target user
      usersToNotify = [targetUserId];
      console.log(`📝 This is a targeted reminder for specific user: ${targetUserId}`);
      
      // Just log whether user is assigned, but don't change behavior based on it
      if (!assignedToIds.includes(targetUserId)) {
        console.log(`⚠️ Note: Target user ${targetUserId} is not in the assignee list for task ${realTaskId}`);
      }
    } else {
      // For regular reminders, notify all assignees
      usersToNotify = assignedToIds;
      console.log(`📝 This is a regular reminder. Will notify all assigned users: ${usersToNotify.join(', ')}`);
    }
    
    // Iterate through each user to send cross-platform notifications
    for (const userId of usersToNotify) {
      console.log(`🔔 Processing notification for user ID: ${userId}`);
      
      // Get user details
      const { data: assignee, error: assigneeError } = await supabase
        .from("users")
        .select("name, email")
        .eq("id", userId)
        .single();
  
      if (assigneeError || !assignee) {
        console.error(`❌ Error fetching user ${userId}:`, assigneeError);
        console.log(`❌ Cannot send reminder to user ${userId} - user not found`);
        continue; // Skip to the next user
      }
  
      const assigneeName = assignee.name || "Unknown User";
      const emailAddress = assignee.email || "No email address";
      console.log(`👤 Sending cross-platform reminders to: ${assigneeName} (${emailAddress})`);
  
      // Prepare a rich message with task details
      const statusEmojiMap: Record<string, string> = {
        'pending': '⏳',
        'in_progress': '🚧',
        'completed': '✅',
        'cancelled': '❌'
      };
      const statusEmoji = statusEmojiMap[task.status as string] || '📝';
      const deadlineText = task.deadline ? `\nDeadline: ${new Date(task.deadline).toLocaleDateString()}` : '';
        const taskMessage = `⏰ TASK REMINDER: ${reminder.message}\n\n` +
        `${statusEmoji} Task: ${task.title}\n` +
        `📂 Project: ${projectName}\n` +
        `👥 Team: ${teamName}\n` +
        `👤 Assigned to: ${assignee.name}\n` +
        `📧 Email: ${assignee.email}${deadlineText}\n` +
        `📊 Status: ${task.status.toUpperCase()}`;
      
      // Use the cross-platform notification function from botManager
      // For targeted reminders, we need to keep the composite ID to ensure proper cache key generation
      const taskIdToUse = isTargetedReminder ? reminder.taskId : task.id;
      console.log(`📝 Using task ID for notification: ${taskIdToUse} (${isTargetedReminder ? 'targeted' : 'regular'} reminder)`);
      
      const notificationSent = await sendUserNotificationToAllPlatforms(
        userId,
        taskMessage,
        taskIdToUse,
        false // Don't store in reminders table as it's already there
      );
      
      if (notificationSent) {
        console.log(`✅ Successfully sent cross-platform reminder for task "${task.title}" to ${assignee.name} (${assignee.email})`);
        atLeastOneNotificationSent = true;
      } else {
        console.error(`❌ Failed to send cross-platform notification to ${assignee.name} (${assignee.email})`);
      }
    }    // Mark the reminder as sent only if at least one notification was delivered
    if (atLeastOneNotificationSent) {
      if (reminder.taskId.startsWith('custom_')) {
        // For custom reminders, mark as sent based on user ID in custom_reminders table
        const userId = reminder.taskId.replace('custom_', '');
        await supabase
          .from("custom_reminder")
          .update({
            sent: true,
            sent_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("sent", false);
        
        console.log(`✅ Marked custom reminder as sent for user ${userId}`);
      } else if (isTargetedReminder) {
        // For targeted reminders, use the exact taskId from the reminder (includes the user ID)
        await supabase
          .from("reminders")
          .update({
            sent: true,
            sent_at: new Date().toISOString(),
          })
          .eq("task_id", reminder.taskId) // Use the composite task ID for targeted reminders
          .eq("sent", false);
        
        // Get the name of the targeted user
        const targetUserId = taskIdParts[1];
        const { data: targetUser } = await supabase
          .from("users")
          .select("name")
          .eq("id", targetUserId)
          .single();
        
        const targetUserName = targetUser?.name || "targeted user";
        console.log(`✅ Reminder sent to ${targetUserName} about task "${task.title}"`);
      } else {
        // For regular task reminders, mark as sent based on task ID
        await supabase
          .from("reminders")
          .update({
            sent: true,
            sent_at: new Date().toISOString(),
          })
          .eq("task_id", reminder.taskId)
          .eq("sent", false);
        
        console.log(`✅ Marked reminder as sent for task "${task.title}"`);
      }
    } else {
      if (reminder.taskId.startsWith('custom_')) {
        console.error(`Failed to send custom reminder - will be retried later`);
      } else if (isTargetedReminder) {
        const targetUserId = taskIdParts[1];
        console.error(`Security: Failed to send targeted notification for task "${task.title}" to user ${targetUserId} - reminder will be retried later`);
      } else {
        console.error(`Security: Failed to send any notifications for task "${task.title}" - reminder will be retried later`);
      }
    }
  } catch (error) {
    console.error("Error in sendReminder:", error);
  } finally {
    if (!atLeastOneNotificationSent) {
      if (reminder.taskId.startsWith('custom_')) {
        console.log(`Warning: Custom reminder was not sent`);
      } else if (task) {
        console.log(`Warning: No notifications were sent for task ${task.title}`);
      }
    }
  }
}

// Function to check for pending reminders
export async function checkReminders() {
  try {
    console.log("Security: Checking for pending reminders");
    const now = new Date().toISOString();
    
    // Get pending regular reminders
    const { data: pendingReminders, error } = await supabase
      .from("reminders")
      .select("*")
      .eq("sent", false)
      .lte("scheduled_for", now)
      .neq("type", "welcome");  // Exclude welcome messages - they're handled by welcomeService

    // Get pending custom reminders
    const { data: pendingCustomReminders, error: customError } = await supabase
      .from("custom_reminder")
      .select("*")
      .eq("sent", false)
      .lte("scheduled_for", now);

    if (error) {
      console.error("Error fetching reminders:", error);
      return;
    }

    if (customError) {
      console.error("Error fetching custom reminders:", customError);
      // Continue processing regular reminders even if custom reminders fail
    }

    // Combine both types of reminders
    const allPendingReminders = [
      ...(pendingReminders || []),
      ...((pendingCustomReminders || []).map(cr => ({
        ...cr,
        type: 'custom', // Explicitly set type for custom reminders
        task_id: null   // No task_id for custom reminders
      })))
    ];

    if (allPendingReminders.length === 0) {
      console.log("Security: No pending reminders found");
      return;
    }

    console.log(`Security: Found ${allPendingReminders.length} pending reminders (${pendingReminders?.length || 0} regular, ${pendingCustomReminders?.length || 0} custom)`);
    
    // Process each reminder
    for (const reminder of allPendingReminders) {
      console.log(`Security: Processing reminder ID: ${reminder.id}, type: ${reminder.type}, task: ${reminder.task_id || 'N/A'}`);
        // Handle different reminder types
      let reminderTaskId = reminder.task_id;
      if (!reminderTaskId && reminder.type === 'custom') {
        // For custom reminders without task_id, use the format custom_${user_id}        // Make sure we're using the raw user_id without any prefix
        const rawUserId = reminder.user_id.startsWith('reminder_user_') 
          ? (() => {
              const shortId = reminder.user_id.replace('reminder_user_', '');
              // For checkReminders, we don't have access to telegram ID to resolve short IDs
              // The short IDs should have been resolved when the reminder was created
              if (shortId.startsWith('u') && shortId.length < 10) {
                console.warn(`Warning: Found unresolved short ID in reminder: ${shortId}. The mapping may have expired.`);
              }
              return shortId;
            })()
          : reminder.user_id;
        reminderTaskId = `custom_${rawUserId}`;
      }
      
      await sendReminder({
        taskId: reminderTaskId || 'unknown',
        message: reminder.message || `Your task is due soon.`,
      });
      
      // Mark the reminder as sent after successful processing
      // Determine which table to update based on the reminder type
      const tableName = reminder.type === 'custom' ? "custom_reminder" : "reminder";
      await supabase
        .from(tableName)
        .update({
          sent: true,
          sent_at: new Date().toISOString(),
        })
        .eq("id", reminder.id);
    }
  } catch (error) {
    console.error("Error checking reminders:", error);
  } finally {
    // Cleanup if needed
  }
}

// Start the reminder service
function startReminderService() {
  if (isReminderServiceRunning) {
    console.log("Reminder service is already running.");
    return;
  }
  isReminderServiceRunning = true;
  console.log("Starting reminder service")

  // Check for pending reminders immediately
  checkReminders()

  // Set up interval to check for pending reminders every minute
  const interval = setInterval(checkReminders, 60 * 1000)

  // Handle cleanup
  process.once("SIGINT", () => {
    clearInterval(interval)
    console.log("Reminder service stopped")
  })

  process.once("SIGTERM", () => {
    clearInterval(interval)
    console.log("Reminder service stopped")
  })
}

// Track active bot instances by token to prevent duplicates
const activeBotTokens = new Set<string>();

// Start the bot with organization-specific configuration
export async function startBot(config?: OrgConfig) {
  // For the default bot case
  if (isBotRunning && !config) {
    console.log("Telegram bot is already running.");
    return false;
  }

  try {
    // If organization config is provided, set up organization-specific settings
    if (config) {
      console.log(`Setting up Telegram bot for organization: ${config.orgName} (${config.orgId})`);

      // Store the organization config
      const existingConfigIndex = orgConfigs.findIndex(c => c.orgId === config.orgId);
      if (existingConfigIndex >= 0) {
        orgConfigs[existingConfigIndex] = config;
      } else {

        orgConfigs.push(config);
      }

      // Set up Telegram-specific settings if available
      if (config.settings.telegram?.enabled) {
        const telegramSettings = config.settings.telegram;

        // Get token from settings or from database
        let token = telegramSettings.botToken;
        if (!token) {
          try {
            // Try to get token from database for this organization
            const { data, error } = await supabase
              .from("integration_tokens")
              .select("token_value")
              .eq("token_type", "TELEGRAM_BOT")
              .eq("organization_id", config.orgId)
              .eq("is_active", true)
              .single();

            if (error) {
              console.error(`Error fetching Telegram token for organization ${config.orgName}:`, error);
              return false;
            }

            token = data.token_value;
          } catch (error) {
            console.error(`Failed to get Telegram token for organization ${config.orgName}:`, error);
            return false;
          }
        }

        if (!token) {
          console.error(`No Telegram bot token found for organization ${config.orgName}`);
          return false;
        }

        // Check if a bot with this token is already running
        if (activeBotTokens.has(token)) {
          console.log(`Telegram bot for organization ${config.orgName} is already running with this token.`);
          
          // If there's an existing bot instance, try to stop it first
          if (orgBots[config.orgId]) {
            try {
              console.log(`Stopping existing Telegram bot for organization ${config.orgName}...`);
              await orgBots[config.orgId].stop();
              // Remove from active tokens after successful stop
              activeBotTokens.delete(token);
              console.log(`Successfully stopped existing Telegram bot for organization ${config.orgName}.`);
            } catch (stopError) {
              console.error(`Error stopping existing Telegram bot for organization ${config.orgName}:`, stopError);
              // Continue anyway to try to create a new instance
            }
          }
        }
        
        // Create organization-specific bot instance
        orgBots[config.orgId] = new Telegraf(token);

        // Use the telegramBotAgent directly
        orgAgents[config.orgId] = telegramBotAgent;

        // Initialize handlers for this organization's bot
        initializeHandlers(orgBots[config.orgId], orgAgents[config.orgId], config.orgId);
        
        // Launch the bot with proper error handling
        try {
          await orgBots[config.orgId].launch();
          // Add to active tokens after successful launch
          activeBotTokens.add(token);
          console.log(`Telegram bot for organization ${config.orgName} started successfully.`);
          console.log(`Telegram bot for organization ${config.orgName} started with secure authentication`);
        } catch (error: any) {
          console.error(`Error launching Telegram bot for organization ${config.orgName}:`, error);
          // If the error is a conflict, provide more helpful information
          if (error.message && error.message.includes('Conflict: terminated by other getUpdates request')) {
            console.error(`Telegram bot conflict detected for organization ${config.orgName}. Another instance of this bot is already running.`);
          }
          return false;
        }
      }

      return true;
    }

    // Default bot initialization (for backward compatibility)
    console.log("Security: Starting default Telegram bot with secure authentication");

    // Get token from Supabase
    const token = await getTelegramBotToken();
    
    // Check if a bot with this token is already running
    if (activeBotTokens.has(token)) {
      console.log("Default Telegram bot is already running with this token.");
      
      // If there's an existing bot instance, try to stop it first
      if (bot) {
        try {
          console.log("Stopping existing default Telegram bot...");
          await bot.stop();
          // Remove from active tokens after successful stop
          activeBotTokens.delete(token);
          console.log("Successfully stopped existing default Telegram bot.");
        } catch (stopError) {
          console.error("Error stopping existing default Telegram bot:", stopError);
          // Continue anyway to try to create a new instance
        }
      }
    }

    // Create bot instance
    bot = new Telegraf(token);

    // Use the telegramBotAgent directly
    agent = telegramBotAgent;

    // Initialize all handlers
    initializeHandlers(bot, agent);
    
    // Launch the bot with proper error handling
    try {
      await bot.launch();
      // Add to active tokens after successful launch
      activeBotTokens.add(token);
      isBotRunning = true;
    } catch (error: any) {
      console.error("Error launching default Telegram bot:", error);
      // If the error is a conflict, provide more helpful information
      if (error.message && error.message.includes('Conflict: terminated by other getUpdates request')) {
        console.error("Telegram bot conflict detected. Another instance of this bot is already running.");
        console.error("This may happen if the bot wasn't properly shut down previously or if multiple instances are running.");
      }
      return false;
    }
    console.log("Security: Telegram bot started with secure authentication enabled");
    console.log("Security: Only registered users with valid Telegram IDs will be able to interact with the bot");

    // Start the reminder service
    startReminderService();

    // Enable graceful stop
    process.once("SIGINT", async () => {
      console.log("Received SIGINT signal, stopping all Telegram bots...");
      // Stop all organization-specific bots
      for (const [orgId, orgBot] of Object.entries(orgBots)) {
        try {
          console.log(`Stopping Telegram bot for organization ${orgId}...`);
          await orgBot.stop("SIGINT");
          console.log(`Successfully stopped Telegram bot for organization ${orgId}.`);
        } catch (error) {
          console.error(`Error stopping organization bot for ${orgId}:`, error);
        }
      }

      // Stop the default bot
      if (bot) {
        try {
          console.log("Stopping default Telegram bot...");
          await bot.stop("SIGINT");
          console.log("Successfully stopped default Telegram bot.");
        } catch (error) {
          console.error("Error stopping default Telegram bot:", error);
        }
      }
      
      // Clear the set of active tokens
      activeBotTokens.clear();
      console.log("Security: All Telegram bots stopped");
    });

    process.once("SIGTERM", async () => {
      console.log("Received SIGTERM signal, stopping all Telegram bots...");
      // Stop all organization-specific bots
      for (const [orgId, orgBot] of Object.entries(orgBots)) {
        try {
          console.log(`Stopping Telegram bot for organization ${orgId}...`);
          await orgBot.stop("SIGTERM");
          console.log(`Successfully stopped Telegram bot for organization ${orgId}.`);
        } catch (error) {
          console.error(`Error stopping organization bot for ${orgId}:`, error);
        }
      }

      // Stop the default bot
      if (bot) {
        try {
          console.log("Stopping default Telegram bot...");
          await bot.stop("SIGTERM");
          console.log("Successfully stopped default Telegram bot.");
        } catch (error) {
          console.error("Error stopping default Telegram bot:", error);
        }
      }
      
      // Clear the set of active tokens
      activeBotTokens.clear();
      console.log("Security: All Telegram bots stopped");
    });

    return true;
  } catch (error) {
    console.error("Security: Error starting Telegram bot:", error);
    return false;
  }
}

// Export the functions and bot
// Define interfaces for the exported functions
interface SendReminderParams {
  taskId: string;
  message: string;
}

interface TelegramBot {
  bot: any | null; // Using any since Telegraf type is complex and already handled elsewhere
  startBot: () => Promise<boolean>;
  sendReminder: (reminder: SendReminderParams) => Promise<void>;
  checkReminders: () => Promise<void>;
}

// Helper function to check if user is an admin
async function isUserAdmin(userId: string) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single();
    if (error || !data) return false;
    // Allow both admin and manager roles to have admin privileges
    return data.role === 'admin' || data.role === 'manager';
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}


// Helper function to check if project exists
async function doesProjectExist(projectName: string, organizationId?: string) {
  try {
    // Build query for projects, filtering by organization if provided
    let query = supabase
      .from("projects")
      .select("id")
      .ilike("name", projectName)
      .limit(1);

    // Filter by organization if provided
    if (organizationId) {/* ... */}

    const { data, error } = await query;

    return !error && data && data.length > 0;
  } catch (error) {
    console.error("Error checking project existence:", error);
    return false;
  }
}

// Helper function to check if team exists
async function doesTeamExist(teamName: string, organizationId?: string) {
  try {
    // Build query for teams, filtering by organization if provided
    let query = supabase
      .from("teams")
      .select("id")
      .ilike("name", teamName)
      .limit(1);

    // Filter by organization if provided
    if (organizationId) {/* ... */}

    const { data, error } = await query;

    return !error && data && data.length > 0;
  } catch (error) {
    console.error("Error checking team existence:", error);
    return false;
  }
}

// Export the functions and bot with proper types
export default {
  bot,
  startBot,
  sendReminder,
  checkReminders,
} as TelegramBot;

// AI Response Processing Function for Intent Detection and UI Form Automation
async function processAIResponse(
  agentResponseText: string,
  toolCalls: any[],
  user: any,
  ctx: any
): Promise<boolean> {
  console.log("🤖 Processing AI agent response:", agentResponseText?.substring(0, 100) + "...")
  console.log("🔍 Full AI response text:", agentResponseText)
  // Enhanced debugging for AI responses
  console.log("🧠 AI Response Analysis:")
  console.log("📝 Response text length:", agentResponseText?.length)
  console.log("📝 Response beginning:", agentResponseText?.substring(0, 50))
  console.log("📝 Contains CREATE_TASK?", agentResponseText?.includes("TRIGGER_UI_FORM:CREATE_TASK"))
  console.log("📝 Contains UPDATE_TASK?", agentResponseText?.includes("TRIGGER_UI_FORM:UPDATE_TASK"))
  console.log("📝 Contains EDIT_TASK?", agentResponseText?.includes("TRIGGER_UI_FORM:EDIT_TASK"))
  console.log("📝 Contains SEND_REMINDER?", agentResponseText?.includes("TRIGGER_UI_FORM:SEND_REMINDER"))
  console.log("📝 Contains 'remind'?", agentResponseText?.toLowerCase().includes("remind"))
  console.log("📝 Contains 'reminder'?", agentResponseText?.toLowerCase().includes("reminder"))
  
  // Special handling for reminder keywords in AI response
  if (
    agentResponseText?.toLowerCase().includes("remind") ||
    agentResponseText?.toLowerCase().includes("reminder") ||
    agentResponseText?.toLowerCase().includes("notification to user") ||
    agentResponseText?.toLowerCase().includes("notify user")
  ) {
    console.log("⚠️ AI Response contains reminder keywords but didn't use proper TRIGGER_UI_FORM format!")
    console.log("🔄 Force triggering reminder form...")
    await startSendReminderForm(ctx);
    return true;
  }

  // First, check for explicit TRIGGER_UI_FORM patterns (highest priority)
  if (agentResponseText?.includes("TRIGGER_UI_FORM:CREATE_TASK")) {
    console.log("🎯 TRIGGER_UI_FORM:CREATE_TASK detected - Starting task creation form...")
    
    // Extract task title from AI response if present
    let taskTitle = "";
    const titleMatch = agentResponseText.match(/task ['"](.*?)['"]|task: (.*?)(?:\n|$)|titled ['"](.*?)['"]|called ['"](.*?)['"]|named ['"](.*?)[']/i);
    if (titleMatch) {
      taskTitle = titleMatch[1] || titleMatch[2] || titleMatch[3] || titleMatch[4] || titleMatch[5];
      taskTitle = taskTitle?.trim() || "";
    }

    await startTaskCreationFormWithTitle(ctx, taskTitle);
    return true;
  }
  if (agentResponseText?.includes("TRIGGER_UI_FORM:UPDATE_TASK")) {
    console.log("🎯 TRIGGER_UI_FORM:UPDATE_TASK detected - Showing task update form...")
    await showTaskStatusUpdateForm(ctx);
    return true;
  }
  if (agentResponseText?.includes("TRIGGER_UI_FORM:EDIT_TASK") || 
      agentResponseText?.includes("<EDIT_TASK_FORM>") || 
      agentResponseText?.includes("[EDIT_TASK_FORM]")) {
    console.log("🎯 TRIGGER_UI_FORM:EDIT_TASK detected - Showing task edit form...")
    await showTaskEditForm(ctx);
    return true;
  }

  if (agentResponseText?.includes("TRIGGER_UI_FORM:SEND_REMINDER")) {
    console.log("🎯 TRIGGER_UI_FORM:SEND_REMINDER detected - Starting admin send reminder form...")
    await startSendReminderForm(ctx);
    return true;
  }

  if (agentResponseText.includes("TRIGGER_UI_FORM:LIST_TASKS")) {
    console.log("🎯 TRIGGER_UI_FORM:LIST_TASKS detected - Enhanced task listing with UI...")
    
    // Use getUserTasks tool to get tasks, then display with enhanced UI
    if (toolCalls && toolCalls.length > 0) {
      const getUserTasksCall = toolCalls.find(tc => tc.toolName === "getUserTasks");
      if (getUserTasksCall) {
        const formattedResponse = await formatToolCallResponse(getUserTasksCall, user);
        if (formattedResponse) {
          if (getUserTasksCall.args.tasks && getUserTasksCall.args.tasks.length > 0) {
            await ctx.reply(formattedResponse, {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "🔄 Update Task Status", callback_data: "show_update_task_form" },
                    { text: "➕ Create New Task", callback_data: "start_task_creation" }
                  ],
                  [
                    { text: "📊 Filter Tasks", callback_data: "show_task_filters" },
                    { text: "🔍 Search Tasks", callback_data: "search_tasks" }
                  ]
                ]
              }
            });
          } else {
            await ctx.reply(formattedResponse, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "➕ Create Your First Task", callback_data: "start_task_creation" }]
                ]
              }
            });
          }
          return true;
        }
      }
    }
    
    // Fallback: show basic task list UI
    await showTaskStatusUpdateForm(ctx);
    return true;
  }

  // Check for task creation intent (second priority - fallback for old patterns)
  const taskCreationIntent = (
    agentResponseText.toLowerCase().includes("i'll help you create a task") ||
    agentResponseText.toLowerCase().includes("i'll help you create a new task") ||
    agentResponseText.toLowerCase().includes("help you create a task") ||
    agentResponseText.toLowerCase().includes("help you create a new task") ||
    agentResponseText.toLowerCase().includes("let me help you create") ||
    agentResponseText.toLowerCase().includes("create a task") ||
    agentResponseText.toLowerCase().includes("creating a task") ||
    agentResponseText.toLowerCase().includes("add a task") ||
    agentResponseText.toLowerCase().includes("make a task") ||
    agentResponseText.toLowerCase().includes("new task") ||
    agentResponseText.toLowerCase().includes("task creation form") ||
    agentResponseText.toLowerCase().includes("start creating")
  );

  console.log("➕ Task creation intent detected:", taskCreationIntent)

  // Check for task update intent (second priority)
  const taskUpdateIntent = !taskCreationIntent && (
    agentResponseText.toLowerCase().includes("i'll help you update a task status") ||
    agentResponseText.toLowerCase().includes("i'll help you update task status") ||
    agentResponseText.toLowerCase().includes("help you update a task status") ||
    agentResponseText.toLowerCase().includes("help you update task status") ||
    agentResponseText.toLowerCase().includes("i'll show you your tasks so you can select") ||
    agentResponseText.toLowerCase().includes("show you your tasks so you can select") ||
    agentResponseText.toLowerCase().includes("update a task") ||
    agentResponseText.toLowerCase().includes("updating a task") ||
    agentResponseText.toLowerCase().includes("change task status") ||
    agentResponseText.toLowerCase().includes("mark a task") ||
    (agentResponseText.toLowerCase().includes("update") && agentResponseText.toLowerCase().includes("status")) ||
    agentResponseText.toLowerCase().includes("status update") ||
    agentResponseText.toLowerCase().includes("change status") ||
    agentResponseText.toLowerCase().includes("help you update") ||
    agentResponseText.toLowerCase().includes("update task status")
  );-
  console.log("🔄 Task update intent detected:", taskUpdateIntent)  // Check for task editing intent (second priority)
  const taskEditingIntent = !taskCreationIntent && !taskUpdateIntent && (
    agentResponseText.toLowerCase().includes("i'll help you edit a task") ||
    agentResponseText.toLowerCase().includes("i'll help you edit task") ||
    agentResponseText.toLowerCase().includes("help you edit a task") ||
    agentResponseText.toLowerCase().includes("help you edit task") ||
    agentResponseText.toLowerCase().includes("let me help you edit") ||
    agentResponseText.toLowerCase().includes("edit a task") ||
    agentResponseText.toLowerCase().includes("editing a task") ||
    agentResponseText.toLowerCase().includes("modify a task") ||
    agentResponseText.toLowerCase().includes("modifying a task") ||
    agentResponseText.toLowerCase().includes("change task details") ||
    agentResponseText.toLowerCase().includes("update task details") ||
    agentResponseText.toLowerCase().includes("task editing") ||
    agentResponseText.toLowerCase().includes("edit task") ||
    agentResponseText.toLowerCase().includes("modify task") ||
    agentResponseText.toLowerCase().includes("change the task") ||
    agentResponseText.toLowerCase().includes("make changes to the task") ||
    agentResponseText.toLowerCase().includes("please provide the details") ||
    agentResponseText.toLowerCase().includes("provide the details") ||
    agentResponseText.toLowerCase().includes("task you would like to edit") ||
    agentResponseText.toLowerCase().includes("details of the task you would like to edit") ||
    agentResponseText.toLowerCase().includes("which task would you like to edit") ||
    agentResponseText.toLowerCase().includes("show you your tasks so you can edit") ||
    agentResponseText.toLowerCase().includes("show your tasks for editing") ||
    agentResponseText.toLowerCase().includes("which task do you want to edit")
  );

  console.log("✏️ Task editing intent detected:", taskEditingIntent)

  // Check for task viewing intent (lowest priority) - only if not creation, update, or editing
  const taskViewingIntent = !taskCreationIntent && !taskUpdateIntent && !taskEditingIntent && (
    agentResponseText.toLowerCase().includes("your tasks") ||
    agentResponseText.toLowerCase().includes("here are your") ||
    agentResponseText.toLowerCase().includes("tasks:") ||
    agentResponseText.toLowerCase().includes("task list") ||
    agentResponseText.toLowerCase().includes("found these tasks") ||
    agentResponseText.toLowerCase().includes("showing you") ||
    agentResponseText.toLowerCase().includes("tasks for")
  );

  console.log("📋 Task viewing intent detected:", taskViewingIntent)
  // Handle task creation intent
  if (taskCreationIntent) {
    console.log("🎯 Triggering task creation form...")
    
    // Extract task title from AI response if present
    let taskTitle = "";
    const titleMatch = agentResponseText.match(/task ['"](.*?)['"]|task: (.*?)(?:\n|$)|titled ['"](.*?)['"]|called ['"](.*?)['"]|named ['"](.*?)[']/i);
    if (titleMatch) {
      taskTitle = titleMatch[1] || titleMatch[2] || titleMatch[3] || titleMatch[4] || titleMatch[5];
      taskTitle = taskTitle?.trim() || "";
    }

    // Start the task creation form UI flow with optional pre-filled title
    await startTaskCreationFormWithTitle(ctx, taskTitle);
    return true; // Indicates we handled the response with UI
  }
  // Handle task update intent
  if (taskUpdateIntent) {
    console.log("🎯 Triggering task update form...")
    await showTaskStatusUpdateForm(ctx);
    return true; // Indicates we handled the response with UI
  }
  // Handle task editing intent
  if (taskEditingIntent) {
    console.log("🎯 Triggering task editing form...")
    await showTaskEditForm(ctx);
    return true; // Indicates we handled the response with UI
  }

  // Handle task viewing with enhanced UI
  if (taskViewingIntent && toolCalls && toolCalls.length > 0) {
    const toolCall = toolCalls.find(tc => tc.toolName === "getUserTasks");
    if (toolCall) {
      console.log("🎯 Enhancing task viewing with UI buttons...")
      const formattedResponse = await formatToolCallResponse(toolCall, user);
      if (formattedResponse && toolCall.args.tasks && toolCall.args.tasks.length > 0) {
        // Send enhanced task list with action buttons
        await ctx.reply(formattedResponse, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Update Task Status", callback_data: "show_update_task_form" },
                { text: "➕ Create New Task", callback_data: "start_task_creation" }
              ],
              [
                { text: "📊 Filter Tasks", callback_data: "show_task_filters" },
                { text: "🔍 Search Tasks", callback_data: "search_tasks" }
              ]
            ]
          }
        });
        return true; // Indicates we handled the response with enhanced UI
      }
    }
  }

  // If tool calls exist but no special intent, handle them normally
  if (toolCalls && toolCalls.length > 0) {
    console.log("🔧 Processing tool calls without special UI...")
    const toolCall = toolCalls[0];
    
    if (toolCall.toolName === "getUserTasks") {
      const formattedResponse = await formatToolCallResponse(toolCall, user);
      if (formattedResponse) {
        // Check if we have tasks to offer action buttons
        if (toolCall.args.tasks && toolCall.args.tasks.length > 0) {
          await ctx.reply(formattedResponse, {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Update Task Status", callback_data: "show_update_task_form" }]
              ]
            }
          });
        } else {
          await ctx.reply(formattedResponse);
        }
        return true;
      }
    } else {
      // Handle other tool calls
      const formattedResponse = await formatToolCallResponse(toolCall, user);
      if (formattedResponse) {
        await ctx.reply(formattedResponse);
        return true;
      }
    }
  }

  return false; // Indicates we didn't handle the response with special UI
}

// Format tool call responses for better Telegram display
async function formatToolCallResponse(toolCall: any, user: any): Promise<string | null> {
  try {
    switch (toolCall.toolName) {
      case "getUserTasks": {
        const taskData = toolCall.args as any;

        if (taskData.success && taskData.tasks) {
          if (taskData.tasks.length === 0) {
            const statusText = taskData.statusFilter ? ` ${taskData.statusFilter}` : '';
            return `You have no${statusText} tasks. 🎉`;
          } else {
            const statusEmoji: Record<string, string> = {
              'pending': '⏳',
              'in_progress': '🚧',
              'completed': '✅',
              'cancelled': '❌'
            };

            // Determine status text for display
            let statusText = 'All';
            if (taskData.statusFilter) {
              const filter = taskData.statusFilter.toLowerCase();
              if (filter === 'pending') statusText = 'Pending';
              else if (filter === 'in_progress') statusText = 'In Progress';
              else if (filter === 'completed') statusText = 'Completed';
              else if (filter === 'cancelled') statusText = 'Cancelled';
              else statusText = taskData.statusFilter.charAt(0).toUpperCase() + taskData.statusFilter.slice(1);
            }            let responseMessage = `📋 *Your ${statusText} Tasks:*\n\n`;            taskData.tasks.forEach((task: any, index: number) => {
              const emoji = statusEmoji[task.status as keyof typeof statusEmoji] || '📝';
              const dueDate = task.dueDate || "No due date";
              const priority = task.priority ? ` | Priority: ${task.priority.toUpperCase()}` : '';

              responseMessage += `${index + 1}. ${emoji} ${escapeMarkdown(task.title)}\n`;
              responseMessage += `   Status: ${task.status} | Due: ${escapeMarkdown(dueDate)}${priority}\n`;
              responseMessage += `   Project: ${escapeMarkdown(task.projectName)} | Team: ${escapeMarkdown(task.teamName)}\n\n`;
            });

            responseMessage += `Total: ${taskData.tasks.length} task${taskData.tasks.length > 1 ? 's' : ''}`;
            return responseMessage;
          }
        }
        break;
      }

      case "list_projects": {
        const projectData = toolCall.args as any;
        if (projectData.success && projectData.projects) {
          if (projectData.projects.length === 0) {
            return "No projects found. 📝";
          } else {
            let responseMessage = "📁 *Available Projects:*\n\n";
            projectData.projects.forEach((project: any, index: number) => {
              responseMessage += `${index + 1}. *${project.name}*\n`;
              if (project.teamName) {
                responseMessage += `   Team: ${project.teamName}\n`;
              }
              responseMessage += "\n";
            });
            return responseMessage;
          }
        }
        break;
      }

      case "list_teams": {
        const teamData = toolCall.args as any;
        if (teamData.success && teamData.teams) {
          if (teamData.teams.length === 0) {
            return "No teams found. 👥";
          } else {
            let responseMessage = "👥 *Available Teams:*\n\n";
            teamData.teams.forEach((team: any, index: number) => {
              responseMessage += `${index + 1}. *${team.name}*\n\n`;
            });
                       return responseMessage;
          }
        }
        break;
      }

      case "create_task": {
        const taskData = toolCall.args as any;
        if (taskData.success) {
          let responseMessage =
            `✅ Task created successfully!\n\n` +
            `*Task:* ${taskData.taskName}\n` +
            `*Assigned to:* ${taskData.assignedTo}\n` +
            `*Email:* ${taskData.emailAddress}\n`;

          if (taskData.dueDate) {
            responseMessage += `*Due:* ${new Date(taskData.dueDate).toLocaleDateString()}\n`;
          }

          if (taskData.priority) {
            responseMessage += `*Priority:* ${taskData.priority}\n`;
          }

          if (taskData.project) {
            responseMessage += `*Project:* ${taskData.project}${taskData.projectCreated ? " (newly created)" : ""}\n`;
          }

          if (taskData.team) {
            responseMessage += `*Team:* ${taskData.team}${taskData.teamCreated ? " (newly created)" : ""}\n`;
          }

          if (taskData.userCreated) {
            responseMessage += `\n💡 *Note:* Created a new user for ${taskData.assignedTo} with the provided email address.`;
          }

          if (taskData.projectCreated) {
            responseMessage += `\n💡 *Note:* Created a new project "${taskData.project}".`;
          }            if (taskData.teamCreated) {
            responseMessage += `\n💡 *Note:* Created a new team "${taskData.team}".`;
          }

          return responseMessage;
        }
        break;
      }

      case "update_status": {
        const statusData = toolCall.args as any;
        if (statusData.success) {
          return `✅ Task status updated successfully!\n\n*Task:* ${statusData.taskName}\n*New Status:* ${statusData.newStatus}`;
        }
        break;
      }
    default:
        return null;
    }
    return null; // Default return if no case was matched
  } catch (error) {
    console.error("Error formatting tool call response:", error);
    return null;
  }
}

// Function to show task edit form from current session data (for editing during creation)
async function showTaskEditFormFromSession(ctx: Context, session: any) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  
  try {
    // Update session state to edit mode
    session.step = 'edit_before_create';
      const taskInfo = `📋 *Editing Task Before Creation*\n\n` +
      `📝 *Title:* ${escapeMarkdown(session.taskData.title || "Not set")}\n` +
      `📄 *Description:* ${escapeMarkdown(session.taskData.description || "Not set")}\n` +
      `⭐ *Priority:* ${ escapeMarkdown(session.taskData.priority || "Not set")}\n` +
      `📅 *Deadline:* ${escapeMarkdown(session.taskData.deadline || "Not set")}\n` +
      `📂 *Project:* ${escapeMarkdown(session.taskData.projectName || "Not set")}\n` +
      `👤 *Assigned to:* ${escapeMarkdown(session.taskData.assigneeName || "Not set")}\n\n` +
      `Select what you want to edit:`;

    const keyboard = [
      [
        { text: "📝 Title", callback_data: "edit_session_title" },
        { text: "📄 Description", callback_data: "edit_session_description" }
      ],
      [
        { text: "⭐ Priority", callback_data: "edit_session_priority" },
        { text: "📅 Deadline", callback_data: "edit_session_deadline" }
      ],
      [
        { text: "📂 Project", callback_data: "edit_session_project" },
        { text: "👤 Assignee", callback_data: "edit_session_assignee" }
      ],
      [
        { text: "✅ Done Editing", callback_data: "finish_edit_session" },
        { text: "❌ Cancel", callback_data: "cancel_edit_session" }
      ]
    ];

    await ctx.reply(taskInfo, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  } catch (error) {
    console.error("Error in showTaskEditFormFromSession:", error);
    await ctx.reply("❌ An error occurred. Please try again later.");
  }
}