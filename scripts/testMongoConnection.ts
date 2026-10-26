/**
 * Orvix MongoDB Atlas Connection Verification Script
 *
 * Usage:
 *   npm run test:mongo
 *   # or: npx tsx scripts/testMongoConnection.ts
 *
 * Tests:
 * 1. Reads process.env.MONGODB_URI and process.env.MONGODB_DB_NAME
 * 2. Connects to database 'Orvix' using official MongoDB driver
 * 3. Sends ping command
 * 4. Checks collections and latency
 * 5. Closes connection cleanly
 * 6. Never prints connection string, username, or password
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  connectToDatabase,
  getMongoStatus,
  closeDatabase,
  isMongoConfigured,
  getDatabaseName,
  getUriConfigState,
  sanitizeMongoError
} from '../src/db/mongodb.ts';

async function run() {
  console.log('====================================================');
  console.log('       Orvix MongoDB Atlas Connection Verification   ');
  console.log('====================================================');

  const configured = isMongoConfigured();
  const dbName = getDatabaseName();
  const uri = process.env.MONGODB_URI;
  const scheme = getUriConfigState(uri);

  console.log(`Configured in Environment : ${configured ? 'YES' : 'NO'}`);
  console.log(`Target Database Name      : "${dbName}"`);
  console.log(`URI Scheme Detected       : ${scheme !== 'none' ? scheme : 'NOT CONFIGURED'}`);
  console.log('----------------------------------------------------');

  if (!configured) {
    console.warn('⚠️  MONGODB_URI is not set in environment or .env.');
    console.log('Status: UNCONFIGURED (Credentials are not set)');
    process.exit(0);
  }

  console.log(`Initiating connection to MongoDB Atlas database "${dbName}"...`);
  const start = Date.now();
  let db = null;
  try {
    db = await connectToDatabase();
  } catch (connectErr: any) {
    console.error('❌ Connection exception caught:', sanitizeMongoError(connectErr));
  }

  if (!db) {
    const status = await getMongoStatus();
    console.error('❌ Connection failed!');
    console.error(`Reason: ${sanitizeMongoError(status.lastError)}`);
    process.exit(1);
  }

  const duration = Date.now() - start;
  console.log(`✅ Successfully connected to MongoDB Atlas in ${duration}ms!`);

  try {
    const pingResult = await db.command({ ping: 1 });
    console.log('✅ Ping response:', pingResult);

    const collections = await db.listCollections().toArray();
    console.log(`✅ Collections in database "${dbName}":`, collections.map((c) => c.name));
  } catch (err: any) {
    console.error('⚠️ Connected but command execution failed:', sanitizeMongoError(err));
  } finally {
    await closeDatabase();
    console.log('====================================================');
    console.log('Verification test completed.');
  }
}

run().catch((err) => {
  console.error('Unexpected test error:', sanitizeMongoError(err));
  process.exit(1);
});
