import App, { LogLevel } from "@slack/bolt"

/**
 * Slack Bot for TaskMate
 * Handles task management and reminder notifications via Slack
 */

import { BlockAction, InteractiveMessage, SlashCommand } from "@slack/bolt"
import * as dotenv from "dotenv"
import { createClient } from "@supabase/supabase-js"
import { slackBotAgent } from "./agents/slackBotAgent"
import { sendNewTaskAssignmentNotification } from "../health"
import { sendUserNotificationToAllPlatforms } from "../botManager"
import { storeTokenUsage, TokenUsageData } from "../utils/tokenUsage"
import {
  startSendReminderForm,
  handleReminderTypeSelection,
  handleReminderUserSelection,
  handleReminderTaskSelection,
  handleCustomReminderMessage,
  handleReminderCancellation,
  hasActiveReminderSession,
  getReminderSession,
  clearReminderSession,
  reminderSessions
} from "./slackReminderForms"
import { Agent } from "@mastra/core"

dotenv.config()

// Create a Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Interface definitions
interface Task {
  id: string
  title: string
  description?: string
  status: string
  priority: string
  deadline?: string
  assigned_to: string[] // JSONB array format - updated to be more specific about type
  project_id?: string
  organization_id?: string  // Added organization_id
  created_at: string
  updated_at: string
  created_by?: string // Added creator ID field
}

interface User {
  id: string
  name: string
  email: string
  role: string
  organization_id?: string  // Added organization_id
}

interface Project {
  id: string
  name: string
  team_id?: string
  deadline?: string
  project_lead?: string
  organization_id?: string  // Added organization_id
  created_at: string
  updated_at: string
}

interface Team {
  id: string
  name: string
  organization_id?: string  // Added organization_id
  created_at: string
  updated_at: string
}

// Type guards and helpers
const isBlockAction = (body: any): body is BlockAction => {
  return body.type === 'block_actions'
}

const isSlashCommand = (body: any): body is SlashCommand => {
  return body.type === 'slash_command'
}

// Use the slackBotAgent directly
const agent = slackBotAgent

// Organization-specific configuration interface
interface OrgConfig {
  orgId: string;
  orgName: string;
  adminUsers: any[];
  settings: {
    slack?: {
      enabled: boolean;
      appToken?: string;
      botToken?: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
}

// Store organization-specific configurations
let orgConfigs: OrgConfig[] = []

// Store organization-specific bot instances
const orgBots: Record<string, App.App> = {}

// Store organization-specific agents
const orgAgents: Record<string, any> = {}

// We'll use this variable to store the default bot instance
let bot: App.App | null = null

// Fetch Slack tokens from Supabase instead of environment variables
async function getSlackTokens(orgId?: string) {
  try {
    let query = supabase
      .from("integration_tokens")
      .select("token_type, token_value")
      .eq("is_active", true);

    // If organization ID is provided, filter by it
    if (orgId) {
      console.log(`Fetching Slack tokens for organization: ${orgId}`);
      query = query.eq("organization_id", orgId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching Slack tokens:", error);
      throw error;
    }

    // Extract tokens from the results
    let SLACK_APP_TOKEN = "";
    let SLACK_BOT_TOKEN = "";

    if (data) {
      for (const token of data) {
        if (token.token_type === "SLACK_APP") {
          SLACK_APP_TOKEN = token.token_value;
        } else if (token.token_type === "SLACK_BOT") {
          SLACK_BOT_TOKEN = token.token_value;
        }
      }
    }

    // If organization-specific tokens weren't found, try to get default tokens
    if ((!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) && orgId) {
      console.log("Organization-specific tokens not found, trying default tokens...");
      const defaultTokens = await getSlackTokens();

      if (!SLACK_APP_TOKEN) SLACK_APP_TOKEN = defaultTokens.SLACK_APP_TOKEN;
      if (!SLACK_BOT_TOKEN) SLACK_BOT_TOKEN = defaultTokens.SLACK_BOT_TOKEN;
    }

    return {
      SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN
    };
  } catch (error) {
    console.error("Failed to fetch Slack tokens from database:", error);
    throw error;
  }
}

// Common function to handle unregistered users
async function handleUnregisteredUser(client: any, channelId: string, threadTs?: string) {
  await client.chat.postMessage({
    channel: channelId,
    text: "You're not registered yet. Please send me a message first to get started!",
    thread_ts: threadTs
  })
}

// Helper function to get thread timestamp for maintaining conversation
function getThreadTimestamp(message: any, body?: any): string | undefined {
  // For messages
  if (message?.thread_ts) return message.thread_ts
  if (message?.ts) return message.ts

  // For actions/interactions
  if (body?.message?.thread_ts) return body.message.thread_ts
  if (body?.message?.ts) return body.message.ts

  // For events - check if body has event property using type guard
  if (body && typeof body === 'object' && 'event' in body && body.event) {
    if (body.event.thread_ts) return body.event.thread_ts
    if (body.event.ts) return body.event.ts
  }

  return undefined
}

// Helper function to send message with proper thread handling
async function sendMessage(say: any, client: any, channel: string, text: string, options: any = {}, threadTs?: string) {
  const messageOptions = {
    ...options,
    thread_ts: threadTs
  }

  if (say) {
    return await say({ text, ...messageOptions })
  } else {
    return await client.chat.postMessage({ channel, text, ...messageOptions })
  }
}

// Helper function to get allowed status values - returns complete predefined set
async function getAllowedStatuses(): Promise<string[]> {
  // Return the complete set of valid statuses regardless of what exists in the database
  // This ensures all status options are always available in dropdowns
  return ['pending', 'in_progress', 'completed', 'cancelled']
}

// Helper function to create status options for dropdowns
async function createStatusOptions(currentStatus?: string) {
  const allowedStatuses = await getAllowedStatuses()

  const statusEmojis: Record<string, string> = {
    'pending': '⏳',
    'in_progress': '🚧',
    'completed': '✅',
    'cancelled': '❌',
    'canceled': '❌'
  }

  return allowedStatuses
    .map(status => ({
      text: {
        type: "plain_text" as const,
        text: `${statusEmojis[status] || '📝'} ${status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ')}`,
        emoji: true
      },
      value: status
    })) as Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }>
}

// Helper function to create one-tap priority options for task creation
function createPriorityOptions(): Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }> {
  return [
    {
      text: {
        type: "plain_text",
        text: "🔴 High",
        emoji: true
      },
      value: "high"
    },
    {
      text: {
        type: "plain_text",
        text: "🟡 Medium",
        emoji: true
      },
      value: "medium"
    },
    {
      text: {
        type: "plain_text",
        text: "🟢 Low",
        emoji: true
      },
      value: "low"
    },
    {
      text: {
        type: "plain_text",
        text: "⚫ Urgent",
        emoji: true
      },
      value: "urgent"
    }
  ]
}

// Helper function for managing multiple assignees in task creation
interface AssigneeSelectionState {
  assigneeIds: string[];
  assigneeNames: string[];
  assigneeEmails: string[];
  isMultiSelect: boolean;
  taskTitle?: string;
  taskDescription?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
  priority?: string;
  deadline?: string;
}

// Store temporary state for multi-assignee selection sessions
const assigneeSelectionSessions: Record<string, AssigneeSelectionState> = {};

// Helper function to get or initialize assignee selection state
function getAssigneeSelectionState(userId: string): AssigneeSelectionState {
  if (!assigneeSelectionSessions[userId]) {
    assigneeSelectionSessions[userId] = {
      assigneeIds: [],
      assigneeNames: [],
      assigneeEmails: [],
      isMultiSelect: false
    };
  }
  return assigneeSelectionSessions[userId];
}

// Helper function to clear assignee selection state
function clearAssigneeSelectionState(userId: string): void {
  delete assigneeSelectionSessions[userId];
}

// Helper function to get user by email
async function getUserByEmail(email: string): Promise<User | null> {
  console.log(`🔍 getUserByEmail: Searching for email: ${email}`)
  try {
    // First check if the user exists directly in the users table with slack_email
    const { data: directUser, error: directUserError } = await supabase
      .from("users")
      .select("*")
      .eq("slack_email", email)
      .single()

    if (!directUserError && directUser) {
      console.log(`✅ getUserByEmail: Found user directly with slack_email: ${directUser.name} (${directUser.email})`)
      return directUser
    }

    return directUser
  } catch (error) {
    console.error("❌ getUserByEmail: Unexpected error:", error)
    return null
  }
}

// Helper function to get user from any Slack interaction
async function getUserFromSlackId(slackId: string, client: any): Promise<User | null> {
  console.log(`🔍 getUserFromSlackId: Getting user for Slack ID: ${slackId}`)

  try {
    const slackUserInfo = await client.users.info({ user: slackId })

    if (!slackUserInfo.ok || !slackUserInfo.user) {
      console.log("❌ Failed to get Slack user info")
      return null
    }

    const slackUser = slackUserInfo.user

    const userName = slackUser.real_name || slackUser.name || "SlackUser"
    const cleanName = userName.replace(/\s+/g, '').toLowerCase()
    const fallbackEmail = `${cleanName}.${slackId}@localstack`

    let finalEmail = slackUser.profile?.email ||
      fallbackEmail

    console.log(`📧 Resolved email: ${finalEmail}`)

    // First check if the user exists directly in the users table with slack_email
    const { data: directUser, error: directUserError } = await supabase
      .from("users")
      .select("*")
      .eq("slack_email", finalEmail)
      .single()

    if (!directUserError && directUser) {
      console.log(`✅ getUserFromSlackId: Found user directly with slack_email: ${directUser.name} (${directUser.email})`)
      return directUser
    }

    // If not found by slack_email, try the regular lookup
    const user = await getUserByEmail(finalEmail)
    console.log(`📊 User lookup result: ${user ? `Found user: ${user.name}` : "User not found"}`)

    return user
  } catch (error) {
    console.error("❌ Error getting user from Slack ID:", error)
    return null
  }
}

// Helper function to get available teams
async function getAvailableTeams(organizationId?: string): Promise<(Team & { team_lead?: string })[]> {
  try {
    console.log("🔍 Fetching available teams...")

    // Build query for teams, filtering by organization if provided
    let query = supabase
      .from("teams")
      .select("id, name, organization_id, created_at, updated_at")
      .order("name");

    // Filter by organization if provided
    if (organizationId) {
      console.log(`Filtering teams by organization ID: ${organizationId}`);
      query = query.eq("organization_id", organizationId);
    }

    const { data: teams, error } = await query;

    if (error) {
      console.error("❌ Error fetching teams:", error)
      throw error
    }

    // Get team leads for each team
    const teamsWithLeads = await Promise.all(
      (teams || []).map(async (team) => {
        const { data: teamLead } = await supabase
          .from("team_members")
          .select(`
            users (
              name
            )
          `)
          .eq("team_id", team.id)
          .eq("role", "team_lead")
          .single()

        return {
          ...team,
          team_lead: teamLead?.users?.[0]?.name || null
        }
      })
    )

    console.log(`✅ Found ${teamsWithLeads.length} teams`)
    return teamsWithLeads
  } catch (error) {
    console.error("❌ Error fetching teams:", error)
    return []
  }
}

// Helper function to get available projects
async function getAvailableProjects(organizationId?: string): Promise<Project[]> {
  try {
    console.log("🔍 Fetching available projects...")

    // Build query for projects, filtering by organization if provided
    let query = supabase
      .from("projects")
      .select("id, name, team_id, organization_id, created_at, updated_at")
      .order("name");

    // Filter by organization if provided
    if (organizationId) {
      console.log(`Filtering projects by organization ID: ${organizationId}`);
      query = query.eq("organization_id", organizationId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("❌ Error fetching projects:", error)
      throw error
    }

    console.log(`✅ Found ${data?.length || 0} projects`)
    return data || []
  } catch (error) {
    console.error("❌ Error fetching projects:", error)
    return []
  }
}

// Helper function to check if user is a team lead
async function isTeamLead(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("team_members")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "team_lead")
      .limit(1);

    if (error) {
      console.error("Error checking team lead status:", error);
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    console.error("Error checking if user is team lead:", error);
    return false;
  }
}

// Helper function to check if user is an admin
async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Error checking admin status:", error);
      return false;
    }

    return data && data.role === "admin";
  } catch (error) {
    console.error("Error checking if user is admin:", error);
    return false;
  }
}

// Modified: Helper function to get all users for dropdown based on team lead or admin status
async function getAvailableUsers(currentUserId: string | null = null, isTeamLeadOrAdmin = false): Promise<Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }>> {
  try {
    // Determine which users to fetch based on team lead or admin status
    let query = supabase.from("users").select("id, name, email, organization_id").order("name");

    // Get current user's organization ID
    let organizationId = null;
    if (currentUserId) {
      const { data: currentUser } = await supabase
        .from("users")
        .select("organization_id")
        .eq("id", currentUserId)
        .single();

      if (currentUser && currentUser.organization_id) {
        organizationId = currentUser.organization_id;
        // Filter users by organization_id
        query = query.eq("organization_id", organizationId);
      }
    }

    // If user is not a team lead or admin and a currentUserId is provided, only return that user
    if (currentUserId && !isTeamLeadOrAdmin) {
      console.log(`User ${currentUserId} is not a team lead or admin, only showing their own user`);
      query = query.eq("id", currentUserId);
    }

    const { data: users, error } = await query;

    if (error) {
      console.error("Error fetching users:", error);
      return [];
    }

    return users.map(user => {
      // Create a display text that combines name and email but stays under limits
      let displayText = `${user.name} (${user.email})`;

      // Truncate if over Slack's limit (leaving buffer room)
      if (displayText.length > 75) {
        // Try to keep full name but truncate email
        const nameLength = user.name.length;
        const emailStart = displayText.indexOf('(') + 1;
        const availableEmailChars = 75 - nameLength - 5; // 5 for " (...)"

        if (availableEmailChars > 5) {
          // Truncate email
          const emailPart = user.email.substring(0, availableEmailChars) + "...";
          displayText = `${user.name} (${emailPart})`;
        } else {
          // Truncate whole string if email would be too short
          displayText = displayText.substring(0, 75) + "...";
        }
      }

      return {
        text: {
          type: "plain_text" as const,
          text: displayText,
          emoji: true
        },
        value: user.id
      };
    });
  } catch (error) {
    console.error("Error getting available users:", error);
    return [];
  }
}

// Helper function to create team options for dropdown with role-based restrictions
async function createTeamOptions(isUserTeamLeadOrAdmin: boolean = false, organizationId?: string): Promise<Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }>> {
  try {
    // Fetch teams filtered by organization_id if provided
    let teamsQuery = supabase.from("teams").select("id, name, organization_id");

    if (organizationId) {
      teamsQuery = teamsQuery.eq("organization_id", organizationId);
    }

    const { data: teamsData, error } = await teamsQuery.order("name");

    if (error) {
      console.error("❌ Error fetching teams:", error);
      throw error;
    }

    const teams = teamsData || [];
    console.log(`📋 Found ${teams.length} teams for organization ${organizationId || 'any'}`);

    // Get team leads for each team
    const teamsWithLeads = await Promise.all(
      teams.map(async (team) => {
        const { data: teamLead } = await supabase
          .from("team_members")
          .select(`
            users (
              name
            )
          `)
          .eq("team_id", team.id)
          .eq("role", "team_lead")
          .single();

        return {
          ...team,
          team_lead: teamLead?.users?.[0]?.name || null
        };
      })
    );

    const options = teamsWithLeads.map(team => {
      // Limit the team name to prevent UI issues
      let teamName = team.name
      const teamLeadText = team.team_lead ? ` (Lead: ${team.team_lead})` : ''

      // Ensure the entire text fits within Slack's limits
      const fullText = `${teamName}${teamLeadText}`

      // Truncate if needed (75 is Slack's max length for dropdown options)
      const maxLength = 70
      const displayText = fullText.length > maxLength
        ? fullText.substring(0, maxLength) + '...'
        : fullText

      return {
        text: {
          type: "plain_text" as const,
          text: displayText,
          emoji: true
        },
        value: team.id
      }
    })    // Add "Create New" option for team leads and admins
    if (isUserTeamLeadOrAdmin) {
      options.push({
        text: {
          type: "plain_text" as const,
          text: "➕ Create New Team",
          emoji: true
        },
        value: "new_team"
      })
      console.log(`✅ Added "Create New Team" option for team lead or admin`)
    }

    // Add "No Team" option for all users
    options.unshift({
      text: {
        type: "plain_text" as const,
        text: "No Team",
        emoji: true
      },      value: "no_team"
    });
    
    console.log(`✅ Created ${options.length} team options (${teams.length} existing ${isUserTeamLeadOrAdmin ? '+ 1 new' : ''} + 1 no_team)`);
    return options;
  } catch (error) {
    console.error("❌ Error creating team options:", error)

    // Return basic options in case of error
    const defaultOptions: Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }> = [{
      text: {
        type: "plain_text" as const,
        text: "No Team",
        emoji: true
      },
      value: "no_team"
    }]    // Only include "Create New" for team leads and admins
    if (isUserTeamLeadOrAdmin) {
      defaultOptions.push({
        text: {
          type: "plain_text" as const,
          text: "➕ Create New Team",
          emoji: true
        },
        value: "new_team"
      })
    }

    return defaultOptions
  }
}

// Helper function to create project options for dropdown with role-based restrictions
async function createProjectOptions(isUserTeamLeadOrAdmin: boolean = false, organizationId?: string): Promise<Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }>> {
  try {
    // Fetch projects filtered by organization_id if provided
    let projectsQuery = supabase.from("projects").select("id, name, team_id, organization_id");

    if (organizationId) {
      projectsQuery = projectsQuery.eq("organization_id", organizationId);
    }

    const { data: projectsData, error } = await projectsQuery.order("name");

    if (error) {
      console.error("❌ Error fetching projects:", error);
      throw error;
    }

    const projects = projectsData || [];
    console.log(`📋 Found ${projects.length} projects for organization ${organizationId || 'any'}`);

    // Get teams for project team names
    const { data: teamsData } = await supabase
      .from("teams")
      .select("id, name");

    const teams = teamsData || [];

    const teamMap = teams.reduce<Record<string, string>>((map, team) => {
      map[team.id] = team.name
      return map
    }, {})

    const options = projects.map(project => {
      let projectText = project.name

      // Add team name if available
      if (project.team_id && teamMap[project.team_id]) {
        projectText += ` (Team: ${teamMap[project.team_id]})`
      }

      // Truncate if needed to prevent UI issues
      const maxLength = 70
      const displayText = projectText.length > maxLength
        ? projectText.substring(0, maxLength) + '...'
        : projectText

      return {
        text: {
          type: "plain_text" as const,
          text: displayText,
          emoji: true
        },
        value: project.id
      }
    })    // Add "Create New" option for team leads and admins
    if (isUserTeamLeadOrAdmin) {
      options.push({
        text: {
          type: "plain_text" as const,
          text: "➕ Create New Project",
          emoji: true
        },
        value: "new_project"      })
      console.log(`✅ Added "Create New Project" option for team lead or admin`)
    }

    console.log(`✅ Created ${options.length} project options (${projects.length} existing ${isUserTeamLeadOrAdmin ? '+ 1 new' : ''})`)
    return options
  } catch (error) {
    console.error("❌ Error creating project options:", error)// Only include "Create New" for team leads and admins
    if (isUserTeamLeadOrAdmin) {
      return [{
        text: {
          type: "plain_text" as const,
          text: "➕ Create New Project",
          emoji: true
        },
        value: "new_project"
      }]
    }
    return []
  }
}

