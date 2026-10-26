/**
 * Orvix User Settings Repository (MongoDB Atlas)
 *
 * Handles persistence and queries for the 'user_settings' collection in database 'Orvix'.
 * Replaces Firebase Firestore /users/{userId}/settings/preferences collection.
 */

import { Collection } from 'mongodb';
import { getDatabase } from '../db/mongodb.ts';

export type AppTheme = 'light' | 'dark' | 'system';
export type ResponseLength = 'concise' | 'balanced' | 'detailed';
export type ChatMode = 'general' | 'coding' | 'writing' | 'learning';

export interface UserSettingsDocument {
  _id: string; // userId
  userId: string;
  theme: AppTheme;
  responseLength: ResponseLength;
  defaultMode: ChatMode;
  beginnerFriendly: boolean;
  enterToSend: boolean;
  showTimestamps: boolean;
  speechRate: number;
  speechVoiceURI: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSettingsInput {
  theme?: AppTheme;
  responseLength?: ResponseLength;
  defaultMode?: ChatMode;
  beginnerFriendly?: boolean;
  enterToSend?: boolean;
  showTimestamps?: boolean;
  speechRate?: number;
  speechVoiceURI?: string;
}

export const DEFAULT_USER_SETTINGS: Omit<UserSettingsDocument, '_id' | 'userId' | 'createdAt' | 'updatedAt'> = {
  theme: 'system',
  responseLength: 'balanced',
  defaultMode: 'general',
  beginnerFriendly: false,
  enterToSend: true,
  showTimestamps: true,
  speechRate: 1,
  speechVoiceURI: ''
};

const VALID_THEMES = new Set<AppTheme>(['system', 'dark', 'light']);
const VALID_RESPONSE_LENGTHS = new Set<ResponseLength>(['concise', 'balanced', 'detailed']);
const VALID_MODES = new Set<ChatMode>(['general', 'coding', 'writing', 'learning']);

/**
 * Sanitizes and validates user settings values.
 */
export function sanitizeSettingsInput(raw?: Partial<UserSettingsInput> | null): Partial<UserSettingsInput> {
  if (!raw || typeof raw !== 'object') return {};

  const clean: Partial<UserSettingsInput> = {};

  if (raw.theme && VALID_THEMES.has(raw.theme as AppTheme)) {
    clean.theme = raw.theme as AppTheme;
  }
  if (raw.responseLength && VALID_RESPONSE_LENGTHS.has(raw.responseLength as ResponseLength)) {
    clean.responseLength = raw.responseLength as ResponseLength;
  }
  if (raw.defaultMode && VALID_MODES.has(raw.defaultMode as ChatMode)) {
    clean.defaultMode = raw.defaultMode as ChatMode;
  }
  if (typeof raw.beginnerFriendly === 'boolean') {
    clean.beginnerFriendly = raw.beginnerFriendly;
  }
  if (typeof raw.enterToSend === 'boolean') {
    clean.enterToSend = raw.enterToSend;
  }
  if (typeof raw.showTimestamps === 'boolean') {
    clean.showTimestamps = raw.showTimestamps;
  }
  if (typeof raw.speechRate === 'number' && !isNaN(raw.speechRate)) {
    const rate = Math.max(0.5, Math.min(2.5, raw.speechRate));
    clean.speechRate = rate;
  }
  if (typeof raw.speechVoiceURI === 'string') {
    clean.speechVoiceURI = raw.speechVoiceURI.trim();
  }

  return clean;
}

/**
 * Generates standard default settings for a given user ID.
 */
export function getDefaultUserSettings(userId: string): UserSettingsDocument {
  const now = new Date();
  return {
    _id: userId,
    userId,
    ...DEFAULT_USER_SETTINGS,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Returns the MongoDB collection for user_settings.
 */
export function getUserSettingsCollection(): Collection<UserSettingsDocument> {
  const db = getDatabase();
  return db.collection<UserSettingsDocument>('user_settings');
}

/**
 * Ensures optimal indexes for the 'user_settings' collection.
 */
export async function ensureUserSettingsIndexes(): Promise<void> {
  try {
    const col = getUserSettingsCollection();
    await col.createIndex({ userId: 1 }, { unique: true });
  } catch (err: any) {
    console.warn('[UserSettingsRepository] Index creation notice:', err?.message || err);
  }
}

/**
 * Retrieves preferences for a user, or null if not yet stored.
 */
export async function getUserSettings(userId: string): Promise<UserSettingsDocument | null> {
  if (!userId || !userId.trim()) return null;
  const col = getUserSettingsCollection();
  const cleanId = userId.trim();
  return col.findOne({
    $or: [{ _id: cleanId }, { userId: cleanId }]
  });
}

/**
 * Upserts preferences for a user (creates with defaults if absent, merges updates if existing).
 */
export async function upsertUserSettings(
  userId: string,
  partialSettings: Partial<UserSettingsInput>
): Promise<UserSettingsDocument> {
  if (!userId || !userId.trim()) {
    throw new Error('Valid userId is required to save preferences.');
  }

  const col = getUserSettingsCollection();
  const cleanId = userId.trim();
  const sanitized = sanitizeSettingsInput(partialSettings);
  const now = new Date();

  // Fields that were explicitly updated/provided go into $set
  const setFields: Record<string, any> = {
    userId: cleanId,
    updatedAt: now,
    ...sanitized
  };

  // Immutable insertion fields and unprovided defaults go into $setOnInsert
  const setOnInsertFields: Record<string, any> = {
    _id: cleanId,
    createdAt: now
  };

  // Only apply default values on insert for properties not already being set via $set
  for (const [key, defaultValue] of Object.entries(DEFAULT_USER_SETTINGS)) {
    if (!(key in sanitized)) {
      setOnInsertFields[key] = defaultValue;
    }
  }

  const result = await col.findOneAndUpdate(
    { $or: [{ _id: cleanId }, { userId: cleanId }] },
    {
      $set: setFields,
      $setOnInsert: setOnInsertFields
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    throw new Error(`Failed to upsert user settings for userId: ${cleanId}`);
  }

  return result;
}

/**
 * Deletes user settings document by user ID.
 */
export async function deleteUserSettings(userId: string): Promise<boolean> {
  if (!userId || !userId.trim()) return false;
  const col = getUserSettingsCollection();
  const cleanId = userId.trim();
  const result = await col.deleteOne({
    $or: [{ _id: cleanId }, { userId: cleanId }]
  });
  return result.deletedCount > 0;
}
