/**
 * Teams Team Forms - Team Creation UI Components
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

// Interface for team session state
interface TeamsTeamSessionState {
  step: 'team_details' | 'team_members' | 'team_confirm';
  teamData: {
    teamName?: string;
    teamDescription?: string;
    teamLead?: string;
    teamLeadName?: string;
    selectedMembers?: string[];
    selectedMemberNames?: string[];
    createdAt?: string;
    processing?: boolean;
  };
  userId?: string;
}

// Store user session data
const teamsTeamSessions: Record<string, TeamsTeamSessionState> = {};

// Track sessions that are processing a request to prevent duplicates
const teamSessionsInProgress = new Set<string>();

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
 * Get available users for team lead and member selection
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
 * Start the create team form for administrators and managers
 */
export async function startCreateTeamForm(context: TurnContext, user: any) {
  console.log(`🎯 startCreateTeamForm called for user ${user.id} - ${new Date().toISOString()}`);
  
  try {
    // Check if user is admin or manager
    const isAdmin = await isUserAdminOrManager(user.id);
    if (!isAdmin) {
      await context.sendActivity("❌ Only administrators and managers can create teams.");
      return;
    }

    // Initialize session
    const sessionKey = user.id;
    teamsTeamSessions[sessionKey] = {
      step: 'team_details',
      teamData: {
        createdAt: new Date().toISOString()
      },
      userId: user.id
    };    // Get available users
    const users = await getAvailableUsers(user.organization_id);

    // Create user choices for team lead
    const userChoices = users.map(u => ({
      title: `${u.name} (${u.email})`,
      value: JSON.stringify({ userId: u.id, userName: u.name, userEmail: u.email })
    }));
    userChoices.unshift({ title: "No Team Lead", value: JSON.stringify({ userId: "no_lead", userName: "No Lead", userEmail: "" }) });

    // Show team creation card
    const teamCreationCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "👥 Create New Team",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": "Fill in the team details below:",
          "wrap": true,
          "spacing": "Medium"
        },
        {
          "type": "Input.Text",
          "id": "teamName",
          "label": "Team Name",
          "placeholder": "Enter team name",
          "isRequired": true
        },
        {
          "type": "Input.Text",
          "id": "teamDescription",
          "label": "Description",
          "placeholder": "Enter team description",
          "isMultiline": true
        },
        {
          "type": "Input.ChoiceSet",
          "id": "teamLead",
          "label": "Team Lead (Optional)",
          "choices": userChoices,
          "placeholder": "Select team lead",
          "style": "compact"
        },
        {
          "type": "TextBlock",
          "text": "**Note:** You can add team members after creating the team.",
          "wrap": true,
          "isSubtle": true,
          "spacing": "Medium"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "✅ Create Team",
          "data": {
            "actionType": "createTeam"
          }
        },
        {
          "type": "Action.Submit",
          "title": "👥 Add Members First",
          "data": {
            "actionType": "addMembersFirst"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelTeamCreation"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(teamCreationCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in startCreateTeamForm:", error);
    await context.sendActivity("❌ Error starting team creation form. Please try again later.");
  }
}

/**
 * Handle adding members first before team creation
 */
export async function handleAddMembersFirst(context: TurnContext, action: any, user: any) {
  try {
    const sessionKey = user.id;
    const session = teamsTeamSessions[sessionKey];

    if (!session) {
      await context.sendActivity("❌ Session expired. Please start over with the team creation command.");
      return;
    }

    // Validate and store team basic info
    if (!action.teamName?.trim()) {
      await context.sendActivity("❌ Team name is required.");
      return;
    }

    session.teamData.teamName = action.teamName.trim();
    session.teamData.teamDescription = action.teamDescription?.trim() || "";
    
    // Parse team lead if selected
    if (action.teamLead && action.teamLead !== "no_lead") {
      try {
        const leadData = JSON.parse(action.teamLead);
        if (leadData.userId !== "no_lead") {
          session.teamData.teamLead = leadData.userId;
          session.teamData.teamLeadName = leadData.userName;
        }
      } catch (parseError) {
        console.error("Error parsing team lead:", parseError);
      }
    }

    session.step = 'team_members';    // Get available users for member selection
    const users = await getAvailableUsers(user.organization_id);
    
    // Filter out the team lead from member selection if one was selected
    const availableUsers = users.filter(u => u.id !== session.teamData.teamLead);

    const memberChoices = availableUsers.map(u => ({
      title: `${u.name} (${u.email})`,
      value: JSON.stringify({ userId: u.id, userName: u.name, userEmail: u.email })
    }));

    // Show member selection card
    const memberSelectionCard = CardFactory.adaptiveCard({
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.3",
      "body": [
        {
          "type": "TextBlock",
          "size": "Medium",
          "weight": "Bolder",
          "text": "👥 Add Team Members",
          "color": "Accent"
        },
        {
          "type": "TextBlock",
          "text": `**Team:** ${session.teamData.teamName}`,
          "wrap": true,
          "weight": "Bolder"
        },
        {
          "type": "TextBlock",
          "text": `**Team Lead:** ${session.teamData.teamLeadName || 'No Lead'}`,
          "wrap": true
        },
        {
          "type": "TextBlock",
          "text": "Select team members (you can select multiple users):",
          "wrap": true,
          "spacing": "Medium"
        },
        {
          "type": "Input.ChoiceSet",
          "id": "teamMembers",
          "choices": memberChoices,
          "isMultiSelect": true,
          "style": "expanded"
        }
      ],
      "actions": [
        {
          "type": "Action.Submit",
          "title": "✅ Create Team with Members",
          "data": {
            "actionType": "createTeamWithMembers"
          }
        },
        {
          "type": "Action.Submit",
          "title": "🔙 Back to Team Details",
          "data": {
            "actionType": "backToTeamDetails"
          }
        },
        {
          "type": "Action.Submit",
          "title": "❌ Cancel",
          "data": {
            "actionType": "cancelTeamCreation"
          }
        }
      ]
    });

    const message = MessageFactory.attachment(memberSelectionCard);
    await context.sendActivity(message);

  } catch (error) {
    console.error("Error in handleAddMembersFirst:", error);
    await context.sendActivity("❌ Error processing member selection. Please try again.");
  }
}

