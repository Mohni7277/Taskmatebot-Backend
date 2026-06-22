import { createClient } from "@supabase/supabase-js"
import dotenv from "dotenv"
import axios, { AxiosInstance } from "axios"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { storeTokenUsage, TokenUsageData } from "../utils/tokenUsage"
import { whatsappBotAgent } from "./agents/whatsappBotAgent"
import { getWeekDateRange } from "../utils/dateUtils"
import { sendNewTaskAssignmentNotification } from "../health"
import { 
  startSendReminderForm,
  handleReminderTypeSelection,
  handleReminderUserSelection,
  handleReminderTaskSelection,
  handleCustomReminderMessage,
  getReminderSession
} from "./whatsappReminderForms"
import { sendUserNotificationToAllPlatforms, hasReminderBeenSentRecently, storeNotificationLog } from "../botManager"

dotenv.config()


// TypeScript declarations for globals
declare global {
  namespace NodeJS {
    interface Global {
      whatsappReminderCache?: Map<string, number>;
      crossPlatformReminderCache?: Map<string, number>;
    }
  }
}

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Default environment variables (will be fetched from Supabase integration_tokens table)
let DEFAULT_WAAPI_API_KEY = process.env.WAAPI_API_KEY || ""
let DEFAULT_WAAPI_INSTANCE_ID = process.env.WAAPI_INSTANCE_ID || ""
let DEFAULT_WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3005")
let DEFAULT_SECURITY_TOKEN = process.env.SECURITY_TOKEN || ""

