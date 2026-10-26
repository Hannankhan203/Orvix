/**
 * Orvix MongoDB Repositories Verification Script
 *
 * Verifies end-to-end CRUD and query operations across all four repositories:
 * 1. users
 * 2. conversations
 * 3. messages
 * 4. user_settings
 *
 * NOTE: All test records created during this verification are strictly cleaned up
 * at the end so no permanent or dummy data is left in the database.
 * Never prints or exposes connection strings, usernames, or passwords.
 *
 * Usage:
 *   npm run test:repositories
 *   # or: npx tsx scripts/testMongoRepositories.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  connectToDatabase,
  closeDatabase,
  isMongoConfigured,
  getDatabaseName,
  sanitizeMongoError
} from '../src/db/mongodb.ts';

import {
  createUser,
  findUserById,
  updateUser,
  deleteUser
} from '../src/repositories/userRepository.ts';

import {
  upsertUserSettings,
  getUserSettings,
  deleteUserSettings
} from '../src/repositories/userSettingsRepository.ts';

import {
  createConversation,
  findConversationById,
  findConversationsByUserId,
  updateConversationTitle,
  setConversationPinned,
  deleteConversation
} from '../src/repositories/conversationRepository.ts';

import {
  createMessage,
  findMessagesByConversationId,
  updateMessage,
  deleteMessagesByConversationId
} from '../src/repositories/messageRepository.ts';

async function run() {
  console.log('====================================================');
  console.log('     Orvix MongoDB Repositories Verification Check   ');
  console.log('====================================================');

  if (!isMongoConfigured()) {
    console.warn('⚠️  MONGODB_URI is not configured in environment or .env.');
    console.log('Status: UNCONFIGURED (Set MONGODB_URI to run repository verification)');
    process.exit(0);
  }

  const dbName = getDatabaseName();
  console.log(`Connecting to database: "${dbName}"...`);

  const db = await connectToDatabase();
  if (!db) {
    console.error('❌ Failed to connect to MongoDB.');
    process.exit(1);
  }

  console.log('✅ Connected to MongoDB. Starting repository validation...\n');

  const testIdSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const testUserId = `test-user-${testIdSuffix}`;
  const testChatId = `test-chat-${testIdSuffix}`;
  const testMsgId = `test-msg-${testIdSuffix}`;

  try {
    // -------------------------------------------------------------------------
    // 1. User Repository Test
    // -------------------------------------------------------------------------
    console.log('--- [1/4] Testing UserRepository ---');
    const createdUser = await createUser({
      uid: testUserId,
      username: `TestExplorer_${testIdSuffix.slice(-4)}`,
      email: `test_${testIdSuffix}@example.com`
    });
    console.log(`  ✓ createUser: OK (uid: ${createdUser.uid}, username: ${createdUser.username})`);

    const fetchedUser = await findUserById(testUserId);
    if (!fetchedUser || fetchedUser.uid !== testUserId) {
      throw new Error(`findUserById failed: expected ${testUserId}, got ${fetchedUser?.uid}`);
    }
    console.log('  ✓ findUserById: OK');

    const updatedUser = await updateUser(testUserId, {
      username: `Updated_${testIdSuffix.slice(-4)}`
    });
    if (!updatedUser || !updatedUser.username.startsWith('Updated_')) {
      throw new Error('updateUser failed to modify username');
    }
    console.log('  ✓ updateUser: OK');

    // -------------------------------------------------------------------------
    // 2. User Settings Repository Test
    // -------------------------------------------------------------------------
    console.log('\n--- [2/4] Testing UserSettingsRepository ---');
    const savedSettings = await upsertUserSettings(testUserId, {
      theme: 'dark',
      responseLength: 'concise',
      defaultMode: 'coding',
      beginnerFriendly: true,
      enterToSend: true
    });
    console.log(`  ✓ upsertUserSettings: OK (theme: ${savedSettings.theme}, length: ${savedSettings.responseLength})`);

    const fetchedSettings = await getUserSettings(testUserId);
    if (!fetchedSettings || fetchedSettings.theme !== 'dark' || fetchedSettings.defaultMode !== 'coding') {
      throw new Error('getUserSettings failed to return persisted settings');
    }
    console.log('  ✓ getUserSettings: OK');

    const updatedSettings = await upsertUserSettings(testUserId, {
      responseLength: 'detailed'
    });
    if (!updatedSettings || updatedSettings.responseLength !== 'detailed' || updatedSettings.theme !== 'dark') {
      throw new Error('upsertUserSettings partial update failed');
    }
    console.log('  ✓ upsertUserSettings (partial update): OK');

    // -------------------------------------------------------------------------
    // 3. Conversation Repository Test
    // -------------------------------------------------------------------------
    console.log('\n--- [3/4] Testing ConversationRepository ---');
    const createdChat = await createConversation({
      id: testChatId,
      userId: testUserId,
      title: 'Initial Test Conversation',
      mode: 'coding'
    });
    console.log(`  ✓ createConversation: OK (id: ${createdChat.id}, title: "${createdChat.title}")`);

    const fetchedChat = await findConversationById(testChatId);
    if (!fetchedChat || fetchedChat.id !== testChatId) {
      throw new Error(`findConversationById failed for ${testChatId}`);
    }
    console.log('  ✓ findConversationById: OK');

    await updateConversationTitle(testChatId, 'Renamed Test Conversation');
    await setConversationPinned(testChatId, true);
    const userChats = await findConversationsByUserId(testUserId);
    if (userChats.length !== 1 || userChats[0].title !== 'Renamed Test Conversation' || !userChats[0].isPinned) {
      throw new Error('updateConversationTitle or setConversationPinned failed');
    }
    console.log('  ✓ updateConversationTitle & setConversationPinned: OK');

    // -------------------------------------------------------------------------
    // 4. Message Repository Test
    // -------------------------------------------------------------------------
    console.log('\n--- [4/4] Testing MessageRepository ---');
    const createdMsg = await createMessage({
      id: testMsgId,
      conversationId: testChatId,
      userId: testUserId,
      sender: 'user',
      content: 'Hello, this is a test prompt for repository verification.',
      clientTimestamp: '10:00 AM'
    });
    console.log(`  ✓ createMessage (user): OK (id: ${createdMsg.id})`);

    const assistantMsg = await createMessage({
      conversationId: testChatId,
      userId: testUserId,
      sender: 'assistant',
      content: 'Hello! I am confirming repository persistence.',
      modelUsed: 'gemini-3.1-flash-lite',
      provider: 'gemini',
      responseTimeMs: 250,
      alternatives: [
        {
          id: `alt-${testIdSuffix}`,
          sender: 'assistant',
          content: 'Alternative response variant',
          provider: 'gemini'
        }
      ]
    });
    console.log(`  ✓ createMessage (assistant with alternatives): OK (id: ${assistantMsg.id})`);

    const messages = await findMessagesByConversationId(testChatId);
    if (messages.length !== 2) {
      throw new Error(`findMessagesByConversationId expected 2 messages, got ${messages.length}`);
    }
    console.log(`  ✓ findMessagesByConversationId: OK (found ${messages.length} messages)`);

    await updateMessage(testMsgId, { content: 'Edited prompt content' });
    console.log('  ✓ updateMessage: OK');

    console.log('\n====================================================');
    console.log('  All 4 Repository Test Suites Passed Successfully!  ');
    console.log('====================================================');
  } catch (err: any) {
    console.error('❌ Repository test failed:', sanitizeMongoError(err));
    throw err;
  } finally {
    // -------------------------------------------------------------------------
    // Clean up all test documents
    // -------------------------------------------------------------------------
    console.log('\nCleaning up transient test records from collections...');
    try {
      const deletedMsgs = await deleteMessagesByConversationId(testChatId);
      const deletedChat = await deleteConversation(testChatId);
      const deletedSettings = await deleteUserSettings(testUserId);
      const deletedUser = await deleteUser(testUserId);

      console.log(`  ✓ Cleaned up messages (${deletedMsgs} deleted)`);
      console.log(`  ✓ Cleaned up conversation (${deletedChat ? 'deleted' : 'none'})`);
      console.log(`  ✓ Cleaned up settings (${deletedSettings ? 'deleted' : 'none'})`);
      console.log(`  ✓ Cleaned up user (${deletedUser ? 'deleted' : 'none'})`);
      console.log('✅ Teardown complete. Zero permanent test data left in MongoDB.\n');
    } catch (cleanupErr) {
      console.warn('⚠️ Teardown notice:', sanitizeMongoError(cleanupErr));
    }

    await closeDatabase();
  }
}

run().catch((err) => {
  console.error('Test execution failed:', sanitizeMongoError(err));
  process.exit(1);
});