/**
 * Handle team creation (simple version without member selection)
 */
export async function handleTeamCreation(context: TurnContext, action: any, user: any) {
  try {
    // Show typing indicator immediately
    await context.sendActivity({ type: 'typing' });
    
    const sessionKey = user.id;
    const session = teamsTeamSessions[sessionKey];

    if (!session) {
      await context.sendActivity("❌ Session expired. Please start over with the team creation command.");
      return;
    }

    // Prevent duplicate processing
    if (session.teamData.processing || teamSessionsInProgress.has(sessionKey)) {
      await context.sendActivity("⏳ Team creation is already in progress. Please wait...");
      return;
    }

    session.teamData.processing = true;
    teamSessionsInProgress.add(sessionKey);    // Validate required fields
    if (!action.teamName?.trim()) {
      await context.sendActivity("❌ Team name is required.");
      session.teamData.processing = false;
      teamSessionsInProgress.delete(sessionKey);
      return;
    }

    await createTeamInDatabase(context, action, user, session, []);

  } catch (error) {
    console.error("Error in handleTeamCreation:", error);
    
    // Clean up on error
    const sessionKey = user.id;
    const session = teamsTeamSessions[sessionKey];
    if (session) {
      session.teamData.processing = false;
    }
    teamSessionsInProgress.delete(sessionKey);
    
    await context.sendActivity("❌ Error creating team. Please try again.");
  }
}

/**
 * Handle team creation with members
 */
export async function handleTeamCreationWithMembers(context: TurnContext, action: any, user: any) {
  try {
    // Show typing indicator immediately
    await context.sendActivity({ type: 'typing' });
    
    const sessionKey = user.id;
    const session = teamsTeamSessions[sessionKey];

    if (!session) {
      await context.sendActivity("❌ Session expired. Please start over with the team creation command.");
      return;
    }

    // Prevent duplicate processing
    if (session.teamData.processing || teamSessionsInProgress.has(sessionKey)) {
      await context.sendActivity("⏳ Team creation is already in progress. Please wait...");
      return;
    }

    session.teamData.processing = true;
    teamSessionsInProgress.add(sessionKey);

    // Parse selected members
    let selectedMembers: any[] = [];
    if (action.teamMembers) {
      try {
        if (Array.isArray(action.teamMembers)) {
          selectedMembers = action.teamMembers.map((m: any) => JSON.parse(m));
        } else {
          selectedMembers = [JSON.parse(action.teamMembers)];
        }
      } catch (parseError) {
        console.error("Error parsing team members:", parseError);
      }
    }

    await createTeamInDatabase(context, {
      teamName: session.teamData.teamName,
      teamDescription: session.teamData.teamDescription,
      teamLead: session.teamData.teamLead
    }, user, session, selectedMembers);

  } catch (error) {
    console.error("Error in handleTeamCreationWithMembers:", error);
    
    // Clean up on error
    const sessionKey = user.id;
    const session = teamsTeamSessions[sessionKey];
    if (session) {
      session.teamData.processing = false;
    }
    teamSessionsInProgress.delete(sessionKey);
    
    await context.sendActivity("❌ Error creating team with members. Please try again.");
  }
}

/**
 * Create team in database (shared function)
 */