// Function to fetch WhatsApp integration tokens from Supabase
async function fetchWhatsAppTokens() {
  try {
    // Fetch tokens from integration_tokens table
    const { data: tokenData, error: tokenError } = await supabase
      .from("integration_tokens")
      .select("id, token_type, token_value, organization_id")
      .in("token_type", ["WHATSAPP_API", "WHATSAPP_INSTANCE_ID", "WHATSAPP_SECURITY_TOKEN"])
      .eq("is_active", true);

    if (tokenError) {
      console.error("Error fetching WhatsApp integration tokens:", tokenError);
    } else if (tokenData && tokenData.length > 0) {
      console.log(`Found ${tokenData.length} WhatsApp integration tokens`);

      // Group tokens by organization
      const orgTokens: Record<string, {
        apiKey?: string;
        instanceId?: string;
        securityToken?: string;
      }> = {};

      // Process each token and organize by organization_id
      for (const token of tokenData) {
        const orgId = token.organization_id || 'default';

        // Initialize organization tokens object if not exists
        if (!orgTokens[orgId]) {
          orgTokens[orgId] = {};
        }

        if (token.token_type === "WHATSAPP_API") {
          orgTokens[orgId].apiKey = token.token_value;
        } else if (token.token_type === "WHATSAPP_INSTANCE_ID") {
          orgTokens[orgId].instanceId = token.token_value;
        } else if (token.token_type === "WHATSAPP_SECURITY_TOKEN") {
          orgTokens[orgId].securityToken = token.token_value;
        }
      }

      // Process organization-specific tokens and set up clients/instance IDs
      for (const [orgId, tokens] of Object.entries(orgTokens)) {
        if (tokens.apiKey && tokens.instanceId && tokens.securityToken) {
          // Set up organization-specific WhatsApp API client
          waapiClients[orgId] = axios.create({
            baseURL: "https://waapi.app/api/v1",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${tokens.apiKey}`,
              "content-type": "application/json"
            }
          });

          // Set up configs for this organization if not already exists
          const existingConfigIndex = orgConfigs.findIndex(c => c.orgId === orgId);
          if (existingConfigIndex === -1) {
            // Create a basic config for this organization
            const orgConfig: OrgConfig = {
              orgId: orgId,
              orgName: orgId === 'default' ? 'Default Organization' : `Organization ${orgId}`,
              adminUsers: [],
              settings: {
                whatsapp: {
                  enabled: true,
                  apiKey: tokens.apiKey,
                  instanceId: tokens.instanceId,
                  securityToken: tokens.securityToken
                }
              }
            };

            orgConfigs.push(orgConfig);
          } else {
            // Update existing config with new token values
            if (!orgConfigs[existingConfigIndex].settings.whatsapp) {
              orgConfigs[existingConfigIndex].settings.whatsapp = {
                enabled: true
              };
            }

            orgConfigs[existingConfigIndex].settings.whatsapp.apiKey = tokens.apiKey;
            orgConfigs[existingConfigIndex].settings.whatsapp.instanceId = tokens.instanceId;
            orgConfigs[existingConfigIndex].settings.whatsapp.securityToken = tokens.securityToken;
          }

          // Register security tokens for this instance
          securityTokens[tokens.instanceId] = tokens.securityToken;
          // Also store the token directly with the token as the key for easier lookup
          securityTokens[tokens.securityToken] = tokens.securityToken;          console.log(`Set up WhatsApp integration for organization ${orgId} with instance ${tokens.instanceId}`);

          // Make sure the main handler is initialized before setting up organization handlers
          ensureMainWebhookHandler();

          // Webhook handlers are already set up globally - no need for individual setup
          console.log(`Organization ${orgId} configured for WhatsApp with security token: ${tokens.securityToken.substring(0, 10)}...`);

          // Use the first valid token as the default if not already set
          if (orgId === 'default' || (!DEFAULT_WAAPI_API_KEY && !DEFAULT_WAAPI_INSTANCE_ID && !DEFAULT_SECURITY_TOKEN)) {
            DEFAULT_WAAPI_API_KEY = tokens.apiKey;
            DEFAULT_WAAPI_INSTANCE_ID = tokens.instanceId;
            DEFAULT_SECURITY_TOKEN = tokens.securityToken;
            console.log(`Using organization ${orgId} tokens as default`);
          }
        } else {
          console.warn(`Incomplete token set for organization ${orgId}. Missing: ${!tokens.apiKey ? 'API key, ' : ''}${!tokens.instanceId ? 'instance ID, ' : ''}${!tokens.securityToken ? 'security token' : ''}`);
        }
      }
    } else {
      console.warn("No WhatsApp integration tokens found in database");
    }

    // If any token is still empty, use fallback values
    if (!DEFAULT_WAAPI_API_KEY) {
      DEFAULT_WAAPI_API_KEY = "sCkPKPtwi2OcgkMJRHn3juVKSY4p3RTVL28MQpaj12fe9dcb";
      console.warn("Using fallback WhatsApp API key");
    }

    if (!DEFAULT_WAAPI_INSTANCE_ID) {
      DEFAULT_WAAPI_INSTANCE_ID = "68075";
      console.warn("Using fallback WhatsApp instance ID");
    }

    if (!DEFAULT_SECURITY_TOKEN) {
      DEFAULT_SECURITY_TOKEN = "zC9kNq8RgSrorZJud3NL2jKbv9j01Tx6";
      console.warn("Using fallback WhatsApp security token");
    }

    // Register default security tokens if not already registered
    if (DEFAULT_WAAPI_INSTANCE_ID && DEFAULT_SECURITY_TOKEN) {
      if (!securityTokens[DEFAULT_WAAPI_INSTANCE_ID]) {
        securityTokens[DEFAULT_WAAPI_INSTANCE_ID] = DEFAULT_SECURITY_TOKEN;
      }
      if (!securityTokens[DEFAULT_SECURITY_TOKEN]) {
        securityTokens[DEFAULT_SECURITY_TOKEN] = DEFAULT_SECURITY_TOKEN;
      }
      console.log(`Registered default security token for instance ${DEFAULT_WAAPI_INSTANCE_ID}`);
    }
  } catch (error) {
    console.error("Error fetching WhatsApp integration tokens:", error);
  }
}

// Organization-specific configurations
interface OrgConfig {
  orgId: string;
  orgName: string;
  adminUsers: any[];
  settings: {
    whatsapp?: {
      enabled: boolean;
      adminNumber?: string;
      apiKey?: string;
      instanceId?: string;
      securityToken?: string;
      webhookPort?: number;
    };
    [key: string]: any;
  };
}

// Store organization-specific configurations
let orgConfigs: OrgConfig[] = []

// Store security tokens mapped to instance IDs
// Make securityTokens global so it can be accessed from anywhere
declare global {
  var whatsappSecurityTokens: Record<string, string>;
  var whatsappBotRunning: boolean;
}

// Initialize global security tokens
global.whatsappSecurityTokens = global.whatsappSecurityTokens || {};

// Local reference to global security tokens
const securityTokens: Record<string, string> = global.whatsappSecurityTokens;

// Token registration will happen after fetching tokens from Supabase

// Store WhatsApp API clients for each organization
const waapiClients: Record<string, AxiosInstance> = {}

// Create Hono app for webhook
const app = new Hono()

// Hono has built-in body parsing, no need for separate middleware

// Track if the main webhook handler has been initialized
let mainWebhookHandlerInitialized = false;

// Function to ensure the main webhook handler is initialized
function ensureMainWebhookHandler() {
  if (mainWebhookHandlerInitialized) {
    return true;
  }

  // Initialize the main webhook handler if it doesn't exist yet
  try {
    // Define a placeholder route pattern that will be overridden later
    // This ensures that the router is initialized properly
    app.post('/webhooks/whatsapp/:token', async (c) => {
      // This is a placeholder that should be replaced by the actual handler
      console.log("Placeholder handler called - this should not happen");
      return c.text("Placeholder handler", 200);
    });

    mainWebhookHandlerInitialized = true;
    console.log("Main webhook handler pattern registered successfully");
    return true;
  } catch (err) {
    console.error("Failed to initialize main webhook handler:", err);
    return false;
  }
}

// Hono handles errors differently - we'll add error handling in the route handlers

// Create default agent with supabase client
// Use the whatsappBotAgent directly
const agent = whatsappBotAgent

// Store organization-specific agents
const orgAgents: Record<string, any> = {}

let isBotRunning = false
let isReminderServiceRunning = false

// ===== CONVERSATION STATE MANAGEMENT =====

// Define the conversation state interface
interface ConversationState {
  stage: string;
  data: Record<string, any>;
  expiresAt: number;
}

// In-memory conversation state
const activeConversations: Record<string, ConversationState> = {};

// Helper to create/update conversation state
function updateConversationState(whatsappId: string, stage: string, data: any = {}) {
  // Merge with existing data if present
  const existingData = activeConversations[whatsappId]?.data || {};

  activeConversations[whatsappId] = {
    stage,
    data: { ...existingData, ...data },
    expiresAt: Date.now() + 30 * 60 * 1000 // 30 minute expiration
  };

  console.log(`Updated conversation state for ${whatsappId}: ${stage}`, data);
  return activeConversations[whatsappId];
}

// Get current conversation state
function getConversationState(whatsappId: string): ConversationState | null {
  const state = activeConversations[whatsappId];

  // Clear expired states
  if (state && state.expiresAt < Date.now()) {
    delete activeConversations[whatsappId];
    return null;
  }

  return state;
}

// Clear conversation state when complete
function clearConversationState(whatsappId: string) {
  delete activeConversations[whatsappId];
  console.log(`Cleared conversation state for ${whatsappId}`);
}

// Parse date from user input
function parseDateInput(input: string): Date | null {
  try {
    // Try to parse as ISO date
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
      return date;
    }

    // Try DD/MM/YYYY format
    const ddmmyyyy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/;
    const ddmmyyyyMatch = input.match(ddmmyyyy);
    if (ddmmyyyyMatch) {
      const [_, day, month, year] = ddmmyyyyMatch;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    // Try DD/MM format (assume current year)
    const ddmm = /^(\d{1,2})[\/\-](\d{1,2})$/;
    const ddmmMatch = input.match(ddmm);
    if (ddmmMatch) {
      const [_, day, month] = ddmmMatch;
      const date = new Date();
      date.setDate(parseInt(day));
      date.setMonth(parseInt(month) - 1);
      return date;
    }

    // Try relative dates
    const today = new Date();
    if (input.toLowerCase() === 'today') {
      return today;
    } else if (input.toLowerCase() === 'tomorrow') {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    } else if (input.toLowerCase().includes('next week')) {
      const nextWeek = new Date(today);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return nextWeek;
    } else if (input.toLowerCase().includes('next month')) {
      const nextMonth = new Date(today);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      return nextMonth;
    }

    return null;
  } catch (error) {
    console.error("Error parsing date:", error);
    return null;
  }
}

// ===== TASK & PROJECT HELPERS =====

// Function to send a simple text message
export async function sendMessage(chatId: string, message: string, orgId?: string) {
  try {
    // Find the organization config for this chat ID if not provided
    if (!orgId) {
      // Try to find the user in the database to get their organization
      const user = await getUserByWhatsAppId(chatId);
      if (user) {
        orgId = user.organization_id;
        console.log(`Found organization ID ${orgId} for user with WhatsApp ID ${chatId}`);
      } else {
        console.log(`No user found for WhatsApp ID ${chatId}, using default organization`);
      }
    }

    // Get the appropriate WhatsApp API client for this organization
    const client = getWaapiClient(orgId);
    const instanceId = getInstanceId(orgId);

    if (!client || !instanceId) {
      console.error(`No WhatsApp API client or instance ID found for organization ${orgId}, falling back to default`);
      // Fallback to default client if available
      const defaultClient = waapiClients['default'];
      if (!defaultClient || !DEFAULT_WAAPI_INSTANCE_ID) {
        console.error("No default WhatsApp API client or instance ID available");
        return null;
      }

      const response = await defaultClient.post(`/instances/${DEFAULT_WAAPI_INSTANCE_ID}/client/action/send-message`, {
        chatId: chatId,
        message: message
      });

      console.log(`Message sent to ${chatId} using default client: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
      return response.data;
    }

    // Using organization-specific client
    const response = await client.post(`/instances/${instanceId}/client/action/send-message`, {
      chatId: chatId,
      message: message
    });

    console.log(`Message sent to ${chatId} (org: ${orgId || 'unknown'}) using instance ${instanceId}: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
    return response.data;
  } catch (error) {
    console.error(`Error sending WhatsApp message (org: ${orgId || 'unknown'}):`, error);
    throw error;
  }
}

// Helper function to get the WhatsApp API client for an organization
function getWaapiClient(orgId?: string): AxiosInstance | null {
  // First check if we have a client specifically for this organization
  if (orgId && waapiClients[orgId]) {
    console.log(`Using organization-specific WhatsApp client for org: ${orgId}`);
    return waapiClients[orgId];
  }

  // If no organization-specific client found, try to find the organization in configs
  // to check if we need to create a client
  if (orgId) {
    const orgConfig = orgConfigs.find(c => c.orgId === orgId);
    if (orgConfig?.settings.whatsapp?.enabled && orgConfig?.settings.whatsapp.apiKey) {
      // Create a new client for this organization
      waapiClients[orgId] = axios.create({
        baseURL: "https://waapi.app/api/v1",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${orgConfig.settings.whatsapp.apiKey}`,
          "content-type": "application/json"
        }
      });

      console.log(`Created new WhatsApp API client for organization ${orgId}`);
      return waapiClients[orgId];
    } else {
      console.log(`No WhatsApp configuration found for organization ${orgId}, falling back to default`);
    }
  }

  // Create a default client if no organization-specific client is found
  if (!waapiClients['default']) {
    // Make sure we have fetched the latest tokens
    if (!DEFAULT_WAAPI_API_KEY) {
      console.warn("WhatsApp API key not loaded yet, using fallback");
      DEFAULT_WAAPI_API_KEY = "sCkPKPtwi2OcgkMJRHn3juVKSY4p3RTVL28MQpaj12fe9dcb";
    }

    waapiClients['default'] = axios.create({
      baseURL: "https://waapi.app/api/v1",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${DEFAULT_WAAPI_API_KEY}`,
        "content-type": "application/json"
      }
    });

    console.log("Created default WhatsApp API client");
  }

  return waapiClients['default'];
}

// Helper function to get the instance ID for an organization
function getInstanceId(orgId?: string): string | null {
  // First check for organization-specific instance ID
  if (orgId) {
    // Look for organization in configs
    const config = orgConfigs.find(c => c.orgId === orgId);
    if (config?.settings.whatsapp?.instanceId) {
      console.log(`Using instance ID ${config.settings.whatsapp.instanceId} for organization ${orgId}`);
      return config.settings.whatsapp.instanceId;
    }
  }

  // If no organization-specific instance ID found, use default
  if (DEFAULT_WAAPI_INSTANCE_ID) {
    console.log(`Using default instance ID ${DEFAULT_WAAPI_INSTANCE_ID}`);
    return DEFAULT_WAAPI_INSTANCE_ID;
  }

  console.warn("No instance ID available");
  return null;
}

// Helper function to get user by WhatsApp ID
async function getUserByWhatsAppId(whatsappId: string) {
  try {
    console.log(`Attempting to find user for WhatsApp ID: ${whatsappId}`);

    // Extract clean phone number without the @c.us suffix
    const cleanPhoneNumber = whatsappId.replace('@c.us', '');
    console.log(`Cleaned phone number: ${cleanPhoneNumber}`);

    // Extract the last 10 digits (standard Indian mobile number length)
    const lastTenDigits = cleanPhoneNumber.slice(-10);
    console.log(`Last 10 digits: ${lastTenDigits}`);

    // Only query for columns that actually exist in your database
    const { data: allUsers, error } = await supabase
      .from("users")
      .select("id, name, email, whatsapp_number, slack_email, teams_email, telegram_id, organization_id")
      .limit(50);

    if (error) {
      console.error("Error fetching users:", error);
      return null;
    }

    console.log(`Retrieved ${allUsers?.length || 0} users from database`);

    // Check each user for whatsapp_number match
    if (allUsers && allUsers.length > 0) {
      for (const user of allUsers) {
        // Skip if there's no WhatsApp number
        if (!user.whatsapp_number) continue;

        console.log(`Checking user ID: ${user.id}, WhatsApp: ${user.whatsapp_number}`);

        // Clean up the stored number (remove all non-digits)
        const storedNumber = String(user.whatsapp_number).replace(/\D/g, '');
        console.log(`WhatsApp number: ${user.whatsapp_number} (cleaned: ${storedNumber})`);

        // MATCHING LOGIC:

        // 1. Direct match with full phone number
        if (storedNumber === cleanPhoneNumber) {
          console.log(`✅ MATCH FOUND! Full number match for user ${user.id}`);
          return user;
        }

        // 2. Last 10 digits match (common scenario)
        if (storedNumber === lastTenDigits || storedNumber.endsWith(lastTenDigits)) {
          console.log(`✅ MATCH FOUND! Last 10 digits match for user ${user.id}`);
          return user;
        }

        // 3. Check if WhatsApp number (with country code) ends with stored number
        if (cleanPhoneNumber.endsWith(storedNumber)) {
          console.log(`✅ MATCH FOUND! WhatsApp number ends with stored number for user ${user.id}`);
          return user;
        }

        // 4. Special case for Indian numbers: check if adding country code 91 to stored number matches
        if (cleanPhoneNumber === `91${storedNumber}`) {
          console.log(`✅ MATCH FOUND! Adding country code to stored number matches for user ${user.id}`);
          return user;
        }

        // 5. Handle case where stored number might have country code but WhatsApp number doesn't
        const storedLastTen = storedNumber.slice(-10);
        if (lastTenDigits === storedLastTen) {
          console.log(`✅ MATCH FOUND! Last 10 digits match between WhatsApp and stored for user ${user.id}`);
          return user;
        }
      }
    }

    console.log(`❌ No user found with WhatsApp ID: ${whatsappId}`);
    return null;
  } catch (error) {
    console.error("Error getting user by WhatsApp ID:", error);
    return null;
  }
}

// Check if user is admin or manager
async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single();

    if (error || !data) {
      return false;
    }

    return data.role === 'admin' || data.role === 'manager';
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

// Check if user is team lead
async function isUserTeamLead(userId: string, teamId?: string): Promise<boolean> {
  try {
    let query = supabase
      .from("team_members")
      .select("*")
      .eq("user_id", userId)
      .eq("role", "lead");

    if (teamId) {
      query = query.eq("team_id", teamId);
    }

    const { data, error } = await query;

    if (error) {
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    console.error("Error checking if user is team lead:", error);
    return false;
  }
}

// Helper function to get available projects
async function getAvailableProjects(userId?: string) {
  try {
    // Get organization ID if we have a user ID
    let organizationId = null;
    if (userId) {
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("organization_id")
        .eq("id", userId)
        .single();

      if (userError) {
        console.error("Error getting user organization:", userError);
      } else if (userData && userData.organization_id) {
        organizationId = userData.organization_id;
        console.log("Using organization ID from user for projects:", organizationId);
      }
    }

    // Query projects, filtering by organization if we have one
    let query = supabase
      .from("projects")
      .select("id, name, team_id, organization_id")
      .order("name");

    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data, error } = await query;

    if (error) throw error

    // If no projects exist, create a default project
    if (!data || data.length === 0) {
      console.log("No projects found, creating a default project");
      const defaultProject = await createDefaultProject(userId);
      if (defaultProject) {
        return [defaultProject];
      }
    }

    return data || []
  } catch (error) {
    console.error("Error fetching projects:", error)
    return []
  }
}

// Helper function to create a default project if none exists
async function createDefaultProject(userId?: string) {
  try {
    // Get organization ID if we have a user ID
    let organizationId = null;
    if (userId) {
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("organization_id")
        .eq("id", userId)
        .single();

      if (userError) {
        console.error("Error getting user organization:", userError);
      } else if (userData && userData.organization_id) {
        organizationId = userData.organization_id;
        console.log("Using organization ID from user:", organizationId);
      }
    }

    // If we couldn't get an organization ID from the user, try to get the first organization
    if (!organizationId) {
      const { data: orgs, error: orgsError } = await supabase
        .from("organizations")
        .select("id")
        .limit(1);

      if (orgsError) {
        console.error("Error getting organizations:", orgsError);
      } else if (orgs && orgs.length > 0) {
        organizationId = orgs[0].id;
        console.log("Using first organization ID:", organizationId);
      } else {
        console.error("No organizations found in the database");
        return null;
      }
    }

    // First check if we have any teams
    const { data: teams, error: teamsError } = await supabase
      .from("teams")
      .select("id, name")
      .eq("organization_id", organizationId)
      .limit(1);

    if (teamsError) {
      console.error("Error checking teams:", teamsError);
      return null;
    }

    // Create a default team if none exists
    let teamId = null;
    if (!teams || teams.length === 0) {
      const { data: newTeam, error: teamError } = await supabase
        .from("teams")
        .insert({
          name: "Default Team",
          organization_id: organizationId
        })
        .select()
        .single();

      if (teamError) {
        console.error("Error creating default team:", teamError);
      } else {
        teamId = newTeam.id;
        console.log("Created default team:", newTeam);
      }
    } else {
      teamId = teams[0].id;
    }

    // Create the default project
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({
        name: "Default Project",
        team_id: teamId,
        organization_id: organizationId
      })
      .select()
      .single();

    if (projectError) {
      console.error("Error creating default project:", projectError);
      return null;
    }

    console.log("Created default project:", project);
    return project;
  } catch (error) {
    console.error("Error creating default project:", error);
    return null;
  }
}

// Helper function to get available teams
async function getAvailableTeams(userId?: string) {
  try {
    // Get organization ID if we have a user ID
    let organizationId = null;
    if (userId) {
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("organization_id")
        .eq("id", userId)
        .single();

      if (userError) {
        console.error("Error getting user organization:", userError);
      } else if (userData && userData.organization_id) {
        organizationId = userData.organization_id;
        console.log("Using organization ID from user for teams:", organizationId);
      }
    }

    // Query teams, filtering by organization if we have one
    let query = supabase
      .from("teams")
      .select("id, name, organization_id")
      .order("name");

    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data, error } = await query;

    if (error) throw error

    // If no teams exist, create a default team
    if (!data || data.length === 0) {
      console.log("No teams found, creating a default team");

      // Get the first organization if we don't have one
      if (!organizationId) {
        const { data: orgs, error: orgsError } = await supabase
          .from("organizations")
          .select("id")
          .limit(1);

        if (orgsError) {
          console.error("Error getting organizations:", orgsError);
          return [];
        } else if (orgs && orgs.length > 0) {
          organizationId = orgs[0].id;
          console.log("Using first organization ID for team:", organizationId);
        } else {
          console.error("No organizations found in the database");
          return [];
        }
      }

      const { data: newTeam, error: teamError } = await supabase
        .from("teams")
        .insert({
          name: "Default Team",
          organization_id: organizationId
        })
        .select()
        .single();

      if (teamError) {
        console.error("Error creating default team:", teamError);
        return [];
      }

      console.log("Created default team:", newTeam);
      return [newTeam];
    }

    return data || []
  } catch (error) {
    console.error("Error fetching teams:", error)
    return []
  }
}

// Helper function to get available users
async function getAvailableUsers() {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, name, email")
      .order("name")

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("Error fetching users:", error)
    return []
  }
}

// Helper function to get allowed status values - returns complete predefined set
async function getAllowedStatuses(): Promise<string[]> {
  // Return the complete set of valid statuses regardless of what exists in the database
  // This ensures all status options are always available in dropdowns
  return ['pending', 'in_progress', 'completed', 'cancelled']
}

// Helper function to get registration instructions
function getRegistrationInstructions(whatsappId: string) {
  const cleanPhoneNumber = whatsappId.replace('@c.us', '');
  const lastTenDigits = cleanPhoneNumber.slice(-10);

  return `⚠️ Access denied. Your WhatsApp number (${lastTenDigits}) is not registered in our system.

Please ask an administrator to add your number to your user profile, or update your profile with one of these formats:
- Full number: ${cleanPhoneNumber}
- Last 10 digits: ${lastTenDigits}

Once registered, try sending a message again.`;
}

// Helper function to ensure project has correct team ID
async function ensureProjectHasTeam(projectId: string, teamId: string): Promise<boolean> {
  try {
    // First check if the project already has this team
    const { data: project, error: getError } = await supabase
      .from("projects")
      .select("team_id")
      .eq("id", projectId)
      .single();

    if (getError) {
      console.error("Error checking project team:", getError);
      return false;
    }

    // If project already has this team, no need to update
    if (project && project.team_id === teamId) {
      console.log("Project already has correct team_id");
      return true;
    }

    // Update the project with the team_id
    const { error: updateError } = await supabase
      .from("projects")
      .update({ team_id: teamId })
      .eq("id", projectId);

    if (updateError) {
      console.error("Error updating project team:", updateError);
      return false;
    }

    console.log(`Project ${projectId} updated with team_id ${teamId}`);
    return true;
  } catch (error) {
    console.error("Error ensuring project has team:", error);
    return false;
  }
}

// ===== TASK CREATION FLOW - SIMPLIFIED =====

// Start task creation flow
async function startTaskCreationFlow(whatsappId: string, user: any) {
  updateConversationState(whatsappId, 'task_creation_name', {});

  await sendMessage(
    whatsappId,
    "📝 *Create New Task*\n\nLet's create a new task. What should I call this task? Please provide a brief name or description."
  );
}

// Handle task name input and show project selection
async function handleTaskNameInput(whatsappId: string, taskName: string, user: any) {
  // Store task name
  updateConversationState(whatsappId, 'task_creation_project', {
    taskName
  });

  // Get available projects for this user
  const projects = await getAvailableProjects(user.id);
  
  // Check if user is admin
  const isAdmin = await isUserAdmin(user.id);

  let message = `*Task:* ${taskName}\n\n*Available Projects*\nPlease select a project (reply with the number):\n\n`;

  projects.forEach((project, index) => {
    message += `${index + 1}. ${project.name}\n`;
  });
  
  // Add option to create new project for admins
  if (isAdmin) {
    message += `\n${projects.length + 1}. ➕ Create New Project\n`;
  }

  await sendMessage(whatsappId, message);
}

// Handle project selection and show team selection
async function handleProjectSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  const projects = await getAvailableProjects(user.id);
  const isAdmin = await isUserAdmin(user.id);
  let selectedProject;

  try {
    const selectionIndex = parseInt(selection) - 1;

    // Check if user selected "Create New Project"
    if (isAdmin && selectionIndex === projects.length) {
      // Start new project creation flow
      updateConversationState(whatsappId, 'project_creation_name', {
        ...state.data,
        returnToTaskCreation: true
      });
      
      await sendMessage(
        whatsappId,
        `*Task:* ${state.data.taskName}\n\n📝 *Create New Project*\n\nPlease enter the name for the new project:`
      );
      return;
    }

    if (selectionIndex >= 0 && selectionIndex < projects.length) {
      selectedProject = projects[selectionIndex];
    } else {
      // Show the project list again with an error message
      let errorMessage = "Invalid selection. Please select a valid project number.\n\n*Available Projects*\nPlease select a project (reply with the number):\n\n";

      projects.forEach((project, index) => {
        errorMessage += `${index + 1}. ${project.name}\n`;
      });
      
      if (isAdmin) {
        errorMessage += `\n${projects.length + 1}. ➕ Create New Project\n`;
      }

      await sendMessage(whatsappId, errorMessage);
      return;
    }
  } catch (e) {
    await sendMessage(whatsappId, "Please enter a valid project number.");
    return;
  }

  // Update state with selected project
  updateConversationState(whatsappId, 'task_creation_team', {
    ...state.data,
    projectId: selectedProject.id,
    projectName: selectedProject.name
  });
  // Get teams for selection
  const teams = await getAvailableTeams(user.id);

  let message = `*Task:* ${state.data.taskName}\n*Project:* ${selectedProject.name}\n\n*Available Teams*\nPlease select a team (reply with the number):\n\n`;

  teams.forEach((team, index) => {
    message += `${index + 1}. ${team.name}\n`;
  });
  
  // Add option to create new team for admins
  if (isAdmin) {
    message += `\n${teams.length + 1}. ➕ Create New Team\n`;
  }

  await sendMessage(whatsappId, message);
}

// Handle team selection and go to assignee selection
async function handleTeamSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  const teams = await getAvailableTeams(user.id);
  const isAdmin = await isUserAdmin(user.id);
  let selectedTeam;

  try {
    const selectionIndex = parseInt(selection) - 1;

    // Check if user selected "Create New Team"
    if (isAdmin && selectionIndex === teams.length) {
      // Start new team creation flow
      updateConversationState(whatsappId, 'team_creation_name', {
        ...state.data,
        returnToTaskCreation: true
      });
      
      await sendMessage(
        whatsappId,
        `*Task:* ${state.data.taskName}\n*Project:* ${state.data.projectName}\n\n📝 *Create New Team*\n\nPlease enter the name for the new team:`
      );
      return;
    }

    if (selectionIndex >= 0 && selectionIndex < teams.length) {
      selectedTeam = teams[selectionIndex];
    } else {
      // Show the team list again with an error message
      const teams = await getAvailableTeams();
      let errorMessage = "Invalid selection. Please select a valid team number.\n\n*Available Teams*\nPlease select a team (reply with the number):\n\n";

      teams.forEach((team, index) => {
        errorMessage += `${index + 1}. ${team.name}\n`;
      });
      
      if (isAdmin) {
        errorMessage += `\n${teams.length + 1}. ➕ Create New Team\n`;
      }

      await sendMessage(whatsappId, errorMessage);
      return;
    }
  } catch (e) {
    await sendMessage(whatsappId, "Please enter a valid team number.");
    return;
  }

  // Update state with selected team and move to assignee selection
  updateConversationState(whatsappId, 'task_creation_assignee', {
    ...state.data,
    teamId: selectedTeam.id,
    teamName: selectedTeam.name,
    // Initialize assignee arrays for multiple assignees
    assigneeIds: [],
    assigneeNames: [],
    assigneeEmails: []
  });

  // Make sure project has the correct team_id association
  await ensureProjectHasTeam(state.data.projectId, selectedTeam.id);

  await handleAssigneeSelection(whatsappId, state, user);
}

// Handle assignee selection and show options
async function handleAssigneeSelection(whatsappId: string, state: ConversationState, user: any) {
  // Check user permissions
  const isAdmin = await isUserAdmin(user.id);
  const isTeamLead = state.data.teamId ? 
    await isUserTeamLead(user.id, state.data.teamId) : 
    await isUserTeamLead(user.id);

  // If not admin or team lead, auto-assign to self
  if (!isAdmin && !isTeamLead) {
    const updatedState = updateConversationState(whatsappId, 'task_creation_deadline', {
      ...state.data,
      assigneeIds: [user.id],
      assigneeNames: [user.name],
      assigneeEmails: [user.email],
      // For backward compatibility
      assigneeId: user.id,
      assigneeName: user.name
    });

    await sendMessage(
      whatsappId,
      `*Task:* ${state.data.taskName}\n*Project:* ${state.data.projectName}\n*Team:* ${state.data.teamName}\n*Assigned to:* ${user.name} (You)\n\nAs a regular user, you can only create tasks assigned to yourself.\n\nPlease enter a deadline for this task (e.g., DD/MM/YYYY, "tomorrow", or "next week"):`
    );
    return;
  }

  // Get available users for assignment
  const users = await getAvailableUsers();
  
  let message = `*Task:* ${state.data.taskName}\n*Project:* ${state.data.projectName}\n*Team:* ${state.data.teamName}\n\n*Assign Task To:*\nSelect who should receive this task (reply with the number):\n\n`;
  
  // Add "Assign to me" option first
  message += `1. ${user.name} (You)\n`;
  
  // Add other users
  users.forEach((u, index) => {
    if (u.id !== user.id) { // Skip current user since they're already listed
      message += `${index + 2}. ${u.name} (${u.email})\n`;
    }
  });
  
  // Add multiple assignee option for admins/team leads
  message += `\n${users.length + 1}. Multiple people (select several users)\n`;
  
  // Show current assignees if any
  if (state.data.assigneeNames && state.data.assigneeNames.length > 0) {
    message += `\n*Currently assigned to:*\n`;
    state.data.assigneeNames.forEach((name: string, index: number) => {
      message += `• ${name}\n`;
    });
    message += `\n${users.length + 2}. Done selecting assignees\n`;
  }

  await sendMessage(whatsappId, message);
}

// Handle assignee selection input
async function handleAssigneeSelectionInput(whatsappId: string, selection: string, state: ConversationState, user: any) {
  const users = await getAvailableUsers();
  
  try {
    const selectionIndex = parseInt(selection) - 1;
    
    // Handle "Multiple people" option
    if (selectionIndex === users.length) {
      const updatedState = updateConversationState(whatsappId, 'task_creation_assignee', {
        ...state.data,
        multiAssigneeMode: true
      });
      
      await sendMessage(
        whatsappId,
        "✅ *Multiple assignee mode enabled.*\n\nYou can now select multiple people one by one. When done selecting, choose the 'Done selecting assignees' option."
      );
      
      await handleAssigneeSelection(whatsappId, updatedState, user);
      return;
    }
    
    // Handle "Done selecting assignees" option
    if (state.data.assigneeNames && state.data.assigneeNames.length > 0 && 
        selectionIndex === users.length + 1) {
      
      // Set backward compatibility fields
      const updatedState = updateConversationState(whatsappId, 'task_creation_deadline', {
        ...state.data,
        assigneeId: state.data.assigneeIds[0], // First assignee for compatibility
        assigneeName: state.data.assigneeNames[0]
      });
      
      let assigneeText = state.data.assigneeNames.length === 1 ? 
        state.data.assigneeNames[0] : 
        `${state.data.assigneeNames.length} people (${state.data.assigneeNames.join(', ')})`;
      
      await sendMessage(
        whatsappId,
        `*Task:* ${state.data.taskName}\n*Project:* ${state.data.projectName}\n*Team:* ${state.data.teamName}\n*Assigned to:* ${assigneeText}\n\nPlease enter a deadline for this task (e.g., DD/MM/YYYY, "tomorrow", or "next week"):`
      );
      return;
    }
      // Handle individual user selection
    let selectedUser;
    if (selectionIndex === 0) {
      // First option is current user
      selectedUser = { id: user.id, name: user.name, email: user.email };
    } else if (selectionIndex > 0 && selectionIndex < users.length + 1) {
      // Create a properly ordered list that matches the display
      const orderedUsers = [
        { id: user.id, name: user.name, email: user.email }, // Position 0 (displayed as "1")
        ...users.filter(u => u.id !== user.id) // Positions 1+ (displayed as "2", "3", etc.)
      ];
      
      // Get the user at the correct index (selectionIndex is 0-based after parsing)
      if (selectionIndex < orderedUsers.length) {
        selectedUser = orderedUsers[selectionIndex];
      }
    }
    
    if (!selectedUser) {
      await sendMessage(whatsappId, "Invalid selection. Please select a valid assignee number.");
      await handleAssigneeSelection(whatsappId, state, user);
      return;
    }
    
    // Check if user is already assigned (prevent duplicates)
    if (state.data.assigneeIds && state.data.assigneeIds.includes(selectedUser.id)) {
      await sendMessage(whatsappId, `${selectedUser.name} is already assigned to this task.`);
      await handleAssigneeSelection(whatsappId, state, user);
      return;
    }
    
    // Add assignee to arrays
    const updatedAssigneeIds = [...(state.data.assigneeIds || []), selectedUser.id];
    const updatedAssigneeNames = [...(state.data.assigneeNames || []), selectedUser.name];
    const updatedAssigneeEmails = [...(state.data.assigneeEmails || []), selectedUser.email];
    
    if (state.data.multiAssigneeMode) {
      // Multi-assignee mode - continue selecting
      const updatedState = updateConversationState(whatsappId, 'task_creation_assignee', {
        ...state.data,
        assigneeIds: updatedAssigneeIds,
        assigneeNames: updatedAssigneeNames,
        assigneeEmails: updatedAssigneeEmails
      });
      
      await sendMessage(
        whatsappId,
        `✅ Added ${selectedUser.name} to the task!\n\nYou can select more assignees or choose 'Done selecting assignees' to continue.`
      );
      
      await handleAssigneeSelection(whatsappId, updatedState, user);
    } else {
      // Single assignee mode - proceed to deadline
      const updatedState = updateConversationState(whatsappId, 'task_creation_deadline', {
        ...state.data,
        assigneeIds: updatedAssigneeIds,
        assigneeNames: updatedAssigneeNames,
        assigneeEmails: updatedAssigneeEmails,
        // For backward compatibility
        assigneeId: selectedUser.id,
        assigneeName: selectedUser.name
      });
      
      await sendMessage(
        whatsappId,
        `*Task:* ${state.data.taskName}\n*Project:* ${state.data.projectName}\n*Team:* ${state.data.teamName}\n*Assigned to:* ${selectedUser.name}\n\nPlease enter a deadline for this task (e.g., DD/MM/YYYY, "tomorrow", or "next week"):`
      );
    }
    
  } catch (e) {
    await sendMessage(whatsappId, "Please enter a valid assignee number.");
    await handleAssigneeSelection(whatsappId, state, user);
  }
}

// Handle deadline input and go to priority selection
async function handleTaskDeadline(whatsappId: string, deadlineInput: string, state: ConversationState, user: any) {
  const deadlineDate = parseDateInput(deadlineInput);

  if (!deadlineDate) {
    await sendMessage(
      whatsappId,
      "I couldn't understand that date format. Please try again with a format like DD/MM/YYYY, or words like 'tomorrow' or 'next week'."
    );
    return;
  }

  updateConversationState(whatsappId, 'task_creation_priority', {
    ...state.data,
    deadline: deadlineDate.toISOString()
  });

  await sendMessage(
    whatsappId,
    `*Task:* ${state.data.taskName}\n*Deadline:* ${deadlineDate.toLocaleDateString()}\n\nSelect priority (reply with number):\n\n1. Low\n2. Medium\n3. High\n4. Urgent`
  );
}

// Handle priority selection and create the task
async function handleTaskPriority(whatsappId: string, selection: string, state: ConversationState, user: any) {
  const priorities = ['low', 'medium', 'high', 'urgent'];
  let selectedPriority;

  try {
    const selectionIndex = parseInt(selection) - 1;

    if (selectionIndex >= 0 && selectionIndex < priorities.length) {
      selectedPriority = priorities[selectionIndex];
    } else {
      // Show the priority options again with an error message
      await sendMessage(
        whatsappId,
        `Invalid selection. Please select a valid priority number.\n\nSelect priority (reply with number):\n\n1. Low\n2. Medium\n3. High\n4. Urgent`
      );
      return;
    }
  } catch (e) {
    // Default to medium if input is not a number
    selectedPriority = 'medium';
  }

  // Now we have all the info, create the task directly
  try {    // Log all the data we have for debugging
    console.log("Creating task with data:", {
      taskName: state.data.taskName,
      assigneeIds: state.data.assigneeIds || [state.data.assigneeId],
      assigneeNames: state.data.assigneeNames || [state.data.assigneeName],
      projectId: state.data.projectId,
      projectName: state.data.projectName,
      teamId: state.data.teamId,
      teamName: state.data.teamName,
      deadline: state.data.deadline,
      priority: selectedPriority
    });

    // Validate required fields
    if (!state.data.taskName) {
      throw new Error("Task name is required");
    }

    if (!state.data.assigneeIds && !state.data.assigneeId) {
      throw new Error("Assignee ID is required");
    }

    if (!state.data.projectId) {
      throw new Error("Project ID is required");
    }

    // Get the organization ID from the first assignee (all assignees should be in same org)
    const assigneeIds = state.data.assigneeIds || [state.data.assigneeId];
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", assigneeIds[0])
      .single();

    if (userError) {
      console.error("Error getting user organization:", userError);
      throw new Error("Could not determine organization ID");
    }

    if (!userData || !userData.organization_id) {
      throw new Error("User does not have an organization ID");
    }

    console.log("User organization ID:", userData.organization_id);    // Create task in database
    const taskData = {
      title: state.data.taskName,
      description: state.data.taskName, // Use name as description if none provided
      assigned_to: assigneeIds, // Support multiple assignees
      project_id: state.data.projectId,
      status: "pending",
      priority: selectedPriority,
      deadline: state.data.deadline,
      created_at: new Date().toISOString(),
      organization_id: userData.organization_id, // Add organization ID
      created_by: user.id // Add the creator's ID to track who created the task
    };

    console.log("Inserting task with data:", taskData);

    // First check if the project exists
    const { data: projectCheck, error: projectError } = await supabase
      .from("projects")
      .select("id, name")
      .eq("id", state.data.projectId)
      .single();

    if (projectError) {
      console.error("Error checking project:", projectError);
      throw new Error(`Project not found: ${projectError.message}`);
    }

    console.log("Project check result:", projectCheck);    // Now insert the task
    const { data: newTask, error: taskError } = await supabase
      .from("tasks")
      .insert(taskData)
      .select()
      .single();

    if (taskError) {
      console.error("Database error creating task:", taskError);
      throw taskError;
    }

    console.log("Task created successfully:", newTask);    // Send immediate notification for task assignment
    try {
      const creatorName = user.name || user.email || 'Someone';
      const assigneeIds = state.data.assigneeIds || [state.data.assigneeId];
      await sendNewTaskAssignmentNotification(newTask.id, assigneeIds, creatorName);
      console.log("✅ Immediate task assignment notification sent successfully");
    } catch (notificationError) {
      console.error("❌ Error sending immediate task assignment notification:", notificationError);
      // Don't fail task creation if notification fails
    }    // Send confirmation message
    const assigneeNames = state.data.assigneeNames || [state.data.assigneeName];
    const assigneeText = assigneeNames.length === 1 ? 
      `${assigneeNames[0]}${assigneeNames[0] === user.name ? ' (You)' : ''}` :
      assigneeNames.join(', ');
      
    const responseMessage = `✅ Task created successfully!\n\n` +
      `*Task:* ${state.data.taskName}\n` +
      `*Assigned to:* ${assigneeText}\n` +
      `*Project:* ${state.data.projectName}\n` +
      `*Team:* ${state.data.teamName}\n` +
      `*Priority:* ${selectedPriority}\n` +
      `*Deadline:* ${new Date(state.data.deadline).toLocaleDateString()}\n`;

    // Send message with edit options text
    const messageWithOptions = responseMessage + 
      `\n\nWhat would you like to do next?\n` +
      `Reply with:\n` +
      `• "edit task" to modify this task\n` +
      `• "create task" to create another task`;
    
    await sendMessage(whatsappId, messageWithOptions);

    // Clear the conversation state
    clearConversationState(whatsappId);

  } catch (error) {
    console.error("Error creating task:", error);

    // Get more detailed error information
    let errorMessage = "There was a problem creating your task";

    if (error instanceof Error) {
      errorMessage = error.message;
      console.log("Error details:", error.stack);
    }

    // Check for specific error types
    if (errorMessage.includes("foreign key constraint")) {
      errorMessage = "One of the selected items doesn't exist in the database. Please try again.";

      // Try to identify which foreign key is the problem
      if (errorMessage.includes("project_id")) {
        errorMessage = "The selected project doesn't exist. Please try again.";
      } else if (errorMessage.includes("assigned_to")) {
        errorMessage = "There was a problem with the user assignment. Please try again.";
      }
    }

    await sendMessage(whatsappId, `Sorry, I couldn't create your task: ${errorMessage}\n\nLet's try again with a different approach.`);

    // Restart from project selection instead of task name
    await startTaskCreationFlow(whatsappId, user);
  }
}

// ===== PROJECT & TEAM CREATION FLOWS =====

// Handle new project creation
async function handleProjectCreation(whatsappId: string, projectName: string, state: ConversationState, user: any) {
  try {
    // Validate project name
    if (!projectName || projectName.trim().length === 0) {
      await sendMessage(whatsappId, "❌ Project name cannot be empty. Please enter a valid project name:");
      return;
    }

    if (projectName.trim().length > 100) {
      await sendMessage(whatsappId, "❌ Project name is too long (max 100 characters). Please enter a shorter name:");
      return;
    }

    // Get user's organization ID
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .single();

    if (userError || !userData || !userData.organization_id) {
      await sendMessage(whatsappId, "❌ Could not determine your organization. Please try again.");
      return;
    }

    // Check if project name already exists in the organization
    const { data: existingProject, error: checkError } = await supabase
      .from("projects")
      .select("id")
      .eq("name", projectName.trim())
      .eq("organization_id", userData.organization_id)
      .single();

    if (existingProject) {
      await sendMessage(whatsappId, `❌ A project named "${projectName.trim()}" already exists. Please choose a different name:`);
      return;
    }

    // Store project name and start collecting additional fields
    updateConversationState(whatsappId, 'project_creation_description', {
      ...state.data,
      projectName: projectName.trim(),
      organizationId: userData.organization_id
    });

    await sendMessage(whatsappId, `*Creating Project: ${projectName.trim()}*\n\nPlease provide a description for this project (or type "skip" to skip):`);

  } catch (error) {
    console.error("Error in project creation:", error);
    await sendMessage(whatsappId, "❌ An error occurred while creating the project. Please try again.");
  }
}

// Handle project description input
async function handleProjectDescriptionInput(whatsappId: string, description: string, state: ConversationState, user: any) {
  try {
    const projectDescription = description.trim().toLowerCase() === 'skip' ? null : description.trim();
    
    updateConversationState(whatsappId, 'project_creation_deadline', {
      ...state.data,
      projectDescription: projectDescription
    });

    await sendMessage(whatsappId, `*Project:* ${state.data.projectName}\n*Description:* ${projectDescription || 'None'}\n\nPlease provide a deadline for this project (DD/MM/YYYY, "next week", or type "skip" to skip):`);

  } catch (error) {
    console.error("Error in handleProjectDescriptionInput:", error);
    await sendMessage(whatsappId, "❌ Error processing description. Please try again.");
  }
}

// Handle project deadline input
async function handleProjectDeadlineInput(whatsappId: string, deadlineInput: string, state: ConversationState, user: any) {
  try {
    let projectDeadline = null;
    
    if (deadlineInput.trim().toLowerCase() !== 'skip') {
      projectDeadline = parseDateInput(deadlineInput);
      
      if (!projectDeadline) {
        await sendMessage(whatsappId, "❌ Invalid date format. Please try again with DD/MM/YYYY, 'next week', or 'skip':");
        return;
      }
    }

    updateConversationState(whatsappId, 'project_creation_lead', {
      ...state.data,
      projectDeadline: projectDeadline?.toISOString() || null
    });

    // Get available users for project lead selection
    const users = await getAvailableUsers();
    
    let message = `*Project:* ${state.data.projectName}\n*Deadline:* ${projectDeadline ? projectDeadline.toLocaleDateString() : 'None'}\n\n*Select Project Lead:*\nChoose who will lead this project (reply with the number):\n\n`;
    
    // Add current user as first option
    message += `1. ${user.name} (You)\n`;
    
    // Add other users
    let userIndex = 2;
    users.forEach((u, index) => {
      if (u.id !== user.id) {
        message += `${userIndex}. ${u.name} (${u.email})\n`;
        userIndex++;
      }
    });
    
    message += `\n${userIndex}. Skip (No project lead)\n`;
    
    // Store users for selection
    updateConversationState(whatsappId, 'project_creation_lead', {
      ...state.data,
      availableUsers: users
    });

    await sendMessage(whatsappId, message);

  } catch (error) {
    console.error("Error in handleProjectDeadlineInput:", error);
    await sendMessage(whatsappId, "❌ Error processing deadline. Please try again.");
  }
}

// Handle project lead selection
async function handleProjectLeadSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  try {
    const users = state.data.availableUsers || [];
    let selectedLead = null;
    
    const selectionIndex = parseInt(selection) - 1;
    
    if (selectionIndex === 0) {
      // Selected current user
      selectedLead = user;
    } else if (selectionIndex > 0 && selectionIndex <= users.length) {
      // Filter out current user and get the selected one
      const otherUsers = users.filter((u: any) => u.id !== user.id);
      if (selectionIndex - 1 < otherUsers.length) {
        selectedLead = otherUsers[selectionIndex - 1];
      }
    }
    // If selectionIndex is the last option (skip), selectedLead remains null

    // Now create the project with all collected information
    const projectData: any = {
      name: state.data.projectName,
      organization_id: state.data.organizationId,
      description: state.data.projectDescription || `Project created via WhatsApp bot`,
      deadline: state.data.projectDeadline,
      project_lead: selectedLead?.id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Include team_id if available in task creation context
    if (state.data.teamId) {
      projectData.team_id = state.data.teamId;
    }
    
    const { data: newProject, error: projectError } = await supabase
      .from("projects")
      .insert(projectData)
      .select()
      .single();

    if (projectError) {
      console.error("Error creating project:", projectError);
      await sendMessage(whatsappId, `❌ Error creating project: ${projectError.message}`);
      return;
    }

    // Update state with the new project and continue to team selection
    updateConversationState(whatsappId, 'task_creation_team', {
      ...state.data,
      projectId: newProject.id,
      projectName: newProject.name
    });

    // Create success message with all project details
    let successMessage = `✅ *Project "${newProject.name}" created successfully!*\n\n`;
    successMessage += `📝 *Description:* ${projectData.description}\n`;
    successMessage += `📅 *Deadline:* ${projectData.deadline ? new Date(projectData.deadline).toLocaleDateString() : 'None'}\n`;
    successMessage += `👤 *Project Lead:* ${selectedLead?.name || 'None'}\n\n`;
    successMessage += `*Task:* ${state.data.taskName}\n*Project:* ${newProject.name}\n\n`;

    // Get teams for selection
    const teams = await getAvailableTeams(user.id);
    const isAdmin = await isUserAdmin(user.id);

    successMessage += `*Available Teams*\nPlease select a team (reply with the number):\n\n`;

    teams.forEach((team, index) => {
      successMessage += `${index + 1}. ${team.name}\n`;
    });
    
    if (isAdmin) {
      successMessage += `\n${teams.length + 1}. ➕ Create New Team\n`;
    }

    await sendMessage(whatsappId, successMessage);

  } catch (error) {
    console.error("Error in handleProjectLeadSelection:", error);
    await sendMessage(whatsappId, "❌ An error occurred while creating the project. Please try again.");
  }
}

// Handle new team creation
async function handleTeamCreation(whatsappId: string, teamName: string, state: ConversationState, user: any) {
  try {
    // Validate team name
    if (!teamName || teamName.trim().length === 0) {
      await sendMessage(whatsappId, "❌ Team name cannot be empty. Please enter a valid team name:");
      return;
    }

    if (teamName.trim().length > 100) {
      await sendMessage(whatsappId, "❌ Team name is too long (max 100 characters). Please enter a shorter name:");
      return;
    }

    // Get user's organization ID
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .single();

    if (userError || !userData || !userData.organization_id) {
      await sendMessage(whatsappId, "❌ Could not determine your organization. Please try again.");
      return;
    }

    // Check if team name already exists in the organization
    const { data: existingTeam, error: checkError } = await supabase
      .from("teams")
      .select("id")
      .eq("name", teamName.trim())
      .eq("organization_id", userData.organization_id)
      .single();

    if (existingTeam) {
      await sendMessage(whatsappId, `❌ A team named "${teamName.trim()}" already exists. Please choose a different name:`);
      return;
    }

    // Create the new team
    const { data: newTeam, error: teamError } = await supabase
      .from("teams")
      .insert({
        name: teamName.trim(),
        organization_id: userData.organization_id
      })
      .select()
      .single();

    if (teamError) {
      console.error("Error creating team:", teamError);
      await sendMessage(whatsappId, `❌ Error creating team: ${teamError.message}`);
      return;
    }

    console.log("Created new team:", newTeam);

    // Update the project with the new team (if we have a project)
    if (state.data.projectId) {
      await ensureProjectHasTeam(state.data.projectId, newTeam.id);
    }

    // Update state with the new team and continue to assignee selection
    updateConversationState(whatsappId, 'task_creation_assignee', {
      ...state.data,
      teamId: newTeam.id,
      teamName: newTeam.name,
      // Initialize assignee arrays for multiple assignees
      assigneeIds: [],
      assigneeNames: [],
      assigneeEmails: []
    });

    await sendMessage(whatsappId, `✅ *Team "${newTeam.name}" created successfully!*\n\n*Task:* ${state.data.taskName}\n*Project:* ${state.data.projectName}\n*Team:* ${newTeam.name}\n\nNow let's assign this task...`);

    // Continue to assignee selection
    await handleAssigneeSelection(whatsappId, { stage: 'task_creation_assignee', data: state.data, expiresAt: 0 }, user);

  } catch (error) {
    console.error("Error in team creation:", error);
    await sendMessage(whatsappId, "❌ An error occurred while creating the team. Please try again.");
  }
}

// ===== TASK UPDATE FLOW - SIMPLIFIED =====

// Start task update flow
async function startTaskUpdateFlow(whatsappId: string, user: any) {
  // Get user's active tasks
  const { data: tasks, error } = await supabase
    .from("tasks")
    .select(`
      id,
      title,
      status,      projects (
        name      )    `)
    .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly format user ID for JSONB containment
    .order("created_at", { ascending: false })
    .limit(10);

  if (error || !tasks || tasks.length === 0) {
    await sendMessage(whatsappId, "You don't have any tasks to update.");
    return;
  }

  let message = "*🔄 Select a task to update:*\n\nReply with the number of the task you want to update:\n\n";

  tasks.forEach((task, index) => {
    message += `${index + 1}. ${task.title} (${task.status}) - ${task.projects?.[0]?.name || 'No Project'}\n`;
  });

  await sendMessage(whatsappId, message);

  // Update state
  updateConversationState(whatsappId, 'task_update_selection', {
    tasks
  });
}

// Handle task selection for update
async function handleTaskSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  const tasks = state.data.tasks;
  let selectedTask;

  try {
    const selectionIndex = parseInt(selection) - 1;

    if (selectionIndex >= 0 && selectionIndex < tasks.length) {
      selectedTask = tasks[selectionIndex];
    } else {
      await sendMessage(whatsappId, "Invalid selection. Please select a valid task number.");
      return;
    }
  } catch (e) {
    await sendMessage(whatsappId, "Please enter a valid task number.");
    return;
  }
  // Get allowed statuses
  const allowedStatuses = await getAllowedStatuses();
  const currentStatus = selectedTask.status;

  // Show all available statuses (don't filter out current status)
  const availableStatuses = allowedStatuses;

  // Map status emojis
  const statusEmojis: Record<string, string> = {
    'pending': '⏳',
    'in_progress': '🚧',
    'completed': '✅',
    'cancelled': '❌',
    'canceled': '❌'
  };

  let message = `*Selected Task:* ${selectedTask.title}\n*Current Status:* ${currentStatus}\n\nSelect new status (reply with the number):\n\n`;

  availableStatuses.forEach((status, index) => {
    const emoji = statusEmojis[status] || '📝';
    const displayStatus = status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');
    message += `${index + 1}. ${emoji} ${displayStatus}\n`;
  });

  await sendMessage(whatsappId, message);

  // Update state
  updateConversationState(whatsappId, 'task_update_status', {
    taskId: selectedTask.id,
    taskName: selectedTask.title,
    currentStatus,
    availableStatuses
  });
}

// Handle status update
async function handleStatusUpdate(whatsappId: string, selection: string, state: ConversationState, user: any) {
  const availableStatuses = state.data.availableStatuses;
  let newStatus;

  try {
    const selectionIndex = parseInt(selection) - 1;

    if (selectionIndex >= 0 && selectionIndex < availableStatuses.length) {
      newStatus = availableStatuses[selectionIndex];
    } else {
      await sendMessage(whatsappId, "Invalid selection. Please select a valid status number.");
      return;
    }
  } catch (e) {
    await sendMessage(whatsappId, "Please enter a valid status number.");
    return;
  }
  try {    // Update the task status in the database
    const { data: updatedTask, error } = await supabase
      .from("tasks")      .update({ status: newStatus })
      .eq("id", state.data.taskId)
      .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly format user ID for JSONB containment
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Send confirmation message
    await sendMessage(
      whatsappId,
      `✅ Task "${state.data.taskName}" has been updated to *${newStatus}*!`
    );

    // Clear conversation state
    clearConversationState(whatsappId);

  } catch (error: any) {
    console.error("Error updating task status:", error);
    await sendMessage(whatsappId, `Error updating task: ${error.message || "There was a problem with the database. Please try again."}\n\nYou can type "update task" to start over.`);
    clearConversationState(whatsappId);
  }
}

// ===== LIST TASKS FLOW =====

// List user's tasks
async function listUserTasks(whatsappId: string, user: any) {
  try {
    // Get user's tasks
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select(`
        id,
        title,
        status,
        priority,
        deadline,
        project_id,        projects (
          name,
          team_id,
          teams (
            name          )        )      `)
      .filter('assigned_to', 'cs', `["${user.id}"]`) // Fix: properly format user ID for JSONB containment
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    if (!tasks || tasks.length === 0) {
      await sendMessage(whatsappId, "You don't have any tasks.");
      return;
    }

    const statusEmoji: Record<string, string> = {
      'pending': '⏳',
      'in_progress': '🚧',
      'completed': '✅',
      'cancelled': '❌',
      'canceled': '❌'
    };

    // Group tasks by status
    const tasksByStatus: Record<string, any[]> = {};

    tasks.forEach(task => {
      if (!tasksByStatus[task.status]) {
        tasksByStatus[task.status] = [];
      }
      tasksByStatus[task.status].push(task);
    });

    // Format message
    let message = `📋 *Your Tasks:*\n\n`;

    // Orders to display statuses
    const statusOrder = ['in_progress', 'pending', 'completed', 'cancelled', 'canceled'];

    // Display tasks by status
    statusOrder.forEach(status => {
      if (tasksByStatus[status] && tasksByStatus[status].length > 0) {
        const emoji = statusEmoji[status] || '📝';
        const displayStatus = status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');
        message += `*${emoji} ${displayStatus} Tasks (${tasksByStatus[status].length}):*\n`;

        tasksByStatus[status].forEach((task, index) => {
          const dueDate = task.deadline ? new Date(task.deadline).toLocaleDateString() : "No due date";
          const projectName = task.projects?.name || "No project";

          // Improved team name handling
          let teamName = "No Team";
          if (task.projects?.team_id) {
            if (task.projects?.teams && task.projects.teams[0]) {
              teamName = task.projects.teams[0].name;
            } else {
              // Fetch team info directly if relation didn't work
              console.log(`Need to fetch team info for team_id: ${task.projects.team_id}`);
            }
          }

          message += `${index + 1}. *${task.title}*\n`;
          message += `   Due: ${dueDate} | Priority: ${task.priority.toUpperCase()}\n`;
          message += `   Project: ${projectName} | Team: ${teamName}\n\n`;
        });
      }
    });

    message += `Total: ${tasks.length} task${tasks.length > 1 ? 's' : ''}`;

    await sendMessage(whatsappId, message);
  } catch (error: any) {
    console.error("Error listing tasks:", error);
    await sendMessage(whatsappId, `Error listing tasks: ${error.message || "There was a problem with the database. Please try again."}\n\nYou can type "list tasks" to try again.`);
  }
}

// ===== MAIN CONVERSATION HANDLER =====

// Main conversation stage handler
async function handleConversationStage(whatsappId: string, message: string, state: ConversationState, user: any) {
  console.log(`Handling conversation stage: ${state.stage}`);

  // Allow users to cancel any flow
  if (message.toLowerCase() === 'cancel') {
    clearConversationState(whatsappId);
    await sendMessage(whatsappId, "Operation cancelled. What would you like to do next?");
    return;
  }

  switch (state.stage) {
    // Task creation flow
    case 'task_creation_name':
      await handleTaskNameInput(whatsappId, message, user);
      break;

    case 'task_creation_project':
      await handleProjectSelection(whatsappId, message, state, user);
      break;    case 'task_creation_team':
      await handleTeamSelection(whatsappId, message, state, user);
      break;

    case 'task_creation_assignee':
      await handleAssigneeSelectionInput(whatsappId, message, state, user);
      break;

    case 'task_creation_deadline':
      await handleTaskDeadline(whatsappId, message, state, user);
      break;

    case 'task_creation_priority':
      await handleTaskPriority(whatsappId, message, state, user);
      break;    // Task update flow
    case 'task_update_selection':
      await handleTaskSelection(whatsappId, message, state, user);
      break;    case 'task_update_status':
      await handleStatusUpdate(whatsappId, message, state, user);
      break;

    // Task editing flow
    case 'task_edit_selection':
      await handleTaskEditSelection(whatsappId, message, state, user);
      break;

    case 'task_edit_options':
      await handleTaskEditOptionSelection(whatsappId, message, state, user);
      break;

    case 'task_edit_field':
      await handleTaskEditFieldInput(whatsappId, message, state, user);
      break;

    case 'task_edit_project_creation':
      // Handle new project creation during task editing
      await handleProjectCreationForTaskEdit(whatsappId, message, state, user);
      break;    // Project creation flow
    case 'project_creation_name':
      await handleProjectCreation(whatsappId, message, state, user);
      break;

    case 'project_creation_description':
      await handleProjectDescriptionInput(whatsappId, message, state, user);
      break;

    case 'project_creation_deadline':
      await handleProjectDeadlineInput(whatsappId, message, state, user);
      break;

    case 'project_creation_lead':
      await handleProjectLeadSelection(whatsappId, message, state, user);
      break;

    // Project creation during task editing
    case 'project_edit_creation_description':
      await handleProjectEditDescriptionInput(whatsappId, message, state, user);
      break;

    case 'project_edit_creation_deadline':
      await handleProjectEditDeadlineInput(whatsappId, message, state, user);
      break;

    case 'project_edit_creation_lead':
      await handleProjectEditLeadSelection(whatsappId, message, state, user);
      break;    // Team creation flow
    case 'team_creation_name':
      await handleTeamCreation(whatsappId, message, state, user);
      break;

    // Send reminder flow stages
    case 'send_reminder_type':
      await handleReminderTypeSelection(whatsappId, message, user, sendMessage);
      break;

    case 'send_reminder_user':
      await handleReminderUserSelection(whatsappId, message, user, sendMessage);
      break;

    case 'send_reminder_task':
      await handleReminderTaskSelection(whatsappId, message, user, sendMessage);
      break;

    case 'send_reminder_custom_message':
      await handleCustomReminderMessage(whatsappId, message, user, sendMessage);
      break;    default:
      // Unknown state - reset conversation
      clearConversationState(whatsappId);
      await sendMessage(whatsappId, "I lost track of our conversation. Let's start over. What would you like to do?");
  }
}

// ===== REMINDER FLOW HANDLER =====

// Handle reminder flow separately from conversation stages
async function handleReminderFlow(whatsappId: string, message: string, reminderSession: any, user: any): Promise<boolean> {
  try {
    switch (reminderSession.step) {
      case 'reminder_type':
        return await handleReminderTypeSelection(whatsappId, message, user, sendMessage);
      
      case 'reminder_user':
        return await handleReminderUserSelection(whatsappId, message, user, sendMessage);
      
      case 'reminder_task':
        return await handleReminderTaskSelection(whatsappId, message, user, sendMessage);
      
      case 'reminder_custom_message':
        return await handleCustomReminderMessage(whatsappId, message, user, sendMessage);
      
      default:
        console.log(`Unknown reminder step: ${reminderSession.step}`);
        return false;
    }
  } catch (error) {
    console.error("Error handling reminder flow:", error);
    await sendMessage(whatsappId, "❌ Sorry, there was an error processing your reminder. Please try again.");
    return true;
  }
}

// ===== WEBHOOK HANDLERS =====

// Common webhook processing function
async function processWhatsAppWebhook(c: any, body: any, headers: any, orgId?: string, token?: string) {
  try {
    console.log("Processing WhatsApp webhook");
    console.log("Organization ID:", orgId || 'none');
    console.log("Token:", token || 'none');
    console.log("Headers:", JSON.stringify(headers));
    console.log("Body:", JSON.stringify(body).substring(0, 500));

    // Validate security for organization-specific webhooks
    if (orgId) {
      // Find organization configuration
      const orgConfig = orgConfigs.find(cfg => cfg.orgId === orgId);
      if (!orgConfig || !orgConfig.settings.whatsapp?.enabled) {
        console.error(`Organization ${orgId} not found or WhatsApp not enabled`);
        return c.json({ error: `Organization ${orgId} not found or WhatsApp not enabled` }, 404);
      }

      // Extract instance ID from headers or body (WAAPI sends it in headers as x-waapi-instance-id)
      const requestInstanceId = headers['x-waapi-instance-id'] || body.instanceId;
      console.log(`Request instance ID: ${requestInstanceId}, Configured instance ID: ${orgConfig.settings.whatsapp.instanceId}`);
      
      // More flexible instance ID validation - check both string and number formats
      if (requestInstanceId && orgConfig.settings.whatsapp.instanceId) {
        const configuredInstanceId = String(orgConfig.settings.whatsapp.instanceId);
        const receivedInstanceId = String(requestInstanceId);
        
        if (configuredInstanceId !== receivedInstanceId) {
          console.error(`Instance ID mismatch for organization ${orgId}. Expected: ${configuredInstanceId}, Got: ${receivedInstanceId}`);
          // Don't return error immediately - log warning but continue processing
          console.warn(`⚠️ Instance ID mismatch - proceeding anyway for organization ${orgId}`);
        }
      }

      console.log(`Organization webhook validated for: ${orgConfig.orgName} (${orgId})`);
    }

    // Validate security token for token-based webhooks ONLY if token is provided
    if (token) {
      // Extract organization ID and instance ID from request
      const requestInstanceId = body.instanceId || 'unknown';

      // Determine the organization ID based on token and instance

      let requestOrgId: string | undefined;

      // Look through organization configs to find matching token or instance
      for (const config of orgConfigs) {
        if (config.settings.whatsapp?.securityToken === token ||
            config.settings.whatsapp?.instanceId === requestInstanceId) {
          requestOrgId = config.orgId;
          orgId = requestOrgId; // Set orgId for processing
          console.log(`Request identified as coming from organization: ${config.orgName} (${config.orgId})`);
          break;
        }
      }

      // Register the token on the fly to ensure it works for default tokens
      if (token === DEFAULT_SECURITY_TOKEN || token === "zC9kNq8RgSrorZJud3NL2jKbv9j01Tx6") {
        securityTokens[token] = token;
        console.log(`Registered default token on the fly: ${token}`);
      }

      console.log(`Security tokens: ${JSON.stringify(securityTokens)}`);
      console.log(`Global security tokens: ${JSON.stringify(global.whatsappSecurityTokens || {})}`);

      // Check if the token is in our list of valid tokens
      if (!Object.values(securityTokens).includes(token)) {
        console.error(`Invalid security token: ${token}`);
        console.error(`Expected one of: ${Object.values(securityTokens).join(', ')}`);
        return c.text("Unauthorized", 401);
      }

      console.log(`Security token validated: ${token} for instance: ${requestInstanceId} (Organization: ${orgId || 'unknown'})`);
    } else if (!orgId) {
      // If neither orgId nor token is provided, this is an invalid request
      console.error("Neither organization ID nor security token provided");
      return c.text("Unauthorized - missing organization context", 401);
    }

    // Check if this is a verification request from WAAPI
    if (body.event === 'webhook_verification') {
      console.log("Webhook verification request received");
      return c.text("Webhook verified", 200);
    }

    // Extract data from the request body
    const { event, data } = body;
    const instanceId = body.instanceId || 'unknown';

    console.log(`Processing ${event} event from instance ${instanceId}`);

    // Only process message events
    if (event !== "message") {
      return c.text("Event acknowledged", 200);
    }

    // Check if message is from us (fromMe)
    if (data.message.fromMe) {
      return c.text("Own message, ignoring", 200);
    }

    const messageData = data.message;
    const whatsappId = messageData.from;
    const messageText = messageData.body || "";

    console.log(`Received message from ${whatsappId}: ${messageText}`);

    // Check if user exists in database
    let user = await getUserByWhatsAppId(whatsappId);

    // If user is not found in the database, reject the message
    if (!user) {
      console.log(`Security: Rejected message from unregistered WhatsApp ID: ${whatsappId}`);
      await sendMessage(whatsappId, getRegistrationInstructions(whatsappId), orgId);
      return c.text("Unauthorized user", 200);
    }

    // Check if this webhook is for a specific organization
    const queryParams = c.req.query();
    const finalOrgId = orgId || body.orgId || queryParams.orgId;
    if (finalOrgId && user.organization_id && user.organization_id !== finalOrgId) {
      console.log(`Security: Rejected message from user ${user.name} (${user.email}) with WhatsApp ID: ${whatsappId} - user belongs to organization ${user.organization_id} but webhook is for organization ${finalOrgId}`);
      await sendMessage(whatsappId, "⚠️ Access denied. You are not authorized to use this bot instance. Please contact your administrator.", finalOrgId);
      return c.text("Unauthorized organization", 200);
    }

    // Update the user's organization ID if it's not set but we know which organization this is from
    if (!user.organization_id && finalOrgId) {
      console.log(`User ${user.name} (${user.email}) has no organization ID but message is from organization ${finalOrgId}. Updating user.`);
      user.organization_id = finalOrgId;
    }

    // If we reach here, the user is authenticated
    console.log(`Security: Authenticated user ${user.name} (${user.email}) with WhatsApp ID: ${whatsappId}`);    // Check for active conversation first
    const conversationState = getConversationState(whatsappId);
    
    // Check for active reminder session
    const reminderSession = getReminderSession(whatsappId);
    
    if (reminderSession) {
      // Handle reminder flow based on current step
      const handled = await handleReminderFlow(whatsappId, messageText, reminderSession, user);
      if (handled) {
        return c.text("Reminder flow continued", 200);
      }
    }
    
    if (conversationState) {
      // Continue existing flow based on the current stage
      await handleConversationStage(whatsappId, messageText, conversationState, user);
      return c.text("Conversation continued", 200);
    }// Simple test case: respond to "hello"
    if (messageText.toLowerCase() === "hello") {
      await sendMessage(whatsappId,
        `Hello ${user.name}! I'm your task management assistant. What would you like to do?\n\n` +
        `1. Create Task\n` +
        `2. Update Task\n` +
        `3. Edit Task\n` +
        `4. View My Tasks\n\n` +
        `Reply with the option number.`
      );
      return c.text("Menu sent", 200);
    }

    // Handle menu selections with more natural language understanding for task creation
    if (messageText === "1" ||
        messageText.toLowerCase().includes('create task') ||
        messageText.toLowerCase().includes('new task') ||
        messageText.toLowerCase().includes('add task') ||
        messageText.toLowerCase().includes('make a task') ||
        messageText.toLowerCase().includes('i need to') ||
        messageText.toLowerCase().includes('create a new') ||
        messageText.toLowerCase().includes('add a new') ||
        messageText.toLowerCase().includes('prepare') ||
        messageText.toLowerCase().includes('work on') ||
        messageText.toLowerCase().includes('do a') ||
        messageText.toLowerCase().includes('start a') ||
        messageText.toLowerCase().includes('begin a') ||
        messageText.toLowerCase().includes('schedule') ||
        messageText.toLowerCase().includes('plan') ||
        messageText.toLowerCase().includes('organize') ||
        messageText.toLowerCase().includes('set up') ||
        messageText.toLowerCase().includes('need to get') ||
        messageText.toLowerCase().includes('have to') ||
        messageText.toLowerCase().includes('should') ||
        messageText.toLowerCase().includes('must') ||
        messageText.toLowerCase().includes('want to') ||
        messageText.toLowerCase().includes('would like to')) {
      await startTaskCreationFlow(whatsappId, user);
      return c.text("Task creation flow started", 200);
    }    if (messageText === "2" ||
        messageText.toLowerCase().includes('update task') ||
        messageText.toLowerCase().includes('change task') ||
        messageText.toLowerCase().includes('modify task') ||
        messageText.toLowerCase().includes('mark task') ||
        messageText.toLowerCase().includes('finished') ||
        messageText.toLowerCase().includes('completed') ||
        messageText.toLowerCase().includes('done with') ||
        messageText.toLowerCase().includes('complete task') ||
        messageText.toLowerCase().includes('task complete') ||
        messageText.toLowerCase().includes('update status') ||
        messageText.toLowerCase().includes('change status') ||
        messageText.toLowerCase().includes('mark as') ||
        messageText.toLowerCase().includes('set status') ||
        messageText.toLowerCase().includes('status update') ||
        messageText.toLowerCase().includes('i finished') ||
        messageText.toLowerCase().includes('task is done') ||
        messageText.toLowerCase().includes('task done')) {
      await startTaskUpdateFlow(whatsappId, user);
      return c.text("Task update flow started", 200);
    }

    // Dedicated task editing flow
    if (messageText.toLowerCase().includes('edit task') ||
        messageText.toLowerCase().includes('edit my task') ||
        messageText.toLowerCase().includes('modify a task') ||
        messageText.toLowerCase().includes('change task details')) {
      await showTaskEditForm(whatsappId, user);
      return c.text("Task editing flow started", 200);
    }    // Handle menu option 3 - Edit Task
    if (messageText === "3") {
      await showTaskEditForm(whatsappId, user);
      return c.text("Task editing flow started", 200);
    }    if (messageText === "4" ||
        messageText.toLowerCase().includes('my tasks') ||
        messageText.toLowerCase().includes('list tasks') ||
        messageText.toLowerCase().includes('show tasks') ||
        messageText.toLowerCase().includes('view tasks') ||
        messageText.toLowerCase().includes('see my tasks') ||
        messageText.toLowerCase().includes('what do i have') ||
        messageText.toLowerCase().includes('pending tasks') ||
        messageText.toLowerCase().includes('what tasks')) {
      await listUserTasks(whatsappId, user);
      return c.text("Tasks listed", 200);
    }

    // Check for send reminder intent (admin only)
    const lowerText = messageText.toLowerCase().trim();
    if (await isUserAdmin(user.id)) {
      const reminderKeywords = [
        "remind", "reminder", "send reminder", "create reminder", "admin reminder",
        "send a reminder", "set reminder", "reminder to", "remind user", "notify",
        "notification", "notification to", "send notif", "send notification"
      ];
      
      // Check exact matches
      if (lowerText === "remind" || lowerText === "reminder" || lowerText === "reminders" ||
          lowerText === "notifications" || lowerText === "notification") {
        await startSendReminderForm(whatsappId, user, sendMessage);
        return c.text("Reminder form started", 200);
      }
      
      // Check keyword matches
      for (const keyword of reminderKeywords) {
        if (lowerText.includes(keyword)) {
          await startSendReminderForm(whatsappId, user, sendMessage);
          return c.text("Reminder form started", 200);
        }
      }
      
      // Check for common phrases
      if ((lowerText.includes("send") && (lowerText.includes("notification") || lowerText.includes("notif"))) ||
          (lowerText.includes("send") && lowerText.includes("rem")) ||
          (lowerText.includes("create") && lowerText.includes("rem")) ||
          lowerText.includes("about reminder") ||
          lowerText.includes("about sending reminder") ||
          lowerText.includes("remind someone") ||
          lowerText.includes("i want to remind") || 
          lowerText.includes("need to remind") ||
          lowerText.includes("want to send a reminder") ||
          lowerText.includes("want to create a reminder")) {
        await startSendReminderForm(whatsappId, user, sendMessage);
        return c.text("Reminder form started", 200);
      }
    }

    // Menu command
    if (messageText.toLowerCase() === 'menu' || messageText.toLowerCase() === 'help') {
      await sendMessage(
        whatsappId,
        `*📋 Main Menu*\n\nPlease select an option:\n\n1. Create Task\n2. Update Task\n3. Edit Task\n4. View My Tasks\n\nReply with the option number.`
      );
      return c.text("Menu sent", 200);
    }

    // Create memory thread ID based on user's WhatsApp ID
    const threadId = `whatsapp_${whatsappId}`;
    // Use user's database ID as the resource ID
    const resourceId = user.id;

    try {
      // Try to use the agent's stream method
      console.log("Attempting to use agent.stream method");

      // Show typing indicator to user
      try {
        const client = getWaapiClient(user.organization_id);
        const instanceId = getInstanceId(user.organization_id);

        if (client && instanceId) {
          await client.post(`/instances/${instanceId}/client/action/chatting`, {
            chatId: whatsappId
          });
          console.log("Sent typing indicator to user");
        }
      } catch (typingError) {
        console.error("Error sending typing indicator:", typingError);
        // Continue even if typing indicator fails
      }

      try {
        // Use organization-specific agent if available
        const userOrgId = user.organization_id || finalOrgId;
        const agentToUse = (userOrgId && orgAgents[userOrgId]) ? orgAgents[userOrgId] : agent;        console.log(`Using ${userOrgId && orgAgents[userOrgId] ? 'organization-specific' : 'default'} agent for user ${user.name} (${user.email})`);

        // SECURITY: Sanitize user message to prevent identity spoofing
        let sanitizedText = messageText;
        
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
        
        if (sanitizedText !== messageText) {
          console.log(`🚨 SECURITY: Filtered potentially malicious content from WhatsApp message`);
        }        // First try the stream method
        const streamResponse = await agentToUse.stream(sanitizedText, {
          threadId,
          resourceId,
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
                platform_type: 'whatsapp',
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
                    console.log(`✅ Token usage data stored for user ${user.id} on whatsapp`);
                  }
                })
                .catch(error => {
                  console.error("Error storing token usage data:", error);
                });
            }
          },
          instructions: `Context: My name is ${user.name}, my email is ${user.email}, my WhatsApp ID is ${whatsappId}`
        });

        // Since WhatsApp doesn't support streaming responses, collect the full response
        let responseText = "";
        for await (const chunk of streamResponse.textStream) {
          responseText += chunk;
        }

        // Send the response
        await sendMessage(whatsappId, responseText);

        // Check for tool calls
        const toolCalls = await streamResponse.toolCalls;

        // Process tool calls
        if (toolCalls && toolCalls.length > 0) {
          await processToolCalls(whatsappId, toolCalls);
        }
      } catch (streamError) {
        console.error("Error using agent.stream method:", streamError);

        try {
          // Try a second stream attempt as a fallback
          console.log("Trying agent.stream method again as fallback");
          const userOrgId = user.organization_id || finalOrgId;
          const agentToUse = (userOrgId && orgAgents[userOrgId]) ? orgAgents[userOrgId] : agent;

          const streamResponse = await agentToUse.stream(messageText, {
            threadId: `whatsapp_fallback_${whatsappId}`,
            resourceId,
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
              console.log("Stream complete (fallback):", {
                totalSteps: steps.length,
                finishReason,
                providerMetadata,
                usage
              });
              
              // Store token usage data in the database
              if (usage) {
                const tokenUsageData: TokenUsageData = {
                  user_id: user.id,
                  platform_type: 'whatsapp',
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
                      console.log(`✅ Token usage data stored for user ${user.id} on whatsapp (fallback)`);
                    }
                  })
                  .catch(error => {
                    console.error("Error storing token usage data:", error);
                  });
              }
            },
            instructions: `Context: My name is ${user.name}, my email is ${user.email}, my WhatsApp ID is ${whatsappId}`
          });

          // Since WhatsApp doesn't support streaming responses, collect the full response
          let responseText = "";
          for await (const chunk of streamResponse.textStream) {
            responseText += chunk;
          }

          // Send the response
          await sendMessage(whatsappId, responseText);

          // Check for tool calls
          const toolCalls = await streamResponse.toolCalls;

          // Process tool calls
          if (toolCalls && toolCalls.length > 0) {
            await processToolCalls(whatsappId, toolCalls);
          }
        } catch (secondStreamError) {
          console.error("Error using agent.stream method (second attempt):", secondStreamError);

          // Check if the message might be a task creation intent
          const taskCreationPatterns = [
            'need to', 'have to', 'want to', 'should', 'must', 'would like to',
            'prepare', 'create', 'make', 'add', 'start', 'begin', 'schedule', 'plan',
            'organize', 'set up', 'do a', 'work on'
          ];          // Check if message contains task creation intent
          const hasTaskCreationIntent = taskCreationPatterns.some(pattern =>
            messageText.toLowerCase().includes(pattern)
          );

          // Check for status update intent patterns
          const statusUpdatePatterns = [
            'finished', 'completed', 'done', 'complete', 'did', 'accomplished', 
            'wrapped up', 'finalized', 'delivered', 'submitted', 'concluded'
          ];
          
          const hasStatusUpdateIntent = statusUpdatePatterns.some(pattern =>
            messageText.toLowerCase().includes(pattern)
          ) && (
            messageText.toLowerCase().includes('task') ||
            messageText.toLowerCase().includes('work') ||
            messageText.toLowerCase().includes('project') ||
            messageText.toLowerCase().includes('assignment') ||
            messageText.toLowerCase().includes('the ') // e.g., "finished the report"
          );

          // Priority: status update intent over task creation
          if (hasStatusUpdateIntent) {
            console.log("Detected status update intent, starting task update flow");
            await startTaskUpdateFlow(whatsappId, user);
          } else if (hasTaskCreationIntent && !messageText.toLowerCase().includes('show') &&
              !messageText.toLowerCase().includes('list') && !messageText.toLowerCase().includes('view')) {
            console.log("Detected task creation intent, starting task creation flow");
            await startTaskCreationFlow(whatsappId, user);} else if (messageText.toLowerCase().includes("task") || messageText.toLowerCase().includes("project") || messageText.toLowerCase().includes("reminder")) {
            // If message contains task-related keywords
            await sendMessage(whatsappId, `Hi ${user.name}, I can help you with tasks, projects, and reminders. Please try one of these commands:\n\n1. Create Task\n2. Update Task\n3. Edit Task\n4. View My Tasks`);
          } else {
            // Generic fallback
            await sendMessage(whatsappId, `Hi ${user.name}, I'm here to help you manage your tasks. You can ask me to create tasks, edit tasks, show your tasks, or help with reminders. What would you like to do today?`);
          }}
      } // Close the try block that was opened for the second stream attempt
    } catch (error) {
      console.error("Error processing message:", error);

      try {        // Last resort fallback
        await sendMessage(whatsappId, `Hi ${user.name}, I'm having trouble processing your request right now. Please try again or use one of these commands:\n\n1. Create Task\n2. Update Task\n3. Edit Task\n4. View My Tasks`);
      } catch (sendError) {
        console.error("Error sending fallback message:", sendError);
      }

      // Return early since we've handled the response
      return c.text("Message processed with fallback", 200);
    }

    // Function to process tool calls
    async function processToolCalls(whatsappId: string, toolCalls: any[]) {

      const toolCall = toolCalls[0];

      // Handle task creation
      if (toolCall.toolName === "create_task") {
        const taskData = toolCall.args as any;

        if (taskData.success) {
          let responseMessage =
            `✅ Task created successfully!\n\n` +
            `Task: ${taskData.taskName}\n` +
            `Assigned to: ${taskData.assignedTo}\n` +
            `Email: ${taskData.emailAddress}\n`;

          if (taskData.dueDate) {
            responseMessage += `Due: ${new Date(taskData.dueDate).toLocaleDateString()}\n`;
          }

          if (taskData.priority) {
            responseMessage += `Priority: ${taskData.priority}\n`;
          }

          if (taskData.project) {
            responseMessage += `Project: ${taskData.project}${taskData.projectCreated ? " (newly created)" : ""}\n`;
          }          if (taskData.team) {
            responseMessage += `Team: ${taskData.team}${taskData.teamCreated ? " (newly created)" : ""}\n`;
          }          // Send message with edit options text
          const messageWithOptions = responseMessage + 
            `\n\nWhat would you like to do next?\n` +
            `Reply with:\n` +
            `• "edit task" to modify this task\n` +
            `• "create task" to create another task`;
          
          await sendMessage(whatsappId, messageWithOptions);
        } else {
          await sendMessage(whatsappId, `Error creating task: ${taskData.message || "There was a problem with the database. Please try again."}\n\nYou can type "create task" to start over.`);
        }
      }

      // Handle status update
      if (toolCall.toolName === "update_status") {
        const statusData = toolCall.args as any;

        if (statusData.success) {
          await sendMessage(whatsappId, `✅ Task "${statusData.taskName}" marked as ${statusData.status}!`);
        } else {
          await sendMessage(whatsappId, `Error updating task: ${statusData.message || "There was a problem with the database. Please try again."}\n\nYou can type "update task" to start over.`);
        }
      }      // Handle reminder creation
      if (toolCall.toolName === "create_reminder") {
        const reminderData = toolCall.args as any;

        if (reminderData.success) {
          await sendMessage(
            whatsappId,
            `⏰ Reminder set for task "${reminderData.taskName}" at ${new Date(reminderData.scheduledFor).toLocaleString()}`,
          );
        } else {
          await sendMessage(whatsappId, `Error setting reminder: ${reminderData.message || "There was a problem with the database. Please try again."}\n\nYou can type "create reminder" to start over.`);
        }
      }

      // Handle attendance check-in/check-out
      if (toolCall.toolName === "attendance_tool") {
        const attendanceData = toolCall.args as any;

        if (attendanceData.success) {
          const action = attendanceData.action;
          const status = attendanceData.status;
          const workHours = attendanceData.work_hours;
          const locationText = attendanceData.location ? `\n📍 *Location:* ${attendanceData.location}` : '';
          const notesText = attendanceData.notes ? `\n📝 *Notes:* ${attendanceData.notes}` : '';
          
          if (action === 'check_in') {
            await sendMessage(whatsappId, `✅ *Checked In Successfully!*\n⏰ *Time:* ${new Date(attendanceData.checkIn).toLocaleString()}\n📊 *Status:* ${status.toUpperCase()}${locationText}${notesText}`);
          } else if (action === 'check_out') {
            const hoursText = workHours ? `\n🕐 *Work Hours:* ${workHours} hours` : '';
            await sendMessage(whatsappId, `🏁 *Checked Out Successfully!*\n⏰ *Time:* ${new Date(attendanceData.checkOut).toLocaleString()}${hoursText}${locationText}${notesText}`);
          }
        } else {
          await sendMessage(whatsappId, `❌ Attendance Error: ${attendanceData.message || "There was a problem with attendance tracking. Please try again."}`);
        }
      }

      // Handle attendance status check
      if (toolCall.toolName === "attendance_status_tool") {
        const statusData = toolCall.args as any;

        if (statusData.success) {
          let response = `📊 *Attendance Status*\n\n`;
          
          if (statusData.todayRecord) {
            const record = statusData.todayRecord;
            response += `*Today (${new Date(record.date).toLocaleDateString()}):*\n`;
            response += `• Check-in: ${record.check_in ? new Date(record.check_in).toLocaleTimeString() : 'Not checked in'}\n`;
            response += `• Check-out: ${record.check_out ? new Date(record.check_out).toLocaleTimeString() : 'Not checked out'}\n`;
            response += `• Status: ${record.status}\n`;
            if (record.work_hours) response += `• Work Hours: ${record.work_hours} hours\n`;
            if (record.location) response += `• Location: ${record.location}\n`;
            response += `\n`;
          } else {
            response += `*Today:* No attendance record found\n\n`;
          }

          if (statusData.recentRecords && statusData.recentRecords.length > 0) {
            response += `*Recent Records:*\n`;
            statusData.recentRecords.slice(0, 5).forEach((record: any) => {
              const date = new Date(record.date).toLocaleDateString();
              const checkIn = record.check_in ? new Date(record.check_in).toLocaleTimeString() : 'N/A';
              const checkOut = record.check_out ? new Date(record.check_out).toLocaleTimeString() : 'N/A';
              response += `• ${date}: ${checkIn} - ${checkOut} (${record.status})\n`;
            });
          }

          if (statusData.monthlySummary) {
            const summary = statusData.monthlySummary;
            response += `\n*This Month Summary:*\n`;
            response += `• Total Days: ${summary.total_days || 0}\n`;
            response += `• Present: ${summary.days_present || 0}\n`;
            response += `• Late: ${summary.days_late || 0}\n`;
            response += `• Half Day: ${summary.days_half_day || 0}\n`;
            response += `• Total Hours: ${summary.total_hours || 0}\n`;
          }

          await sendMessage(whatsappId, response);
        } else {
          await sendMessage(whatsappId, `❌ Error fetching attendance status: ${statusData.message || "There was a problem fetching your attendance information. Please try again."}`);
        }
      }
    }

    return c.text("Message processed", 200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    return c.text("Error processing webhook", 500);
  }
}