// Helper function to get user tasks for status update
async function getUserTasksForUpdate(userId: string): Promise<Array<{ text: { type: "plain_text"; text: string; emoji?: boolean }; value: string }>> {
  try {    console.log(`🔍 Fetching tasks for user ${userId} for status update...`)
    const allowedStatuses = await getAllowedStatuses();    const { data: tasks, error } = await supabase
      .from("tasks")      .select(`
        id,
        title,
        status,
        projects (
          name
        )      `)
      .filter('assigned_to', 'cs', `["${userId}"]`) // Fix: properly format user ID for JSONB containment
      .in("status", allowedStatuses)
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) {
      console.error("❌ Error fetching tasks:", error)
      return []
    }

    // Filter out completed and cancelled tasks
    const activeTasks = tasks.filter(task => task.status !== 'completed' && task.status !== 'cancelled')

    if (!activeTasks || activeTasks.length === 0) {
      console.log("📭 No active tasks found for the user")
      return []
    }

    console.log(`✅ Found ${activeTasks.length} active tasks for dropdown`)

    // Format for Slack dropdown
    return activeTasks.map(task => {
      // Create display text and truncate if needed
      let displayText = `${task.title} (${task.status}) - ${task.projects?.[0]?.name || 'No Project'}`
      const maxLength = 70

      if (displayText.length > maxLength) {
        displayText = displayText.substring(0, maxLength) + '...'
      }

      return {
        text: {
          type: "plain_text" as const,
          text: displayText,
          emoji: true
        },
        value: task.id
      }
    })
  } catch (error) {
    console.error("❌ Error getting user tasks for update:", error)
    return []
  }
}

// Function to generate task creation form based on AI detection of task intent
async function generateTaskCreationForm(user: User, client: any, channel: string, taskTitle: string, threadTs?: string) {
  console.log(`🎯 Generating task creation form for: "${taskTitle}"`)

  try {
    // First ask for task name with a text input instead of going directly to project selection
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Let's create a new task${taskTitle !== "New Task" ? ` for "${taskTitle}"` : ""}.`
        }
      },
      {
        type: "input",
        block_id: "task_name_block",
        element: {
          type: "plain_text_input",
          action_id: "task_name_input",
          initial_value: taskTitle !== "New Task" ? taskTitle : "",
          placeholder: {
            type: "plain_text",
            text: "Enter a name for the task"
          }
        },
        label: {
          type: "plain_text",
          text: "Task Name"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Next",
              emoji: true
            },
            action_id: "task_name_next",
            style: "primary"
          }
        ]
      }
    ]

    await client.chat.postMessage({
      channel: channel,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          user_id: user.id,
          organization_id: user.organization_id,
          is_team_lead: await isTeamLead(user.id),
          action: "input_task_name"
        }
      },
      thread_ts: threadTs
    })

    return true
  } catch (error) {
    console.error("❌ Error generating task form:", error)
    await client.chat.postMessage({
      channel: channel,
      text: "Sorry, I encountered an error creating the task form. Please try again.",
      thread_ts: threadTs
    })
    return false
  }
}

// Function to generate task update form based on AI detection of update intent
async function generateTaskUpdateForm(user: User, client: any, channel: string, threadTs?: string) {
  console.log(`🔄 Generating task update form for user: ${user.name}`)

  try {
    // Get user's tasks
    const taskOptions = await getUserTasksForUpdate(user.id)

    if (!taskOptions || taskOptions.length === 0) {
      await client.chat.postMessage({
        channel: channel,
        text: "You don't have any active tasks to update.",
        thread_ts: threadTs
      })
      return false
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*🔄 Select a task to update:*"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose the task you want to update:"
        },
        accessory: {
          type: "static_select",
          action_id: "select_task_to_update",
          options: taskOptions,
          placeholder: {
            type: "plain_text",
            text: "Select a task...",
            emoji: true
          }
        } as any
      }
    ]

    await client.chat.postMessage({
      channel: channel,
      blocks: blocks,
      metadata: {
        event_type: "task_update",
        event_payload: {
          user_id: user.id,
          organization_id: user.organization_id // Include organization_id
        }
      },
      thread_ts: threadTs
    })

    return true
  } catch (error) {
    console.error("❌ Error generating task update form:", error)
    await client.chat.postMessage({
      channel: channel,
      text: "Sorry, I encountered an error creating the task update form. Please try again.",
      thread_ts: threadTs
    })
    return false  }
}

// Function to generate task edit form based on AI detection of edit intent
async function generateTaskEditForm(user: User, client: any, channel: string, threadTs?: string) {
  console.log(`✏️ Generating task edit form for user: ${user.name}`)

  try {
    // Get user's tasks (excluding completed and cancelled)
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select(`
        id,
        title,
        description,
        status,
        priority,
        deadline,
        assigned_to,        projects (
          id,
          name
        )      `)
      .filter('assigned_to', 'cs', `["${user.id}"]`)
      .neq("status", "completed")
      .neq("status", "cancelled")
      .eq("organization_id", user.organization_id)
      .order("created_at", { ascending: false })
      .limit(10)

    if (error) {
      console.error("❌ Error fetching user tasks:", error)
      await client.chat.postMessage({
        channel: channel,
        text: "Sorry, I encountered an error fetching your tasks.",
        thread_ts: threadTs
      })
      return false
    }

    if (!tasks || tasks.length === 0) {
      await client.chat.postMessage({
        channel: channel,
        text: "You don't have any active tasks to edit.",
        thread_ts: threadTs
      })
      return false
    }

    // Create task options for dropdown
    const taskOptions = tasks.map(task => {
      const priorityEmoji = {
        'low': '🟢',
        'medium': '🟡',
        'high': '🟠',
        'urgent': '🔴'
      }[task.priority as string] || '📝'

      const projectInfo = (task.projects as any)?.name ? ` (${(task.projects as any).name})` : ''
      
      return {
        text: {
          type: "plain_text" as const,
          text: `${priorityEmoji} ${task.title}${projectInfo}`,
          emoji: true
        },
        value: task.id
      }
    })

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*✏️ Select a task to edit:*"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose the task you want to edit:"
        },
        accessory: {
          type: "static_select",
          action_id: "select_task_to_edit",
          options: taskOptions,
          placeholder: {
            type: "plain_text",
            text: "Select a task...",
            emoji: true
          }
        } as any
      }
    ]

    await client.chat.postMessage({
      channel: channel,
      blocks: blocks,
      metadata: {
        event_type: "task_edit",
        event_payload: {
          user_id: user.id,
          organization_id: user.organization_id
        }
      },
      thread_ts: threadTs
    })

    return true
  } catch (error) {
    console.error("❌ Error generating task edit form:", error)
    await client.chat.postMessage({
      channel: channel,
      text: "Sorry, I encountered an error creating the task edit form. Please try again.",
      thread_ts: threadTs
    })
    return false
  }
}

// Extract AI-predicted intent and generate corresponding forms for UI interactions
async function processAIResponse(response: any, user: User, client: any, say: any, channel: string, threadTs?: string) {
  console.log("🤖 Processing AI agent response:", response.text?.substring(0, 100) + "...")
  console.log("🔍 Full AI response text:", response.text)
  
  // First check for reminder intent with TRIGGER_UI_FORM pattern (highest priority for admin reminders)
  if (response.text?.includes("TRIGGER_UI_FORM:SEND_REMINDER")) {
    console.log("🎯 TRIGGER_UI_FORM:SEND_REMINDER detected - Starting admin send reminder form...")
    await startSendReminderForm(client, user, channel, threadTs);
    return;
  }
  
  // Check for reminder keywords in AI response (fallback detection)
  if (
    response.text?.toLowerCase().includes("remind") ||
    response.text?.toLowerCase().includes("reminder") ||
    response.text?.toLowerCase().includes("send notification") ||
    response.text?.toLowerCase().includes("notify user")
  ) {
    console.log("⚠️ AI Response contains reminder keywords - Triggering reminder form...")
    await startSendReminderForm(client, user, channel, threadTs);
    return;
  }
  // First check for edit intent patterns - these should have highest priority for edit operations
  const taskEditIntent = (
    response.text.toLowerCase().includes("i'll help you edit a task. i'll show you your tasks so you can select which one to edit") ||
    response.text.toLowerCase().includes("help you edit a task. i'll show you your tasks so you can select which one to edit") ||
    response.text.toLowerCase().includes("i'll help you edit a task") ||
    response.text.toLowerCase().includes("i'll help you edit task") ||
    response.text.toLowerCase().includes("help you edit a task") ||
    response.text.toLowerCase().includes("help you edit task") ||
    response.text.toLowerCase().includes("which one you'd like to edit") ||
    response.text.toLowerCase().includes("task you want to edit") ||
    response.text.toLowerCase().includes("specify the task you want to edit") ||
    response.text.toLowerCase().includes("let me know which one you'd like to edit") ||
    response.text.toLowerCase().includes("please let me know which one you'd like to edit") ||
    response.text.toLowerCase().includes("i'll open a form where you can provide the new details") ||
    response.text.toLowerCase().includes("open a form where you can provide the new details") ||
    response.text.toLowerCase().includes("edit a task") ||
    response.text.toLowerCase().includes("modify a task") ||
    response.text.toLowerCase().includes("change a task") ||
    response.text.toLowerCase().includes("edit task") ||
    response.text.toLowerCase().includes("modify task") ||
    response.text.toLowerCase().includes("change task") ||
    response.text.toLowerCase().includes("update task details") ||
    response.text.toLowerCase().includes("edit my task") ||
    response.text.toLowerCase().includes("modify my task") ||
    response.text.toLowerCase().includes("change task details") ||
    response.text.toLowerCase().includes("i want to edit") ||
    response.text.toLowerCase().includes("i need to modify") ||
    // Check for edit-specific patterns in AI responses about task selection
    (response.text.toLowerCase().includes("show you your tasks so you can select") && 
     response.text.toLowerCase().includes("edit")) ||
    (response.text.toLowerCase().includes("i'll show you your tasks") && 
     response.text.toLowerCase().includes("edit")) ||
    // Check if the response asks which task to edit - key edit intent pattern
    response.text.toLowerCase().includes("which task you would like to edit") ||
    response.text.toLowerCase().includes("what changes you would like to make") ||
    // Check if response ends with edit-related question
    response.text.toLowerCase().includes("would like to edit and what changes"));
    
  console.log("✏️ Task edit intent detected:", taskEditIntent)

  // Check for task viewing intent ONLY if edit intent is not detected
  const taskViewingIntent = !taskEditIntent && (
    response.text.toLowerCase().includes("📋 *your tasks:*") ||
    response.text.toLowerCase().includes("*your tasks:*") ||
    response.text.toLowerCase().includes("your tasks:") ||
    response.text.toLowerCase().includes("here are your") ||
    response.text.toLowerCase().includes("tasks:") ||
    response.text.toLowerCase().includes("task list") ||
    response.text.toLowerCase().includes("found these tasks") ||
    response.text.toLowerCase().includes("showing you") ||
    response.text.toLowerCase().includes("📋") ||
    (response.text.toLowerCase().includes("tasks") && 
     (response.text.toLowerCase().includes("found") || 
      response.text.toLowerCase().includes("total:") || 
      response.text.toLowerCase().includes("status:"))) ||
    // Check if response contains a formatted task list (numbered list with tasks)
    /\d+\.\s*[⏳🚧✅❌].*status:/i.test(response.text)
  );
  
  console.log("📋 Task viewing intent detected:", taskViewingIntent)
  // Check for task update intent ONLY if edit intent is not detected and it's not clearly a task viewing response
  const taskUpdateIntent = !taskEditIntent && !taskViewingIntent && (
    response.text.toLowerCase().includes("i'll help you update a task status") ||
    response.text.toLowerCase().includes("i'll help you update task status") ||
    response.text.toLowerCase().includes("help you update a task status") ||
    response.text.toLowerCase().includes("help you update task status") ||
    response.text.toLowerCase().includes("update a task") ||
    response.text.toLowerCase().includes("updating a task") ||
    response.text.toLowerCase().includes("change task status") ||
    response.text.toLowerCase().includes("mark a task") ||
    (response.text.toLowerCase().includes("update") && response.text.toLowerCase().includes("status")) ||
    response.text.toLowerCase().includes("status update") ||
    response.text.toLowerCase().includes("change status") ||
    response.text.toLowerCase().includes("help you update") ||
    response.text.toLowerCase().includes("update task status") ||
    // Only match generic selection patterns if not edit context
    (!response.text.toLowerCase().includes("edit") && 
     (response.text.toLowerCase().includes("i'll show you your tasks so you can select") ||
      response.text.toLowerCase().includes("show you your tasks so you can select"))));
      
  console.log("🔄 Task update intent detected:", taskUpdateIntent)
  // Check for task creation intent (lower priority)
  const taskCreationIntent = !taskUpdateIntent && !taskViewingIntent && !taskEditIntent && (
    response.text.toLowerCase().includes("create a task") ||
    response.text.toLowerCase().includes("creating a task") ||
    response.text.toLowerCase().includes("add a task") ||
    response.text.toLowerCase().includes("make a task") ||
    response.text.toLowerCase().includes("new task") ||
    response.text.toLowerCase().includes("i'll help you create") ||
    response.text.toLowerCase().includes("let's create"));
    
  console.log("➕ Task creation intent detected:", taskCreationIntent)
  // Handle task viewing intent first (highest priority for show tasks responses)
  if (taskViewingIntent) {
    console.log("📋 Task viewing intent detected - showing tasks without update prompt")
    // Just display the tasks without triggering update forms
    await sendMessage(say, client, channel, response.text, {}, threadTs);
    return;
  }

  // Extract task title from AI response if present
  let taskTitle = "";
  if (taskCreationIntent) {
    const titleMatch = response.text.match(/task ['"](.*?)['"]|task: (.*?)(?:\n|$)/i);
    if (titleMatch) {
      taskTitle = titleMatch[1] || titleMatch[2];
      taskTitle = taskTitle.trim();
    } else {
      // If no explicit title found, use a generic one
      taskTitle = "New Task";
    }

    // Generate task creation form - always start with name input
    await generateTaskCreationForm(user, client, channel, taskTitle, threadTs);    return;
  }

  if (taskEditIntent) {
    // Generate task edit form
    await generateTaskEditForm(user, client, channel, threadTs);
    return;
  }

  if (taskUpdateIntent) {
    // Generate task update form
    await generateTaskUpdateForm(user, client, channel, threadTs);
    return;
  }

  // If there are tool calls, process them (this handles viewing tasks via tools)
  if (response.toolCalls && response.toolCalls.length > 0) {
    const toolCall = response.toolCalls[0]
    console.log(`🔧 Tool used: ${toolCall.toolName}`)

    // Handle specific tool responses
    if (toolCall.toolName === "getUserTasks") {
      // For task list responses, include a "Update Task Status" button
      const formattedResponse = await formatToolCallResponse(toolCall, user);
      if (formattedResponse) {
        // Check if we have tasks to offer status updates
        if (toolCall.args.tasks && toolCall.args.tasks.length > 0) {
          // Send message with tasks list and update button
          await client.chat.postMessage({
            channel: channel,
            text: formattedResponse,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: formattedResponse
                }
              },
              {
                type: "actions",
                block_id: "task_update_actions",
                element: {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Update Task Status",
                    emoji: true
                  },
                  action_id: "show_update_task_form",
                  style: "primary"
                }
              }
            ],
            thread_ts: threadTs
          });
        } else {
          // No tasks to update, just send the message
          await sendMessage(say, client, channel, formattedResponse, {}, threadTs);
        }
        return;
      }    } else if (toolCall.toolName === "list_projects" ||
      toolCall.toolName === "list_teams" ||
      toolCall.toolName === "create_task" ||
      toolCall.toolName === "update_status" ||
      toolCall.toolName === "create_reminder" ||
      toolCall.toolName === "attendance_tool" ||
      toolCall.toolName === "attendance_status_tool") {

      // Format response for other tool calls
      let formattedResponse = await formatToolCallResponse(toolCall, user);
      if (formattedResponse) {
        await sendMessage(say, client, channel, formattedResponse, {}, threadTs);
        return;
      }
    }
  }

  // For other responses, just send the AI's text response
  await sendMessage(say, client, channel, response.text, {}, threadTs);
}

// Format the response from tool calls for better Slack display
async function formatToolCallResponse(toolCall: any, user: User): Promise<string | null> {
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
            }

            let responseMessage = `📋 *Your ${statusText} Tasks:*\n\n`;

            taskData.tasks.forEach((task: any, index: number) => {
              const emoji = statusEmoji[task.status as keyof typeof statusEmoji] || '📝';
              const dueDate = task.dueDate || "No due date";
              const priority = task.priority ? ` | Priority: ${task.priority.toUpperCase()}` : '';

              responseMessage += `${index + 1}. ${emoji} *${task.title}*\n`;
              responseMessage += `   Status: ${task.status} | Due: ${dueDate}${priority}\n`;
              responseMessage += `   Project: ${task.projectName} | Team: ${task.teamName}\n\n`;
            });

            responseMessage += `Total: ${taskData.tasks.length} task${taskData.tasks.length > 1 ? 's' : ''}`;
            return responseMessage;
          }
        }
        break;
      }

      case "list_projects": {
        const projectData = toolCall.args as any;

        if (projectData.success) {
          if (projectData.totalProjects === 0) {
            return "No projects found in the system.";
          } else {
            let responseMessage = "📁 *Available Projects:*\n\n";

            // Show projects organized by team
            if (projectData.projectsByTeam && Object.keys(projectData.projectsByTeam).length > 0) {
              Object.entries(projectData.projectsByTeam).forEach(([teamName, projects]) => {
                responseMessage += `*${teamName}*\n`;
                // Make sure projects is treated as an array
                (projects as Project[]).forEach((project: Project, index: number) => {
                  responseMessage += `   ${index + 1}. ${project.name}\n`;
                });
                responseMessage += "\n";
              });
            }

            // Show projects without teams
            if (projectData.projectsWithoutTeam && projectData.projectsWithoutTeam.length > 0) {
              responseMessage += "*Projects without Team*\n";
              projectData.projectsWithoutTeam.forEach((project: any, index: number) => {
                responseMessage += `   ${index + 1}. ${project.name}\n`;
              });
              responseMessage += "\n";
            }

            responseMessage += `Total: ${projectData.totalProjects} project${projectData.totalProjects > 1 ? 's' : ''}`;
            return responseMessage;
          }
        }
        break;
      }

      case "list_teams": {
        const teamData = toolCall.args as any;

        if (teamData.success) {
          if (teamData.totalTeams === 0) {
            return "No teams found in the system.";
          } else {
            let responseMessage = "👥 *Available Teams:*\n\n";

            teamData.teams.forEach((team: any, index: number) => {
              const teamLead = team.team_lead ? ` (Lead: ${team.team_lead})` : '';
              responseMessage += `${index + 1}. ${team.name}${teamLead}\n`;
            });
            responseMessage += `\nTotal: ${teamData.totalTeams} team${teamData.totalTeams > 1 ? 's' : ''}`;
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

          if (taskData.organization) {
            responseMessage += `*Organization:* ${taskData.organization}\n`;
          }

          return responseMessage;
        } else {
          return `Error creating task: ${taskData.message || "Unknown error"}`;
        }
      }

      case "update_status": {
        const statusData = toolCall.args as any;

        if (statusData.success) {
          return `✅ Task *"${statusData.taskName}"* marked as ${statusData.status}! 🎉`;
        } else {
          return `Error updating task: ${statusData.message || "Unknown error"}`;
        }
      }      case "create_reminder": {
        const reminderData = toolCall.args as any;

        if (reminderData.success) {
          return `⏰ Reminder set for task *"${reminderData.taskName}"* at ${new Date(reminderData.scheduledFor).toLocaleString()}`;
        } else {
          return `Error setting reminder: ${reminderData.message || "Unknown error"}`;
        }
      }

      case "attendance_tool": {
        const attendanceData = toolCall.args as any;

        if (attendanceData.success) {
          const action = attendanceData.action;
          const status = attendanceData.status;
          const workHours = attendanceData.work_hours;
          const locationText = attendanceData.location ? `\n📍 *Location:* ${attendanceData.location}` : '';
          const notesText = attendanceData.notes ? `\n📝 *Notes:* ${attendanceData.notes}` : '';
          
          if (action === 'check_in') {
            return `✅ *Checked In Successfully!*\n⏰ *Time:* ${new Date(attendanceData.checkIn).toLocaleString()}\n📊 *Status:* ${status.toUpperCase()}${locationText}${notesText}`;
          } else if (action === 'check_out') {
            const hoursText = workHours ? `\n🕐 *Work Hours:* ${workHours} hours` : '';
            return `🏁 *Checked Out Successfully!*\n⏰ *Time:* ${new Date(attendanceData.checkOut).toLocaleString()}${hoursText}${locationText}${notesText}`;
          }
        } else {
          return `❌ Attendance Error: ${attendanceData.message || "Unknown error"}`;
        }
      }

      case "attendance_status_tool": {
        const statusData = toolCall.args as any;

        if (statusData.success) {
          let response = `📊 *Attendance Status*\n\n`;
              if (statusData.todayRecord) {
            const record = statusData.todayRecord;
            response += `Today (${new Date(record.date).toLocaleDateString()}):\n`;
            response += `• Check-in: ${record.check_in ? new Date(record.check_in).toLocaleTimeString() : 'Not checked in'}\n`;
            response += `• Check-out: ${record.check_out ? new Date(record.check_out).toLocaleTimeString() : 'Not checked out'}\n`;
            response += `• Status: ${record.status}\n`;
            if (record.work_hours) response += `• Work Hours: ${record.work_hours} hours\n`;
            if (record.location) response += `• Location: ${record.location}\n`;
            response += `\n`;
          } else {
            response += `Today: No attendance record found\n\n`;
          }          if (statusData.recentRecords && statusData.recentRecords.length > 0) {
            response += `Recent Records:\n`;
            statusData.recentRecords.slice(0, 5).forEach((record: any) => {
              const date = new Date(record.date).toLocaleDateString();
              const checkIn = record.check_in ? new Date(record.check_in).toLocaleTimeString() : 'N/A';
              const checkOut = record.check_out ? new Date(record.check_out).toLocaleTimeString() : 'N/A';
              response += `• ${date}: ${checkIn} - ${checkOut} (${record.status})\n`;
            });
          }

          if (statusData.monthlySummary) {
            const summary = statusData.monthlySummary;
            response += `\nThis Month Summary:\n`;
            response += `• Total Days: ${summary.total_days || 0}\n`;
            response += `• Present: ${summary.days_present || 0}\n`;
            response += `• Late: ${summary.days_late || 0}\n`;
            response += `• Half Day: ${summary.days_half_day || 0}\n`;
            response += `• Total Hours: ${summary.total_hours || 0}\n`;
          }

          return response;
        } else {
          return `❌ Error fetching attendance status: ${statusData.message || "Unknown error"}`;
        }
      }
    }

    // Default case - return null to let the caller handle it
    return null;
  } catch (error) {
    console.error("❌ Error formatting tool call response:", error);
    return null;
  }
}

