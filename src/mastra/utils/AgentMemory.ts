import { openai } from "@ai-sdk/openai";
import { Memory } from "@mastra/memory";
import { TokenLimiter, ToolCallFilter } from "@mastra/memory/processors";
import { PgVector, PostgresStore } from "@mastra/pg";

// Configure PostgreSQL memory with a connection string from the environment.
const connectionString: string = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";

if (!connectionString) {
  throw new Error("SUPABASE_DB_URL or DATABASE_URL must be set for agent memory.");
}

/**
 * Creates a memory instance configured for a specific platform and organization
 * @param platform - The platform (telegram, whatsapp, slack, teams)
 * @param orgId - Optional organization ID to further namespace the memory
 * @returns Memory instance specific to platform and organization
 */
export function createMemoryForPlatform(platform: string, orgId?: string): Memory {
  // Create a unique namespace for this platform and organization
  const namespace = orgId ? `${platform}_${orgId}` : `${platform}_default`;
  
  return new Memory({    // Configure PostgreSQL storage
    storage: new PostgresStore({
      connectionString: connectionString,
      schemaName: `memory_${namespace}` // Use platform-specific schema name
    }),
  embedder: openai.embedding("text-embedding-ada-002"),    // Configure PostgreSQL vector database for semantic search
    vector: new PgVector({
      schemaName: `memory_vectors_${namespace}`,
      connectionString: connectionString,
    }),
    // Memory configuration options
    options: {
      lastMessages: 20, // Include the last 20 messages in context
      semanticRecall: {
        topK: 3, // Retrieve 3 most similar messages
        messageRange: 2, // Include 2 messages before and after each match
      },
      // Enable working memory to store user preferences and context
      workingMemory: {
        enabled: true,
        template: `
# User Profile

## Personal Info

- Name:
- Email:

## Preferences

- Communication Style:
- Task Priority Default:
- Preferred Team:
- Preferred Project:

## Session State

- Last Task Discussed:
- Open Questions:      `,
      }
    },
    // Add memory processors to optimize token usage
    processors: [
      // Filter out verbose tool calls to save tokens
      new ToolCallFilter(),
      // Limit total tokens to prevent context overflow
      new TokenLimiter(127000),
    ]
  });
}

// Create a default memory instance for backward compatibility
export const memory = createMemoryForPlatform('telegram');