// Organization-specific WhatsApp webhook endpoint
app.post('/org/:orgId/whatsapp/webhook', async (c) => {
  console.log("Received message at organization-specific WhatsApp webhook endpoint");
  console.log(`Request URL: ${c.req.url}`);
  console.log(`Request Method: ${c.req.method}`);
  
  // Extract organization ID from the request
  const orgId = c.req.param('orgId');
  console.log(`Received WhatsApp webhook for organization: ${orgId}`);

  // Get request body and headers
  const body = await c.req.json();
  const headers = Object.fromEntries(c.req.raw.headers.entries());

  // Process the webhook using the common function
  return await processWhatsAppWebhook(c, body, headers, orgId);
});

// Legacy token-based webhook (for backward compatibility)
app.post('/webhooks/whatsapp/:token', async (c) => {
  console.log("Received message at legacy token-based WhatsApp webhook endpoint");
  
  // Get request body and headers
  const body = await c.req.json();
  const headers = Object.fromEntries(c.req.raw.headers.entries());
  const token = c.req.param('token');

  // Process the webhook using the common function
  return await processWhatsAppWebhook(c, body, headers, undefined, token);
});

// ===== HELPER FUNCTIONS FOR ORGANIZATION MANAGEMENT =====

// Helper function to generate organization-specific URLs
export function generateOrgWebhookUrl(orgId: string, baseUrl?: string): string {
  const base = baseUrl || process.env.BOT_BASE_URL || 'https://your-bot-domain.com';
  return `${base}/org/${orgId}/whatsapp/webhook`;
}