// Register all event handlers and middleware
function registerBotHandlers(bot: App.App, orgId?: string) {
  // Debug middleware to log all incoming requests
  bot.use(async ({ body, context, next }) => {
    console.log("=== INCOMING REQUEST ===")
    console.log("Type:", body.type || ('event' in body ? body.event?.type : undefined))
    console.log("Command:", isSlashCommand(body) ? body.command : 'N/A')

    if (orgId) {
      console.log(`Organization context: ${orgId}`)
    }

    // Extract user ID from different types of Slack event bodies
    let userId = '';
    if (isSlashCommand(body)) {
      userId = body.user_id;
    } else if ('event' in body && body.event?.user) {
      userId = body.event.user;
    } else if (body.user?.id) {
      userId = body.user.id;
    }
    console.log("User:", userId)

    // Extract channel ID from different types of bodies
    let channelId = '';
    if (isSlashCommand(body)) {
      channelId = body.channel_id;
    } else if ('event' in body && body.event?.channel) {
      channelId = body.event.channel;
    } else if ('channel' in body && body.channel?.id) {
      channelId = body.channel.id;
    }
    console.log("Channel:", channelId)

    console.log("========================")
    return next()
  })

  // Middleware to handle users with strict security validation
  bot.use(async ({ body, context, client, next }) => {
    console.log("\n=== MIDDLEWARE START ===")
    console.log("Body type:", body.type)

    // Extract user ID from different event types
    let slackId = null;

    // Handle message events
    if ('event' in body && body.event && body.event.user) {
      slackId = body.event.user;
      console.log("Event type:", body.event.type || "unknown event type")
      console.log("Event user:", body.event.user)
      console.log("Event channel:", body.event.channel)
    }
    // Handle interactive actions (buttons, etc.)
    else if (body.user && body.user.id) {
      slackId = body.user.id;
      console.log("Action user:", body.user.id)
    }
    // Handle direct messages to the app
    else if ('message' in body && body.message && body.message.user) {
      slackId = body.message.user;
      console.log("Message user:", body.message.user)
    }

    // If we can't identify a user, block the request
    if (!slackId) {
      console.log("❌ No user ID found in request, BLOCKING")
      console.log("=== MIDDLEWARE END (NO USER ID) ===\n")
      return // Block by not calling next()
    }

    console.log(`🔍 Processing Slack user: ${slackId}`)

    console.log("  📞 Fetching Slack user info to get email...")
    const slackUserInfo = await client.users.info({ user: slackId })
    console.log("  📋 Slack API response:", slackUserInfo.ok ? "Success" : "Failed")

    if (!slackUserInfo.ok || !slackUserInfo.user) {
      console.log("  ❌ Failed to get Slack user info - BLOCKING")
      console.log("=== MIDDLEWARE END (FAILED TO GET USER INFO) ===\n")
      return // Block by not calling next()
    }

    const slackUser = slackUserInfo.user

    const userName = slackUser.real_name || slackUser.name || "SlackUser"
    const cleanName = userName.replace(/\s+/g, '').toLowerCase()
    const fallbackEmail = `${cleanName}.${slackId}@localstack`

    let finalEmail = slackUser.profile?.email ||
      fallbackEmail

    console.log("  📧 Email resolution:")
    console.log("    - Final email:", finalEmail)
    console.log("    - Is using fallback?", finalEmail === fallbackEmail)

    // Check if user exists in the database by slack_email
    let user = await getUserByEmail(finalEmail)
    console.log("📊 Database lookup result:", user ? `Found user: ${user.name}` : "User not found")

    // Security check: If user is not found in the database, completely block the message
    if (!user) {
      console.log("🔒 SECURITY: User not found in database - BLOCKING MESSAGE")
      console.log(`🚫 Blocked access for user: ${slackId} with email: ${finalEmail}`)

      // Set null user in context to indicate unauthorized
      context.user = null
      console.log("=== MIDDLEWARE END (UNAUTHORIZED) ===\n")
      const channelId = isSlashCommand(body) ? body.channel_id :
        ('event' in body && body.event && 'channel' in body.event ? body.event.channel :
          ('user' in body && body.user) ? body.user.id :
            (isBlockAction(body) && body.channel?.id) ? body.channel.id : undefined);

      await client.chat.postMessage({
        channel: channelId || "",
        text: "You're not registered yet. Please send me a message first to get started!",
        thread_ts: getThreadTimestamp(null, body)
      })

      // Return without calling next() to completely block the request
      return
    }

    // We found the user, but we don't update the slack_email field
    // Just log that we found the user and continue
    if (user) {
      console.log("✅ User found in database, proceeding with authentication")

      // // If we have an organization context, verify the user belongs to this organization
      // if (orgId && user.organization_id !== orgId) {
      //   console.log(`🔒 SECURITY: User ${slackId} (${user.name}) belongs to organization ${user.organization_id} but tried to access organization ${orgId} - BLOCKING REQUEST`)
      //   console.log(`🚫 Blocked cross-organization access for user: ${slackId}`)

      //   // Return without calling next() to block the request
      //   return
      // }
    }

    console.log("📤 Setting context.user:", user ? `${user.name} (${user.email})` : "null")
    context.user = user
    console.log("=== MIDDLEWARE END ===\n")

    return next()
  })

  // Handle all messages through the AI agent
  bot.message(async ({ message, say, context, client, body }) => {
    try {
      console.log("\n=== MESSAGE HANDLER START ===")
      console.log("Message type:", message.subtype || "regular")

      // Get user ID safely with type checking
      const userId = 'user' in message ? message.user : "unknown"
      console.log("From user:", userId)

      // Get message text safely with type checking
      let messageText = ""
      if ('text' in message && typeof message.text === 'string') {
        messageText = message.text
        console.log("Message text:", messageText.substring(0, 50) + (messageText.length > 50 ? "..." : ""))
      }

      if (message.subtype === 'bot_message' || messageText.startsWith("/")) {
        console.log("⏭️  Skipping bot message or command")
        return
      }

      const user = context.user
      console.log("Context user:", user ? `${user.name} (${user.id})` : "null")      // Security check: Only process messages from authenticated users
      if (!user) {
        console.log("🔒 SECURITY: No authenticated user in context - BLOCKING MESSAGE")
        console.log(`🚫 Blocked message from user: ${userId}`)

        // Return without sending any response to completely block the request
        return
      }      // Always process through the AI agent
      const text = 'text' in message ? message.text || "" : ""
      const threadTs = getThreadTimestamp(message, body)

      // Check if user is in reminder session and this is a custom message
      const reminderSession = reminderSessions[user.id];
      if (reminderSession && reminderSession.step === 'reminder_custom_message') {
        console.log("📝 Processing custom reminder message from user:", user.name);
        const customMessage = messageText.trim();
        
        // Check if this is a cancellation request
        if (customMessage.toLowerCase() === "cancel") {
          await handleReminderCancellation(client, user, message.channel, reminderSession.messageTs || "", threadTs);
          return; // Don't process through AI agent
        }
        
        if (customMessage) {
          console.log(`📝 Custom reminder content: "${customMessage.substring(0, 50)}${customMessage.length > 50 ? '...' : ''}"`);
          await handleCustomReminderMessage(client, user, customMessage, message.channel, threadTs);
          return; // Don't process through AI agent
        }
      }// Special commands for debugging - bypass AI agent
      if (text.toLowerCase().includes('debug projects') || text.toLowerCase().includes('debug teams')) {
        console.log("🔧 Debug command requested");
        
        const teams = await getAvailableTeams(user.organization_id)
        const projects = await getAvailableProjects(user.organization_id)
        const teamOptions = await createTeamOptions(false, user.organization_id);
        const projectOptions = await createProjectOptions(false, user.organization_id);

        let debugMessage = `*Debug Information:*\n\n`
        debugMessage += `Teams in Database: ${teams.length}\n`
        teams.forEach((team, index) => {
          debugMessage += `  ${index + 1}. ${team.name}${team.team_lead ? ` (Lead: ${team.team_lead})` : ''}\n`
        })

        debugMessage += `\nProjects in Database: ${projects.length}\n`
        projects.forEach((project, index) => {
          debugMessage += `  ${index + 1}. ${project.name}`
          if (project.team_id) {
            const team = teams.find(t => t.id === project.team_id)
            debugMessage += ` (Team: ${team?.name || 'Unknown'})`
          }
          debugMessage += `\n`
        })

        debugMessage += `\nTeam Options for Dropdown: ${teamOptions.length}\n`
        teamOptions.forEach((option, index) => {
          debugMessage += `  ${index + 1}. ${option.text.text}\n`
        })

        debugMessage += `\nProject Options for Dropdown: ${projectOptions.length}\n`
        projectOptions.forEach((option, index) => {
          debugMessage += `  ${index + 1}. ${option.text.text}\n`
        })

        await sendMessage(say, client, message.channel, debugMessage, {}, threadTs)
        return
      }

      console.log("💭 Processing message with AI agent...")

      // Add user context to the AI agent request
      const contextualMessage = `${text}\n\nContext: My name is ${user.name} and my email is ${user.email}. ${user.organization_id ? `My organization ID is ${user.organization_id}.` : ''}`

      // Use organization-specific agent if available, otherwise use default agent
      const agentToUse:Agent = user.organization_id && orgAgents[user.organization_id]
        ? orgAgents[user.organization_id]
        : agent;

      console.log(`Using ${user.organization_id && orgAgents[user.organization_id] ? 'organization-specific' : 'default'} agent for user ${user.name}`);

      const response = await agentToUse.generate([
        {
          role: "user",
          content: contextualMessage,
        },
        
      ])

      console.log("🤖 AI Agent response:", response.text?.substring(0, 100) + "...")
      console.log("🛠️ Tool calls:", response.toolCalls?.length || 0)
      
      // Store token usage data in the database
      if (response.usage) {
        const tokenUsageData: TokenUsageData = {
          user_id: user.id,
          platform_type: 'slack',
          prompt_tokens: response.usage.promptTokens || 0,
          completion_tokens: response.usage.completionTokens || 0,
          total_tokens: response.usage.totalTokens || 0,
          finish_reason: response.finishReason,
          model: response.providerMetadata?.openai?.model ? String(response.providerMetadata.openai.model) : undefined,
          organization_id: user.organization_id
        };
        
        storeTokenUsage(supabase, tokenUsageData)
          .then(success => {
            if (success) {
              console.log(`✅ Token usage data stored for user ${user.id} on slack`);
            }
          })
          .catch(error => {
            console.error("Error storing token usage data:", error);
          });
      }

      // Process the AI response and handle UI interactions
      await processAIResponse(response, user, client, say, message.channel, threadTs)
    } catch (error) {
      console.error("❌ Unexpected error in message handler:", error)
      try {
        // Get thread timestamp again in case it wasn't defined in the outer scope
        const errorThreadTs = getThreadTimestamp(message, body)
        await sendMessage(say, client, message.channel, "Sorry, I encountered an error. Please try again.", {}, errorThreadTs)
      } catch (innerError) {
        console.error("❌ Failed to send error message:", innerError)
      }
    }

    console.log("=== MESSAGE HANDLER END ===\n")
  })
  // Handle task name input and proceed to project selection
  bot.action("task_name_next", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;

    const allValues = blockAction.state?.values;
    console.log("All state values for task name:", JSON.stringify(allValues, null, 2));

    let taskName: string | undefined;
    for (const [sectionId, section] of Object.entries(allValues || {})) {
      if ((section as any).task_name_input?.value) {
        taskName = (section as any).task_name_input.value;
        break;
      }
    }

    if (!taskName || taskName.trim() === '') {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Please provide a task name.",
        thread_ts: getThreadTimestamp(null, body)
      })
      return
    }

    console.log("Task name extracted:", taskName)

    // Get user from Slack ID for button interactions
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return;
    
    // Check if user is team lead or admin (will affect available options)
    const userIsTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = userIsTeamLead || isAdmin;
    console.log(`User ${user.name} permissions - Team Lead: ${userIsTeamLead}, Admin: ${isAdmin}`);

    // Now show project selection with the task name
    console.log("🔍 Fetching project options...")
    const projectOptions = await createProjectOptions(isTeamLeadOrAdmin, user.organization_id)
    console.log(`✅ Got ${projectOptions.length} project options:`)
    projectOptions.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.text.text} (${option.value})`)
    })

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Task to create:* ${taskName}\n\nGreat! Now please select a project for this task:`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose a project:"
        },
        accessory: {
          type: "static_select",
          action_id: "select_project_for_task",
          placeholder: {
            type: "plain_text",
            text: "Select a project...",
            emoji: true
          },
          options: projectOptions
        }
      }
    ]

    // Access message properties directly without type assertion
    const messageTs = blockAction.message?.ts || ""

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          task_title: taskName,
          user_id: user.id,
          organization_id: user.organization_id ?? "", // Include organization_id
          is_team_lead: userIsTeamLead,
          action: "select_project"
        }
      }
    })
  })
  // Handle project selection for task creation
  bot.action("select_project_for_task", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;
    const action = blockAction.actions[0];

    // Check if action has selected_option property
    const selectedProjectId = 'selected_option' in action ? action.selected_option?.value : undefined;

    if (!selectedProjectId) return;

    // Get user from Slack ID for button interactions
    const user = await getUserFromSlackId(blockAction.user.id, client);

    // Security check: Only allow registered users to create tasks
    if (!user) {
      console.log("🔒 SECURITY: Unauthorized user attempted to select a project for task creation");
      console.log(`🚫 Blocked access for user: ${blockAction.user.id}`);
      return;
    }
    
    const taskTitle = blockAction.message?.metadata?.event_payload?.task_title || "New Task";
    const threadTs = getThreadTimestamp(null, body);
    
    // Check if user is team lead or admin
    const userIsTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = userIsTeamLead || isAdmin;    // Check if user is trying to create a new project but isn't a team lead or admin
    if (selectedProjectId === "new_project" && !isTeamLeadOrAdmin) {
      console.log("🔒 SECURITY: User without proper permissions attempted to create a project");
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, only team leads and admins can create new projects. Please select an existing project.",
        thread_ts: threadTs
      });
      return;
    }

    if (selectedProjectId === "new_project" && isTeamLeadOrAdmin) {
      console.log("🆕 Team lead selected to create new project");      // Show form for creating new project with all details
      const userOptions = await getAvailableUsers(user.id, true);

      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Task:* ${taskTitle}\n\nCreating new project. Please provide project details:`
          }
        },
        {
          type: "input",
          block_id: "project_name_block", // Add block_id
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "e.g., Website Redesign"
            },
            action_id: "new_project_name_input"
          },
          label: {
            type: "plain_text",
            text: "Project Name"
          }
        },
        {
          type: "input",
          block_id: "project_deadline_block", // Add block_id
          element: {
            type: "datepicker",
            placeholder: {
              type: "plain_text",
              text: "Select project deadline"
            },
            action_id: "new_project_deadline"
          },
          label: {
            type: "plain_text",
            text: "Project Deadline"
          }
        },
        {
          type: "section",
          block_id: "project_lead_block", // Add block_id
          text: {
            type: "mrkdwn",
            text: "Select Project Lead:"
          },
          accessory: {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "Select project lead..."
            },
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "No Project Lead"
                },
                value: "none"
              },
              ...userOptions
            ],
            action_id: "new_project_lead_select"
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Next: Select Team"
              },
              action_id: "new_project_team_selection",
              style: "primary"
            }
          ]
        }
      ]      // Safely access message properties without type assertion
      const messageTs = blockAction.message?.ts || "";

      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: messageTs,
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            user_id: user.id,
            organization_id: user.organization_id || "", // Include organization_id
            is_team_lead: userIsTeamLead,
            action: "create_new_project_details"
          }
        }
      });
    } else {
      console.log(`🏢 User selected existing project: ${selectedProjectId}`);
      // Existing project selected - show team selection first
      const { data: project } = await supabase
        .from("projects")
        .select(`
          name,
          team_id,
          organization_id,
          teams (
            name
          )
        `)
        .eq("id", selectedProjectId)
        .single();      // Get team options, restricted based on user role and organization
      const teamOptions = await createTeamOptions(isTeamLeadOrAdmin, user.organization_id);

      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Task:* ${taskTitle}\n*Project:* ${project?.name || 'Unknown'}\n*Current Team:* ${project?.teams?.[0]?.name || 'No Team'}\n\nYou can change the team for this task or keep the project's team:`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Select team for this task:"
          },
          accessory: {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "Select team...",
              emoji: true
            },
            options: teamOptions,
            action_id: "select_team_for_existing_project"
          }
        }
      ];

      // Access message properties safely without type assertion
      const messageTs = blockAction.message?.ts || "";

      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: messageTs,
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: selectedProjectId,
            project_name: project?.name || 'Unknown',
            organization_id: user.organization_id || project?.organization_id, // Include organization_id
            original_team_id: project?.team_id,
            original_team_name: project?.teams?.[0]?.name || 'No Team',
            user_id: user.id,
            is_team_lead: userIsTeamLead,
            action: "select_team_for_existing_project"
          }
        }
      });
    }
  });

  // One-tap form submission for team selection
  bot.action("select_team_for_existing_project", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;
    const action = blockAction.actions[0];

    // Check if action has selected_option property
    const selectedTeamId = 'selected_option' in action ? action.selected_option?.value : undefined;

    if (!selectedTeamId) return;

    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) {
      console.log("🔒 SECURITY: Unauthorized user attempted to select a team");
      return;
    }

    const metadata = blockAction.message?.metadata?.event_payload;
    const taskTitle = metadata?.task_title || "New Task";
    const projectId = metadata?.project_id || "new_project";
    const threadTs = getThreadTimestamp(null, body);
    
    // Check if user is team lead or admin
    const userIsTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = userIsTeamLead || isAdmin;    // Check if user is trying to create a new project but isn't a team lead or admin
    if (selectedTeamId === "new_team" && !isTeamLeadOrAdmin) {
      console.log("🔒 SECURITY: User without proper permissions attempted to create a team");
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, only team leads and admins can create new teams. Please select an existing team.",
        thread_ts: threadTs
      });
      return;
    }    if (selectedTeamId === "new_team") {
      if (!isTeamLeadOrAdmin) {
        console.log("🔒 SECURITY: User without proper permissions attempted to create a team");
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Sorry, only team leads and admins can create new teams. Please select an existing team.",
          thread_ts: threadTs
        });
        return;
      }

      console.log("🆕 Team lead selected to create new team");      // Show form for creating new team with all details
      const userOptions = await getAvailableUsers(user.id, true)

      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Task:* ${taskTitle}\n\nCreating new team. Please provide team details:`
          }
        },
        {
          type: "input",
          element: {
            type: "plain_text_input",
            placeholder: {
              type: "plain_text",
              text: "e.g., Marketing Team"
            },
            action_id: "new_team_name_input"
          },
          label: {
            type: "plain_text",
            text: "Team Name"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Select Team Lead (optional):"
          },
          accessory: {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "Select team lead...",
              emoji: true
            },
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "No Team Lead",
                  emoji: true
                },
                value: "none"
              },
              ...userOptions
            ],
            action_id: "new_team_lead_select"
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Create Team & Continue",
                emoji: true
              },
              action_id: "create_team_for_existing_project",
              style: "primary"
            }
          ]
        }
      ]

      // Access message properties directly without type assertion
      const messageTs = blockAction.message?.ts || ""

      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: messageTs,
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            ...metadata,
            organization_id: metadata?.organization_id || user.organization_id,
            action: "create_new_team_for_existing_project"
          }
        }
      })
    } else {
      // Handle existing team selection
      console.log(`🏢 User selected existing team: ${selectedTeamId}`);
      
      // Get team name for display
      let teamName = "No Team";
      if (selectedTeamId !== "no_team") {
        const { data: team } = await supabase
          .from("teams")
          .select("name")
          .eq("id", selectedTeamId)
          .single();

        if (team) {
          teamName = team.name;
        }
      }

      // Check if user is team lead or admin for assignee options
      const userOptions = await getAvailableUsers(user.id, isTeamLeadOrAdmin);

      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Task:* ${taskTitle}\n*Project:* ${metadata?.project_name || 'Unknown'}\n*Team:* ${teamName}\n\nPlease provide task details and click Create when ready:`
          }
        },
        {
          type: "input",
          block_id: "description_block",
          element: {
            type: "plain_text_input",
            action_id: "task_description_input",
            placeholder: {
              type: "plain_text",
              text: "Describe the task"
            }
          },
          label: {
            type: "plain_text",
            text: "Description (optional)"
          },
          optional: true
        },
        {
          type: "input",
          block_id: "deadline_block",
          element: {
            type: "datepicker",
            action_id: "task_deadline_date",
            placeholder: {
              type: "plain_text",
              text: "Select deadline"
            },
            initial_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          },
          label: {
            type: "plain_text",
            text: "Deadline (Required)"
          }
        },
        {
          type: "section",
          block_id: "priority_block",
          text: {
            type: "mrkdwn",
            text: "*Priority:*"
          },          accessory: {
            type: "static_select",
            action_id: "task_priority_select",
            placeholder: {
              type: "plain_text",
              text: "Select priority",
              emoji: true
            },
            options: createPriorityOptions()
          }        }
      ];      // Add assignee selection section for team leads and admins
      if (isTeamLeadOrAdmin) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Assignee:*"
          }
        });

        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👤 Assign to myself",
                emoji: true
              },
              action_id: "assign_to_self"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👥 Enable Multi-Assignee",
                emoji: true
              },
              action_id: "enable_multi_assignee",
              style: "primary"
            }
          ]
        });
      } else {
        // For regular users, show that the task will be assigned to them
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Assigned to:* ${user.name} (you)`
          }
        });
      }

      // Add Create Task button
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Create Task",
              emoji: true
            },
            action_id: "create_task_final",
            style: "primary"
          }
        ]
      });

      // Update the message with task creation form
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: blockAction.message?.ts || "",
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: metadata?.project_id,
            project_name: metadata?.project_name,
            team_id: selectedTeamId !== "no_team" ? selectedTeamId : "",
            team_name: teamName,
            organization_id: user.organization_id || "",
            user_id: user.id,
            is_team_lead: userIsTeamLead,
            action: "collect_task_details"
          }
        }
      });
    }
  });
  // Handle new project team selection - show team selection form
  bot.action("new_project_team_selection", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;

    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;

    const metadata = blockAction.message?.metadata?.event_payload;
    const taskTitle = metadata?.task_title || "New Task";
    
    // Extract project details from form
    const stateValues = blockAction.state?.values || {};
    let projectName = "";
    let projectDeadline = "";
    let projectLeadId = "";

    // Extract project name
    for (const sectionId in stateValues) {
      if (stateValues[sectionId].new_project_name_input?.value) {
        projectName = stateValues[sectionId].new_project_name_input.value;
        break;
      }
    }

    // Extract project deadline
    for (const sectionId in stateValues) {
      if (stateValues[sectionId].new_project_deadline?.selected_date) {
        projectDeadline = stateValues[sectionId].new_project_deadline.selected_date;
        break;
      }
    }

    // Extract project lead
    for (const sectionId in stateValues) {
      if (stateValues[sectionId].new_project_lead_select?.selected_option?.value) {
        projectLeadId = stateValues[sectionId].new_project_lead_select.selected_option.value;
        break;
      }
    }

    if (!projectName || projectName.trim() === '') {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Please provide a project name."
      });
      return;
    }

    // Check if user is team lead or admin
    const userIsTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = userIsTeamLead || isAdmin;

    // Get team options, restricted based on user role and organization
    const teamOptions = await createTeamOptions(isTeamLeadOrAdmin, user.organization_id);

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Task:* ${taskTitle}\n*Project:* ${projectName}${projectDeadline ? `\n*Deadline:* ${projectDeadline}` : ""}\n\nNow select a team for this project:`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose a team:"
        },
        accessory: {
          type: "static_select",
          placeholder: {
            type: "plain_text",
            text: "Select team",
            emoji: true
          },
          options: teamOptions,
          action_id: "new_project_final_team_selection"
        }
      }
    ];

    // Safely access message properties
    const messageTs = blockAction.message?.ts || "";

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_name: projectName,
            project_deadline: projectDeadline,
            project_lead_id: projectLeadId,
            user_id: user.id,
            organization_id: user.organization_id || "",
            action: "select_team_for_new_project"
          }
        }
    });
  });

  // Handle final team selection for new project creation
  bot.action("new_project_final_team_selection", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;
    const action = blockAction.actions[0];

    // Check if action has selected_option property
    const selectedTeamId = 'selected_option' in action ? action.selected_option?.value : undefined;

    if (!selectedTeamId) return;

    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;

    const metadata = blockAction.message?.metadata?.event_payload;
    const taskTitle = metadata?.task_title || "New Task";
    const projectName = metadata?.project_name || "";
    const projectDeadline = metadata?.project_deadline || "";
    const projectLeadId = metadata?.project_lead_id || "";

    if (!projectName || projectName.trim() === '') {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Project name is missing. Please start over."
      });
      return;
    }    try {
      // Debug environment variables and database connection
      console.log("🔧 Environment check:");
      console.log("- Supabase URL exists:", !!process.env.NEXT_PUBLIC_SUPABASE_URL);
      console.log("- Service key exists:", !!process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY);
      console.log("- User organization ID:", user.organization_id);
      console.log("- User details:", { id: user.id, email: user.email, name: user.name });

      console.log("🔄 Creating new project with data:");
      const projectData = {
        name: projectName,
        description: `Project created via Slack bot for task: ${taskTitle}`,
        deadline: projectDeadline ? new Date(projectDeadline).toISOString() : null,
        project_lead: projectLeadId !== "none" ? projectLeadId : null,
        team_id: selectedTeamId !== "no_team" ? selectedTeamId : null,
        organization_id: user.organization_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      console.log("Project data:", JSON.stringify(projectData, null, 2));

      // Test database connection first
      console.log("🔗 Testing database connection...");
      const { data: connectionTest, error: connectionError } = await supabase
        .from("projects")
        .select("count")
        .limit(1);

      console.log("Connection test result:", { data: connectionTest, error: connectionError });      if (connectionError) {
        console.error("❌ Database connection failed:", connectionError);
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: `Database connection error: ${connectionError.message}`
        });
        return;
      }

      // Check projects table schema
      console.log("📋 Checking projects table schema...");
      const { data: schemaCheck, error: schemaError } = await supabase
        .from("projects")
        .select("*")
        .limit(1);      console.log("Schema check result:", { 
        data: schemaCheck, 
        error: schemaError,
        columns: schemaCheck?.[0] ? Object.keys(schemaCheck[0]) : 'No existing projects'
      });

      // Validate required fields
      console.log("✅ Validating project data:");
      console.log("- Project name valid:", !!projectName && projectName.trim().length > 0);
      console.log("- Organization ID valid:", !!user.organization_id);
      console.log("- User ID valid:", !!user.id);

      if (!projectName || projectName.trim().length === 0) {
        console.error("❌ Project name is empty or invalid");
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Error: Project name cannot be empty"
        });
        return;
      }      if (!user.organization_id) {
        console.error("❌ User organization ID is missing");
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Error: User organization ID is missing. Please contact an administrator."
        });
        return;
      }

      // Check for existing projects with the same name
      console.log("🔍 Checking for duplicate project names...");
      const { data: existingProjects, error: duplicateError } = await supabase
        .from("projects")
        .select("id, name")
        .eq("organization_id", user.organization_id)
        .ilike("name", projectName);

      console.log("Duplicate check results:", { 
        data: existingProjects, 
        error: duplicateError,
        count: existingProjects?.length || 0
      });

      if (existingProjects && existingProjects.length > 0) {
        console.log("⚠️ Project with similar name already exists");
        // Continue anyway but log this for debugging
      }

      // Create the new project
      const { data: newProject, error: projectError } = await supabase
        .from("projects")
        .insert(projectData)
        .select()
        .single();

      console.log("📊 Database response:");
      console.log("- Data:", JSON.stringify(newProject, null, 2));
      console.log("- Error:", JSON.stringify(projectError, null, 2));

      if (projectError) {
        console.error("❌ Error creating project:", projectError);
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: `Error creating project: ${projectError.message}`
        });
        return;
      }

      if (!newProject) {
        console.error("❌ No project data returned from database");
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Error: No project data returned from database. Please check the database connection."
        });
        return;
      }

      console.log(`✅ Project created successfully: ${newProject.id} - ${newProject.name}`);
      
      // Verify the project was actually saved by checking the database
      const { data: verifyProject, error: verifyError } = await supabase
        .from("projects")
        .select("*")
        .eq("id", newProject.id)
        .single();

      console.log("🔍 Verification check:");
      console.log("- Verify data:", JSON.stringify(verifyProject, null, 2));
      console.log("- Verify error:", JSON.stringify(verifyError, null, 2));      if (verifyError || !verifyProject) {
        console.error("❌ Project verification failed - project may not have been saved properly");
        
        // Try a broader search to see if project exists with similar name
        console.log("🔍 Attempting broader project search...");
        const { data: allProjects, error: searchError } = await supabase
          .from("projects")
          .select("*")
          .eq("organization_id", user.organization_id)
          .ilike("name", `%${projectName}%`);

        console.log("Broader search results:", { 
          data: allProjects, 
          error: searchError,
          count: allProjects?.length || 0
        });

        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Warning: Project creation may have failed. Please check if the project was created in the database."
        });
      } else {        console.log("✅ Project verification successful - project exists in database");
      }

      // Final comprehensive check - list all projects for this organization
      console.log("📊 Final check - listing all projects for organization:");
      const { data: allOrgProjects, error: listError } = await supabase
        .from("projects")
        .select("id, name, created_at")
        .eq("organization_id", user.organization_id)
        .order("created_at", { ascending: false })
        .limit(10);

      console.log("All organization projects:", { 
        data: allOrgProjects, 
        error: listError,
        count: allOrgProjects?.length || 0
      });

      // Get team name if team was selected
      let teamName = "No Team";
      if (selectedTeamId !== "no_team") {
        const { data: team } = await supabase
          .from("teams")
          .select("name")
          .eq("id", selectedTeamId)
          .single();

        if (team) {
          teamName = team.name;
        }
      }      // Continue with task creation - show assignee selection
      const userIsTeamLead = await isTeamLead(user.id);
      const isAdmin = await isUserAdmin(user.id);
      const isTeamLeadOrAdmin = userIsTeamLead || isAdmin;

      // Get user options based on permission level
      const userOptions = await getAvailableUsers(user.id, isTeamLeadOrAdmin);

      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Project "${projectName}" created successfully!*\n\n*Task:* ${taskTitle}\n*Project:* ${projectName}\n*Team:* ${teamName}\n\nPlease provide task details and click Create when ready:`
          }
        },
        {
          type: "input",
          block_id: "description_block",
          element: {
            type: "plain_text_input",
            action_id: "task_description_input",
            placeholder: {
              type: "plain_text",
              text: "Describe the task"
            }
          },
          label: {
            type: "plain_text",
            text: "Description (optional)"
          },
          optional: true
        },
        {
          type: "input",
          block_id: "deadline_block",
          element: {
            type: "datepicker",
            action_id: "task_deadline_date",
            placeholder: {
              type: "plain_text",
              text: "Select deadline"
            },
            initial_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          },
          label: {
            type: "plain_text",
            text: "Deadline (Required)"
          }
        },
        {
          type: "section",
          block_id: "priority_block",
          text: {
            type: "mrkdwn",
            text: "*Priority:*"
          },          accessory: {
            type: "static_select",
            action_id: "task_priority_select",
            placeholder: {
              type: "plain_text",
              text: "Select priority",
              emoji: true
            },
            options: createPriorityOptions()
          }
        }
      ];

      // Add assignee selection section for team leads and admins
      if (isTeamLeadOrAdmin) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Assignee:*"
          }
        });

        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👤 Assign to myself",
                emoji: true
              },
              action_id: "assign_to_self"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👥 Enable Multi-Assignee",
                emoji: true
              },
              action_id: "enable_multi_assignee",
              style: "primary"
            }
          ]
        });
      } else {
        // For regular users, show that the task will be assigned to them
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Assigned to:* ${user.name} (you)`
          }
        });
      }

      // Add Create Task button
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Create Task",
              emoji: true
            },
            action_id: "create_task_final",
            style: "primary"
          }
        ]
      });

      // Update the message with the new project creation success and task form
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: blockAction.message?.ts || "",
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: newProject.id,
            project_name: newProject.name,
            team_id: selectedTeamId !== "no_team" ? selectedTeamId : "",
            team_name: teamName || "",
            organization_id: user.organization_id || "",
            user_id: user.id,
            is_team_lead: userIsTeamLead,
            action: "collect_task_details"
          }
        }
      });

    } catch (error) {
      console.error("❌ Unexpected error creating project:", error);
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, something went wrong while creating the project. Please try again."
      });
    }  });

  // Handle team creation for existing project
  bot.action("create_team_for_existing_project", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;

    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;

    const metadata = blockAction.message?.metadata?.event_payload;
    const taskTitle = metadata?.task_title || "New Task";
    const threadTs = getThreadTimestamp(null, body);

    // Check if user is team lead or admin
    const userIsTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = userIsTeamLead || isAdmin;

    if (!isTeamLeadOrAdmin) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, only team leads and admins can create new teams.",
        thread_ts: threadTs
      });
      return;
    }

    // Extract team details from form
    const stateValues = blockAction.state?.values || {};
    let teamName = "";
    let teamLeadId = "";

    // Extract team name
    for (const sectionId in stateValues) {
      if (stateValues[sectionId].new_team_name_input?.value) {
        teamName = stateValues[sectionId].new_team_name_input.value;
        break;
      }
    }

    // Extract team lead
    for (const sectionId in stateValues) {
      if (stateValues[sectionId].new_team_lead_select?.selected_option?.value) {
        teamLeadId = stateValues[sectionId].new_team_lead_select.selected_option.value;
        break;
      }
    }

    if (!teamName || teamName.trim() === '') {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Please provide a team name."
      });
      return;
    }

    try {
      console.log("🔄 Creating new team with data:");
      const teamData = {
        name: teamName,
        description: `Team created via Slack bot for task: ${taskTitle}`,
        organization_id: user.organization_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      console.log("Team data:", JSON.stringify(teamData, null, 2));

      // Create the new team
      const { data: newTeam, error: teamError } = await supabase
        .from("teams")
        .insert(teamData)
        .select()
        .single();

      if (teamError) {
        console.error("❌ Error creating team:", teamError);
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: `Error creating team: ${teamError.message}`
        });
        return;
      }

      if (!newTeam) {
        console.error("❌ No team data returned from database");
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Error: No team data returned from database."
        });
        return;
      }

      console.log(`✅ Team created successfully: ${newTeam.id} - ${newTeam.name}`);

      // Add team lead if specified
      if (teamLeadId && teamLeadId !== "none") {
        const { error: memberError } = await supabase
          .from("team_members")
          .insert({
            team_id: newTeam.id,
            user_id: teamLeadId,
            role: "team_lead",
            organization_id: user.organization_id,
            created_at: new Date().toISOString()
          });

        if (memberError) {
          console.error("❌ Error adding team lead:", memberError);
          // Continue anyway, team was created successfully
        } else {
          console.log("✅ Team lead added successfully");
        }
      }

      // Get user options for task assignee
      const userOptions = await getAvailableUsers(user.id, isTeamLeadOrAdmin);

      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Team "${teamName}" created successfully!*\n\n*Task:* ${taskTitle}\n*Project:* ${metadata?.project_name || 'Unknown'}\n*Team:* ${teamName}\n\nPlease provide task details and click Create when ready:`
          }
        },
        {
          type: "input",
          block_id: "description_block",
          element: {
            type: "plain_text_input",
            action_id: "task_description_input",
            placeholder: {
              type: "plain_text",
              text: "Describe the task"
            }
          },
          label: {
            type: "plain_text",
            text: "Description (optional)"
          },
          optional: true
        },
        {
          type: "input",
          block_id: "deadline_block",
          element: {
            type: "datepicker",
            action_id: "task_deadline_date",
            placeholder: {
              type: "plain_text",
              text: "Select deadline"
            },
            initial_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          },
          label: {
            type: "plain_text",
            text: "Deadline (Required)"
          }
        },
        {
          type: "section",
          block_id: "priority_block",
          text: {
            type: "mrkdwn",
            text: "*Priority:*"
          },          accessory: {
            type: "static_select",
            action_id: "task_priority_select",
            placeholder: {
              type: "plain_text",
              text: "Select priority",
              emoji: true
            },
            options: createPriorityOptions()
          }
        }
      ];      // Add assignee selection section for team leads and admins
      if (isTeamLeadOrAdmin) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Assignee:*"
          }
        });

        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👤 Assign to myself",
                emoji: true
              },
              action_id: "assign_to_self"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👥 Enable Multi-Assignee",
                emoji: true
              },
              action_id: "enable_multi_assignee",
              style: "primary"
            }
          ]
        });
      } else {
        // For regular users, show that the task will be assigned to them
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Assigned to:* ${user.name} (you)`
          }
        });
      }

      // Add Create Task button
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Create Task",
              emoji: true
            },
            action_id: "create_task_final",
            style: "primary"
          }
        ]
      });

      // Update the message with team creation success and task form
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: blockAction.message?.ts || "",
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: metadata?.project_id,
            project_name: metadata?.project_name,
            team_id: newTeam.id,
            team_name: newTeam.name,
            organization_id: user.organization_id || "",
            user_id: user.id,
            is_team_lead: userIsTeamLead,
            action: "collect_task_details"
          }
        }
      });

    } catch (error) {
      console.error("❌ Unexpected error creating team:", error);
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, something went wrong while creating the team. Please try again."
      });
    }
  });

  // Handle task selection from dropdown
  bot.action("select_task_to_update", async ({ body, ack, client, context }) => {
    await ack()

    console.log("\n=== TASK SELECTION HANDLER ===")

    if (!isBlockAction(body)) return

    const blockAction = body
    // Safely access selected_option by checking if it exists on the action
    const action = blockAction.actions[0];
    const selectedOption = 'selected_option' in action ? action.selected_option?.value : undefined;
    console.log("Selected task ID:", selectedOption)

    const taskId = selectedOption

    if (!taskId) return

    // Get user from Slack ID for button interactions
    const user = await getUserFromSlackId(blockAction.user.id, client)

    // Security check: Only allow registered users to update tasks
    if (!user) {
      console.log("🔒 SECURITY: Unauthorized user attempted to select a task for update")
      console.log(`🚫 Blocked access for user: ${blockAction.user.id}`)
      return
    }    // Get the selected task details
    const { data: task, error } = await supabase
      .from("tasks")
      .select("*")      .eq("id", taskId)
      .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly check if user ID is in JSONB array
      .single()

    if (error || !task) {
      console.error("❌ Error fetching task:", error)
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, I couldn't find that task.",
        thread_ts: getThreadTimestamp(null, body)
      })
      return
    }

    // Create status selection menu with dynamic options and one-tap selection
    const statusOptions = await createStatusOptions(task.status)

    if (statusOptions.length === 0) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: `The task "${task.title}" already has all possible statuses. No update needed.`,
        thread_ts: getThreadTimestamp(null, body)
      })
      return
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Selected Task:* ${task.title}\n*Current Status:* ${task.status}`
        }
      },
      {
        type: "section",
        block_id: "status_block",
        text: {
          type: "mrkdwn",
          text: "*Choose the new status:*"
        },
        accessory: {
          type: "radio_buttons",
          action_id: "status_selection",
          options: statusOptions
        }
      },
      {
        type: "actions" as const,
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Update Status",
              emoji: true
            },
            action_id: "update_task_status",
            style: "primary" as const,
            value: JSON.stringify({
              task_id: taskId,
              task_title: task.title
            })
          }
        ]
      }
    ]

    // Update the original message
    if (!('channel' in blockAction) || !blockAction.channel || !blockAction.channel.id) {
      console.error("Channel ID is missing from the Slack interaction payload.");
      return
    }

    // Safely access the message timestamp without type assertion
    const messageTs = blockAction.message?.ts || ""

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      // Store task ID in private metadata for the next action
      metadata: {
        event_type: "task_update",
        event_payload: {
          task_id: taskId,
          task_title: task.title,
          organization_id: user.organization_id ?? ""
        }
      }    })
  })
  // Handle task selection from dropdown for editing
  bot.action("select_task_to_edit", async ({ body, ack, client, context }) => {
    await ack()

    console.log("\n=== TASK EDIT SELECTION HANDLER ===")

    if (!isBlockAction(body)) return

    const blockAction = body
    const action = blockAction.actions[0];
    const selectedOption = 'selected_option' in action ? action.selected_option?.value : undefined;
    console.log("Selected task ID for editing:", selectedOption)

    const taskId = selectedOption

    if (!taskId) return

    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client)

    // Security check: Only allow registered users to edit tasks
    if (!user) {
      console.log("🔒 SECURITY: Unauthorized user attempted to select a task for editing")
      console.log(`🚫 Blocked access for user: ${blockAction.user.id}`)
      return
    }

    // Get the selected task details with all necessary fields
    const { data: task, error } = await supabase
      .from("tasks")
      .select(`
        *,
        projects (
          id,
          name
        )      `)      .eq("id", taskId)
      .filter('assigned_to', 'cs', `["${user.id}"]`)
      .single()

    if (error || !task) {
      console.error("❌ Error fetching task for editing:", error)
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, I couldn't find that task or you don't have permission to edit it.",
        thread_ts: getThreadTimestamp(null, body)
      })
      return
    }

    // Show the task edit form with current values
    await showTaskEditForm(blockAction, client, user, task)
  })

  // Handle task edit field actions
  // Edit task title
  bot.action("edit_task_title", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Show modal for title input
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_title_modal",
        title: {
          type: "plain_text",
          text: "Edit Task Title"
        },
        submit: {
          type: "plain_text",
          text: "Update"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({ taskId, channelId: blockAction.channel?.id, messageTs: blockAction.message?.ts }),
        blocks: [
          {
            type: "input",
            block_id: "title_block",
            element: {
              type: "plain_text_input",
              action_id: "title_input",
              placeholder: {
                type: "plain_text",
                text: "Enter new task title"
              }
            },
            label: {
              type: "plain_text",
              text: "New Title"
            }
          }
        ]
      }
    })
  })

  // Edit task description
  bot.action("edit_task_description", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Show modal for description input
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_description_modal",
        title: {
          type: "plain_text",
          text: "Edit Task Description"
        },
        submit: {
          type: "plain_text",
          text: "Update"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({ taskId, channelId: blockAction.channel?.id, messageTs: blockAction.message?.ts }),
        blocks: [
          {
            type: "input",
            block_id: "description_block", 
            element: {
              type: "plain_text_input",
              action_id: "description_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "Enter new task description"
              }
            },
            label: {
              type: "plain_text",
              text: "New Description"
            },
            optional: true
          }
        ]
      }
    })
  })

  // Edit task priority
  bot.action("edit_task_priority", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Show modal for priority selection
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_priority_modal",
        title: {
          type: "plain_text",
          text: "Edit Task Priority"
        },
        submit: {
          type: "plain_text",
          text: "Update"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({ taskId, channelId: blockAction.channel?.id, messageTs: blockAction.message?.ts }),
        blocks: [
          {
            type: "section",
            block_id: "priority_block",
            text: {
              type: "mrkdwn",
              text: "*Select new priority:*"
            },
            accessory: {
              type: "static_select",
              action_id: "priority_select",
              placeholder: {
                type: "plain_text",
                text: "Choose priority"
              },
              options: createPriorityOptions()
            }
          }
        ]
      }
    })
  })

  // Edit task deadline
  bot.action("edit_task_deadline", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Show modal for deadline input
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_deadline_modal",
        title: {
          type: "plain_text",
          text: "Edit Task Deadline"
        },
        submit: {
          type: "plain_text",
          text: "Update"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({ taskId, channelId: blockAction.channel?.id, messageTs: blockAction.message?.ts }),
        blocks: [
          {
            type: "input",
            block_id: "deadline_block",
            element: {
              type: "datepicker",
              action_id: "deadline_picker",
              placeholder: {
                type: "plain_text",
                text: "Select new deadline"
              }
            },
            label: {
              type: "plain_text",
              text: "New Deadline"
            },
            optional: true
          }
        ]
      }    })
  })

  // Edit task project
  bot.action("edit_task_project", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Get available projects for this user's organization
    const { data: projects } = await supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", user.organization_id)
      .order("name")

    const projectOptions = projects?.map(project => ({
      text: {
        type: "plain_text",
        text: project.name
      },
      value: project.id
    })) || []

    // Add "No Project" option
    projectOptions.unshift({
      text: {
        type: "plain_text",
        text: "No Project"
      },
      value: "none"
    })

    // Show modal for project selection
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_project_modal",
        title: {
          type: "plain_text",
          text: "Edit Task Project"
        },
        submit: {
          type: "plain_text",
          text: "Update"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({ taskId, channelId: blockAction.channel?.id, messageTs: blockAction.message?.ts }),
        blocks: [
          // {
          //   type: "section",
          //   block_id: "project_block",
          //   text: {
          //     type: "mrkdwn",
          //     text: "*Select new project:*"
          //   },
          //   accessory: {
          //     type: "static_select",
          //     action_id: "project_select",
          //     placeholder: {
          //       type: "plain_text",
          //       text: "Choose project"
          //     },
          //     options: projectOptions
          //   }
          // }
        ]
      }
    })
  })

  // Edit task status
  bot.action("edit_task_status", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Get current task to create status options
    const { data: task } = await supabase
      .from("tasks")
      .select("status, title")
      .eq("id", taskId)
      .single()

    if (!task) return

    const statusOptions = await createStatusOptions(task.status)

    // Show modal for status selection
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_status_modal",
        title: {
          type: "plain_text",
          text: "Edit Task Status"
        },
        submit: {
          type: "plain_text",
          text: "Update"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({ taskId, channelId: blockAction.channel?.id, messageTs: blockAction.message?.ts }),
        blocks: [
          {
            type: "section",
            block_id: "status_block",
            text: {
              type: "mrkdwn",
              text: `*Current Status:* ${task.status}\n*Select new status:*`
            },
            accessory: {
              type: "radio_buttons",
              action_id: "status_select",
              options: statusOptions
            }
          }
        ]
      }
    })
  })

  // Finish editing task
  bot.action("finish_task_edit", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body
    const action = blockAction.actions[0]
    const taskId = 'value' in action ? action.value : undefined
    
    if (!taskId) return

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Get updated task details
    const { data: task } = await supabase
      .from("tasks")
      .select(`
        *,
        projects (
          name
        )
      `)
      .eq("id", taskId)
      .single()

    if (!task) return

    // Show completion message
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Task editing completed!*\n\n*Task:* ${task.title}\n*Status:* ${task.status}\n*Priority:* ${task.priority}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Edit Another Task",
              emoji: true
            },
            action_id: "edit_another_task",
            style: "primary"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Create New Task",
              emoji: true
            },
            action_id: "create_another_task"
          }
        ]
      }
    ]

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: blockAction.message?.ts || "",
      blocks: blocks
    })
  })

  // Cancel task editing
  bot.action("cancel_task_edit", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body

    // Show cancellation message
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "❌ Task editing cancelled."
        }
      }
    ]

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: blockAction.message?.ts || "",
      blocks: blocks
    })
  })

  // Handle "Edit Another Task" button
  bot.action("edit_another_task", async ({ body, ack, client }) => {
    await ack()
    
    if (!isBlockAction(body)) return
    const blockAction = body

    // Get user
    const user = await getUserFromSlackId(blockAction.user.id, client)
    if (!user) return

    // Generate new edit form
    await generateTaskEditForm(user, client, blockAction.channel?.id || "", getThreadTimestamp(null, body))
  })

  // Handle status selection and update task status
  bot.action("update_task_status", async ({ body, ack, client }) => {
    await ack()

    console.log("\n=== STATUS UPDATE HANDLER ===")

    if (!isBlockAction(body)) return

    const blockAction = body

    // Get task info from button value
    let taskId = "";
    let taskTitle = "";

    try {
      const action = blockAction.actions[0];
      const buttonValue = 'value' in action && action.value
        ? JSON.parse(action.value)
        : {};
      taskId = buttonValue.task_id;
      taskTitle = buttonValue.task_title;
    } catch (error) {
      console.error("Error parsing button value:", error);
    }

    if (!taskId) {
      // Try to get task ID from metadata as fallback
      if (blockAction.message?.metadata?.event_payload?.task_id) {
        taskId = blockAction.message.metadata.event_payload.task_id;
        taskTitle = blockAction.message.metadata.event_payload.task_title || "Unknown Task";
      } else {
        console.log("⚠️ No task ID found, update may not work correctly");
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Sorry, I couldn't complete the update. Please try again.",
          thread_ts: getThreadTimestamp(null, body)
        });
        return;
      }
    }

    // Get the selected status from the radio button
    let newStatus = "";
    const values = blockAction.state?.values || {};

    for (const blockId in values) {
      if (blockId === "status_block" && values[blockId]?.status_selection?.selected_option?.value) {
        newStatus = values[blockId].status_selection.selected_option.value;
        break;
      }
    }

    if (!newStatus) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Please select a status before updating.",
        thread_ts: getThreadTimestamp(null, body)
      });
      return;
    }

    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client)

    // Security check: Only allow registered users to update task status
    if (!user) {
      console.log("🔒 SECURITY: Unauthorized user attempted to update task status")
      console.log(`🚫 Blocked access for user: ${blockAction.user.id}`)
      return
    }

    console.log("Updating task:", { taskId, newStatus })    // Update the task
    const { data: task, error } = await supabase      .from("tasks")
      .update({ status: newStatus })      .eq("id", taskId)
      .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly check if user ID is in JSONB array
      .select()
      .single()

    if (error) {
      console.error("❌ Error updating task:", error)
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: `Error updating task: ${error.message}`,
        thread_ts: getThreadTimestamp(null, body)
      })
      return
    }

    if (!task) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Task not found or you don't have permission to update it.",
        thread_ts: getThreadTimestamp(null, body)
      })
      return
    }

    console.log("✅ Task updated successfully")

    // Update the message with success confirmation
    const statusEmojis: Record<string, string> = {
      pending: "⏳",
      in_progress: "🚧",
      completed: "✅",
      cancelled: "❌"
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Task Updated Successfully!*\n\n*Task:* ${task.title}\n*New Status:* ${statusEmojis[task.status] || '📝'} ${task.status}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Update Another Task",
              emoji: true
            },
            action_id: "update_another_task",
            style: "primary"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Create New Task",
              emoji: true
            },
            action_id: "create_another_task"
          }
        ]
      }
    ]

    // Access message properties directly without type assertion
    const messageTs = blockAction.message?.ts || ""

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks
    })
  })

  // Add handler for "Create Another Task" button
  bot.action("create_another_task", async ({ body, ack, client }) => {
    await ack();

    if (!isBlockAction(body)) return;

    const blockAction = body;

    // Get user from Slack ID for button interactions
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    // Generate a new task creation form
    await generateTaskCreationForm(user, client, blockAction.channel?.id || user.id, "New Task");
  });

  // Add handler for "Assign to myself" button
  bot.action("assign_to_self", async ({ body, ack, client }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    // Get user from Slack ID for button interactions
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    console.log(`🎯 Self-assignment requested by user: ${user.name} (${user.id})`);
    
    // Get the assignee selection state and set it to self-assignment
    const assigneeState = getAssigneeSelectionState(user.id);
    assigneeState.assigneeIds = [user.id];
    assigneeState.assigneeNames = [user.name];
    assigneeState.assigneeEmails = [user.email];
    assigneeState.isMultiSelect = false; // Disable multi-select mode
    
    // Get metadata from the message
    const metadata = blockAction.message?.metadata?.event_payload;
    const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
    const projectId = metadata?.project_id || assigneeState.projectId;
    const projectName = metadata?.project_name || assigneeState.projectName;
    const teamId = metadata?.team_id || assigneeState.teamId;
    const teamName = metadata?.team_name || assigneeState.teamName;
    const organizationId = metadata?.organization_id || user.organization_id;
    
    // Save details to assignee state for consistency
    assigneeState.taskTitle = taskTitle;
    assigneeState.projectId = projectId;
    assigneeState.projectName = projectName;
    assigneeState.teamId = teamId;
    assigneeState.teamName = teamName;
    
    console.log("✅ Task assigned to self, proceeding to task details form");
    
    // Show task details form with self-assignment
    const blocks = await createTaskDetailsForm(taskTitle, projectName, teamName, undefined, assigneeState);
    
    // Get the message timestamp
    const messageTs = blockAction.message?.ts || "";
    
    // Update the message with the task details form
    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          task_title: taskTitle,
          project_id: projectId,
          project_name: projectName,
          team_id: teamId,
          team_name: teamName,
          organization_id: organizationId,
          action: "collect_task_details"
        }
      }
    });
    
    // Send confirmation message
    await client.chat.postMessage({
      channel: blockAction.user.id,
      text: `✅ Task will be assigned to you (${user.name}). Please fill in the task details below.`
    });
  });

  // Add handler for "Enable Multi-Assignee" button
  bot.action("enable_multi_assignee", async ({ body, ack, client }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    // Get user from Slack ID for button interactions
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    // Check if the user is a team lead or admin
    const isUserTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = isUserTeamLead || isAdmin;
    
    // Only allow team leads and admins to enable multi-assignee mode
    if (!isTeamLeadOrAdmin) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, only team leads and admins can assign tasks to multiple users. Tasks will be assigned to you by default."
      });
      return;
    }
    
    // Get the assignee selection state
    const assigneeState = getAssigneeSelectionState(user.id);
    
    // Enable multi-select mode
    assigneeState.isMultiSelect = true;
    
    // Reset any existing assignees
    assigneeState.assigneeIds = [];
    assigneeState.assigneeNames = [];
    assigneeState.assigneeEmails = [];
    
    // Update metadata if available
    const metadata = blockAction.message?.metadata?.event_payload;
    
    // Get the task and project details
    const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
    const projectId = metadata?.project_id || assigneeState.projectId;
    const projectName = metadata?.project_name || assigneeState.projectName;
    const teamId = metadata?.team_id || assigneeState.teamId;
    const teamName = metadata?.team_name || assigneeState.teamName;
    const organizationId = metadata?.organization_id || user.organization_id;
    
    // Save details to assignee state for consistency
    assigneeState.taskTitle = taskTitle;
    assigneeState.projectId = projectId;
    assigneeState.projectName = projectName;
    assigneeState.teamId = teamId;
    assigneeState.teamName = teamName;    console.log("✅ Enabled multi-assignee mode for task:", taskTitle);
    
    // Get user options based on permission level
    // Pass user.id to ensure proper organization filtering for multi-assignee mode
    const userOptions = await getAvailableUsers(user.id, true);
    
    console.log(`📋 Got ${userOptions.length} user options for multi-assignee selection`);
    
    // Create UI for multi-assignee selection
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Task:* ${taskTitle}\n*Project:* ${projectName || "Not set"}\n*Team:* ${teamName || "Not set"}\n\n✅ *Multi-assignee mode enabled*. Select each user one by one to build your assignee list.`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*No assignees selected yet.*"
        }
      },
      {
        type: "section",
        block_id: "assignee_block",
        text: {
          type: "mrkdwn",
          text: "*Add an assignee:*"
        },
        accessory: {
          type: "static_select",
          action_id: "task_assignee_select",
          placeholder: {
            type: "plain_text",
            text: "Select user",
            emoji: true
          },
          options: userOptions
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Continue with task details",
              emoji: true
            },
            action_id: "done_selecting_assignees",
            style: "primary"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "🗑️ Clear All Assignees",
              emoji: true
            },
            action_id: "clear_all_assignees",
            style: "danger"
          }
        ]
      }
    ];
    
    // Get the message timestamp
    const messageTs = blockAction.message?.ts || "";
    
    // Update the message with the new blocks
    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          task_title: taskTitle,
          project_id: projectId || "",
          project_name: projectName || "",
          team_id: teamId || "",
          team_name: teamName || "",
          organization_id: organizationId || "",
          action: "multi_assignee_selection"
        }
      }
    });
  });  // Add handler for "Task Assignee Select" to handle multi-assignee selection
  bot.action("task_assignee_select", async ({ body, ack, client }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    console.log("🎯 Task assignee select triggered");
    
    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    console.log(`👤 User: ${user.name} (${user.id})`);
    
    // Check if user is team lead or admin
    const isUserTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = isUserTeamLead || isAdmin;
    
    console.log(`🔐 Permissions - Team Lead: ${isUserTeamLead}, Admin: ${isAdmin}`);
    
    // For normal users, they can only select themselves
    // For team leads and admins, they can select any user
    const action = blockAction.actions[0];
    const selectedUserId = 'selected_option' in action ? action.selected_option?.value : undefined;
    
    console.log(`🎯 Selected user ID: ${selectedUserId}`);
    
    if (!selectedUserId) return;
    
    // If not a team lead or admin, ensure the user can only assign to themselves
    if (!isTeamLeadOrAdmin && selectedUserId !== user.id) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "As a regular user, you can only assign tasks to yourself. The task will be assigned to you instead."
      });
      
      // Force self-assignment for regular users
      const assigneeState = getAssigneeSelectionState(user.id);
      assigneeState.assigneeIds = [user.id];
      assigneeState.assigneeNames = [user.name];
      assigneeState.assigneeEmails = [user.email];
      
      // Continue with the task creation process
      // Skip the rest of this handler and jump to task details
      const metadata = blockAction.message?.metadata?.event_payload;
      const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
      const projectId = metadata?.project_id || assigneeState.projectId;
      const projectName = metadata?.project_name || assigneeState.projectName;
      const teamId = metadata?.team_id || assigneeState.teamId;
      const teamName = metadata?.team_name || assigneeState.teamName;
      
      // Show task details form
      const blocks = await createTaskDetailsForm(taskTitle, projectName, teamName, undefined, assigneeState);
      
      // Update the message with the new blocks
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: blockAction.message?.ts || "",
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: projectId,
            project_name: projectName,
            team_id: teamId,
            team_name: teamName,
            organization_id: metadata?.organization_id || user.organization_id,
            action: "collect_task_details"
          }
        }
      });
      return;
    }
    
    // For team leads and admins, continue with normal flow
    const assigneeState = getAssigneeSelectionState(user.id);
    
    // Get the user details from Supabase
    const { data: selectedUser, error: userError } = await supabase
      .from("users")
      .select("id, name, email")
      .eq("id", selectedUserId)
      .single();
      
    if (userError || !selectedUser) {
      console.error("Error fetching user:", userError);
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Error finding the selected user."
      });
      return;
    }
    
    // Check if user is already in the list
    if (assigneeState.assigneeIds.includes(selectedUserId)) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: `${selectedUser.name} is already assigned to this task.`
      });
      return;
    }
    
    // Add the assignee to the list
    assigneeState.assigneeIds.push(selectedUserId);
    assigneeState.assigneeNames.push(selectedUser.name);
    assigneeState.assigneeEmails.push(selectedUser.email);
    
    console.log(`✅ Added ${selectedUser.name} to assignees list (${assigneeState.assigneeNames.length} total)`);
    
    // Update metadata if available
    const metadata = blockAction.message?.metadata?.event_payload;
    
    // Get the task and project details
    const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
    const projectId = metadata?.project_id || assigneeState.projectId;
    const projectName = metadata?.project_name || assigneeState.projectName;
    const teamId = metadata?.team_id || assigneeState.teamId;
    const teamName = metadata?.team_name || assigneeState.teamName;
    const organizationId = metadata?.organization_id || user.organization_id;
      // If multi-select mode, update the UI to show current assignees
    if (assigneeState.isMultiSelect) {
      // Update assignee state with project and team info
      assigneeState.projectId = projectId;
      assigneeState.projectName = projectName;
      assigneeState.teamId = teamId;
      assigneeState.teamName = teamName;
      
      // Create blocks showing current assignees
      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Task:* ${taskTitle}\n*Project:* ${projectName || "Not set"}\n*Team:* ${teamName || "Not set"}`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Current Assignees:*"
          }
        }
      ];        // Add each assignee as a section
      for (let i = 0; i < assigneeState.assigneeNames.length; i++) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${i + 1}. ${assigneeState.assigneeNames[i]} (${assigneeState.assigneeEmails[i]})`
          },
          accessory: {
            type: "button",          text: {
              type: "plain_text",
              text: "❌ Remove",
              emoji: true
            },
            action_id: `remove_assignee_${i}`
          }
        });
      }
        // Add dropdown to assign more users
      blocks.push({
        type: "section",
        block_id: "assignee_block",
        text: {
          type: "mrkdwn",
          text: "*Add another assignee:*"
        },
        accessory: {
          type: "static_select",
          action_id: "task_assignee_select",
          placeholder: {
            type: "plain_text",
            text: "Select user",
            emoji: true
          },
          options: await getAvailableUsers(user.id, true) // Get org users for multi-assignee with proper organization filtering
        }
      });
        // Add button to finish selecting assignees
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Continue with task details",
              emoji: true
            },
            action_id: "done_selecting_assignees",
            style: "primary"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "🗑️ Clear All Assignees",
              emoji: true
            },
            action_id: "clear_all_assignees",
            style: "danger"
          }
        ]
      });

      // Update the message with the new blocks showing current assignees
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: blockAction.message?.ts || "",
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: projectId,
            project_name: projectName,
            team_id: teamId,
            team_name: teamName,
            organization_id: organizationId,
            action: "multi_assignee_selection"
          }
        }
      });
    } else {
      // Single assignee mode - continue to the task details form
      
      // Show task details form
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: `✅ Task assigned to ${selectedUser.name}.`
      });
      
      // Continue with task creation
      // We'll include assignee info in the final task creation
      const blocks = await createTaskDetailsForm(taskTitle, projectName, teamName, undefined, assigneeState);
      
      // Get the message timestamp
      const messageTs = blockAction.message?.ts || "";
      
      // Update the message with the new blocks
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: messageTs,
        blocks: blocks,
        metadata: {
          event_type: "task_creation",
          event_payload: {
            task_title: taskTitle,
            project_id: projectId,
            project_name: projectName,
            team_id: teamId,
            team_name: teamName,
            organization_id: organizationId,
            action: "collect_task_details"
          }
        }
      });
    }
  });
  
  // Add handler for "Done Selecting Assignees"
  bot.action("done_selecting_assignees", async ({ body, ack, client }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    // Get the assignee selection state
    const assigneeState = getAssigneeSelectionState(user.id);
    
    // Check if any assignees were selected
    if (assigneeState.assigneeIds.length === 0) {
      // No assignees selected, assign to self
      assigneeState.assigneeIds = [user.id];
      assigneeState.assigneeNames = [user.name];
      assigneeState.assigneeEmails = [user.email];
      
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "No assignees selected. The task will be assigned to you."
      });
    }
    
    // Update metadata if available
    const metadata = blockAction.message?.metadata?.event_payload;
    
    // Get the task and project details
    const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
    const projectId = metadata?.project_id || assigneeState.projectId;
    const projectName = metadata?.project_name || assigneeState.projectName;
    const teamId = metadata?.team_id || assigneeState.teamId;
    const teamName = metadata?.team_name || assigneeState.teamName;
    
    // Continue with task creation
    // Show task details form
    const assigneeNames = assigneeState.assigneeNames.join(", ");
    await client.chat.postMessage({
      channel: blockAction.user.id,
      text: `✅ Task will be assigned to: ${assigneeNames}`
    });
      // Generate task details form with the assignee state
    const blocks = await createTaskDetailsForm(taskTitle, projectName, teamName, undefined, assigneeState);
    
    // Get the message timestamp
    const messageTs = blockAction.message?.ts || "";
    
    // Update the message with the new blocks
    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          task_title: taskTitle,
          project_id: projectId,
          project_name: projectName,
          team_id: teamId,
          team_name: teamName,
          organization_id: metadata?.organization_id || user.organization_id,
          action: "collect_task_details"
        }
      }
    });
  });
  
  // Add handler for "Clear All Assignees" button in multi-assignee mode
  bot.action("clear_all_assignees", async ({ body, ack, client }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    // Get the assignee selection state
    const assigneeState = getAssigneeSelectionState(user.id);
    
    // Clear all assignees
    assigneeState.assigneeIds = [];
    assigneeState.assigneeNames = [];
    assigneeState.assigneeEmails = [];
    
    console.log(`✅ Cleared all assignees from selection`);
    
    // Update metadata if available
    const metadata = blockAction.message?.metadata?.event_payload;
    
    // Get the task and project details
    const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
    const projectId = metadata?.project_id || assigneeState.projectId;
    const projectName = metadata?.project_name || assigneeState.projectName;
    const teamId = metadata?.team_id || assigneeState.teamId;
    const teamName = metadata?.team_name || assigneeState.teamName;
    const organizationId = metadata?.organization_id || user.organization_id;
    
    // Create blocks showing current assignees (which is now empty)
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Task:* ${taskTitle}\n*Project:* ${projectName || "Not set"}\n*Team:* ${teamName || "Not set"}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*No assignees selected*"
        }
      },
      {
        type: "section",
        block_id: "assignee_block",
        text: {
          type: "mrkdwn",
          text: "*Add an assignee:*"
        },
        accessory: {
          type: "static_select",
          action_id: "task_assignee_select",
          placeholder: {
            type: "plain_text",
            text: "Select user",
            emoji: true
          },
          options: await getAvailableUsers(user.id, true) // Only team leads see this
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Continue with task details",
              emoji: true
            },
            action_id: "done_selecting_assignees",
            style: "primary"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "🗑️ Clear All Assignees",
              emoji: true
            },
            action_id: "clear_all_assignees",
            style: "danger"
          }
        ]
      }
    ];
    
    // Get the message timestamp
    const messageTs = blockAction.message?.ts || "";
    
    // Update the message with the new blocks
    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          task_title: taskTitle,
          project_id: projectId,
          project_name: projectName,
          team_id: teamId,
          team_name: teamName,
          organization_id: organizationId,
          action: "multi_assignee_selection"
        }
      }
    });
  });
  
  // Add handlers for remove_assignee_X buttons (dynamically created)
  bot.action(/^remove_assignee_(\d+)$/, async ({ body, ack, client, context }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    // Get the index from the regex match
    const index = parseInt(context.matches[1], 10);
    
    // Get the assignee selection state
    const assigneeState = getAssigneeSelectionState(user.id);
    
    // Check if the index is valid
    if (index < 0 || index >= assigneeState.assigneeIds.length) {
      console.error(`Invalid assignee index: ${index}`);
      return;
    }
    
    // Remove the assignee
    const removedName = assigneeState.assigneeNames[index];
    assigneeState.assigneeIds.splice(index, 1);
    assigneeState.assigneeNames.splice(index, 1);
    assigneeState.assigneeEmails.splice(index, 1);
    
    console.log(`✅ Removed ${removedName} from assignees list (${assigneeState.assigneeNames.length} remaining)`);
    
    // Update metadata if available
    const metadata = blockAction.message?.metadata?.event_payload;
    
    // Get the task and project details
    const taskTitle = metadata?.task_title || assigneeState.taskTitle || "New Task";
    const projectId = metadata?.project_id || assigneeState.projectId;
    const projectName = metadata?.project_name || assigneeState.projectName;
    const teamId = metadata?.team_id || assigneeState.teamId;
    const teamName = metadata?.team_name || assigneeState.teamName;
    const organizationId = metadata?.organization_id || user.organization_id;
    
    // If no assignees left, show empty list message
    if (assigneeState.assigneeIds.length === 0) {
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "All assignees removed. Please select at least one assignee."
      });
    }
    
    // Create blocks showing current assignees
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Task:* ${taskTitle}\n*Project:* ${projectName || "Not set"}\n*Team:* ${teamName || "Not set"}`
        }
      }
    ];
    
    // If there are assignees, show them
    if (assigneeState.assigneeNames.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Current Assignees:*"
        }
      });
    // Add each assignee as a section
      for (let i = 0; i < assigneeState.assigneeNames.length; i++) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${i + 1}. ${assigneeState.assigneeNames[i]} (${assigneeState.assigneeEmails[i]})`
          },
          accessory: {
            type: "button",            text: {
              type: "plain_text",
              text: "❌ Remove",
              emoji: true
            },
            action_id: `remove_assignee_${i}`
          }
        });
      }
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*No assignees selected*"
        }
      });
    }
      // Add dropdown to assign more users
    blocks.push({
      type: "section",
      block_id: "assignee_block",
      text: {
        type: "mrkdwn",
        text: "*Add an assignee:*"
      },
      accessory: {
        type: "static_select",
        action_id: "task_assignee_select",
        placeholder: {
          type: "plain_text",
          text: "Select user",
          emoji: true
        },
        options: await getAvailableUsers(user.id, true) // Get org users for multi-assignee with proper organization filtering
      }
    });
    
    // Add buttons to finish selecting assignees or clear all
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Continue with task details",
            emoji: true
          },
          action_id: "done_selecting_assignees",
          style: "primary"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🗑️ Clear All Assignees",
            emoji: true
          },
          action_id: "clear_all_assignees",
          style: "danger"
        }
      ]
    });
    
    // Get the message timestamp
    const messageTs = blockAction.message?.ts || "";
    
    // Update the message with the new blocks
    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_creation",
        event_payload: {
          task_title: taskTitle,
          project_id: projectId,
          project_name: projectName,
          team_id: teamId,
          team_name: teamName,
          organization_id: organizationId,
          action: "multi_assignee_selection"
        }
      }
    });
  });

  // Handle "Create Task" button click to create the task in the database
  bot.action("create_task_final", async ({ body, ack, client }) => {
    await ack();
    
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    
    // Get user from Slack ID
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    console.log(`🔍 Processing task creation by user: ${user.name} (${user.id})`);
    
    // Extract metadata
    const metadata = blockAction.message?.metadata?.event_payload;
    
    // Get the task details from the form
    const stateValues = blockAction.state?.values || {};
    console.log("Form state values:", JSON.stringify(stateValues, null, 2));
    
    // Extract task title from metadata
    const taskTitle = metadata?.task_title || "New Task";
    
    // Extract description from form
    let taskDescription = "";
    for (const sectionId in stateValues) {
      if (sectionId.includes("description_block") && stateValues[sectionId].task_description_input?.value) {
        taskDescription = stateValues[sectionId].task_description_input.value;
        break;
      }
    }
    
    // Extract deadline from form
    let deadline: string | undefined;
    for (const sectionId in stateValues) {
      if (sectionId.includes("deadline_block") && stateValues[sectionId].task_deadline_date?.selected_date) {
        deadline = stateValues[sectionId].task_deadline_date.selected_date;
        break;
      }
    }
    
    // Extract priority from form
    let priority = "medium"; // Default
    for (const sectionId in stateValues) {
      if (sectionId.includes("priority_block") && stateValues[sectionId].task_priority_select?.selected_option?.value) {
        priority = stateValues[sectionId].task_priority_select.selected_option.value;
        break;
      }
    }
    
    // Get project and team IDs from metadata
    const projectId = metadata?.project_id;
    const projectName = metadata?.project_name;
    const teamId = metadata?.team_id;
    const teamName = metadata?.team_name;
    const organizationId = metadata?.organization_id || user.organization_id;
      // Check for assignee state
    const assigneeState = getAssigneeSelectionState(user.id);
    
    console.log("🔍 Assignee State Debug:", {
      assigneeIds: assigneeState.assigneeIds,
      assigneeNames: assigneeState.assigneeNames,
      assigneeEmails: assigneeState.assigneeEmails,
      isMultiSelect: assigneeState.isMultiSelect,
      length: assigneeState.assigneeIds.length
    });
    
    // Determine assignees based on user role and assignee selection state
    let assigneeIds: string[] = [];
    let assigneeName = "";
    
    // Check if user is team lead or admin
    const isUserTeamLead = await isTeamLead(user.id);
    const isAdmin = await isUserAdmin(user.id);
    const isTeamLeadOrAdmin = isUserTeamLead || isAdmin;
    
    console.log(`User permissions check: Team Lead: ${isUserTeamLead}, Admin: ${isAdmin}`);
    
    // If we have assignees selected in multi-select mode
    if (assigneeState && assigneeState.assigneeIds.length > 0) {
      // If user is team lead or admin, they can assign to multiple users
      if (isTeamLeadOrAdmin) {
        assigneeIds = [...assigneeState.assigneeIds];
        if (assigneeState.assigneeNames.length > 1) {
          assigneeName = `Multiple users (${assigneeState.assigneeNames.length})`;
        } else {
          assigneeName = assigneeState.assigneeNames[0];
        }
        console.log(`Team lead/admin assigning task to ${assigneeIds.length} users`);
      } else {
        // Non-team leads/admins can only self-assign
        assigneeIds = [user.id];
        assigneeName = user.name;
        console.log("Normal user can only self-assign tasks");
        
        // Notify user about the limitation
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: "Note: As a regular user, you can only assign tasks to yourself. The task has been assigned to you."
        });
      }
    } else {
      // Default to self-assignment if no assignees specified
      assigneeIds = [user.id];
      assigneeName = user.name;
      console.log("No assignees specified, defaulting to self-assignment");
    }
    
    console.log(`Task assignees: ${assigneeIds.join(", ")}`);
    
    try {
      // Create the task in the database
      const { data: newTask, error } = await supabase
        .from("tasks")
        .insert({
          title: taskTitle,
          description: taskDescription,
          status: "pending",
          priority: priority,
          deadline: deadline,
          assigned_to: assigneeIds, // Store as an array
          project_id: projectId, // Use projectId directly, it should contain the actual project ID
          organization_id: organizationId,
          created_by: user.id
        })
        .select()
        .single();
        
      if (error) {
        console.error("❌ Error creating task:", error);
        await client.chat.postMessage({
          channel: blockAction.user.id,
          text: `Error creating task: ${error.message}`
        });
        return;
      }
      
      console.log(`✅ Task created: ${newTask.id}`);
      
      // Send confirmation message
      let confirmationText = `✅ Task *"${taskTitle}"* created successfully!\n\n`;
      confirmationText += `• *Priority:* ${priority.charAt(0).toUpperCase() + priority.slice(1)}\n`;
      
      if (deadline) {
        confirmationText += `• *Due:* ${new Date(deadline).toLocaleDateString()}\n`;
      }
      
      if (projectName) {
        confirmationText += `• *Project:* ${projectName}\n`;
      }
      
      if (teamName) {
        confirmationText += `• *Team:* ${teamName}\n`;
      }
      
      if (assigneeIds.length > 1) {
        confirmationText += `• *Assigned to:* ${assigneeState.assigneeNames.join(", ")}\n`;
      } else {
        confirmationText += `• *Assigned to:* ${assigneeName}\n`;
      }
        // Send notification to all assigned users via all platforms
      // This will send to Slack, Teams, WhatsApp, Telegram and log to notification_logs
      try {
        await sendNewTaskAssignmentNotification(
          newTask.id,
          assigneeIds, // Pass all assignee IDs at once
          user.name
        );
          console.log(`📩 Sent task notifications to all assigned users via all platforms`);
      } catch (notifyError) {
        console.error(`❌ Error sending notifications:`, notifyError);
      }
      
      // Clear assignee selection state after successful task creation
      clearAssigneeSelectionState(user.id);
      console.log("🧹 Cleared assignee selection state after task creation");
      
      // Update the message with confirmation
      await client.chat.update({
        channel: blockAction.channel?.id || "",
        ts: blockAction.message?.ts || "",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: confirmationText
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Create Another Task",
                  emoji: true
                },
                action_id: "create_another_task"
              }
            ]
          }
        ]
      });    } catch (error) {
      console.error("❌ Unexpected error creating task:", error);
      await client.chat.postMessage({
        channel: blockAction.user.id,
        text: "Sorry, something went wrong while creating the task. Please try again."
      });
    }
  });

  // Handle modal view submissions for task editing
  bot.view("edit_title_modal", async ({ ack, body, client }) => {
    await ack()

    try {
      const metadata = JSON.parse(body.view.private_metadata || "{}")
      const taskId = metadata.taskId
      const channelId = metadata.channelId
      const messageTs = metadata.messageTs

      if (!taskId) return

      // Get user
      const user = await getUserFromSlackId(body.user.id, client)
      if (!user) return

      // Get new title from form
      const newTitle = body.view.state.values.title_block.title_input.value?.trim()
      
      if (!newTitle) {
        // Show error in modal
        await ack({
          response_action: "errors",
          errors: {
            "title_block": "Title cannot be empty"
          }
        })
        return
      }      // Update task in database
      const { error } = await supabase
        .from("tasks")        .update({ 
          title: newTitle,
          updated_at: new Date().toISOString()
        })
        .eq("id", taskId)
        .filter('assigned_to', 'cs', `["${user.id}"]`)

      if (error) {
        console.error("❌ Error updating task title:", error)
        return
      }

      // Get updated task and refresh the edit form
      const { data: updatedTask } = await supabase
        .from("tasks")
        .select(`
          *,
          projects (
            id,
            name
          )
        `)
        .eq("id", taskId)
        .single()

      if (updatedTask) {
        // Simulate blockAction for showTaskEditForm
        const fakeBlockAction = {
          channel: { id: channelId },
          message: { ts: messageTs },
          user: { id: body.user.id }
        }
        await showTaskEditForm(fakeBlockAction, client, user, updatedTask)
      }

    } catch (error) {
      console.error("❌ Error updating task title:", error)
    }
  })

  bot.view("edit_description_modal", async ({ ack, body, client }) => {
    await ack()

    try {
      const metadata = JSON.parse(body.view.private_metadata || "{}")
      const taskId = metadata.taskId
      const channelId = metadata.channelId
      const messageTs = metadata.messageTs

      if (!taskId) return

      // Get user
      const user = await getUserFromSlackId(body.user.id, client)
      if (!user) return

      // Get new description from form
      const newDescription = body.view.state.values.description_block.description_input.value?.trim() || ""

      // Update task in database
      const { error } = await supabase        .from("tasks")        .update({ 
          description: newDescription,
          updated_at: new Date().toISOString()
        })
        .eq("id", taskId)
        .filter('assigned_to', 'cs', `["${user.id}"]`)

      if (error) {
        console.error("❌ Error updating task description:", error)
        return
      }

      // Get updated task and refresh the edit form
      const { data: updatedTask } = await supabase
        .from("tasks")
        .select(`
          *,
          projects (
            id,
            name
          )
        `)
        .eq("id", taskId)
        .single()

      if (updatedTask) {
        const fakeBlockAction = {
          channel: { id: channelId },
          message: { ts: messageTs },
          user: { id: body.user.id }
        }
        await showTaskEditForm(fakeBlockAction, client, user, updatedTask)
      }

    } catch (error) {
      console.error("❌ Error updating task description:", error)
    }
  })

  bot.view("edit_priority_modal", async ({ ack, body, client }) => {
    await ack()

    try {
      const metadata = JSON.parse(body.view.private_metadata || "{}")
      const taskId = metadata.taskId
      const channelId = metadata.channelId
      const messageTs = metadata.messageTs

      if (!taskId) return

      // Get user
      const user = await getUserFromSlackId(body.user.id, client)
      if (!user) return

      // Get new priority from form
      const newPriority = body.view.state.values.priority_block.priority_select.selected_option?.value

      if (!newPriority) return

      // Update task in database
      const { error } = await supabase        .from("tasks")        .update({ 
          priority: newPriority,
          updated_at: new Date().toISOString()
        })
        .eq("id", taskId)
        .filter('assigned_to', 'cs', `["${user.id}"]`)

      if (error) {
        console.error("❌ Error updating task priority:", error)
        return
      }

      // Get updated task and refresh the edit form
      const { data: updatedTask } = await supabase
        .from("tasks")
        .select(`
          *,
          projects (
            id,
            name
          )
        `)
        .eq("id", taskId)
        .single()

      if (updatedTask) {
        const fakeBlockAction = {
          channel: { id: channelId },
          message: { ts: messageTs },
          user: { id: body.user.id }
        }
        await showTaskEditForm(fakeBlockAction, client, user, updatedTask)
      }

    } catch (error) {
      console.error("❌ Error updating task priority:", error)
    }
  })

  bot.view("edit_deadline_modal", async ({ ack, body, client }) => {
    await ack()

    try {
      const metadata = JSON.parse(body.view.private_metadata || "{}")
      const taskId = metadata.taskId
      const channelId = metadata.channelId
      const messageTs = metadata.messageTs

      if (!taskId) return

      // Get user
      const user = await getUserFromSlackId(body.user.id, client)
      if (!user) return

      // Get new deadline from form
      const newDeadline = body.view.state.values.deadline_block.deadline_picker.selected_date

      // Update task in database
      const { error } = await supabase
        .from("tasks")        .update({ 
          deadline: newDeadline,        updated_at: new Date().toISOString()
        })
        .eq("id", taskId)
        .filter('assigned_to', 'cs', `["${user.id}"]`)

      if (error) {
        console.error("❌ Error updating task deadline:", error)
        return
      }

      // Get updated task and refresh the edit form
      const { data: updatedTask } = await supabase
        .from("tasks")
        .select(`
          *,
          projects (
            id,
            name
          )
        `)
        .eq("id", taskId)
        .single()

      if (updatedTask) {
        const fakeBlockAction = {
          channel: { id: channelId },
          message: { ts: messageTs },
          user: { id: body.user.id }
        }
        await showTaskEditForm(fakeBlockAction, client, user, updatedTask)
      }

    } catch (error) {
      console.error("❌ Error updating task deadline:", error)
    }
  })

  bot.view("edit_status_modal", async ({ ack, body, client }) => {
    await ack()

    try {
      const metadata = JSON.parse(body.view.private_metadata || "{}")
      const taskId = metadata.taskId
      const channelId = metadata.channelId
      const messageTs = metadata.messageTs

      if (!taskId) return

      // Get user
      const user = await getUserFromSlackId(body.user.id, client)
      if (!user) return

      // Get new status from form
      const newStatus = body.view.state.values.status_block.status_select.selected_option?.value

      if (!newStatus) return

      // Update task in database
      const { error } = await supabase
        .from("tasks")        .update({ 
          status: newStatus,        updated_at: new Date().toISOString()
        })
        .eq("id", taskId)
        .filter('assigned_to', 'cs', `["${user.id}"]`)

      if (error) {
        console.error("❌ Error updating task status:", error)
        return
      }

      // Get updated task and refresh the edit form
      const { data: updatedTask } = await supabase
        .from("tasks")
        .select(`
          *,
          projects (
            id,
            name
          )
        `)
        .eq("id", taskId)
        .single()

      if (updatedTask) {
        const fakeBlockAction = {
          channel: { id: channelId },
          message: { ts: messageTs },
          user: { id: body.user.id }
        }
        await showTaskEditForm(fakeBlockAction, client, user, updatedTask)
      }    } catch (error) {
      console.error("❌ Error updating task status:", error)
    }
  })

  bot.view("edit_project_modal", async ({ ack, body, client }) => {
    await ack()

    try {
      const metadata = JSON.parse(body.view.private_metadata || "{}")
      const taskId = metadata.taskId
      const channelId = metadata.channelId
      const messageTs = metadata.messageTs

      if (!taskId) return

      // Get user
      const user = await getUserFromSlackId(body.user.id, client)
      if (!user) return

      // Get new project from form
      const newProjectId = body.view.state.values.project_block.project_select.selected_option?.value

      if (!newProjectId) return

      // Update task in database
      const { error } = await supabase
        .from("tasks")        .update({ 
          project_id: newProjectId === "none" ? null : newProjectId,
          updated_at: new Date().toISOString()
        })        .eq("id", taskId)
        .filter('assigned_to', 'cs', `["${user.id}"]`)

      if (error) {
        console.error("❌ Error updating task project:", error)
        return
      }

      // Get updated task and refresh the edit form
      const { data: updatedTask } = await supabase
        .from("tasks")
        .select(`
          *,
          projects (
            id,
            name
          )
        `)
        .eq("id", taskId)
        .single()

      if (updatedTask) {
        const fakeBlockAction = {
          channel: { id: channelId },
          message: { ts: messageTs },
          user: { id: body.user.id }
        }
        await showTaskEditForm(fakeBlockAction, client, user, updatedTask)
      }    } catch (error) {
      console.error("❌ Error updating task project:", error)
    }
  })
  // === REMINDER HANDLERS ===
  
  // Handle reminder type selection (task/custom)
  bot.action("reminder_type_task", async ({ body, ack, client }) => {
    await ack();
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    const channelId = blockAction.channel?.id || "";
    const messageTs = blockAction.message?.ts || "";
    const threadTs = getThreadTimestamp(null, body);
    
    await handleReminderTypeSelection(client, user, "reminder_type_task", channelId, messageTs, threadTs);
  });

  bot.action("reminder_type_custom", async ({ body, ack, client }) => {
    await ack();
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    const channelId = blockAction.channel?.id || "";
    const messageTs = blockAction.message?.ts || "";
    const threadTs = getThreadTimestamp(null, body);
    
    await handleReminderTypeSelection(client, user, "reminder_type_custom", channelId, messageTs, threadTs);
  });

  // Handle user selection for reminders
  bot.action("reminder_user_select", async ({ body, ack, client }) => {
    await ack();
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    const action = blockAction.actions[0];
    const selectedUserId = 'selected_option' in action ? action.selected_option?.value : undefined;
    if (!selectedUserId) return;
    
    const channelId = blockAction.channel?.id || "";
    const messageTs = blockAction.message?.ts || "";
    const threadTs = getThreadTimestamp(null, body);
    
    await handleReminderUserSelection(client, user, selectedUserId, channelId, messageTs, threadTs);
  });

  // Handle task selection for reminders
  bot.action("reminder_task_select", async ({ body, ack, client }) => {
    await ack();
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    const action = blockAction.actions[0];
    const selectedTaskId = 'selected_option' in action ? action.selected_option?.value : undefined;
    if (!selectedTaskId) return;
    
    const channelId = blockAction.channel?.id || "";
    const messageTs = blockAction.message?.ts || "";
    const threadTs = getThreadTimestamp(null, body);
    
    await handleReminderTaskSelection(client, user, selectedTaskId, channelId, messageTs, threadTs);
  });

  // Handle cancellation of reminder
  bot.action("cancel_send_reminder", async ({ body, ack, client }) => {
    await ack();
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
      const channelId = blockAction.channel?.id || "";
    const messageTs = blockAction.message?.ts || "";
    const threadTs = getThreadTimestamp(null, body);
    
    await handleReminderCancellation(client, user, channelId, messageTs, threadTs);
  });

  // Handle custom reminder message submission via button
  bot.action("send_custom_reminder_message", async ({ body, ack, client }) => {
    await ack();
    if (!isBlockAction(body)) return;
    
    const blockAction = body;
    const user = await getUserFromSlackId(blockAction.user.id, client);
    if (!user) return;
    
    // Extract the message from the input field
    let customMessage = "";
    const values = blockAction.state?.values || {};
    
    for (const blockId in values) {
      if (blockId === "custom_reminder_message_block" && 
          values[blockId]?.custom_reminder_message_input?.value) {
        customMessage = values[blockId].custom_reminder_message_input.value;
        break;
      }
    }
    
    const channelId = blockAction.channel?.id || "";
    const threadTs = getThreadTimestamp(null, body);
    
    if (customMessage && customMessage.trim()) {
      console.log(`📝 Processing custom reminder from button submission: "${customMessage.substring(0, 50)}${customMessage.length > 50 ? '...' : ''}"`);
      await handleCustomReminderMessage(client, user, customMessage, channelId, threadTs);
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: "❌ Please enter a message for the reminder.",
        thread_ts: threadTs
      });
    }
  });
}

