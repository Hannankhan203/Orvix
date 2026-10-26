/**
 * Orvix User Repository (MongoDB Atlas)
 *
 * Handles persistence and queries for the 'users' collection in database 'Orvix'.
 * Replaces Firebase Firestore /users/{userId} profile collection.
 */

import { Collection } from 'mongodb';
import { getDatabase } from '../db/mongodb.ts';

export interface UserDocument {
  _id: string; // User UID
  uid: string; // Duplicate of _id for API compatibility
  username: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  uid: string;
  username: string;
  email?: string;
}

export interface UpdateUserInput {
  username?: string;
  email?: string;
}

/**
 * Returns the MongoDB collection for users.
 */
export function getUsersCollection(): Collection<UserDocument> {
  const db = getDatabase();
  return db.collection<UserDocument>('users');
}

/**
 * Ensures optimal indexes for the 'users' collection.
 */
export async function ensureUserIndexes(): Promise<void> {
  try {
    const col = getUsersCollection();
    await col.createIndex({ uid: 1 }, { unique: true, sparse: true });
    await col.createIndex({ username: 1 });
  } catch (err: any) {
    console.warn('[UserRepository] Index creation notice:', err?.message || err);
  }
}

/**
 * Creates a new user profile document in MongoDB.
 */
export async function createUser(input: CreateUserInput): Promise<UserDocument> {
  if (!input.uid || !input.uid.trim()) {
    throw new Error('Valid user UID is required.');
  }
  const cleanUsername = (input.username || '').trim();
  if (!cleanUsername) {
    throw new Error('Username cannot be empty.');
  }

  const col = getUsersCollection();
  const now = new Date();

  const doc: UserDocument = {
    _id: input.uid.trim(),
    uid: input.uid.trim(),
    username: cleanUsername,
    email: input.email?.trim() || '',
    createdAt: now,
    updatedAt: now
  };

  await col.insertOne(doc);
  return doc;
}

/**
 * Finds a user profile by UID.
 */
export async function findUserById(uid: string): Promise<UserDocument | null> {
  if (!uid || !uid.trim()) return null;
  const col = getUsersCollection();
  const cleanUid = uid.trim();
  return col.findOne({
    $or: [{ _id: cleanUid }, { uid: cleanUid }]
  });
}

/**
 * Finds a user profile by exact username.
 */
export async function findUserByUsername(username: string): Promise<UserDocument | null> {
  if (!username || !username.trim()) return null;
  const col = getUsersCollection();
  return col.findOne({ username: username.trim() });
}

/**
 * Updates an existing user profile by UID.
 */
export async function updateUser(uid: string, patch: UpdateUserInput): Promise<UserDocument | null> {
  if (!uid || !uid.trim()) {
    throw new Error('Valid user UID is required.');
  }

  const col = getUsersCollection();
  const cleanUid = uid.trim();
  const now = new Date();

  const updateFields: Partial<UserDocument> = {
    updatedAt: now
  };

  if (patch.username !== undefined) {
    const trimmed = patch.username.trim();
    if (!trimmed) throw new Error('Username cannot be empty.');
    updateFields.username = trimmed;
  }

  if (patch.email !== undefined) {
    updateFields.email = patch.email.trim();
  }

  const result = await col.findOneAndUpdate(
    { $or: [{ _id: cleanUid }, { uid: cleanUid }] },
    { $set: updateFields },
    { returnDocument: 'after' }
  );

  return result;
}

/**
 * Upserts a user profile (inserts if not present, updates if exists).
 */
export async function upsertUser(uid: string, data: { username: string; email?: string }): Promise<UserDocument> {
  if (!uid || !uid.trim()) {
    throw new Error('Valid user UID is required.');
  }
  const cleanUid = uid.trim();
  const cleanUsername = (data.username || '').trim();
  if (!cleanUsername) {
    throw new Error('Username cannot be empty.');
  }

  const col = getUsersCollection();
  const now = new Date();

  const result = await col.findOneAndUpdate(
    { $or: [{ _id: cleanUid }, { uid: cleanUid }] },
    {
      $set: {
        uid: cleanUid,
        username: cleanUsername,
        email: data.email?.trim() || '',
        updatedAt: now
      },
      $setOnInsert: {
        _id: cleanUid,
        createdAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    throw new Error(`Failed to upsert user profile for UID: ${cleanUid}`);
  }
  return result;
}

/**
 * Deletes a user profile document by UID.
 */
export async function deleteUser(uid: string): Promise<boolean> {
  if (!uid || !uid.trim()) return false;
  const col = getUsersCollection();
  const cleanUid = uid.trim();
  const result = await col.deleteOne({
    $or: [{ _id: cleanUid }, { uid: cleanUid }]
  });
  return result.deletedCount > 0;
}