// Helper function to generate legacy webhook URLs
export function generateLegacyWebhookUrl(securityToken: string, baseUrl?: string): string {
  const base = baseUrl || process.env.BOT_BASE_URL || 'https://your-bot-domain.com';
  return `${base}/webhooks/whatsapp/${securityToken}`;
}

// Helper function to get organization configuration for dev portal
export function getOrgConfiguration(orgId: string) {
  const config = orgConfigs.find(c => c.orgId === orgId);
  const hasClient = !!waapiClients[orgId];
  
  return {
    orgId,
    orgName: config?.orgName || orgId,
    endpoint: generateOrgWebhookUrl(orgId),
    legacyEndpoint: config?.settings.whatsapp?.securityToken 
      ? generateLegacyWebhookUrl(config.settings.whatsapp.securityToken)
      : null,
    status: hasClient ? 'active' : 'inactive',
    config: config || null,
    hasClient: hasClient,
    instanceId: config?.settings.whatsapp?.instanceId || null,
    securityToken: config?.settings.whatsapp?.securityToken || null
  };
}

// Function to list all configured organizations
export function listOrganizations() {
  const allOrgIds = new Set([
    ...Object.keys(waapiClients),
    ...orgConfigs.map(c => c.orgId)
  ]);
  
  return Array.from(allOrgIds).map(orgId => getOrgConfiguration(orgId));
}