// Send reminders function
export async function sendReminder(reminder: { id: string; message: string; user_id: string; task_id: string }) {
  console.log(`\n⏰ sendReminder: Processing reminder ${reminder.id}`)
  console.log(`   Message: ${reminder.message}`)
  console.log(`   User ID: ${reminder.user_id}`)
  console.log(`   Task ID: ${reminder.task_id}`)
  
  // Track reminders to prevent duplicates using global scope properly
  const reminderKey = `slack_${reminder.user_id}_${reminder.task_id || 'notification'}_${new Date().toISOString().split('T')[0]}`;
  const globalThis = global as any;
  const localReminderCache = globalThis.slackReminderCache || (globalThis.slackReminderCache = new Map());
  const globalReminderCache = globalThis.crossPlatformReminderCache || (globalThis.crossPlatformReminderCache = new Map());  
  // Check if this reminder was sent in the last 5 minutes
  if (localReminderCache.has(reminderKey)) {
    const lastSent = localReminderCache.get(reminderKey);
    const timeDiff = Date.now() - lastSent;
    if (timeDiff < 300000) { // 5 minutes
      console.log(`⚠️ Duplicate Slack reminder prevented for user ${reminder.user_id}, task ${reminder.task_id}: sent ${Math.round(timeDiff/1000)}s ago`);
      return; // Skip this reminder
    }
  }
  
  // Check if this reminder was sent by the cross-platform notification system
  const crossPlatformKey = `all_platforms_${reminder.task_id || 'notification'}_${new Date().toISOString().split('T')[0]}`;
  if (globalReminderCache.has(crossPlatformKey)) {
    const lastSent = globalReminderCache.get(crossPlatformKey);
    const timeDiff = Date.now() - lastSent;
    if (timeDiff < 300000) { // 5 minutes
      console.log(`⚠️ Cross-platform notification already sent for ${reminder.task_id}: sent ${Math.round(timeDiff/1000)}s ago`);
      return; // Skip this reminder
    }
  }
    // Mark this reminder as sent
  localReminderCache.set(reminderKey, Date.now());
  
  try {
    // Check if this is a custom reminder (format: custom_${userId}) or a welcome message
    if (reminder.task_id && (
        reminder.task_id.startsWith('custom_') || 
        reminder.task_id.startsWith('welcome_') || 
        reminder.task_id === 'notification' || 
        reminder.id === 'welcome_notification'
      )) {
      console.log(`📝 Processing special message type - sending directly to Slack user`);
      
      // Extract user ID for custom reminders
      let userId = reminder.user_id;
      if (reminder.task_id.startsWith('custom_')) {
        userId = reminder.task_id.replace('custom_', '');
      } else if (reminder.task_id.startsWith('welcome_')) {
        userId = reminder.task_id.replace('welcome_', '');
      }
      
      // Identify if this is a welcome message
      const isWelcome = reminder.id === 'welcome_notification' || 
                       reminder.task_id.startsWith('welcome_');
        // For welcome messages, we don't need to add any prefix
      // The welcome message template already has proper formatting
      // For other types, add appropriate prefixes
      let formattedMessage = reminder.message;
      
      if (!isWelcome) {
        const messagePrefix = reminder.task_id.startsWith('custom_') ? 
                             '⏰ CUSTOM REMINDER: ' : 
                             '📢 NOTIFICATION: ';
        formattedMessage = `${messagePrefix}${reminder.message}\n\nFrom: Admin`;
      }
      
      // Send message directly to Slack user
      await sendDirectSlackReminder({
        id: reminder.id,
        message: formattedMessage,
        user_id: userId,
        task_id: reminder.task_id
      });
      
      return;
    }    // For regular task reminders, get task details first
    // Extract the real task ID if it's a composite ID like "taskId_userId"
    const reminderTaskIdParts = reminder.task_id.split('_');
    const realTaskId = reminderTaskIdParts[0]; // Use only the task ID part
    
    console.log(`Using task ID: ${realTaskId} from original ID: ${reminder.task_id}`);
    
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, project_id, organization_id, assigned_to, created_by, status")
      .eq("id", realTaskId)
      .single()

    if (taskError || !task) {
      console.error("Error fetching task:", taskError)
      return
    }

    console.log(`📋 Task details found: "${task.title}" (ID: ${realTaskId})`);

    // Get project and team details
    let projectName = "No project"
    let teamName = "No team"

    if (task.project_id) {
      const { data: project } = await supabase
        .from("projects")
        .select("name, team_id, organization_id")
        .eq("id", task.project_id)
        .single()

      if (project) {
        projectName = project.name

        if (project.team_id) {
          const { data: team } = await supabase
            .from("teams")
            .select("name")
            .eq("id", project.team_id)
            .single()

          if (team) {
            teamName = team.name
          }
        }
      }
    }

    // Handle the case where assigned_to might be an array, a single value, or a JSON string
    let assignedToIds = [];
    
    if (typeof task.assigned_to === 'string') {
      try {
        // Try to parse it as JSON
        const parsedIds = JSON.parse(task.assigned_to);
        if (Array.isArray(parsedIds)) {
          assignedToIds = parsedIds;
        } else {
          assignedToIds = [parsedIds];
        }
      } catch (e) {
        // If it's not valid JSON, treat it as a single ID
        assignedToIds = [task.assigned_to];
      }
    } else if (Array.isArray(task.assigned_to)) {
      assignedToIds = task.assigned_to;
    } else if (task.assigned_to) {
      assignedToIds = [task.assigned_to];
    } else {
      // Fallback to task creator if assigned_to is null/undefined
      if (task.created_by) {
        assignedToIds = [task.created_by];
        console.log(`📊 Using task creator as assignee: ${task.created_by}`);
      } else {
        console.error(`❌ No assignees or creator found for task`);
        return;
      }
    }

    // Convert any non-string IDs to strings and filter out invalid values
    const usersToNotify = assignedToIds
      .map(id => {
        if (id === null || id === undefined) return null;
        return typeof id === 'string' ? id : String(id);
      })
      .filter(id => id !== null);    console.log(`📊 Task has ${usersToNotify.length} valid assignees`);    // Check if the reminder is targeted to a specific user (from composite task ID)
    if (reminderTaskIdParts.length > 1 && reminderTaskIdParts[1].length > 30) {
      // If task_id has the format "taskId_userId", extract the userId part and only notify that specific user
      const targetUserId = reminderTaskIdParts[1];
      console.log(`📝 Extracted target user ID from composite task ID: ${targetUserId}`);
      
      // Verify that the target user is actually assigned to this task
      if (!usersToNotify.includes(targetUserId)) {
        console.log(`⚠️ Target user ${targetUserId} is not assigned to task ${realTaskId}, aborting targeted reminder`);
        return;
      }
      
      // Get user details for logging
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("name, email")
        .eq("id", targetUserId)
        .single();

      if (userError || !user) {
        console.error(`❌ User not found: ${targetUserId}`, userError);
        return;
      }

      console.log(`📝 Sending targeted reminder to specific user: ${user.name} (${user.email})`);      // Create detailed reminder message
      const reminderMessage = `⏰ REMINDER: ${reminder.message}\n\n` +
        `📋 Task: ${task.title}\n` +
        `📂 Project: ${projectName}\n` +
        `👥 Team: ${teamName}\n` +
        `👤 Assigned to: ${user.name}\n` +
        `📧 Email: ${user.email}\n` +
        `📊 Status: ${task.status?.toUpperCase() || 'UNKNOWN'}`;      // Send to all platforms for this user
      // Use the original composite task ID to ensure proper cache key generation
      const compositeTaskId = reminder.taskId; // This is already the composite ID: taskId_userId
      console.log(`📝 Using composite task ID for notification: ${compositeTaskId}`);
      
      const notificationSent = await sendUserNotificationToAllPlatforms(
        targetUserId,
        reminderMessage,
        compositeTaskId, // Use composite ID to prevent duplicate detection issues
        false // Don't store in reminders table as it's already there
      );
      
      if (notificationSent) {
        console.log(`✅ Successfully sent cross-platform reminder to ${user.name} (${user.email})`);
      } else {
        console.error(`❌ Failed to send cross-platform reminder to ${user.name} (${user.email})`);
      }

      return;
    }

    // Send to all assignees using cross-platform notifications
    console.log(`📝 Notifying all assigned users: ${usersToNotify.join(', ')}`);
    
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

      console.log(`✅ Found assignee: ${assignee.name} (${assignee.email})`);      // Create detailed reminder message
      const taskMessage = `⏰ REMINDER: ${reminder.message}\n\n` +
        `📋 Task: ${task.title}\n` +
        `📂 Project: ${projectName}\n` +
        `👥 Team: ${teamName}\n` +
        `👤 Assigned to: ${assignee.name}\n` +
        `📧 Email: ${assignee.email}\n` +
        `📊 Status: ${task.status?.toUpperCase() || 'UNKNOWN'}`;

      // Send to all platforms for this user
      const notificationSent = await sendUserNotificationToAllPlatforms(
        userId,
        taskMessage,
        task.id,
        false // Don't store in reminders table as it's already there
      );
      
      if (notificationSent) {
        console.log(`✅ Successfully sent cross-platform reminder to ${assignee.name} (${assignee.email})`);
      } else {
        console.error(`❌ Failed to send cross-platform reminder to ${assignee.name} (${assignee.email})`);
      }
    }
  } catch (error) {
    console.error("❌ Error sending reminder:", error)
    if (error instanceof Error) {
      console.error("   Details:", error.message)
    }  }
}

