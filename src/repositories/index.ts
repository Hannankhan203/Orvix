/**
 * Orvix MongoDB Repositories Index
 *
 * Central export for all MongoDB Atlas repository modules, types, and schema indexes.
 */

export * from './userRepository.ts';
export * from './conversationRepository.ts';
export * from './messageRepository.ts';
export * from './userSettingsRepository.ts';

import { ensureUserIndexes } from './userRepository.ts';
import { ensureConversationIndexes } from './conversationRepository.ts';
import { ensureMessageIndexes } from './messageRepository.ts';
import { ensureUserSettingsIndexes } from './userSettingsRepository.ts';

/**
 * Initializes and ensures all MongoDB Atlas indexes across the four collections.
 * Safe and idempotent.
 */
export async function initializeRepositoryIndexes(): Promise<void> {
  try {
    await Promise.allSettled([
      ensureUserIndexes(),
      ensureConversationIndexes(),
      ensureMessageIndexes(),
      ensureUserSettingsIndexes()
    ]);
  } catch (err: any) {
    console.warn('[Repositories] Index initialization notice:', err?.message || err);
  }
}