// ===== DEVELOPER PORTAL API ENDPOINTS =====

// Organization list endpoint for dev portal
app.get('/api/organizations', async (c) => {
  try {
    const organizations = listOrganizations();
    
    return c.json({
      success: true,
      organizations,
      totalCount: organizations.length,
      endpoints: {
        base: '/org/{orgId}/whatsapp/webhook',
        legacy: '/webhooks/whatsapp/{token}',
        example: organizations.length > 0 ? organizations[0].endpoint : '/org/example-org/whatsapp/webhook'
      }
    });
  } catch (error) {
    console.error('Error fetching organizations:', error);
    return c.json({
      success: false,
      error: 'Failed to fetch organizations'
    }, 500);
  }
})

// Get specific organization configuration
app.get('/api/organizations/:orgId', async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const orgConfig = getOrgConfiguration(orgId);
    
    if (!orgConfig.config && !orgConfig.hasClient) {
      return c.json({
        success: false,
        error: `Organization ${orgId} not found`
      }, 404);
    }
    
    return c.json({
      success: true,
      organization: orgConfig
    });
  } catch (error) {
    console.error('Error fetching organization:', error);
    return c.json({
      success: false,
      error: 'Failed to fetch organization'
    }, 500);
  }
})

// Configuration endpoint for developers to setup their WhatsApp webhook
app.get('/api/dev-portal/:orgId/config', async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const orgConfig = getOrgConfiguration(orgId);
    
    const baseUrl = process.env.BOT_BASE_URL || `${c.req.raw.headers.get('x-forwarded-proto') || 'https'}://${c.req.raw.headers.get('host')}`;
    const webhookEndpoint = `${baseUrl}/org/${orgId}/whatsapp/webhook`;
    const legacyWebhookEndpoint = orgConfig.config?.settings.whatsapp?.securityToken 
      ? `${baseUrl}/webhooks/whatsapp/${orgConfig.config.settings.whatsapp.securityToken}`
      : null;
    
    return c.json({
      success: true,
      organization: orgConfig,
      configuration: {
        webhookEndpoint,
        legacyWebhookEndpoint,
        manifestUrl: `${baseUrl}/api/dev-portal/${orgId}/whatsapp-manifest`,
        instanceId: orgConfig.config?.settings.whatsapp?.instanceId || 'Not configured',
        setupInstructions: {
          steps: [
            "1. Log in to your WAAPI dashboard at https://waapi.app",
            "2. Navigate to your WhatsApp instance settings",
            "3. Set the webhook URL to: " + webhookEndpoint,
            "4. Subscribe to the 'message' event",
            "5. Ensure your instance is authenticated and ready",
            "6. Test the webhook by sending a message to your WhatsApp number"
          ],
          webhookEndpoint,
          legacyWebhookEndpoint,
          instanceId: orgConfig.config?.settings.whatsapp?.instanceId || 'Configure in organization settings',
          apiKey: "Configure WAAPI_API_KEY (hidden for security)",
          securityToken: orgConfig.config?.settings.whatsapp?.securityToken ? "Configured" : "Not configured"
        }
      }
    });
  } catch (error) {
    console.error('Error generating dev portal config:', error);
    return c.json({
      success: false,
      error: 'Failed to generate configuration'
    }, 500);
  }
})

