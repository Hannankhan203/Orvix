/**
 * Orvix Firestore Chat Storage Service
 * Handles conversation metadata, message subcollections, title auto-generation,
 * renaming, and deep subcollection deletion in Cloud Firestore.
 *
 * Schema:
 *   users/{userId}/chats/{chatId}
 *     - id: string
 *     - title: string
 *     - userId: string
 *     - createdAt: timestamp
 *     - updatedAt: timestamp
 *
 *   users/{userId}/chats/{chatId}/messages/{messageId}
 *     - id: string
 *     - sender: 'user' | 'assistant'
 *     - content: string
 *     - modelUsed: string | null
 *     - createdAt: timestamp
 *     - clientTimestamp: string
 */

import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../config/firebaseConfig.js';

/**
 * Generates a clean, readable conversation title from the initial user prompt.
 * @param {string} promptText
 * @param {number} [maxLength=36]
 * @returns {string}
 */
export function generateChatTitle(promptText, maxLength = 36) {
  if (!promptText || !promptText.trim()) {
    return 'New Conversation';
  }

  // Clean markdown symbols, quotes, and excessive whitespace
  let clean = promptText
    .replace(/^[#*`>"'\s]+/, '')
    .replace(/[#*`>"'\n\r\t]+/g, ' ')
    .trim();

  if (!clean) {
    return 'New Conversation';
  }

  if (clean.length <= maxLength) {
    return clean;
  }

  // Truncate at last space before maxLength
  const truncated = clean.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 16) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Creates a new chat conversation document in Firestore
 * @param {string} userId - Authenticated user UID
 * @param {string} [initialTitle='New Conversation']
 * @returns {Promise<string>} The generated chatId
 */
export async function createChatDocument(userId, initialTitle = 'New Conversation') {
  if (!db || !isFirebaseConfigured()) {
    throw new Error('Firestore is not configured. Please supply valid Firebase credentials.');
  }

  const chatsRef = collection(db, 'users', userId, 'chats');
  const newChatDoc = doc(chatsRef); // auto-generates stable ID
  const chatId = newChatDoc.id;

  const chatData = {
    id: chatId,
    title: initialTitle,
    userId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    isPinned: false,
    pinnedAt: null
  };

  await setDoc(newChatDoc, chatData);
  return chatId;
}

/**
 * Appends a message to a chat's messages subcollection and updates parent chat's updatedAt
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {Object} message - Message object
 * @param {string} message.id - Unique stable message ID
 * @param {'user' | 'assistant'} message.sender
 * @param {string} message.content
 * @param {string} [message.modelUsed]
 * @param {string} [message.timestamp]
 */
export async function saveChatMessage(userId, chatId, message) {
  if (!db || !isFirebaseConfigured()) {
    throw new Error('Firestore is not configured. Please supply valid Firebase credentials.');
  }

  // Never persist temporary mock messages, loading states, or failed error messages
  if (message.isError || (message.sender !== 'user' && message.sender !== 'assistant')) {
    return;
  }

  const messageDocRef = doc(db, 'users', userId, 'chats', chatId, 'messages', message.id);
  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);

  const payload = {
    id: message.id,
    sender: message.sender,
    content: message.content,
    modelUsed: message.modelUsed || null,
    createdAt: serverTimestamp(),
    clientTimestamp: message.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  // Write message document idempotently
  await setDoc(messageDocRef, payload);

  // Touch parent chat's updatedAt timestamp
  try {
    await updateDoc(chatDocRef, {
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    console.warn('Could not update parent chat updatedAt:', err);
  }
}

/**
 * Renames an existing conversation
 * @param {string} userId
 * @param {string} chatId
 * @param {string} newTitle
 */
export async function renameConversation(userId, chatId, newTitle) {
  if (!db || !isFirebaseConfigured()) {
    throw new Error('Firestore is not configured.');
  }

  const sanitized = (newTitle || '').trim();
  if (!sanitized) {
    throw new Error('Conversation title cannot be empty.');
  }

  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
  await updateDoc(chatDocRef, {
    title: sanitized,
    updatedAt: serverTimestamp()
  });
}

/**
 * Toggles or updates the pinned status of a conversation in Firestore.
 * Enforces a strict limit of maximum 5 pinned chats per user at the database level.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {boolean} isPinned - Target pinned status
 * @returns {Promise<boolean>} Resulting pinned state
 */
export async function toggleChatPinned(userId, chatId, isPinned) {
  if (!db || !isFirebaseConfigured()) {
    throw new Error('Firestore is not configured.');
  }

  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);

  if (isPinned) {
    // Enforce 5-chat pin limit per user
    const chatsRef = collection(db, 'users', userId, 'chats');
    const pinnedQuery = query(chatsRef, where('isPinned', '==', true));
    const snapshot = await getDocs(pinnedQuery);

    const alreadyPinned = snapshot.docs.some((d) => d.id === chatId);
    if (!alreadyPinned && snapshot.docs.length >= 5) {
      throw new Error('You can pin up to 5 chats. Unpin a chat before pinning another.');
    }

    await updateDoc(chatDocRef, {
      isPinned: true,
      pinnedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  } else {
    await updateDoc(chatDocRef, {
      isPinned: false,
      pinnedAt: null,
      updatedAt: serverTimestamp()
    });
    return false;
  }
}

/**
 * Deletes a conversation and all its subcollection messages reliably
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 */
export async function deleteConversation(userId, chatId) {
  if (!db || !isFirebaseConfigured()) {
    throw new Error('Firestore is not configured.');
  }

  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
  const snapshot = await getDocs(messagesRef);

  // Firestore allows up to 500 writes per batch. We chunk by 400 to remain safely under limit.
  const docs = snapshot.docs;
  const CHUNK_SIZE = 400;

  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const chunk = docs.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    chunk.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });
    await batch.commit();
  }

  // Delete parent chat document
  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
  await deleteDoc(chatDocRef);
}

/**
 * Subscribes in real-time to the authenticated user's conversations list
 * @param {string} userId
 * @param {(chats: Array) => void} onUpdate
 * @param {(err: Error) => void} onError
 * @returns {() => void} Unsubscribe function
 */
export function subscribeToUserChats(userId, onUpdate, onError) {
  if (!db || !isFirebaseConfigured()) {
    onUpdate([]);
    return () => {};
  }

  const chatsRef = collection(db, 'users', userId, 'chats');
  const q = query(chatsRef, orderBy('updatedAt', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const chats = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        let formattedDate = 'Recently';
        if (data.updatedAt?.toDate) {
          formattedDate = data.updatedAt.toDate().toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
          });
        }
        chats.push({
          id: docSnap.id,
          title: data.title || 'Untitled Chat',
          timestamp: formattedDate,
          rawUpdatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : Date.now(),
          isPinned: Boolean(data.isPinned),
          pinnedAt: data.pinnedAt?.toMillis ? data.pinnedAt.toMillis() : (data.pinnedAt || null)
        });
      });
      onUpdate(chats);
    },
    (err) => {
      console.error('Error fetching user chats:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Loads all messages for a specific conversation, ordered chronologically
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
export async function loadConversationMessages(userId, chatId) {
  if (!db || !isFirebaseConfigured()) {
    return [];
  }

  const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
  const q = query(messagesRef, orderBy('createdAt', 'asc'));

  const snapshot = await getDocs(q);
  const messages = [];

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    messages.push({
      id: docSnap.id,
      sender: data.sender,
      content: data.content,
      modelUsed: data.modelUsed,
      timestamp: data.clientTimestamp || (data.createdAt?.toDate ? data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
    });
  });

  return messages;
}
