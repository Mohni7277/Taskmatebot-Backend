import { openai } from "@ai-sdk/openai";
import { Memory } from "@mastra/memory";
import { TokenLimiter, ToolCallFilter } from "@mastra/memory/processors";
import { PgVector, PostgresStore } from "@mastra/pg";

// Configure PostgreSQL memory with a connection string from the environment.
const connectionString: string = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";

if (!connectionString) {
  throw new Error("SUPABASE_DB_URL or DATABASE_URL must be set for platform memory.");
}

// Instead of creating multiple memory instances with separate database connections,
// let's use the schema name to isolate data for different platforms

/**
 * Creates a memory instance configured for a specific platform and organization
 * @param platform - The platform (telegram, whatsapp, slack, teams)
 * @param orgId - Optional organization ID to further namespace the memory
 * @returns Memory instance specific to platform and organization
 */
export function createMemoryForPlatform(platform: string, orgId?: string): Memory {  // Create a unique namespace for this platform and organization
  const namespace = orgId ? `${platform}_${orgId}` : `${platform}_default`;
  
  // We need to limit the number of Memory instances to avoid too many connections
  // Instead of separating by schema, we'll use the threadId parameter when calling agent.stream()
  // This ensures conversations are isolated while sharing the database connection
  return new Memory({
    // Configure PostgreSQL storage with a common schema
    storage: new PostgresStore({
      connectionString: connectionString,
      schemaName: "memory" // Use a single schema for all platforms
    }),
    
    // Use text embedding model for semantic search
    embedder: openai.embedding("text-embedding-ada-002"),
    
    // Configure PostgreSQL vector database with a common schema
    vector: new PgVector({
      connectionString: connectionString,
      schemaName: "memory_vectors" // Use a single schema for all platforms
    }),
    
    // Memory configuration options
    options: {
      lastMessages: 20, // Include the last 20 messages in context
      semanticRecall: {
        topK: 3, // Retrieve 3 most similar messages
        messageRange: 5, // Include 2 messages before and after each match
      },
      
      // Enable working memory to store user preferences and context
      workingMemory: {
        enabled: true,
        template: `
# User Profile

## Personal Info

- Name:
- Email:

## User Info

- User ID:
- User Name:
- User Email:

## User Role

- User Role:
- User Role ID:

## User Permissions

- User Permissions:
- User Permissions ID:

## User Preferences

- User Preferences:
- User Preferences ID:

## Platform Info

- Platform:
- Platform ID:

## Organization Info

- Organization Name:
- Organization ID:

## Preferences

- Communication Style:
- Task Priority Default:
- Preferred Team:
- Preferred Project:

## Session State

- Last Task Discussed:
- Open Questions:
        `,
      },
    },
    
    // Add memory processors to optimize token usage
    processors: [
      // Filter out verbose tool calls to save tokens
      new ToolCallFilter(),
      // Limit total tokens to prevent context overflow
      new TokenLimiter(127000),
    ],
  });
}

// Instead of creating separate memory instances for each platform,
// use a single memory instance to avoid connection issues
// We'll use proper thread IDs in the bot files to keep conversations separate

// Create a single memory instance for all platforms
const sharedMemory = createMemoryForPlatform('shared');

// Export the same memory instance for all platforms
export const telegramMemory = sharedMemory;
export const whatsappMemory = sharedMemory;
export const slackMemory = sharedMemory;
export const teamsMemory = sharedMemory;

// Keep original memory export for backward compatibility
export const memory = sharedMemory;
