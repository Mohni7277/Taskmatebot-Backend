/**
 * Teams Project Forms - Project Creation UI Components
 */

import { 
  TurnContext, 
  MessageFactory, 
  CardFactory,
  ActivityTypes 
} from "botbuilder";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config();

// Create a Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Interface for project session state
interface TeamsProjectSessionState {
  step: 'project_details' | 'project_team' | 'project_confirm';
  projectData: {
    projectName?: string;
    projectDescription?: string;
    projectDeadline?: string;
    projectLead?: string;
    projectLeadName?: string;
    selectedTeam?: string;
    selectedTeamName?: string;
    createdAt?: string;
    processing?: boolean;
  };
  userId?: string;
}

// Store user session data
const teamsProjectSessions: Record<string, TeamsProjectSessionState> = {};

// Track sessions that are processing a request to prevent duplicates
const projectSessionsInProgress = new Set<string>();

/**
 * Helper function to check if user is an admin or manager
 */
async function isUserAdminOrManager(userId: string): Promise<boolean> {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single();

    if (error || !user) {
      console.error("Error checking admin status:", error);
      return false;
    }

    return user.role === 'admin' || user.role === 'manager';
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

/**
 * Get available teams for dropdown
 */
async function getAvailableTeams(organizationId?: string) {
  try {
    let query = supabase
      .from("teams")
      .select("id, name")
      .order("name");

    // Filter by organization if provided
    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data: teams, error } = await query;

    if (error) {
      console.error("Error fetching teams:", error);
      return [];
    }

    return teams || [];
  } catch (error) {
    console.error("Error in getAvailableTeams:", error);
    return [];
  }
}

/**
 * Get available users for project lead selection
 */
async function getAvailableUsers(organizationId?: string) {
  try {
    let query = supabase
      .from("users")
      .select("id, name, email")
      .order("name");

    // Filter by organization if provided
    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data: users, error } = await query;

    if (error) {
      console.error("Error fetching users:", error);
      return [];
    }

    return users || [];
  } catch (error) {
    console.error("Error in getAvailableUsers:", error);
    return [];
  }
}

/**
 * Start the create project form for administrators and managers
 */
export async function startCreateProjectForm(context: TurnContext, user: any) {
  console.log(`🎯 startCreateProjectForm called for user ${user.id} - ${new Date().toISOString()}`);
  
  try {
    // Check if user is admin or manager
    const isAdmin = await isUserAdminOrManager(user.id);
    if (!isAdmin) {
      await context.sendActivity("❌ Only administrators and managers can create projects.");
      return;
    }

    // Initialize session
    const sessionKey = user.id;
    teamsProjectSessions[sessionKey] = {
      step: 'project_details',
      projectData: {
        createdAt: new Date().toISOString()
      },
      userId: user.id
    };    // Get available teams and users
    const teams = await getAvailableTeams(user.organization_id);
    const users = await getAvailableUsers(user.organization_id);

    // Create team choices
    const teamChoices = teams.map(t => ({
      title: t.name,
      value: JSON.stringify({ teamId: t.id, teamName: t.name })
    }));
    teamChoices.push({ title: "No Team", value: JSON.stringify({ teamId: "no_team", teamName: "No Team" }) });

    // Create user choices for project lead
    const userChoices = users.map(u => ({
      title: `${u.name} (${u.email})`,
      value: JSON.stringify({ userId: u.id, userName: u.name, userEmail: u.email })
    }));
    userChoices.unshift({ title: "No Project Lead", value: JSON.stringify({ userId: "no_lead", userName: "No Lead", userEmail: "" }) });

    // Show project creation card
    const projectCreationCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "🚀 Create New Project",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": "Fill in the project details below:",
          "wrap": true,
          "spacing": "Medium"
        },
        {
          "type": "Input.Text",
          "id": "projectName",
          "label": "Project Name",
          "placeholder": "Enter project name",
          "isRequired": true
        },
        {
          "type": "Input.Text",
          "id": "projectDescription",
          "label": "Description",
          "placeholder": "Enter project description",
          "isMultiline": true
        },
        {
          "type": "Input.Date",
          "id": "projectDeadline",
          "label": "Project Deadline (Optional)",
          "placeholder": "Select project deadline"
        },
        {
          "type": "Input.ChoiceSet",
          "id": "projectLead",
          "label": "Project Lead (Optional)",
          "choices": userChoices,
          "placeholder": "Select project lead",
          "style": "compact"
        },
        {
          "type": "Input.ChoiceSet",
          "id": "projectTeam",
          "label": "Team (Optional)",
          "choices": teamChoices,
          "placeholder": "Select a team for this project",
          "style": "compact"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "✅ Create Project",
          "data": {
            "actionType": "createProject"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelProjectCreation"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(projectCreationCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in startCreateProjectForm:", error);
    await context.sendActivity("❌ Error starting project creation form. Please try again later.");
  }
}

/**
 * Handle project creation
 */
