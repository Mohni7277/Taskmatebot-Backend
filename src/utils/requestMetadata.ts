/**
 * Utility functions for handling request metadata in Mastra agents
 */

/**
 * Extract user ID from request metadata
 * @param request Request metadata object from Mastra agent stream
 * @returns User ID string or null if not found
 */
export function extractUserId(request: any): string | null {
  if (!request) return null;
  
  // Try to extract from top-level properties
  if (typeof request.userId === 'string' && request.userId) {
    return request.userId;
  }
  
  if (typeof request.user_id === 'string' && request.user_id) {
    return request.user_id;
  }
  
  // Try to extract from user object
  if (request.user) {
    if (typeof request.user.id === 'string' && request.user.id) {
      return request.user.id;
    }
    
    // Slack-specific: user may contain email that matches slack_email in database
    if (typeof request.user.email === 'string' && request.user.email) {
      return request.user.email; // Will be used as identifier for lookup
    }
  }
  
  // Try to extract from metadata
  if (request.metadata) {
    if (typeof request.metadata.userId === 'string' && request.metadata.userId) {
      return request.metadata.userId;
    }
    
    if (typeof request.metadata.user_id === 'string' && request.metadata.user_id) {
      return request.metadata.user_id;
    }
    
    // Platform-specific identifiers in metadata
    if (typeof request.metadata.slackId === 'string' && request.metadata.slackId) {
      return request.metadata.slackId;
    }
    
    if (typeof request.metadata.teamsEmail === 'string' && request.metadata.teamsEmail) {
      return request.metadata.teamsEmail;
    }
    
    if (typeof request.metadata.whatsappNumber === 'string' && request.metadata.whatsappNumber) {
      return request.metadata.whatsappNumber;
    }
    
    if (typeof request.metadata.telegramId === 'string' && request.metadata.telegramId) {
      return request.metadata.telegramId;
    }
  }
  
  // Try to extract from context
  if (request.context) {
    if (typeof request.context.userId === 'string' && request.context.userId) {
      return request.context.userId;
    }
    
    if (typeof request.context.user_id === 'string' && request.context.user_id) {
      return request.context.user_id;
    }
    
    if (request.context.user && typeof request.context.user.id === 'string' && request.context.user.id) {
      return request.context.user.id;
    }
  }
  
  // Platform-specific identifiers at top level
  if (typeof request.slackId === 'string' && request.slackId) {
    return request.slackId;
  }
  
  if (typeof request.teamsEmail === 'string' && request.teamsEmail) {
    return request.teamsEmail;
  }
  
  if (typeof request.whatsappNumber === 'string' && request.whatsappNumber) {
    return request.whatsappNumber;
  }
  
  if (typeof request.telegramId === 'string' && request.telegramId) {
    return request.telegramId;
  }
  
  return null;
}

/**
 * Extract organization ID from request metadata
 * @param request Request metadata object from Mastra agent stream
 * @returns Organization ID string or null if not found
 */
export function extractOrganizationId(request: any): string | null {
  if (!request) return null;
  
  // Try to extract from top-level properties
  if (typeof request.organizationId === 'string' && request.organizationId) {
    return request.organizationId;
  }
  
  if (typeof request.organization_id === 'string' && request.organization_id) {
    return request.organization_id;
  }
  
  // Try to extract from metadata
  if (request.metadata) {
    if (typeof request.metadata.organizationId === 'string' && request.metadata.organizationId) {
      return request.metadata.organizationId;
    }
    
    if (typeof request.metadata.organization_id === 'string' && request.metadata.organization_id) {
      return request.metadata.organization_id;
    }
  }
  
  // Try to extract from context
  if (request.context) {
    if (typeof request.context.organizationId === 'string' && request.context.organizationId) {
      return request.context.organizationId;
    }
    
    if (typeof request.context.organization_id === 'string' && request.context.organization_id) {
      return request.context.organization_id;
    }
    
    if (request.context.organization && typeof request.context.organization.id === 'string' && request.context.organization.id) {
      return request.context.organization.id;
    }
  }
  
  return null;
}

/**
 * Extract conversation ID from request metadata
 * @param request Request metadata object from Mastra agent stream
 * @returns Conversation ID string or null if not found
 */
export function extractConversationId(request: any): string | null {
  if (!request) return null;
  
  // Try to extract from top-level properties
  if (typeof request.conversationId === 'string' && request.conversationId) {
    return request.conversationId;
  }
  
  if (typeof request.conversation_id === 'string' && request.conversation_id) {
    return request.conversation_id;
  }
  
  if (typeof request.id === 'string' && request.id) {
    return request.id;
  }
  
  // Try to extract from metadata
  if (request.metadata) {
    if (typeof request.metadata.conversationId === 'string' && request.metadata.conversationId) {
      return request.metadata.conversationId;
    }
    
    if (typeof request.metadata.conversation_id === 'string' && request.metadata.conversation_id) {
      return request.metadata.conversation_id;
    }
  }
  
  // Try to extract from context
  if (request.context) {
    if (typeof request.context.conversationId === 'string' && request.context.conversationId) {
      return request.context.conversationId;
    }
    
    if (typeof request.context.conversation_id === 'string' && request.context.conversation_id) {
      return request.context.conversation_id;
    }
  }
  
  return null;
}