async function createTeamInDatabase(context: TurnContext, action: any, user: any, session: TeamsTeamSessionState, members: any[]) {
  const sessionKey = user.id;

  try {
    console.log(`👥 Creating team: ${action.teamName} for user ${user.id}`);

    // Parse team lead if selected
    let teamLeadId = null;
    let teamLeadName = "No Lead";
    
    if (action.teamLead && action.teamLead !== "no_lead") {
      try {
        const leadData = JSON.parse(action.teamLead);
        if (leadData.userId !== "no_lead") {
          teamLeadId = leadData.userId;
          teamLeadName = leadData.userName;
        }
      } catch (parseError) {
        console.error("Error parsing team lead:", parseError);
      }
    } else if (session.teamData.teamLead) {
      teamLeadId = session.teamData.teamLead;
      teamLeadName = session.teamData.teamLeadName || "Lead";
    }    // Create team in database
    const teamData = {
      name: action.teamName.trim(),
      description: action.teamDescription?.trim() || session.teamData.teamDescription || null,
      organization_id: user.organization_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newTeam, error: teamError } = await supabase
      .from("teams")
      .insert(teamData)
      .select()
      .single();

    if (teamError) {
      console.error("Error creating team:", teamError);
      await context.sendActivity("❌ Error creating team. Please try again.");
      session.teamData.processing = false;
      teamSessionsInProgress.delete(sessionKey);
      return;
    }

    console.log("✅ Team created successfully:", newTeam);

    // Add members to team if any were selected
    let memberCount = 0;
    if (members.length > 0) {
      const memberInserts = members.map(member => ({
        team_id: newTeam.id,
        user_id: member.userId,
        role: 'member',
        joined_at: new Date().toISOString()
      }));

      // Add team lead as member if they're not already in the members list
      if (teamLeadId && !members.some(m => m.userId === teamLeadId)) {
        memberInserts.push({
          team_id: newTeam.id,
          user_id: teamLeadId,
          role: 'lead',
          joined_at: new Date().toISOString()
        });
      }

      const { error: membersError } = await supabase
        .from("team_members")
        .insert(memberInserts);

      if (membersError) {
        console.error("Error adding team members:", membersError);
        // Don't fail team creation, just warn
        await context.sendActivity("⚠️ Team created but some members couldn't be added. You can add them manually later.");
      } else {
        memberCount = memberInserts.length;
        console.log(`✅ Added ${memberCount} members to team`);
      }
    } else if (teamLeadId) {
      // Add just the team lead as member
      const { error: leadMemberError } = await supabase
        .from("team_members")
        .insert({
          team_id: newTeam.id,
          user_id: teamLeadId,
          role: 'lead',
          joined_at: new Date().toISOString()
        });

      if (!leadMemberError) {
        memberCount = 1;
      }
    }

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
          "text": "✅ Team Created Successfully!",
          "color": "Good"
        },
        {
          "type": "Container",
          "style": "emphasis",
          "items": [
            {
              "type": "TextBlock",
              "text": `**👥 Team Name:** ${newTeam.name}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**📝 Description:** ${newTeam.description || 'No description'}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**👤 Team Lead:** ${teamLeadName}`,
              "wrap": true
            },
            {
              "type": "TextBlock",
              "text": `**👥 Members:** ${memberCount} member${memberCount !== 1 ? 's' : ''} added`,
              "wrap": true
            }
          ]
        },
        {
          "type": "TextBlock",
          "text": "🎯 You can now create projects for this team and assign tasks to team members.",
          "wrap": true,
          "isSubtle": true,
          "spacing": "Medium"
        }
      ]
    });

    const message = MessageFactory.attachment(successCard);
    await context.sendActivity(message);

    // Clean up session
    delete teamsTeamSessions[sessionKey];
    teamSessionsInProgress.delete(sessionKey);

  } catch (error) {
    console.error("Error in createTeamInDatabase:", error);
    session.teamData.processing = false;
    teamSessionsInProgress.delete(sessionKey);
    throw error;
  }
}

/**
 * Handle back to team details
 */
export async function handleBackToTeamDetails(context: TurnContext, user: any) {
  // Restart the team creation form
  await startCreateTeamForm(context, user);
}

/**
 * Cancel team creation process
 */
export async function cancelTeamCreation(context: TurnContext, user: any) {
  const sessionKey = user.id;
  
  // Clean up all tracking data for this user
  delete teamsTeamSessions[sessionKey];
  teamSessionsInProgress.delete(sessionKey);
  
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
        "text": "❌ Team Creation Cancelled",
        "color": "Attention"
      },
      {
        "type": "TextBlock",
        "text": "Team creation has been cancelled. No team was created.",
        "wrap": true
      }
    ]
  });
  
  const message = MessageFactory.attachment(cancelCard);
  await context.sendActivity(message);
}

// Export the sessions for debugging and management purposes
export { 
  teamsTeamSessions,
  teamSessionsInProgress
};