// WhatsApp webhook manifest endpoint for easy configuration
app.get('/api/dev-portal/:orgId/whatsapp-manifest', async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const orgConfig = getOrgConfiguration(orgId);
    
    const baseUrl = process.env.BOT_BASE_URL || `${c.req.raw.headers.get('x-forwarded-proto') || 'https'}://${c.req.raw.headers.get('host')}`;
    
    const manifest = {
      webhookConfiguration: {
        organizationId: orgId,
        organizationName: orgConfig.orgName || `Organization ${orgId}`,
        webhook: {
          url: `${baseUrl}/org/${orgId}/whatsapp/webhook`,
          events: ["message", "message_ack"],
          method: "POST",
          contentType: "application/json"
        },
        legacyWebhook: orgConfig.config?.settings.whatsapp?.securityToken ? {
          url: `${baseUrl}/webhooks/whatsapp/${orgConfig.config.settings.whatsapp.securityToken}`,
          events: ["message", "message_ack"],
          method: "POST",
          contentType: "application/json"
        } : null,
        instanceConfiguration: {
          instanceId: orgConfig.config?.settings.whatsapp?.instanceId || 'CONFIGURE_INSTANCE_ID',
          apiEndpoint: 'https://waapi.app/api/v1',
          requiredEvents: ['message'],
          optionalEvents: ['message_ack', 'qr', 'authenticated', 'ready']
        },
        setupInstructions: [
          "Copy the webhook URL from this manifest",
          "Log in to your WAAPI dashboard",
          "Navigate to your WhatsApp instance settings",
          "Paste the webhook URL in the webhook field",
          "Subscribe to the 'message' event",
          "Save the configuration",
          "Test by sending a message to your WhatsApp number"
        ]
      }
    };

    c.header('Content-Type', 'application/json');
    c.header('Content-Disposition', `attachment; filename="whatsapp-webhook-${orgId}-config.json"`);
    
    return c.json(manifest);
  } catch (error) {
    console.error('Error generating WhatsApp manifest:', error);
    return c.json({
      success: false,
      error: 'Failed to generate WhatsApp webhook manifest'
    }, 500);
  }
})