// Helper function to send reminders directly through Slack (not cross-platform)
// Export this function so it can be used by botManager for welcome messages and non-task notifications
export async function sendDirectSlackReminder(reminder: { id: string; message: string; user_id: string; task_id: string }) {
  try {
    console.log(`🎯 Sending direct Slack reminder to user: ${reminder.user_id}`)
    
    // Get user's email and slack_email directly from users table
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("email, name, organization_id, slack_email")
      .eq("id", reminder.user_id)
      .single()

    if (userError || !user) {
      console.error("❌ User not found:", reminder.user_id)
      console.error("   Error:", userError?.message || "User not found")
      return
    }

    if (!user.slack_email) {
      console.error("❌ No Slack email found for user:", reminder.user_id)
      console.error("   User email:", user.email)
      return
    }    
    
    console.log(`✅ User email: ${user.email}`)
    console.log(`✅ User Slack email: ${user.slack_email}`)    
    
    // Find the appropriate bot instance (organization-specific or default)
    let botToUse = bot; // default bot
  
    // If user has organization_id, try to use organization-specific bot
    if (user.organization_id && orgBots[user.organization_id]) {
      botToUse = orgBots[user.organization_id];
      console.log(`📱 Using organization-specific bot for org: ${user.organization_id}`);
    } else {
      console.log(`📱 Using default bot`);
    }

    if (!botToUse) {
      console.error("❌ No bot instance available, can't send reminder")
      return
    }

    // Find Slack user ID from email address
    console.log(`🔍 Looking up Slack user ID for email: ${user.slack_email}`)
    let slackUserId = null;
    
    try {
      // Use users.lookupByEmail to find the Slack user ID
      const lookupResponse = await botToUse.client.users.lookupByEmail({
        email: user.slack_email
      });
      
      if (lookupResponse.ok && lookupResponse.user) {
        slackUserId = lookupResponse.user.id;
        console.log(`✅ Found Slack user ID: ${slackUserId} for email: ${user.slack_email}`);
      } else {
        console.error(`❌ Could not find Slack user with email: ${user.slack_email}`);
        return;
      }
    } catch (lookupError) {
      console.error(`❌ Error looking up Slack user by email:`, lookupError);
      return;
    }

    // Ensure slackUserId is not null before proceeding
    if (!slackUserId) {
      console.error(`❌ No valid Slack user ID found for email: ${user.slack_email}`);
      return;
    }

    // Try to open a direct message channel with the user
    console.log(`📱 Opening DM channel with user: ${slackUserId}`)
    let dmChannelId = slackUserId; // Default to user ID as fallback
    
    try {
      const dmResponse = await botToUse.client.conversations.open({
        users: slackUserId
      });
      
      if (dmResponse.ok && dmResponse.channel && dmResponse.channel.id) {
        dmChannelId = dmResponse.channel.id;
        console.log(`✅ Opened DM channel: ${dmChannelId}`);
      } else {
        console.log(`⚠️  Could not open DM channel, using user ID directly: ${slackUserId}`);
        dmChannelId = slackUserId; // Use user ID directly as fallback
      }
    } catch (dmError: any) {
      console.log(`⚠️  Error opening DM channel, using user ID directly: ${slackUserId}`);
      dmChannelId = slackUserId; // Use user ID directly as fallback
    }

    // Try to find recent conversation thread (only if we have a proper DM channel)
    console.log(`🔍 Looking for recent conversation with user to maintain threading...`)
    let threadTs = undefined;
    
    // Only try to get conversation history if we successfully opened a DM channel (not using fallback)
    if (dmChannelId && dmChannelId !== slackUserId) {
      try {
        // Look for recent conversations in the DM channel
        const conversationHistory = await botToUse.client.conversations.history({
          channel: dmChannelId,
          limit: 20 // Check last 20 messages for recent interactions
        });
        
        if (conversationHistory.ok && conversationHistory.messages && conversationHistory.messages.length > 0) {
          // Find the most recent message that is part of an existing thread or could start one
          const messages = conversationHistory.messages;
          
          // Look for the most recent message that has a thread_ts (is part of a thread)
          const recentThreadMessage = messages.find(msg => msg.thread_ts);
          
          if (recentThreadMessage) {
            // Continue the existing thread
            threadTs = recentThreadMessage.thread_ts;
            console.log(`🧵 Found existing conversation thread: ${threadTs}`);
          } else {
            // Look for the most recent message from the last 24 hours to continue that conversation
            const oneDayAgo = Date.now() / 1000 - (24 * 60 * 60); // 24 hours ago in Unix timestamp
            const recentMessage = messages.find(msg => {
              const messageTime = parseFloat(msg.ts || '0');
              return messageTime > oneDayAgo;
            });
            
            if (recentMessage) {
              // Use this message's timestamp to create a thread
              threadTs = recentMessage.ts;
              console.log(`🧵 Creating thread from recent message: ${threadTs}`);
            } else {
              console.log(`📭 No recent messages found, will send as new conversation`);
            }
          }
        } else {
          console.log(`📭 No conversation history found, will send as new conversation`);
        }
      } catch (historyError) {
        console.log(`⚠️  Could not fetch conversation history:`, historyError);
        // Continue without threading - this is not critical
      }
    } else {
      console.log(`⚠️  Using fallback method, skipping conversation history lookup`);
    }

    // Send reminder message to Slack using the DM channel ID with threading
    console.log(`💬 Sending reminder message to DM channel: ${dmChannelId}${threadTs ? ` (threaded: ${threadTs})` : ' (new message)'}`)

    const messageOptions: any = {
      channel: dmChannelId, // Use the DM channel ID
      text: reminder.message
    };
    
    // Add threading if we found a recent conversation
    if (threadTs) {
      messageOptions.thread_ts = threadTs;
    }

    await botToUse.client.chat.postMessage(messageOptions)

    console.log(`✅ Slack reminder message sent successfully`)
    console.log(`📤 Reminder sent to user ${reminder.user_id} (${user.email})`)
    
  } catch (error) {
    console.error("❌ Error sending direct Slack reminder:", error)
    if (error instanceof Error) {
      console.error("   Details:", error.message)
    }
  }
}

