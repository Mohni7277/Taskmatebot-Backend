// Import the platform-specific memory implementation
import { telegramMemory } from './PlatformMemory';

// Re-export the telegram memory as the default memory for backward compatibility
export const memory = telegramMemory;

// This file is kept for backward compatibility
// For platform-specific memory implementations, please use PlatformMemory.ts