// Developer portal web interface
app.get('/dev-portal', async (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TaskMate WhatsApp Bot Developer Portal</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          margin: 0; padding: 20px; background-color: #f5f5f5; 
        }
        .container { 
          max-width: 1200px; margin: 0 auto; background: white; 
          padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
        }
        h1 { color: #25D366; border-bottom: 2px solid #25D366; padding-bottom: 10px; }
        .org-card { 
          border: 1px solid #ddd; border-radius: 6px; padding: 20px; 
          margin: 15px 0; background: #fafafa; 
        }
        .org-card.active { border-color: #25D366; background: #f0fff4; }
        .endpoint { 
          background: #2d3748; color: white; padding: 10px; 
          border-radius: 4px; font-family: monospace; margin: 10px 0; 
        }
        .button { 
          background: #25D366; color: white; border: none; 
          padding: 10px 20px; border-radius: 4px; cursor: pointer; 
          margin: 5px; text-decoration: none; display: inline-block; 
        }
        .button:hover { background: #20b557; }
        .status { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .status.active { background: #c6f6d5; color: #22543d; }
        .status.inactive { background: #fed7d7; color: #822727; }
        .org-input { margin: 20px 0; }
        .org-input input { 
          padding: 10px; border: 1px solid #ddd; border-radius: 4px; 
          margin-right: 10px; width: 200px; 
        }
        .setup-steps { 
          background: #e6fffa; border-left: 4px solid #25D366; 
          padding: 15px; margin: 15px 0; 
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📱 TaskMate WhatsApp Bot - Developer Portal</h1>
        <p>Configure your organization's WhatsApp bot webhook with a unique URL endpoint.</p>

        <div class="org-input">
          <h3>Get Configuration for Your Organization</h3>
          <input type="text" id="orgIdInput" placeholder="Enter your organization ID" />
          <button class="button" onclick="getOrgConfig()">Get Configuration</button>
        </div>

        <div id="orgConfig" style="display: none;">
          <h3>Organization Configuration</h3>
          <div id="configDetails"></div>
        </div>

        <h2>Available Organizations</h2>
        <div id="organizationsList">
          <p>Loading organizations...</p>
        </div>
      </div>

      <script>
        const BOT_BASE_URL = window.location.origin;

        async function loadOrganizations() {
          try {
            const response = await fetch(\`\${BOT_BASE_URL}/api/organizations\`);
            const data = await response.json();
            
            const container = document.getElementById('organizationsList');
            
            if (data.success && data.organizations.length > 0) {
              container.innerHTML = data.organizations.map(org => \`
                <div class="org-card \${org.status}">
                  <h3>\${org.orgName || org.orgId} <span class="status \${org.status}">\${org.status}</span></h3>
                  <p><strong>Organization ID:</strong> \${org.orgId}</p>
                  <div class="endpoint">\${org.endpoint}</div>
                  <div style="margin-top: 15px;">
                    <button class="button" onclick="getOrgConfig('\${org.orgId}')">Get Configuration</button>
                    <a href="\${BOT_BASE_URL}/api/dev-portal/\${org.orgId}/whatsapp-manifest" class="button" download>Download Webhook Config</a>
                  </div>
                </div>
              \`).join('');
            } else {
              container.innerHTML = '<p>No organizations configured yet.</p>';
            }
          } catch (error) {
            console.error('Error loading organizations:', error);
            document.getElementById('organizationsList').innerHTML = '<p>Error loading organizations.</p>';
          }
        }

        async function getOrgConfig(orgId = null) {
          const targetOrgId = orgId || document.getElementById('orgIdInput').value.trim();
          
          if (!targetOrgId) {
            alert('Please enter an organization ID');
            return;
          }

          try {
            const response = await fetch(\`\${BOT_BASE_URL}/api/dev-portal/\${targetOrgId}/config\`);
            const data = await response.json();
            
            const configDiv = document.getElementById('orgConfig');
            const detailsDiv = document.getElementById('configDetails');
            
            if (data.success) {
              const config = data.configuration;
              const org = data.organization;
              
              detailsDiv.innerHTML = \`
                <div class="org-card active">
                  <h3>\${org.orgName || org.orgId} Configuration</h3>
                  <p><strong>Organization ID:</strong> \${org.orgId}</p>
                  <p><strong>Status:</strong> <span class="status \${org.status}">\${org.status}</span></p>
                  
                  <h4>WhatsApp Webhook Endpoint:</h4>
                  <div class="endpoint">\${config.webhookEndpoint}</div>
                  
                  \${config.legacyWebhookEndpoint ? \`
                    <h4>Legacy Webhook (for existing setups):</h4>
                    <div class="endpoint">\${config.legacyWebhookEndpoint}</div>
                  \` : ''}
                  
                  <div class="setup-steps">
                    <h4>Setup Instructions:</h4>
                    <ol>
                      \${config.setupInstructions.steps.map(step => \`<li>\${step}</li>\`).join('')}
                    </ol>
                  </div>
                  
                  <div style="margin-top: 20px;">
                    <a href="\${config.manifestUrl}" class="button" download>Download Webhook Config</a>
                    <button class="button" onclick="copyToClipboard('\${config.webhookEndpoint}')">Copy Webhook URL</button>
                  </div>
                </div>
              \`;
              
              configDiv.style.display = 'block';
            } else {
              alert(\`Error: \${data.error}\`);
            }
          } catch (error) {
            console.error('Error getting organization config:', error);
            alert('Error getting organization configuration');
          }
        }

        function copyToClipboard(text) {
          navigator.clipboard.writeText(text).then(() => {
            alert('Webhook URL copied to clipboard!');
          }).catch(err => {
            console.error('Error copying to clipboard:', err);
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            alert('Webhook URL copied to clipboard!');
          });
        }

        loadOrganizations();
      </script>
    </body>
    </html>
  `);
})

// ===== REMINDER FUNCTIONS =====

// Function to send reminders
export async function sendReminder(reminder: { taskId: string; message: string }) {  console.log(`\n⏰ WhatsApp sendReminder: Processing reminder for task ${reminder.taskId}`)
  console.log(`   Message: ${reminder.message}`)
    // Track reminders to prevent duplicates
  const reminderKey = `whatsapp_${reminder.taskId}_${new Date().toISOString().split('T')[0]}`;
  const globalThis = global as any;
  const localReminderCache = globalThis.whatsappReminderCache || (globalThis.whatsappReminderCache = new Map());
  const globalReminderCache = globalThis.crossPlatformReminderCache || (globalThis.crossPlatformReminderCache = new Map());
  
  // Check if this reminder was sent in the last 5 minutes by WhatsApp
  if (localReminderCache.has(reminderKey)) {
    const lastSent = localReminderCache.get(reminderKey);
    const timeDiff = Date.now() - lastSent;
    if (timeDiff < 300000) { // 5 minutes
      console.log(`⚠️ Duplicate WhatsApp reminder prevented for ${reminder.taskId}: sent ${Math.round(timeDiff/1000)}s ago`);
      return true; // Return true to prevent retries
    }
  }
  
  // Check if this reminder was sent by the cross-platform notification system
  const crossPlatformKey = `all_platforms_${reminder.taskId}_${new Date().toISOString().split('T')[0]}`;
  if (globalReminderCache.has(crossPlatformKey)) {
    const lastSent = globalReminderCache.get(crossPlatformKey);
    const timeDiff = Date.now() - lastSent;
    if (timeDiff < 300000) { // 5 minutes
      console.log(`⚠️ Cross-platform notification already sent for ${reminder.taskId}: sent ${Math.round(timeDiff/1000)}s ago`);
      return true; // Return true to prevent retries
    }
  }
  
  // Mark this reminder as sent in the WhatsApp cache
  localReminderCache.set(reminderKey, Date.now());

  try {
    // Check if this is a custom reminder (format: custom_${userId})
    if (reminder.taskId.startsWith('custom_')) {
      console.log(`📝 Processing custom reminder - skipping task lookup`)
      
      // Extract user ID from custom reminder format
      let userId = reminder.taskId.replace('custom_', '');
      
      // Remove any "reminder_user_" prefix if it exists (from Telegram compatibility)
      if (userId.startsWith('reminder_user_')) {
        userId = userId.replace('reminder_user_', '');
      }
      
      console.log(`📝 Sending custom reminder to user ID: ${userId}`);
      
      // Get user details for custom reminder
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("email, name, organization_id, whatsapp_number")
        .eq("id", userId)
        .single();
      
      if (userError || !user) {
        console.error(`❌ User not found: ${userId}`, userError);
        return;
      }

      if (!user.whatsapp_number) {
        console.error(`❌ No WhatsApp number found for user: ${userId}`);
        return;
      }
      
      console.log(`✅ Found user: ${user.name} (${user.email})`);
      
      // Format WhatsApp ID
      let whatsappId = user.whatsapp_number.toString();
      if (!whatsappId.startsWith('+')) {
        whatsappId = '+91' + whatsappId.replace(/\D/g, '');
      }
      whatsappId = whatsappId.replace(/\D/g, '');
      if (!whatsappId.endsWith('@c.us')) {
        whatsappId += '@c.us';
      }

      console.log(`📱 Formatted WhatsApp ID: ${whatsappId}`);      // Send custom reminder message - without organization ID
      const customReminderMessage = `⏰ CUSTOM REMINDER: ${reminder.message}\n\n` +
        `*From:* Admin\n` +
        `*To:* ${user.name}\n` +
        `*Email:* ${user.email}`;

      // Don't send organization ID as requested
      await sendMessage(whatsappId, customReminderMessage);

      console.log(`✅ Custom reminder sent successfully to ${user.name}`);
      return; // Exit early for custom reminders
    }

    // Handle regular task reminders
    // Extract the real taskId if it's a combined ID like "taskId_userId"
    const taskIdParts = reminder.taskId.split('_');
    const realTaskId = taskIdParts[0]; // Use only the task ID part
    
    console.log(`Using task ID: ${realTaskId} from original ID: ${reminder.taskId}`)
    
    // Get task details with complete organization context
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, assigned_to, project_id, organization_id, created_at")
      .eq("id", realTaskId)
      .single();

    if (taskError || !task) {
      console.error("❌ Error fetching task:", taskError);
      return;
    }
    
    // Log details for debugging
    console.log(`✅ Task details:
      ID: ${task.id}
      Title: ${task.title}
      Assigned To: ${task.assigned_to}
      Organization ID: ${task.organization_id}
    `);

    // Get project and team details
    let projectName = "No project";
    let teamName = "No team";

    if (task.project_id) {
      const { data: project } = await supabase
        .from("projects")
        .select("name, team_id, organization_id")
        .eq("id", task.project_id)
        .single();

      if (project) {
        projectName = project.name;

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
    }

    // Handle the case where assigned_to might be an array or a single value
    const assignedToIds = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to];
    console.log(`🔍 Task has ${assignedToIds.length} assignees`);
      // Determine which users to notify
    let usersToNotify = [];
    let isTargetedReminder = false;
      
    // Check if the taskId contains user information (for targeted reminders)
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
        console.log(`🔔 Notifying user ID: ${userId}`);
        
        // Get basic user details for logging
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("email, name")
          .eq("id", userId)
          .single();
        
        if (userError || !user) {
          console.error(`❌ User not found: ${userId}`);
          console.error("   Error:", userError?.message || "User not found");
          continue;  // Skip to the next user
        }
        
        console.log(`✅ User found: ${user.name} (${user.email})`);

        // Format the message with task details
        const reminderMessage = `⏰ REMINDER: ${reminder.message}\n\n` +
          `*Task:* ${task.title}\n` +
          `*Project:* ${projectName}\n` +
          `*Team:* ${teamName}\n\n` +
          `Reply with:\n1. To mark as Complete\n2. To mark as In Progress`;        // Use the cross-platform notification system
        // For targeted reminders, we need to keep the composite ID to ensure proper cache key generation
        const taskIdToUse = isTargetedReminder ? reminder.taskId : task.id;
        console.log(`📝 Using task ID for notification: ${taskIdToUse} (${isTargetedReminder ? 'targeted' : 'regular'} reminder)`);
        
        const notificationSent = await sendUserNotificationToAllPlatforms(
          userId,
          reminderMessage,
          taskIdToUse,
          false // Don't store in reminders table as it's already being handled
        );
        
        if (notificationSent) {
          console.log(`✅ Cross-platform notification sent to user ${user.name} (${user.email}) for task ${task.title}`);
        } else {
          console.error(`❌ Failed to send cross-platform notification to user ${user.name} (${user.email}) for task ${task.title}`);
        }
    }
  } catch (error) {
    console.error("❌ Error sending WhatsApp reminder:", error);
    if (error instanceof Error) {
      console.error("   Details:", error.message);
    }
  }
}

// Function to check for pending reminders
export async function checkReminders() {
  try {
    console.log("Security: Checking for pending reminders")
    const now = new Date().toISOString()    // Get pending reminders with task info, including organization context
    const { data: pendingReminders, error } = await supabase
      .from("reminders")
      .select(`
        id, 
        message, 
        scheduled_for, 
        sent, 
        sent_at, 
        task_id,
        tasks (
          id,
          title,
          assigned_to,
          organization_id
        )
      `)
      .eq("sent", false)
      .lte("scheduled_for", now)
      .neq("type", "welcome")  // Exclude welcome messages - they're handled by welcomeService

    if (error) {
      console.error("Error fetching pending reminders:", error)
      return
    }

    if (!pendingReminders || pendingReminders.length === 0) {
      console.log("Security: No pending reminders found")
      return
    }

    console.log(`Security: Found ${pendingReminders.length} pending reminders`)    
    
    // Process each reminder
    for (const reminder of pendingReminders) {
      const taskId = reminder.task_id;
      // Handle task information, ensuring we get a single task object even if it's in an array
      const taskData = reminder.tasks;
      const task = Array.isArray(taskData) ? taskData[0] : taskData;
      console.log(`Security: Processing reminder ID: ${reminder.id} for task: ${taskId}`)
      console.log(`Task info: ${JSON.stringify(task)}`)
      
      if (!task) {
        console.error(`Task not found for reminder ${reminder.id}, skipping...`);
        continue;
      }
      
      try {
        // Check if this is a custom reminder
        const isCustomReminder = taskId && taskId.startsWith('custom_');
        
        if (isCustomReminder) {
          // For custom reminders, extract the user ID
          const userId = taskId.replace('custom_', '');
          
          console.log(`Processing custom reminder for user ID: ${userId}`);
          
          // Send notification to all platforms for this user
          const notificationSent = await sendUserNotificationToAllPlatforms(
            userId,
            `⏰ REMINDER: ${reminder.message}\n\nFrom: Admin`,
            undefined, // No task ID for custom reminders
            false // Don't store in reminders table as it's already there
          );
          
          if (notificationSent) {
            console.log(`✅ Cross-platform notification sent to user ${userId}`);
          } else {
            console.error(`❌ Failed to send cross-platform notification to user ${userId}`);
          }
        } else {
          // For task reminders, check if task has assignees
          const assignedToIds = Array.isArray(task.assigned_to) ? task.assigned_to : [task.assigned_to];
          
          if (!assignedToIds || assignedToIds.length === 0) {
            console.error(`Task ${taskId} has no assignees, skipping reminder`);
            continue;
          }
          
          console.log(`Task ${taskId} has ${assignedToIds.length} assignees`);
          
          // Send notification to each assignee across all platforms
          for (const userId of assignedToIds) {
            const notificationSent = await sendUserNotificationToAllPlatforms(
              userId,
              reminder.message || `Your task is due soon.`,
              taskId,
              false // Don't store in reminders table as it's already there
            );
            
            if (notificationSent) {
              console.log(`✅ Cross-platform notification sent to user ${userId} for task ${taskId}`);
            } else {
              console.error(`❌ Failed to send cross-platform notification to user ${userId} for task ${taskId}`);
            }
          }
        }

        // Mark the reminder as sent
        await supabase
          .from("reminders")
          .update({ sent: true, sent_at: new Date().toISOString() })
          .eq("id", reminder.id);

        console.log(`Security: Marked reminder ${reminder.id} as sent`);
      } catch (error) {
        console.error(`Error processing reminder ${reminder.id}:`, error);
        // Don't mark the reminder as sent if there was an error
      }
    }
  } catch (error) {
    console.error("Error checking reminders:", error)
  }
}

// Start the reminder service
export function startReminderService() {
  if (isReminderServiceRunning) {
    console.log("Reminder service is already running.")
    return
  }

  isReminderServiceRunning = true
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

// Start the bot with organization-specific configuration
export async function startBot(config?: OrgConfig) {
  if (isBotRunning && !config) {
    console.log("WhatsApp bot is already running.")
    return false
  }

  try {
    // Fetch WhatsApp tokens from Supabase
    await fetchWhatsAppTokens();

    // If organization config is provided, set up organization-specific settings
    if (config) {
      console.log(`Setting up WhatsApp bot for organization: ${config.orgName} (${config.orgId})`)

      // Store the organization config
      const existingConfigIndex = orgConfigs.findIndex(c => c.orgId === config.orgId)
      if (existingConfigIndex >= 0) {
        orgConfigs[existingConfigIndex] = config
      } else {
        orgConfigs.push(config)
      }

      // Set up WhatsApp-specific settings if available
      if (config.settings.whatsapp?.enabled) {
        const whatsappSettings = config.settings.whatsapp

        // Create organization-specific WhatsApp API client
        if (whatsappSettings.apiKey) {
          waapiClients[config.orgId] = axios.create({
            baseURL: "https://waapi.app/api/v1",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${whatsappSettings.apiKey}`,
              "content-type": "application/json"
            }
          })

          console.log(`Created WhatsApp API client for organization ${config.orgName}`)
        }

        // Store security token for this instance
        if (whatsappSettings.instanceId && whatsappSettings.securityToken) {
          securityTokens[whatsappSettings.instanceId] = whatsappSettings.securityToken
          // Also store the token directly with the token as the key for easier lookup
          securityTokens[whatsappSettings.securityToken] = whatsappSettings.securityToken
          console.log(`Stored security token for instance ${whatsappSettings.instanceId} (org: ${config.orgName}): ${whatsappSettings.securityToken}`)
        }        // Create organization-specific agent
        // Use the whatsappBotAgent directly
        orgAgents[config.orgId] = whatsappBotAgent
        
        // Original code was:
        // orgAgents[config.orgId] = whatsappBotAgent(
        //   { supabase },
        //   { orgId: config.orgId, orgName: config.orgName }
        // );

        console.log(`WhatsApp bot configured for organization ${config.orgName} with admin number: ${whatsappSettings.adminNumber || 'none'}`)
      }      // If this is the first organization, start the webhook server
      if (!isBotRunning) {
        const port = config.settings.whatsapp?.webhookPort || DEFAULT_WEBHOOK_PORT

        // Make sure main webhook handler is initialized
        ensureMainWebhookHandler();

        // Start webhook server
        serve({
          fetch: app.fetch,
          port: port,
        });

        console.log(`Security: WhatsApp webhook server running on port ${port} with secure authentication`)
        console.log(`Security: Only registered users with valid WhatsApp numbers will be able to interact with the bot`)
        console.log(`🔄 Organization-specific WhatsApp bot for ${config.orgName} is now listening for messages`)

        // Log webhook URLs for each organization
        console.log("\n=== WEBHOOK CONFIGURATION GUIDE ===");
        console.log("To expose your webhook to the internet, run: ngrok http " + port);
        console.log("Then use the ngrok URL with the proper path for each organization:\n");

        for (const orgConfig of orgConfigs) {
          if (orgConfig.settings.whatsapp?.enabled &&
              orgConfig.settings.whatsapp.instanceId &&
              orgConfig.settings.whatsapp.securityToken) {
            console.log(`Organization: ${orgConfig.orgName}`)
            console.log(`  Instance ID: ${orgConfig.settings.whatsapp.instanceId}`)
            console.log(`  Webhook URL: https://your-ngrok-url/webhooks/whatsapp/${orgConfig.settings.whatsapp.securityToken}`)
            console.log(`  Configure this URL in WAAPI dashboard for instance ${orgConfig.settings.whatsapp.instanceId}\n`)
          }
        }
        console.log("===============================")

        isBotRunning = true
        console.log("Security: WhatsApp bot started with secure authentication enabled")
        console.log("🔄 WhatsApp bot is now listening for messages")

        // Update global status
        global.whatsappBotRunning = true;

        // Handle graceful shutdown
        process.once("SIGINT", () => {
          console.log("WhatsApp bot stopping...")
          isBotRunning = false
        })

        process.once("SIGTERM", () => {
          console.log("WhatsApp bot stopping...")
          isBotRunning = false
        })
      }

      return true
    } else {      // Start with default configuration if no organization config is provided
      // Start webhook server
      serve({
        fetch: app.fetch,
        port: DEFAULT_WEBHOOK_PORT,
      });

      console.log(`Security: WhatsApp webhook server running on port ${DEFAULT_WEBHOOK_PORT} with secure authentication`)
      console.log(`\n=== WEBHOOK CONFIGURATION GUIDE ===`)
      console.log(`To expose your webhook to the internet, run: ngrok http ${DEFAULT_WEBHOOK_PORT}`)
      console.log(`Then use the ngrok URL with your webhook path:`)
      console.log(`Webhook URL: https://your-ngrok-url/webhooks/whatsapp/${DEFAULT_SECURITY_TOKEN}`)
      console.log(`Configure this URL in WAAPI dashboard for instance ID: ${DEFAULT_WAAPI_INSTANCE_ID}`)
      console.log(`===============================`)
      console.log(`Security: Only registered users with valid WhatsApp numbers will be able to interact with the bot`);

      // Check if this is a verification request from WAAPI
      app.post('/webhooks/whatsapp/:token', async (c) => {
        console.log("Received verification request at legacy token-based WhatsApp webhook endpoint");
        
        // Get request body and headers
        const body = await c.req.json();
        const headers = Object.fromEntries(c.req.raw.headers.entries());
        const token = c.req.param('token');

        // Process the webhook using the common function
        return await processWhatsAppWebhook(c, body, headers, undefined, token);
      });

      isBotRunning = true
      console.log("Security: WhatsApp bot started with secure authentication enabled")
      console.log("🔄 WhatsApp bot is now listening for messages")

      // Update global status
      global.whatsappBotRunning = true;

      // Handle graceful shutdown
      process.once("SIGINT", () => {
        console.log("WhatsApp bot stopping...")
        isBotRunning = false
      })

      process.once("SIGTERM", () => {
        console.log("WhatsApp bot stopping...")
        isBotRunning = false
      })

      return true
    }
  } catch (error) {
    console.error("Error starting WhatsApp bot:", error)
    return false
  }
}

// ===== TASK EDITING FUNCTIONS =====

// Show task edit form - list user's editable tasks
async function showTaskEditForm(whatsappId: string, user: any) {
  try {
    console.log(`Showing task edit form for user: ${user.name}`);

    // Get user's editable tasks (excluding completed and cancelled)
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select(`
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
          team_id
        )
      `)
      .filter('assigned_to', 'cs', `["${user.id}"]`)
      .neq("status", "completed")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("Error fetching user tasks:", error);
      await sendMessage(whatsappId, "❌ Error fetching your tasks. Please try again later.");
      return;
    }

    if (!tasks || tasks.length === 0) {
      await sendMessage(whatsappId, "You have no active tasks to edit. 🎉");
      return;
    }

    // Create task selection message
    let message = "🔧 *Edit Task*\n\nSelect a task to edit (reply with the number):\n\n";

    tasks.forEach((task: any, index) => {
      const priorityEmoji = {
        'low': '🟢',
        'medium': '🟡',
        'high': '🟠',
        'urgent': '🔴'
      }[task.priority as string] || '📝';

      const projectInfo = task.projects?.name ? ` (${task.projects.name})` : '';
      message += `${index + 1}. ${priorityEmoji} ${task.title}${projectInfo}\n`;
    });

    message += `\n${tasks.length + 1}. ❌ Cancel\n`;

    // Store tasks in conversation state for selection
    updateConversationState(whatsappId, 'task_edit_selection', {
      availableTasks: tasks
    });

    await sendMessage(whatsappId, message);

  } catch (error) {
    console.error("Error in showTaskEditForm:", error);
    await sendMessage(whatsappId, "❌ An error occurred while fetching your tasks. Please try again later.");
  }
}

// Handle task selection for editing
async function handleTaskEditSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  try {
    const tasks = state.data.availableTasks;
    const selectionIndex = parseInt(selection) - 1;

    // Check for cancel
    if (selectionIndex === tasks.length) {
      clearConversationState(whatsappId);
      await sendMessage(whatsappId, "Task editing cancelled. What would you like to do next?");
      return;
    }

    // Validate selection
    if (selectionIndex >= 0 && selectionIndex < tasks.length) {
      const selectedTask = tasks[selectionIndex];
      await showTaskEditOptions(whatsappId, selectedTask, user);
    } else {
      await sendMessage(whatsappId, "Invalid selection. Please enter a valid task number.");
    }

  } catch (error) {
    console.error("Error in handleTaskEditSelection:", error);
    await sendMessage(whatsappId, "❌ Error processing task selection. Please try again.");
  }
}

// Show task edit options for selected task
async function showTaskEditOptions(whatsappId: string, task: any, user: any) {
  try {
    // Store the selected task data in conversation state
    updateConversationState(whatsappId, 'task_edit_options', {
      editingTask: task,
      originalTask: { ...task }, // Keep original for comparison
      changes: {} // Track changes made
    });

    // Format task information for display
    const displayDeadline = task.deadline ? 
      new Date(task.deadline).toLocaleDateString('en-GB') : 
      "No deadline";
    
    const displayProject = task.projects?.name || "No project";
    const displayDescription = task.description || "No description";

    const taskInfo = `📋 *Editing Task:* ${task.title}\n\n` +
      `📝 *Description:* ${displayDescription}\n` +
      `🔹 *Status:* ${task.status}\n` +
      `⭐ *Priority:* ${task.priority}\n` +
      `📅 *Deadline:* ${displayDeadline}\n` +
      `📂 *Project:* ${displayProject}\n\n` +
      `*What would you like to edit?*\n\n` +
      `1. 📝 Title\n` +
      `2. 📄 Description\n` +
      `3. ⭐ Priority\n` +
      `4. 📅 Deadline\n` +
      `5. 📂 Project\n` +
      `6. 🔄 Status\n\n` +
      `7. ✅ Done Editing\n` +
      `8. ❌ Cancel\n\n` +
      `Reply with the number of what you want to edit:`;

    await sendMessage(whatsappId, taskInfo);

  } catch (error) {
    console.error("Error in showTaskEditOptions:", error);
    await sendMessage(whatsappId, "❌ Error showing task edit options. Please try again.");
  }
}

// Handle edit option selection
async function handleTaskEditOptionSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  try {
    const task = state.data.editingTask;
    
    switch (selection) {
      case '1': // Edit title
        updateConversationState(whatsappId, 'task_edit_field', {
          ...state.data,
          editingField: 'title'
        });
        await sendMessage(whatsappId, `*Current title:* ${task.title}\n\nPlease enter the new task title:`);
        break;

      case '2': // Edit description
        updateConversationState(whatsappId, 'task_edit_field', {
          ...state.data,
          editingField: 'description'
        });
        await sendMessage(whatsappId, `*Current description:* ${task.description || 'No description'}\n\nPlease enter the new task description:`);
        break;

      case '3': // Edit priority
        updateConversationState(whatsappId, 'task_edit_field', {
          ...state.data,
          editingField: 'priority'
        });
        await showPriorityEditOptions(whatsappId, task);
        break;

      case '4': // Edit deadline
        updateConversationState(whatsappId, 'task_edit_field', {
          ...state.data,
          editingField: 'deadline'
        });
        await showDeadlineEditOptions(whatsappId, task);
        break;

      case '5': // Edit project
        updateConversationState(whatsappId, 'task_edit_field', {
          ...state.data,
          editingField: 'project'
        });
        await showProjectEditOptions(whatsappId, task, user);
        break;

      case '6': // Edit status
        updateConversationState(whatsappId, 'task_edit_field', {
          ...state.data,
          editingField: 'status'
        });
        await showStatusEditOptions(whatsappId, task);
        break;

      case '7': // Done editing - save changes
        await finishTaskEditing(whatsappId, state, user);
        break;

      case '8': // Cancel
        clearConversationState(whatsappId);
        await sendMessage(whatsappId, "Task editing cancelled. What would you like to do next?");
        break;

      default:
        await sendMessage(whatsappId, "Invalid selection. Please enter a number from 1-8:");
    }

  } catch (error) {
    console.error("Error in handleTaskEditOptionSelection:", error);
    await sendMessage(whatsappId, "❌ Error processing your selection. Please try again.");
  }
}

// Show priority edit options
async function showPriorityEditOptions(whatsappId: string, task: any) {
  const message = `*Current priority:* ${task.priority}\n\n` +
    `Select new priority:\n\n` +
    `1. 🟢 Low\n` +
    `2. 🟡 Medium\n` +
    `3. 🟠 High\n` +
    `4. 🔴 Urgent\n\n` +
    `5. ❌ Cancel\n\n` +
    `Reply with the number:`;
  
  await sendMessage(whatsappId, message);
}

// Show deadline edit options
async function showDeadlineEditOptions(whatsappId: string, task: any) {
  const currentDeadline = task.deadline ? 
    new Date(task.deadline).toLocaleDateString('en-GB') : 
    'No deadline';

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);

  const message = `*Current deadline:* ${currentDeadline}\n\n` +
    `Select new deadline:\n\n` +
    `1. 📅 Today (${today.toLocaleDateString('en-GB')})\n` +
    `2. 📅 Tomorrow (${tomorrow.toLocaleDateString('en-GB')})\n` +
    `3. 📅 Next Week (${nextWeek.toLocaleDateString('en-GB')})\n` +
    `4. 📝 Custom Date (DD/MM/YYYY)\n` +
    `5. 🚫 Remove Deadline\n\n` +
    `6. ❌ Cancel\n\n` +
    `Reply with the number or enter a custom date:`;
  
  await sendMessage(whatsappId, message);
}

// Show status edit options
async function showStatusEditOptions(whatsappId: string, task: any) {
  const message = `*Current status:* ${task.status}\n\n` +
    `Select new status:\n\n` +
    `1. ⏳ Pending\n` +
    `2. 🚧 In Progress\n` +
    `3. ✅ Completed\n` +
    `4. ❌ Cancelled\n\n` +
    `5. ❌ Cancel\n\n` +
    `Reply with the number:`;
  
  await sendMessage(whatsappId, message);
}

// Show project edit options
async function showProjectEditOptions(whatsappId: string, task: any, user: any) {
  try {
    // Get available projects for this user's organization
    const projects = await getAvailableProjects(user.organization_id);
    const isAdmin = await isUserAdmin(user.id);

    const currentProject = task.projects?.name || 'No project';

    let message = `*Current project:* ${currentProject}\n\n` +
      `Select new project:\n\n`;

    projects.forEach((project, index) => {
      message += `${index + 1}. ${project.name}\n`;
    });

    const nextIndex = projects.length + 1;
    message += `\n${nextIndex}. 🚫 Remove from Project\n`;
    
    if (isAdmin) {
      message += `${nextIndex + 1}. ➕ Create New Project\n`;
    }

    message += `${isAdmin ? nextIndex + 2 : nextIndex + 1}. ❌ Cancel\n\n` +
      `Reply with the number:`;

    // Store projects in conversation state for selection
    updateConversationState(whatsappId, 'task_edit_field', {
      editingTask: task,
      editingField: 'project',
      availableProjects: projects,
      isAdmin: isAdmin
    });

    await sendMessage(whatsappId, message);

  } catch (error) {
    console.error("Error in showProjectEditOptions:", error);
    await sendMessage(whatsappId, "❌ Error loading projects. Please try again.");
  }
}

// Handle field editing input
async function handleTaskEditFieldInput(whatsappId: string, input: string, state: ConversationState, user: any) {
  try {
    const field = state.data.editingField;
    const task = state.data.editingTask;
    const changes = state.data.changes || {};    let updateData: any = {};
    let successMessage = "";

    switch (field) {
      case 'title':
        if (input.trim().length === 0) {
          await sendMessage(whatsappId, "❌ Task title cannot be empty. Please enter a valid title:");
          return;
        }
        updateData = { title: input.trim() };
        changes.title = input.trim();
        task.title = input.trim();
        successMessage = "✅ Title updated!";
        break;

      case 'description':
        updateData = { description: input.trim() };
        changes.description = input.trim();
        task.description = input.trim();
        successMessage = "✅ Description updated!";
        break;

      case 'priority':
        const priorityMap: { [key: string]: string } = { '1': 'low', '2': 'medium', '3': 'high', '4': 'urgent' };
        if (input === '5') {
          // Cancel
          await showTaskEditOptions(whatsappId, task, user);
          return;
        }
        if (priorityMap[input]) {
          updateData = { priority: priorityMap[input] };
          changes.priority = priorityMap[input];
          task.priority = priorityMap[input];
          successMessage = "✅ Priority updated!";
        } else {
          await sendMessage(whatsappId, "❌ Invalid priority. Please select 1-5:");
          return;
        }
        break;

      case 'deadline':
        await handleDeadlineEditInput(whatsappId, input, state, user);
        return;

      case 'status':
        const statusMap: { [key: string]: string } = { '1': 'pending', '2': 'in_progress', '3': 'completed', '4': 'cancelled' };
        if (input === '5') {
          // Cancel
          await showTaskEditOptions(whatsappId, task, user);
          return;
        }
        if (statusMap[input]) {
          updateData = { status: statusMap[input] };
          changes.status = statusMap[input];
          task.status = statusMap[input];
          successMessage = "✅ Status updated!";
        } else {
          await sendMessage(whatsappId, "❌ Invalid status. Please select 1-5:");
          return;
        }
        break;

      case 'project':
        await handleProjectEditInput(whatsappId, input, state, user);
        return;

      default:
        await sendMessage(whatsappId, "❌ Unknown field being edited. Please try again.");
        return;
    }

    // Immediately save changes to database
    if (Object.keys(updateData).length > 0) {
      updateData.updated_at = new Date().toISOString();
      
      const { error: updateError } = await supabase
        .from("tasks")
        .update(updateData)
        .eq("id", task.id);

      if (updateError) {
        console.error("Error updating task in database:", updateError);
        await sendMessage(whatsappId, "❌ Error saving changes to database. Please try again.");
        return;
      }
    }

    // Update state with changes
    updateConversationState(whatsappId, 'task_edit_options', {
      ...state.data,
      editingTask: task,
      changes: changes
    });

    await sendMessage(whatsappId, successMessage);

    // Show task edit options again
    await showTaskEditOptions(whatsappId, task, user);

  } catch (error) {
    console.error("Error in handleTaskEditFieldInput:", error);
    await sendMessage(whatsappId, "❌ Error updating field. Please try again.");
  }
}

// Handle deadline edit input
async function handleDeadlineEditInput(whatsappId: string, input: string, state: ConversationState, user: any) {
  try {
    const task = state.data.editingTask;
    const changes = state.data.changes || {};

    if (input === '6') {
      // Cancel
      await showTaskEditOptions(whatsappId, task, user);
      return;
    }

    const today = new Date();
    let newDeadline = null;

    switch (input) {
      case '1': // Today
        newDeadline = today.toISOString();
        break;
      case '2': // Tomorrow
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        newDeadline = tomorrow.toISOString();
        break;
      case '3': // Next week
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        newDeadline = nextWeek.toISOString();
        break;
      case '4': // Custom date
        await sendMessage(whatsappId, "Please enter the date in DD/MM/YYYY format:");
        return;
      case '5': // Remove deadline
        newDeadline = null;
        break;
      default:
        // Try to parse as custom date DD/MM/YYYY
        const dateMatch = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dateMatch) {
          const [, day, month, year] = dateMatch;
          const customDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
          if (customDate.getTime()) {
            newDeadline = customDate.toISOString();
          } else {
            await sendMessage(whatsappId, "❌ Invalid date format. Please use DD/MM/YYYY:");
            return;
          }
        } else {
          await sendMessage(whatsappId, "❌ Invalid selection. Please choose 1-6 or enter a date in DD/MM/YYYY format:");
          return;
        }
    }

    changes.deadline = newDeadline;
    task.deadline = newDeadline;
    await sendMessage(whatsappId, "✅ Deadline updated!");

    // Update state and show options again
    updateConversationState(whatsappId, 'task_edit_options', {
      ...state.data,
      editingTask: task,
      changes: changes
    });

    await showTaskEditOptions(whatsappId, task, user);

  } catch (error) {
    console.error("Error in handleDeadlineEditInput:", error);
    await sendMessage(whatsappId, "❌ Error updating deadline. Please try again.");
  }
}

// Handle project edit input
async function handleProjectEditInput(whatsappId: string, input: string, state: ConversationState, user: any) {
  try {
    const task = state.data.editingTask;
    const changes = state.data.changes || {};
    const projects = state.data.availableProjects || [];
    const isAdmin = state.data.isAdmin;

    const selectionIndex = parseInt(input) - 1;
    const removeProjectIndex = projects.length;
    const createProjectIndex = projects.length + 1;
    const cancelIndex = isAdmin ? projects.length + 2 : projects.length + 1;

    if (parseInt(input) === cancelIndex + 1) {
      // Cancel
      await showTaskEditOptions(whatsappId, task, user);
      return;
    }

    if (selectionIndex >= 0 && selectionIndex < projects.length) {
      // Selected existing project
      const selectedProject = projects[selectionIndex];
      changes.project_id = selectedProject.id;
      task.project_id = selectedProject.id;
      task.projects = selectedProject;
      await sendMessage(whatsappId, `✅ Project updated to "${selectedProject.name}"!`);
    } else if (parseInt(input) === removeProjectIndex + 1) {
      // Remove from project
      changes.project_id = null;
      task.project_id = null;
      task.projects = null;
      await sendMessage(whatsappId, "✅ Task removed from project!");
    } else if (isAdmin && parseInt(input) === createProjectIndex + 1) {
      // Create new project
      updateConversationState(whatsappId, 'task_edit_project_creation', {
        ...state.data
      });
      await sendMessage(whatsappId, "Please enter the name for the new project:");
      return;
    } else {
      await sendMessage(whatsappId, "❌ Invalid selection. Please try again:");
      return;
    }

    // Update state and show options again
    updateConversationState(whatsappId, 'task_edit_options', {
      ...state.data,
      editingTask: task,
      changes: changes
    });

    await showTaskEditOptions(whatsappId, task, user);

  } catch (error) {
    console.error("Error in handleProjectEditInput:", error);
    await sendMessage(whatsappId, "❌ Error updating project. Please try again.");
  }
}

// Finish task editing and save changes
async function finishTaskEditing(whatsappId: string, state: ConversationState, user: any) {
  try {
    const task = state.data.editingTask;
    const changes = state.data.changes;

    if (!changes || Object.keys(changes).length === 0) {
      await sendMessage(whatsappId, "No changes were made to the task.");
      clearConversationState(whatsappId);
      return;
    }

    // Update the task in the database
    const updateData = {
      ...changes,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task.id);

    if (error) {
      console.error("Error updating task:", error);
      await sendMessage(whatsappId, `❌ Error updating task: ${error.message}`);
      return;
    }

    // Create summary of changes
    let changesSummary = "✅ *Task updated successfully!*\n\n";
    changesSummary += `*Task:* ${task.title}\n\n`;
    changesSummary += "*Changes made:*\n";

    Object.keys(changes).forEach(field => {
      const newValue = changes[field];
      let displayValue = newValue;
      
      if (field === 'deadline') {
        displayValue = newValue ? new Date(newValue).toLocaleDateString('en-GB') : 'Removed';
      } else if (field === 'project_id') {
        displayValue = newValue ? task.projects?.name || 'Updated' : 'Removed';
        field = 'project'; // Display as project instead of project_id
      }
      
      changesSummary += `• ${field.charAt(0).toUpperCase() + field.slice(1)}: ${displayValue}\n`;
    });

    changesSummary += `\nWhat would you like to do next?\n` +
      `Reply with:\n` +
      `• "edit task" to edit another task\n` +
      `• "create task" to create a new task`;

    await sendMessage(whatsappId, changesSummary);
    clearConversationState(whatsappId);

  } catch (error) {
    console.error("Error in finishTaskEditing:", error);
    await sendMessage(whatsappId, "❌ Error saving task changes. Please try again.");
  }
}

// Handle project creation during task editing
async function handleProjectCreationForTaskEdit(whatsappId: string, projectName: string, state: ConversationState, user: any) {
  try {
    // Validate project name
    if (!projectName || projectName.trim().length === 0) {
      await sendMessage(whatsappId, "❌ Project name cannot be empty. Please enter a valid project name:");
      return;
    }

    if (projectName.trim().length > 100) {
      await sendMessage(whatsappId, "❌ Project name is too long (max 100 characters). Please enter a shorter name:");
      return;
    }

    // Get user's organization ID
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .single();

    if (userError || !userData || !userData.organization_id) {
      await sendMessage(whatsappId, "❌ Could not determine your organization. Please try again.");
      return;
    }

    // Check if project name already exists in the organization
    const { data: existingProject, error: checkError } = await supabase
      .from("projects")
      .select("id")
      .eq("name", projectName.trim())
      .eq("organization_id", userData.organization_id)
      .single();

    if (existingProject) {
      await sendMessage(whatsappId, `❌ A project named "${projectName.trim()}" already exists. Please choose a different name:`);
      return;
    }

    // Store project name and start collecting additional fields
    updateConversationState(whatsappId, 'project_edit_creation_description', {
      ...state.data,
      newProjectName: projectName.trim(),
      organizationId: userData.organization_id
    });

    await sendMessage(whatsappId, `*Creating Project: ${projectName.trim()}*\n\nPlease provide a description for this project (or type "skip" to skip):`);

  } catch (error) {
    console.error("Error in handleProjectCreationForTaskEdit:", error);
    await sendMessage(whatsappId, "❌ An error occurred while creating the project. Please try again.");
  }
}

// Handle project description input during task editing
async function handleProjectEditDescriptionInput(whatsappId: string, description: string, state: ConversationState, user: any) {
  try {
    const projectDescription = description.trim().toLowerCase() === 'skip' ? null : description.trim();
    
    updateConversationState(whatsappId, 'project_edit_creation_deadline', {
      ...state.data,
      newProjectDescription: projectDescription
    });

    await sendMessage(whatsappId, `*Project:* ${state.data.newProjectName}\n*Description:* ${projectDescription || 'None'}\n\nPlease provide a deadline for this project (DD/MM/YYYY, "next week", or type "skip" to skip):`);

  } catch (error) {
    console.error("Error in handleProjectEditDescriptionInput:", error);
    await sendMessage(whatsappId, "❌ Error processing description. Please try again.");
  }
}

// Handle project deadline input during task editing
async function handleProjectEditDeadlineInput(whatsappId: string, deadlineInput: string, state: ConversationState, user: any) {
  try {
    let projectDeadline = null;
    
    if (deadlineInput.trim().toLowerCase() !== 'skip') {
      projectDeadline = parseDateInput(deadlineInput);
      
      if (!projectDeadline) {
        await sendMessage(whatsappId, "❌ Invalid date format. Please try again with DD/MM/YYYY, 'next week', or 'skip':");
        return;
      }
    }

    updateConversationState(whatsappId, 'project_edit_creation_lead', {
      ...state.data,
      newProjectDeadline: projectDeadline?.toISOString() || null
    });

    // Get available users for project lead selection
    const users = await getAvailableUsers();
    
    let message = `*Project:* ${state.data.newProjectName}\n*Deadline:* ${projectDeadline ? projectDeadline.toLocaleDateString() : 'None'}\n\n*Select Project Lead:*\nChoose who will lead this project (reply with the number):\n\n`;
    
    // Add current user as first option
    message += `1. ${user.name} (You)\n`;
    
    // Add other users
    let userIndex = 2;
    users.forEach((u, index) => {
      if (u.id !== user.id) {
        message += `${userIndex}. ${u.name} (${u.email})\n`;
        userIndex++;
      }
    });
    
    message += `\n${userIndex}. Skip (No project lead)\n`;
    
    // Store users for selection
    updateConversationState(whatsappId, 'project_edit_creation_lead', {
      ...state.data,
      availableUsers: users
    });

    await sendMessage(whatsappId, message);

  } catch (error) {
    console.error("Error in handleProjectEditDeadlineInput:", error);
    await sendMessage(whatsappId, "❌ Error processing deadline. Please try again.");
  }
}

// Handle project lead selection during task editing
async function handleProjectEditLeadSelection(whatsappId: string, selection: string, state: ConversationState, user: any) {
  try {
    const users = state.data.availableUsers || [];
    let selectedLead = null;
    
    const selectionIndex = parseInt(selection) - 1;
    
    if (selectionIndex === 0) {
      // Selected current user
      selectedLead = user;
    } else if (selectionIndex > 0 && selectionIndex <= users.length) {
      // Filter out current user and get the selected one
      const otherUsers = users.filter((u: any) => u.id !== user.id);
      if (selectionIndex - 1 < otherUsers.length) {
        selectedLead = otherUsers[selectionIndex - 1];
      }
    }
    // If selectionIndex is the last option (skip), selectedLead remains null

    // Now create the project with all collected information
    const projectData: any = {
      name: state.data.newProjectName,
      organization_id: state.data.organizationId,
      description: state.data.newProjectDescription || `Project created via WhatsApp bot`,
      deadline: state.data.newProjectDeadline,
      project_lead: selectedLead?.id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const { data: newProject, error: projectError } = await supabase
      .from("projects")
      .insert(projectData)
      .select()
      .single();

    if (projectError) {
      console.error("Error creating project:", projectError);
      await sendMessage(whatsappId, `❌ Error creating project: ${projectError.message}`);
      return;
    }

    // Update the task with the new project
    const task = state.data.editingTask;
    const changes = state.data.changes || {};

    changes.project_id = newProject.id;
    task.project_id = newProject.id;
    task.projects = newProject;

    // Create success message with all project details
    let successMessage = `✅ *Project "${newProject.name}" created successfully!*\n\n`;
    successMessage += `📝 *Description:* ${projectData.description}\n`;
    successMessage += `📅 *Deadline:* ${projectData.deadline ? new Date(projectData.deadline).toLocaleDateString() : 'None'}\n`;
    successMessage += `👤 *Project Lead:* ${selectedLead?.name || 'None'}\n\n`;
    successMessage += `Task has been assigned to this project!`;

    await sendMessage(whatsappId, successMessage);

    // Update state and return to task edit options
    updateConversationState(whatsappId, 'task_edit_options', {
      ...state.data,
      editingTask: task,
      changes: changes
    });

    await showTaskEditOptions(whatsappId, task, user);

  } catch (error) {
    console.error("Error in handleProjectEditLeadSelection:", error);
    await sendMessage(whatsappId, "❌ An error occurred while creating the project. Please try again.");
  }
}