// Check for pending reminders
export async function checkReminders() {
  console.log(`\n🔍 checkReminders: Checking for pending reminders...`)
  console.log(`   Current time: ${new Date().toISOString()}`)
  try {
    const now = new Date().toISOString()

    // Get pending regular reminders
    const { data: pendingReminders, error } = await supabase
      .from("reminders")
      .select("*")
      .eq("sent", false)
      .lte("scheduled_for", now)
      .neq("type", "welcome")  // Exclude welcome messages - they're handled by welcomeService

    // Get pending custom reminders
    const { data: pendingCustomReminders, error: customError } = await supabase
      .from("custom_reminder")
      .select("*")
      .eq("sent", false)
      .lte("scheduled_for", now);

    if (error) {
      console.error("❌ Error fetching pending reminders:", error)
      return
    }

    if (customError) {
      console.error("❌ Error fetching custom reminders:", customError);
      // Continue processing regular reminders even if custom reminders fail
    }

    // Combine both types of reminders
    const allPendingReminders = [
      ...(pendingReminders || []),
      ...((pendingCustomReminders || []).map(cr => ({
        ...cr,
        type: 'custom', // Explicitly set type for custom reminders
        task_id: `custom_${cr.user_id}`, // Format task_id for custom reminders
        id: cr.id,
        message: cr.message,
        user_id: cr.user_id,
        scheduled_for: cr.scheduled_for
      })))
    ];

    if (!allPendingReminders?.length) {
      console.log("📭 No pending reminders found")
      return
    }

    console.log(`📬 Found ${allPendingReminders.length} pending reminders (${pendingReminders?.length || 0} regular, ${pendingCustomReminders?.length || 0} custom):`)
    allPendingReminders.forEach((reminder, index) => {
      console.log(`  ${index + 1}. ID: ${reminder.id}`)
      console.log(`     Message: ${reminder.message}`)
      console.log(`     Scheduled: ${reminder.scheduled_for}`)
      console.log(`     User: ${reminder.user_id}`)
      console.log(`     Task: ${reminder.task_id}`)
      console.log(`     Type: ${reminder.type || 'regular'}`)
    })

    for (const reminder of allPendingReminders) {
      await sendReminder({
        id: reminder.id,
        message: reminder.message || "Your task is due soon.",
        user_id: reminder.user_id,
        task_id: reminder.task_id
      })

      // Mark the reminder as sent after successful processing
      // Determine which table to update based on the reminder type
      const tableName = reminder.type === 'custom' ? "custom_reminder" : "reminders";
      await supabase
        .from(tableName)
        .update({
          sent: true,
          sent_at: new Date().toISOString(),
        })
        .eq("id", reminder.id);
    }

    console.log(`✅ Processed all ${allPendingReminders.length} pending reminders`)
  } catch (error) {
    console.error("❌ Error checking reminders:", error)
    if (error instanceof Error) {
      console.error("   Details:", error.message)
    }
  }
}