export async function handleProjectCreation(context: TurnContext, action: any, user: any) {
  try {
    // Show typing indicator immediately
    await context.sendActivity({ type: 'typing' });
    
    const sessionKey = user.id;
    const session = teamsProjectSessions[sessionKey];

    if (!session) {
      await context.sendActivity("❌ Session expired. Please start over with the project creation command.");
      return;
    }

    // Prevent duplicate processing
    if (session.projectData.processing || projectSessionsInProgress.has(sessionKey)) {
      await context.sendActivity("⏳ Project creation is already in progress. Please wait...");
      return;
    }

    session.projectData.processing = true;
    projectSessionsInProgress.add(sessionKey);    // Validate required fields
    if (!action.projectName?.trim()) {
      await context.sendActivity("❌ Project name is required.");
      session.projectData.processing = false;
      projectSessionsInProgress.delete(sessionKey);
      return;
    }

    console.log(`🚀 Creating project: ${action.projectName} for user ${user.id}`);

    // Parse project lead if selected
    let projectLeadId = null;
    let projectLeadName = "No Lead";
    
    if (action.projectLead && action.projectLead !== "no_lead") {
      try {
        const leadData = JSON.parse(action.projectLead);
        if (leadData.userId !== "no_lead") {
          projectLeadId = leadData.userId;
          projectLeadName = leadData.userName;
        }
      } catch (parseError) {
        console.error("Error parsing project lead:", parseError);
      }
    }

    // Parse team if selected
    let teamId = null;
    let teamName = "No Team";
    
    if (action.projectTeam && action.projectTeam !== "no_team") {
      try {
        const teamData = JSON.parse(action.projectTeam);
        if (teamData.teamId !== "no_team") {
          teamId = teamData.teamId;
          teamName = teamData.teamName;
        }
      } catch (parseError) {
        console.error("Error parsing team:", parseError);
      }
    }    // Create project in database
    const projectData: any = {
      name: action.projectName.trim(),
      description: action.projectDescription?.trim() || null,
      team_id: teamId,
      organization_id: user.organization_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Add deadline if provided
    if (action.projectDeadline) {
      projectData.deadline = new Date(action.projectDeadline).toISOString();
    }

    // Add project lead if selected
    if (projectLeadId) {
      projectData.project_lead = projectLeadId;
    }

    const { data: newProject, error: projectError } = await supabase
      .from("projects")
      .insert(projectData)
      .select()
      .single();

    if (projectError) {
      console.error("Error creating project:", projectError);
      await context.sendActivity("❌ Error creating project. Please try again.");
      session.projectData.processing = false;
      projectSessionsInProgress.delete(sessionKey);
      return;
    }

    console.log("✅ Project created successfully:", newProject);

    // Send success message
    const successCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "✅ Project Created Successfully!",
          "color": "Good"
        },
        {
          "type": "Container",
          "style": "emphasis",
          "items": [
            {
              "type": "TextBlock",
              "text": `**📁 Project Name:** ${newProject.name}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**📝 Description:** ${newProject.description || 'No description'}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**👤 Project Lead:** ${projectLeadName}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**👥 Team:** ${teamName}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**📅 Deadline:** ${newProject.deadline ? new Date(newProject.deadline).toLocaleDateString() : 'No deadline'}`,
              "wrap": true
            }
          ]
        },
        {
          "type": "TextBlock",
          "text": "🎯 You can now create tasks under this project and assign them to team members.",
          "wrap": true,
          "isSubtle": true,
          "spacing": "Medium"
        }
      ]
    });

    const message = MessageFactory.attachment(successCard);
    await context.sendActivity(message);

    // Clean up session
    delete teamsProjectSessions[sessionKey];
    projectSessionsInProgress.delete(sessionKey);

  } catch (error) {
    console.error("Error in handleProjectCreation:", error);
    
    // Clean up on error
    const sessionKey = user.id;
    const session = teamsProjectSessions[sessionKey];
    if (session) {
      session.projectData.processing = false;
    }
    projectSessionsInProgress.delete(sessionKey);
    
    await context.sendActivity("❌ Error creating project. Please try again.");
  }
}

/**
 * Cancel project creation process
 */
export async function cancelProjectCreation(context: TurnContext, user: any) {
  const sessionKey = user.id;
  
  // Clean up all tracking data for this user
  delete teamsProjectSessions[sessionKey];
  projectSessionsInProgress.delete(sessionKey);
  
  // Send cancellation message
  const cancelCard = CardFactory.adaptiveCard({
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.3",
    "body": [
      {
        "type": "TextBlock",
        "size": "Medium",
        "weight": "Bolder",
        "text": "❌ Project Creation Cancelled",
        "color": "Attention"
      },
      {
        "type": "TextBlock",
        "text": "Project creation has been cancelled. No project was created.",
        "wrap": true
      }
    ]
  });
  
  const message = MessageFactory.attachment(cancelCard);
  await context.sendActivity(message);
}

// Export the sessions for debugging and management purposes
export { 
  teamsProjectSessions,
  projectSessionsInProgress
};
