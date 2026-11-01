/**
 * scripts/testUserSettingsFirestoreRulesSchema.js
 * Regression verification suite for ORVIX-AUDIT-001:
 * User Settings Firestore Rules Schema & Field Whitelist Rejection
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  saveSettings
} from '../src/services/userSettingsService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    failedTests++;
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    failedTests++;
  }
}

console.log('\n===============================================================');
console.log('ORVIX-AUDIT-001 — User Settings Firestore Rules Verification');
console.log('===============================================================\n');

// 1. Read firestore.rules and firebase-blueprint.json
const firestoreRulesContent = fs.readFileSync(path.join(rootDir, 'firestore.rules'), 'utf8');
const blueprintContent = JSON.parse(fs.readFileSync(path.join(rootDir, 'firebase-blueprint.json'), 'utf8'));

// Extract settings match block
const settingsBlockMatch = firestoreRulesContent.match(
  /match\s+\/settings\/\{settingId\}\s*\{([\s\S]*?)\n\s*\}/
);

runTest('1. firestore.rules contains /settings/{settingId} subcollection rule', () => {
  assert.ok(settingsBlockMatch, 'settings block must be present in firestore.rules');
});

const settingsBlock = settingsBlockMatch ? settingsBlockMatch[1] : '';

// 2. Allowed Fields Whitelist Check
runTest('2. hasOnly() whitelist includes all required settings fields including defaultMode, speechRate, and speechVoiceURI', () => {
  const hasOnlyMatch = settingsBlock.match(/request\.resource\.data\.keys\(\)\.hasOnly\(\[([\s\S]*?)\]\)/);
  assert.ok(hasOnlyMatch, 'hasOnly() check must exist in settings create/update rule');

  const rawFields = hasOnlyMatch[1]
    .split(',')
    .map(s => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);

  const expectedFields = [
    'theme',
    'responseLength',
    'defaultMode',
    'beginnerFriendly',
    'enterToSend',
    'showTimestamps',
    'speechRate',
    'speechVoiceURI',
    'updatedAt'
  ];

  for (const field of expectedFields) {
    assert.ok(
      rawFields.includes(field),
      `Field "${field}" must be included in settings hasOnly() whitelist (found: ${rawFields.join(', ')})`
    );
  }

  // Ensure no rogue or overly permissive wildcards exist
  assert.strictEqual(
    rawFields.length,
    expectedFields.length,
    `Whitelist count must exactly match expected fields without extra keys`
  );
});

// 3. Field Specific Validation Rules
runTest('3. defaultMode is validated against isValidChatMode()', () => {
  assert.ok(
    settingsBlock.includes("(!('defaultMode' in request.resource.data) || isValidChatMode(request.resource.data.defaultMode))"),
    'defaultMode must be validated with isValidChatMode when present'
  );
});

runTest('4. speechRate is validated for numeric type and [0.5, 2.5] range', () => {
  assert.ok(
    settingsBlock.includes("request.resource.data.speechRate is number"),
    'speechRate must be validated as a number'
  );
  assert.ok(
    settingsBlock.includes("request.resource.data.speechRate >= 0.5") &&
    settingsBlock.includes("request.resource.data.speechRate <= 2.5"),
    'speechRate must be bounded between 0.5 and 2.5'
  );
});

runTest('5. speechVoiceURI is validated for string type and max length (<= 256)', () => {
  assert.ok(
    settingsBlock.includes("request.resource.data.speechVoiceURI is string"),
    'speechVoiceURI must be validated as string'
  );
  assert.ok(
    settingsBlock.includes("request.resource.data.speechVoiceURI.size() <= 256"),
    'speechVoiceURI must be bounded to reasonable max length (<= 256)'
  );
});

runTest('6. Ownership and authentication restrictions remain strictly intact', () => {
  assert.ok(
    settingsBlock.includes('allow read, delete: if isOwner(userId);'),
    'Read and delete must require isOwner(userId)'
  );
  assert.ok(
    settingsBlock.includes('allow create, update: if isOwner(userId)'),
    'Create and update must require isOwner(userId)'
  );
  // Verify that isOwner requires authentication
  assert.ok(
    firestoreRulesContent.includes('function isOwner(userId) {') &&
    firestoreRulesContent.includes('request.auth != null') &&
    firestoreRulesContent.includes('request.auth.uid == userId'),
    'isOwner must assert request.auth.uid == userId and authentication'
  );
});

// 4. Blueprint synchronization test
runTest('7. firebase-blueprint.json UserSettings entity includes defaultMode, speechRate, and speechVoiceURI', () => {
  const entity = blueprintContent.entities.UserSettings;
  assert.ok(entity, 'UserSettings entity must exist in firebase-blueprint.json');
  assert.ok(entity.properties.defaultMode, 'defaultMode must exist in UserSettings blueprint properties');
  assert.deepStrictEqual(entity.properties.defaultMode.enum, ['general', 'coding', 'writing', 'learning']);

  assert.ok(entity.properties.speechRate, 'speechRate must exist in UserSettings blueprint properties');
  assert.strictEqual(entity.properties.speechRate.type, 'number');

  assert.ok(entity.properties.speechVoiceURI, 'speechVoiceURI must exist in UserSettings blueprint properties');
  assert.strictEqual(entity.properties.speechVoiceURI.type, 'string');
  assert.strictEqual(entity.properties.speechVoiceURI.maxLength, 256);
});

// 5. Simulated Firestore CEL Security Rule Evaluator for Settings
// Replicates exact CEL semantics of the updated settings rule
function evaluateSettingsWriteRule({ auth, pathUserId, data }) {
  // Helper: isOwner
  const isOwner = auth != null && auth.uid != null && auth.uid === pathUserId;
  if (!isOwner) return { allowed: false, reason: 'NOT_OWNER' };

  // Helper: isValidChatMode
  const isValidChatMode = (mode) => ['general', 'coding', 'writing', 'learning'].includes(mode);

  // Check keys: hasOnly(['theme', 'responseLength', 'defaultMode', 'beginnerFriendly', 'enterToSend', 'showTimestamps', 'speechRate', 'speechVoiceURI', 'updatedAt'])
  const allowedKeys = new Set([
    'theme',
    'responseLength',
    'defaultMode',
    'beginnerFriendly',
    'enterToSend',
    'showTimestamps',
    'speechRate',
    'speechVoiceURI',
    'updatedAt'
  ]);

  const dataKeys = Object.keys(data);
  for (const k of dataKeys) {
    if (!allowedKeys.has(k)) {
      return { allowed: false, reason: `UNALLOWED_FIELD: ${k}` };
    }
  }

  // Field: theme
  if ('theme' in data) {
    if (!['light', 'dark', 'system'].includes(data.theme)) {
      return { allowed: false, reason: 'INVALID_THEME' };
    }
  }

  // Field: responseLength
  if ('responseLength' in data) {
    if (!['concise', 'balanced', 'detailed'].includes(data.responseLength)) {
      return { allowed: false, reason: 'INVALID_RESPONSE_LENGTH' };
    }
  }

  // Field: defaultMode
  if ('defaultMode' in data) {
    if (!isValidChatMode(data.defaultMode)) {
      return { allowed: false, reason: 'INVALID_DEFAULT_MODE' };
    }
  }

  // Field: beginnerFriendly
  if ('beginnerFriendly' in data) {
    if (typeof data.beginnerFriendly !== 'boolean') {
      return { allowed: false, reason: 'INVALID_BEGINNER_FRIENDLY' };
    }
  }

  // Field: enterToSend
  if ('enterToSend' in data) {
    if (typeof data.enterToSend !== 'boolean') {
      return { allowed: false, reason: 'INVALID_ENTER_TO_SEND' };
    }
  }

  // Field: showTimestamps
  if ('showTimestamps' in data) {
    if (typeof data.showTimestamps !== 'boolean') {
      return { allowed: false, reason: 'INVALID_SHOW_TIMESTAMPS' };
    }
  }

  // Field: speechRate
  if ('speechRate' in data) {
    if (typeof data.speechRate !== 'number' || Number.isNaN(data.speechRate) || data.speechRate < 0.5 || data.speechRate > 2.5) {
      return { allowed: false, reason: 'INVALID_SPEECH_RATE' };
    }
  }

  // Field: speechVoiceURI
  if ('speechVoiceURI' in data) {
    if (typeof data.speechVoiceURI !== 'string' || data.speechVoiceURI.length > 256) {
      return { allowed: false, reason: 'INVALID_SPEECH_VOICE_URI' };
    }
  }

  return { allowed: true };
}

// 6. Test Suite using Simulated CEL Evaluator
runTest('8. Authenticated user can save complete sanitized settings object', () => {
  const currentSettings = { ...DEFAULT_SETTINGS };
  const sanitized = sanitizeSettings(currentSettings);
  const writePayload = {
    ...sanitized,
    updatedAt: new Date().toISOString()
  };

  const res = evaluateSettingsWriteRule({
    auth: { uid: 'user_abc123' },
    pathUserId: 'user_abc123',
    data: writePayload
  });

  assert.strictEqual(res.allowed, true, `Write with complete sanitized settings should be allowed, failed with: ${res.reason}`);
});

runTest('9. Authenticated user can update individual settings via merge', () => {
  const partialUpdates = [
    { defaultMode: 'coding' },
    { defaultMode: 'learning' },
    { speechRate: 1.25 },
    { speechVoiceURI: 'Google US English' },
    { speechVoiceURI: '' }, // empty string for system default
    { theme: 'dark' },
    { responseLength: 'detailed' },
    { beginnerFriendly: true },
    { enterToSend: false },
    { showTimestamps: false }
  ];

  for (const partial of partialUpdates) {
    const res = evaluateSettingsWriteRule({
      auth: { uid: 'user_abc123' },
      pathUserId: 'user_abc123',
      data: partial
    });
    assert.strictEqual(res.allowed, true, `Partial update ${JSON.stringify(partial)} should be allowed`);
  }
});

runTest('10. Unauthenticated write is rejected', () => {
  const res = evaluateSettingsWriteRule({
    auth: null,
    pathUserId: 'user_abc123',
    data: { theme: 'dark' }
  });
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'NOT_OWNER');
});

runTest('11. User cannot modify another user settings', () => {
  const res = evaluateSettingsWriteRule({
    auth: { uid: 'attacker_uid' },
    pathUserId: 'victim_uid',
    data: { theme: 'dark' }
  });
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'NOT_OWNER');
});

runTest('12. Invalid defaultMode values are rejected', () => {
  const invalidModes = ['invalid', 'superhero', '', 123, null, true];
  for (const mode of invalidModes) {
    const res = evaluateSettingsWriteRule({
      auth: { uid: 'user_abc123' },
      pathUserId: 'user_abc123',
      data: { defaultMode: mode }
    });
    assert.strictEqual(res.allowed, false, `defaultMode "${mode}" should be rejected`);
    assert.strictEqual(res.reason, 'INVALID_DEFAULT_MODE');
  }
});

runTest('13. Invalid speechRate values are rejected', () => {
  const invalidRates = [0.1, 0.49, 2.51, 3.0, -1, 'fast', NaN, null];
  for (const rate of invalidRates) {
    const res = evaluateSettingsWriteRule({
      auth: { uid: 'user_abc123' },
      pathUserId: 'user_abc123',
      data: { speechRate: rate }
    });
    assert.strictEqual(res.allowed, false, `speechRate "${rate}" should be rejected`);
    assert.strictEqual(res.reason, 'INVALID_SPEECH_RATE');
  }
});

runTest('14. Invalid speechVoiceURI values are rejected', () => {
  const tooLong = 'A'.repeat(257);
  const invalidURIs = [tooLong, 123, null, true, ['voice']];
  for (const uri of invalidURIs) {
    const res = evaluateSettingsWriteRule({
      auth: { uid: 'user_abc123' },
      pathUserId: 'user_abc123',
      data: { speechVoiceURI: uri }
    });
    assert.strictEqual(res.allowed, false, `speechVoiceURI should be rejected`);
    assert.strictEqual(res.reason, 'INVALID_SPEECH_VOICE_URI');
  }
});

runTest('15. Unexpected or ghost fields are rejected by hasOnly()', () => {
  const forbiddenPayloads = [
    { theme: 'dark', isAdmin: true },
    { defaultMode: 'coding', role: 'admin' },
    { speechRate: 1.0, userToken: 'secret' },
    { unknownField: 'val' }
  ];

  for (const payload of forbiddenPayloads) {
    const res = evaluateSettingsWriteRule({
      auth: { uid: 'user_abc123' },
      pathUserId: 'user_abc123',
      data: payload
    });
    assert.strictEqual(res.allowed, false, `Payload with unexpected field must be rejected`);
    assert.ok(res.reason.startsWith('UNALLOWED_FIELD'));
  }
});

runTest('16. sanitizeSettings in userSettingsService.js sanitizes raw input to conform with the rules schema', () => {
  const malformedInput = {
    theme: 'neon-purple',       // invalid -> defaults to 'system'
    responseLength: 'endless',   // invalid -> defaults to 'balanced'
    defaultMode: 'hacking',      // invalid -> defaults to 'general'
    beginnerFriendly: 'yes',     // invalid type -> defaults to false
    enterToSend: 1,              // invalid type -> defaults to true
    showTimestamps: 'no',        // invalid type -> defaults to true
    speechRate: '999',           // out of bounds -> defaults to 1
    speechVoiceURI: 12345,       // invalid type -> defaults to ''
    ghostKey: 'injected'         // extraneous -> stripped
  };

  const sanitized = sanitizeSettings(malformedInput);

  assert.strictEqual(sanitized.theme, 'system');
  assert.strictEqual(sanitized.responseLength, 'balanced');
  assert.strictEqual(sanitized.defaultMode, 'general');
  assert.strictEqual(sanitized.beginnerFriendly, false);
  assert.strictEqual(sanitized.enterToSend, true);
  assert.strictEqual(sanitized.showTimestamps, true);
  assert.strictEqual(sanitized.speechRate, 1);
  assert.strictEqual(sanitized.speechVoiceURI, '');
  assert.strictEqual('ghostKey' in sanitized, false);

  // Feeding sanitized result to the rule evaluator must pass
  const ruleResult = evaluateSettingsWriteRule({
    auth: { uid: 'user_123' },
    pathUserId: 'user_123',
    data: { ...sanitized, updatedAt: new Date().toISOString() }
  });
  assert.strictEqual(ruleResult.allowed, true);
});

console.log('\n===============================================================');
console.log(`Results: ${passedTests} / ${totalTests} tests passed (${failedTests} failed)`);
console.log('===============================================================\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