// Start reminder service
function startReminderService() {
  console.log("\n🚀 Starting reminder service...")

  // Check for pending reminders immediately
  console.log("   🔍 Performing initial reminder check...")
  checkReminders()

  // Set up interval to check for overdue reminders every 10 minutes
  console.log("   ⏱️  Setting up reminder check interval (10 minutes)...")
  const interval = setInterval(checkReminders, 10 * 60 * 1000) // Check every 10 minutes

  console.log("✅ Reminder service started successfully!")

  // Handle cleanup
  process.once("SIGINT", () => {
    console.log("\n⏹️  SIGINT received - stopping reminder service...")
    clearInterval(interval)
    console.log("✅ Reminder service stopped")
  })

  process.once("SIGTERM", () => {
    console.log("\n⏹️  SIGTERM received - stopping reminder service...")
    clearInterval(interval)
    console.log("✅ Reminder service stopped")
  })
}

// Start the bot with organization-specific configuration
export async function startBot(config?: OrgConfig) {
  // If no config is provided, use default configuration
  if (!config) {
    console.log("\n🤖 Starting default Slack bot...")
    console.log("   📝 Configuration:")
    console.log(`   - Supabase URL: ${supabaseUrl}`)
    console.log(`   - Service Key: ${supabaseServiceKey ? supabaseServiceKey.substring(0, 10) + "..." : "NOT SET"}`)

    try {
      // Fetch tokens from Supabase
      console.log("   🔍 Fetching tokens from database...")
      const { SLACK_APP_TOKEN, SLACK_BOT_TOKEN } = await getSlackTokens()
      console.log(`   - App Token: ${SLACK_APP_TOKEN ? SLACK_APP_TOKEN.substring(0, 10) + "..." : "NOT SET"}`)
      console.log(`   - Bot Token: ${SLACK_BOT_TOKEN ? SLACK_BOT_TOKEN.substring(0, 10) + "..." : "NOT SET"}`)

      if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
        console.error("SLACK_APP_TOKEN or SLACK_BOT_TOKEN is not defined in the database")
        return false
      }

      // Create Slack bot
      bot = new App.App({
        appToken: SLACK_APP_TOKEN,
        token: SLACK_BOT_TOKEN,
        socketMode: true,
        logLevel: LogLevel.ERROR,
      })

      // Register all the event handlers
      registerBotHandlers(bot)

      console.log("   🔌 Initializing bot connection...")
      await bot.start()
      console.log("✅ Slack bot started successfully!")

      console.log("   🚀 Starting reminder service...")
      startReminderService()

      console.log("   📡 Setting up process signals...")
      process.once("SIGINT", () => {
        console.log("\n⏹️  Received SIGINT - shutting down bot...")
        if (bot) bot.stop()
        console.log("✅ Slack bot stopped")
      })

      process.once("SIGTERM", () => {
        console.log("\n⏹️  Received SIGTERM - shutting down bot...")
        if (bot) bot.stop()
        console.log("✅ Slack bot stopped")
      })

      console.log("\n🎉 Bot is ready and listening for messages!")
      return true
    } catch (error: unknown) {
      console.error("❌ Error starting bot:", error)
      if (error instanceof Error) {
        console.error("   Details:", error.message)
        console.error("   Stack:", error.stack)
      }
      return false
    }
  } else {
    // Organization-specific bot initialization
    console.log(`\n🤖 Starting Slack bot for organization: ${config.orgName} (${config.orgId})...`)

    try {
      // Store the organization config
      const existingConfigIndex = orgConfigs.findIndex(c => c.orgId === config.orgId)
      if (existingConfigIndex >= 0) {
        orgConfigs[existingConfigIndex] = config
      } else {
        orgConfigs.push(config)
      }

      // Get tokens from settings or from database
      let SLACK_APP_TOKEN = config.settings.slack?.appToken || "";
      let SLACK_BOT_TOKEN = config.settings.slack?.botToken || "";

      // If tokens are not provided in settings, try to get them from the database
      if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
        console.log(`   🔍 Fetching tokens for organization ${config.orgName} from database...`)
        const tokens = await getSlackTokens(config.orgId)

        if (!SLACK_APP_TOKEN) SLACK_APP_TOKEN = tokens.SLACK_APP_TOKEN;
        if (!SLACK_BOT_TOKEN) SLACK_BOT_TOKEN = tokens.SLACK_BOT_TOKEN;

        console.log(`   - App Token: ${SLACK_APP_TOKEN ? SLACK_APP_TOKEN.substring(0, 10) + "..." : "NOT SET"}`)
        console.log(`   - Bot Token: ${SLACK_BOT_TOKEN ? SLACK_BOT_TOKEN.substring(0, 10) + "..." : "NOT SET"}`)
      }

      if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
        console.error(`SLACK_APP_TOKEN or SLACK_BOT_TOKEN is not defined for organization ${config.orgName}`)
        return false
      }

      // Create organization-specific bot instance
      orgBots[config.orgId] = new App.App({
        appToken: SLACK_APP_TOKEN,
        token: SLACK_BOT_TOKEN,
        socketMode: true,
        logLevel: LogLevel.ERROR,
      })

      // Create organization-specific agent
      // Use the slackBotAgent directly
      orgAgents[config.orgId] = slackBotAgent;
      
      // Original code was:
      // orgAgents[config.orgId] = slackBotAgent({
      //   supabase,
      //   orgId: config.orgId,
      //   orgName: config.orgName
      // })

      // Register all the event handlers for this organization's bot
      registerBotHandlers(orgBots[config.orgId], config.orgId)

      console.log(`   🔌 Initializing bot connection for organization ${config.orgName}...`)
      await orgBots[config.orgId].start()
      console.log(`✅ Slack bot for organization ${config.orgName} started successfully!`)

      console.log("\n🎉 Organization-specific bot is ready and listening for messages!")
      return true
    } catch (error: unknown) {
      console.error(`❌ Error starting bot for organization ${config.orgName}:`, error)
      if (error instanceof Error) {
        console.error("   Details:", error.message)
        console.error("   Stack:", error.stack)
      }
      return false
    }
  }
}

// Helper function to create task details form
async function createTaskDetailsForm(taskTitle: string, projectName?: string, teamName?: string, selectedUser?: any, assigneeState?: AssigneeSelectionState): Promise<any[]> {
  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Task:* ${taskTitle}\n*Project:* ${projectName || "Not set"}\n*Team:* ${teamName || "Not set"}\n\nPlease provide task details and click Create when ready:`
      }
    },
    {
      type: "input",
      block_id: "description_block",
      element: {
        type: "plain_text_input",
        action_id: "task_description_input",
        placeholder: {
          type: "plain_text",
          text: "Describe the task"
        }
      },
      label: {
        type: "plain_text",
        text: "Description (optional)"
      },
      optional: true
    },
    {
      type: "input",
      block_id: "deadline_block",
      element: {
        type: "datepicker",
        action_id: "task_deadline_date",
        placeholder: {
          type: "plain_text",
          text: "Select deadline"
        },
        initial_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // Default: 1 week from now
      },
      label: {
        type: "plain_text",
        text: "Deadline (Required)"
      }
    },
    {
      type: "section",
      block_id: "priority_block",
      text: {
        type: "mrkdwn",
        text: "*Priority:*"
      },      accessory: {
        type: "static_select",
        action_id: "task_priority_select",
        placeholder: {
          type: "plain_text",
          text: "Select priority",
          emoji: true
        },
        options: createPriorityOptions()
      }
    }
  ];
  
  // Show assignee information
  if (assigneeState && assigneeState.assigneeIds.length > 0) {
    // If we have multiple assignees from the multi-select process
    if (assigneeState.assigneeIds.length > 1) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Multiple Assignees (${assigneeState.assigneeIds.length}):*`
        }
      });
      
      // Show each assignee (up to 5 to prevent UI clutter)
      const maxAssigneesToShow = 5;
      const showingCount = Math.min(assigneeState.assigneeNames.length, maxAssigneesToShow);
      let assigneeText = "";
      
      for (let i = 0; i < showingCount; i++) {
        assigneeText += `• ${assigneeState.assigneeNames[i]} (${assigneeState.assigneeEmails[i]})\n`;
      }
      
      // If there are more assignees than we're showing
      if (assigneeState.assigneeIds.length > maxAssigneesToShow) {
        assigneeText += `• ...and ${assigneeState.assigneeIds.length - maxAssigneesToShow} more\n`;
      }
      
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: assigneeText
        }
      });
    }
    // Single assignee case (from assigneeState)
    else if (assigneeState.assigneeIds.length === 1) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Assigned to:* ${assigneeState.assigneeNames[0]} (${assigneeState.assigneeEmails[0]})`
        }
      });
    }
  }
  // Legacy single assignee case (from direct selection)
  else if (selectedUser) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Assigned to:* ${selectedUser.name} (${selectedUser.email})`
      }
    });
  }
  
  // Add Create Task button
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Create Task",
          emoji: true
        },
        action_id: "create_task_final",
        style: "primary"
      }
    ]
  });
    return blocks;
}

// Function to show the task edit form with current task details
async function showTaskEditForm(blockAction: any, client: any, user: User, task: any) {
  console.log(`✏️ Showing task edit form for task: ${task.title}`)

  try {
    // Format deadline for display
    const deadlineDisplay = task.deadline 
      ? new Date(task.deadline).toLocaleDateString()
      : "No deadline"

    // Get project name
    const projectName = (task.projects as any)?.name || "No project"

    // Format assigned users (since it's JSONB array)
    const assignedToIds = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to]
    let assigneeDisplay = "Loading..."
    
    // Get assignee names
    if (assignedToIds.length > 0) {
      const { data: assignees } = await supabase
        .from("users")
        .select("name, email")
        .in("id", assignedToIds)
      
      if (assignees && assignees.length > 0) {
        assigneeDisplay = assignees.map(a => `${a.name} (${a.email})`).join(", ")
      }
    }

    const taskInfo = `📋 *Editing Task:* ${task.title}\n\n` +
      `📝 *Description:* ${task.description || "No description"}\n` +
      `🔹 *Status:* ${task.status}\n` +
      `⭐ *Priority:* ${task.priority}\n` +
      `📅 *Deadline:* ${deadlineDisplay}\n` +
      `📂 *Project:* ${projectName}\n` +
      `👤 *Assigned to:* ${assigneeDisplay}\n\n` +
      `Select what you want to edit:`

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: taskInfo
        }
      },
      {
        type: "actions",
        block_id: "edit_options_row1",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "📝 Title",
              emoji: true
            },
            action_id: "edit_task_title",
            value: task.id
          },
          {
            type: "button", 
            text: {
              type: "plain_text",
              text: "📄 Description",
              emoji: true
            },
            action_id: "edit_task_description",
            value: task.id
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "⭐ Priority",
              emoji: true
            },
            action_id: "edit_task_priority",
            value: task.id
          }
        ]
      },
      {
        type: "actions",
        block_id: "edit_options_row2", 
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "📅 Deadline",
              emoji: true
            },
            action_id: "edit_task_deadline",
            value: task.id
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "🔄 Status",
              emoji: true
            },
            action_id: "edit_task_status",
            value: task.id
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "📂 Project",
              emoji: true
            },
            action_id: "edit_task_project",
            value: task.id
          }
        ]
      },
      {
        type: "actions",
        block_id: "edit_options_row3",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Done Editing",
              emoji: true
            },
            action_id: "finish_task_edit",
            style: "primary",
            value: task.id
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Cancel",
              emoji: true
            },
            action_id: "cancel_task_edit",
            value: task.id
          }
        ]
      }
    ]

    // Update the original message
    const messageTs = blockAction.message?.ts || ""

    await client.chat.update({
      channel: blockAction.channel?.id || "",
      ts: messageTs,
      blocks: blocks,
      metadata: {
        event_type: "task_edit",
        event_payload: {
          task_id: task.id,
          task_title: task.title,
          user_id: user.id,
          organization_id: user.organization_id
        }
      }
    })

  } catch (error) {
    console.error("❌ Error showing task edit form:", error)
    await client.chat.postMessage({
      channel: blockAction.user.id,
      text: "Sorry, I encountered an error while loading the task edit form."
    })
  }
}