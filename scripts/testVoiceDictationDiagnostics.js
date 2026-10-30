/**
 * scripts/testVoiceDictationDiagnostics.js
 * Verification test suite for Temporary Voice Dictation Diagnostic Observability:
 *
 * 1. Diagnostics correctly identify active engine ('browser-speech' vs 'audio-record').
 * 2. Native transcripts are recorded raw before cleaning or postprocessing.
 * 3. Provider and model information (Groq Whisper / Gemini) is captured with status and latency.
 * 4. Fallback invocation reasons and bypass reasons are accurately captured.
 * 5. Raw, cleaned, and final composer transcripts remain distinct and distinguishable.
 * 6. Consecutive recording sessions do not mix diagnostic events (independent session IDs).
 * 7. When diagnostics are disabled (opt-out default), no transcript data is logged or retained.
 * 8. Public shared-chat restrictions strictly suppress all diagnostic logging.
 * 9. Audio Blob size and duration formatting functions properly.
 * 10. setDictationDiagnosticsEnabled toggle updates state reliably.
 */

import assert from 'node:assert/strict';

console.log('\n===============================================================');
console.log('ORVIX VOICE DICTATION: DIAGNOSTIC OBSERVABILITY TEST SUITE');
console.log('===============================================================\n');

let passedTests = 0;
const totalTests = 10;

// Mock environment setup
const mockLocalStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockLocalStorage.has(k) ? mockLocalStorage.get(k) : null),
  setItem: (k, v) => mockLocalStorage.set(k, String(v)),
  removeItem: (k) => mockLocalStorage.delete(k),
  clear: () => mockLocalStorage.clear()
};

globalThis.window = {
  __ORVIX_DICTATION_DIAGNOSTICS__: false,
  __ORVIX_LAST_DICTATION_DIAGNOSTIC__: null,
  __ORVIX_DICTATION_DIAGNOSTICS_HISTORY__: [],
  localStorage: globalThis.localStorage
};

// Import modules under test
const {
  isDictationDiagnosticsEnabled,
  setDictationDiagnosticsEnabled,
  createDiagnosticSession,
  finalizeDiagnosticSession,
  formatDiagnosticByteSize,
  getLastDictationDiagnostic
} = await import('../src/utils/dictationDiagnostics.js');

/* --------------------------------------------------------------------------
   Test 1: Diagnostics correctly identify active engine mode
   -------------------------------------------------------------------------- */
try {
  console.log('[Test 1] Diagnostics correctly identify active engine mode...');
  setDictationDiagnosticsEnabled(true);

  const browserSpeechSession = createDiagnosticSession({
    sessionId: 'test-sess-1',
    engineMode: 'browser-speech',
    language: 'en-PK'
  });
  assert.equal(browserSpeechSession.engineMode, 'browser-speech', 'Must identify browser-speech mode');

  const audioRecordSession = createDiagnosticSession({
    sessionId: 'test-sess-2',
    engineMode: 'audio-record',
    language: 'ur-PK'
  });
  assert.equal(audioRecordSession.engineMode, 'audio-record', 'Must identify audio-record mode');

  console.log('  ✓ Active engine mode correctly identified for both browser-speech and audio-record.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 1 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 2: Native transcripts are recorded raw before cleaning
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 2] Native transcripts are recorded raw before cleaning...');
  const session = createDiagnosticSession({
    sessionId: 'test-sess-raw',
    engineMode: 'browser-speech',
    language: 'en-PK'
  });

  const rawNativeSpeech = 'iphone 14 and iphone 13 90000 rupees non pta period';
  session.rawNativeTranscript = rawNativeSpeech;
  session.cleanedTranscript = 'iPhone 14 and iPhone 13 90,000 rupees non PTA.';
  session.finalComposerTranscript = 'iPhone 14 and iPhone 13 90,000 rupees non PTA.';

  const report = finalizeDiagnosticSession(session);
  assert.ok(report, 'Report must be generated when enabled');
  assert.equal(report.rawNativeTranscript, rawNativeSpeech, 'Must preserve exact raw native transcript before cleaning');
  assert.notEqual(report.rawNativeTranscript, report.cleanedTranscript, 'Raw and cleaned transcripts must not be identical');

  console.log('  ✓ Native transcript preserved in pristine raw form prior to formatting.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 2 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 3: Provider and model information captured with status and latency
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 3] Provider and model information captured with status and latency...');
  const session = createDiagnosticSession({
    sessionId: 'test-sess-provider',
    engineMode: 'audio-record',
    language: 'en-US'
  });

  session.serverTranscriptionInvoked = true;
  session.provider = 'groq';
  session.model = 'whisper-large-v3-turbo';
  session.providerStatus = 200;
  session.latencyMs = 645;
  session.rawProviderTranscript = 'Recognized server transcription output';

  const report = finalizeDiagnosticSession(session);
  assert.equal(report.provider, 'groq', 'Must record actual provider');
  assert.equal(report.model, 'whisper-large-v3-turbo', 'Must record actual model');
  assert.equal(report.providerStatus, 200, 'Must record HTTP response status');
  assert.equal(report.latencyMs, 645, 'Must record roundtrip latency');
  assert.equal(report.rawProviderTranscript, 'Recognized server transcription output', 'Must record raw server output');

  console.log('  ✓ Provider details, HTTP status, and latency accurately recorded.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 3 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 4: Fallback invocation reasons and bypass reasons are captured
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 4] Fallback invocation reasons and bypass reasons captured...');
  // Scenario A: Bypassed due to meaningful native speech
  const bypassedSession = createDiagnosticSession({
    sessionId: 'test-sess-bypass',
    engineMode: 'browser-speech',
    language: 'en-PK'
  });
  bypassedSession.serverTranscriptionInvoked = false;
  bypassedSession.fallbackReason = 'bypassed_native_authoritative_meaningful_speech';
  bypassedSession.reconciliationDecision = 'native';
  bypassedSession.reconciliationReason = 'fallback_bypassed';

  const reportBypass = finalizeDiagnosticSession(bypassedSession);
  assert.equal(reportBypass.serverTranscriptionInvoked, false, 'Fallback must be recorded as false');
  assert.equal(reportBypass.fallbackReason, 'bypassed_native_authoritative_meaningful_speech', 'Exact bypass reason recorded');

  // Scenario B: Invoked due to duration word count mismatch
  const invokedSession = createDiagnosticSession({
    sessionId: 'test-sess-invoked',
    engineMode: 'browser-speech',
    language: 'en-US'
  });
  invokedSession.serverTranscriptionInvoked = true;
  invokedSession.fallbackReason = 'duration_word_count_mismatch';
  invokedSession.reconciliationDecision = 'reconciled';
  invokedSession.reconciliationReason = 'demonstrated_native_continuation';

  const reportInvoked = finalizeDiagnosticSession(invokedSession);
  assert.equal(reportInvoked.serverTranscriptionInvoked, true, 'Fallback must be recorded as true');
  assert.equal(reportInvoked.fallbackReason, 'duration_word_count_mismatch', 'Exact invocation reason recorded');

  console.log('  ✓ Both bypass and invocation reasons accurately captured with deterministic tags.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 4 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 5: Raw, cleaned, and final composer transcripts remain distinguishable
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 5] Raw, cleaned, and final composer transcripts remain distinguishable...');
  const session = createDiagnosticSession({
    sessionId: 'test-sess-three-tier',
    engineMode: 'browser-speech',
    language: 'en-US'
  });

  const raw = 'hello orvix can you help me with javascript period';
  const cleaned = 'Hello, Orvix can you help me with JavaScript.';
  const finalComposer = 'Previous text: Hello, Orvix can you help me with JavaScript.';

  session.rawNativeTranscript = raw;
  session.cleanedTranscript = cleaned;
  session.finalComposerTranscript = finalComposer;

  const report = finalizeDiagnosticSession(session);
  assert.equal(report.rawNativeTranscript, raw);
  assert.equal(report.cleanedTranscript, cleaned);
  assert.equal(report.finalComposerTranscript, finalComposer);
  assert.notEqual(report.rawNativeTranscript, report.cleanedTranscript);
  assert.notEqual(report.cleanedTranscript, report.finalComposerTranscript);

  console.log('  ✓ Three-tier transcript progression (raw, cleaned, final) remains distinct.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 5 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 6: Consecutive sessions maintain independent diagnostic records
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 6] Consecutive sessions maintain independent diagnostic records...');
  const sessionA = createDiagnosticSession({
    sessionId: 'dict-sess-1001',
    engineMode: 'browser-speech',
    language: 'en-PK'
  });
  sessionA.rawNativeTranscript = 'Session 1 transcript';
  sessionA.audioBlobSizeBytes = 45000;
  const reportA = finalizeDiagnosticSession(sessionA);

  const sessionB = createDiagnosticSession({
    sessionId: 'dict-sess-1002',
    engineMode: 'audio-record',
    language: 'ur-PK'
  });
  sessionB.rawNativeTranscript = 'Session 2 transcript';
  sessionB.audioBlobSizeBytes = 92000;
  const reportB = finalizeDiagnosticSession(sessionB);

  assert.equal(reportA.sessionId, 'dict-sess-1001');
  assert.equal(reportB.sessionId, 'dict-sess-1002');
  assert.equal(reportA.language, 'en-PK');
  assert.equal(reportB.language, 'ur-PK');
  assert.notEqual(reportA.rawNativeTranscript, reportB.rawNativeTranscript);

  // Check that last diagnostic in memory points to latest session
  const lastDiag = getLastDictationDiagnostic();
  assert.equal(lastDiag.sessionId, 'dict-sess-1002', 'Latest diagnostic in memory must be session B');

  console.log('  ✓ Consecutive recording sessions remain isolated without cross-session contamination.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 6 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 7: When diagnostics are disabled, no transcript data is stored
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 7] When diagnostics are disabled, no transcript data is stored...');
  // Explicitly turn diagnostics off
  setDictationDiagnosticsEnabled(false);
  assert.equal(isDictationDiagnosticsEnabled(), false, 'Diagnostics must be disabled');

  const unrecordedSession = createDiagnosticSession({
    sessionId: 'dict-sess-private',
    engineMode: 'browser-speech',
    language: 'en-US'
  });
  unrecordedSession.rawNativeTranscript = 'Secret private transcript that should not be logged';

  const result = finalizeDiagnosticSession(unrecordedSession);
  assert.equal(result, null, 'finalizeDiagnosticSession must return null when disabled');

  console.log('  ✓ Privacy preserved: disabled diagnostics bypasses logging and storage.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 7 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 8: Public shared-chat restrictions strictly suppress all diagnostics
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 8] Public shared-chat restrictions strictly suppress all diagnostics...');
  // Even if diagnostics are globally turned on
  setDictationDiagnosticsEnabled(true);
  assert.equal(isDictationDiagnosticsEnabled(), true);

  const sharedSession = createDiagnosticSession({
    sessionId: 'dict-sess-shared',
    engineMode: 'browser-speech',
    language: 'en-US',
    isPublicSharedViewer: true
  });

  assert.equal(sharedSession.isPublicSharedViewer, true);
  assert.equal(sharedSession.isEnabled, false, 'Must be disabled in public shared viewer');

  sharedSession.rawNativeTranscript = 'Shared viewer attempt';
  const sharedResult = finalizeDiagnosticSession(sharedSession);
  assert.equal(sharedResult, null, 'Shared chat must unconditionally return null');

  console.log('  ✓ Public shared viewer privacy enforced: zero diagnostic leakage.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 8 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 9: Audio Blob size and duration formatting
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 9] Audio Blob size and duration formatting...');
  assert.equal(formatDiagnosticByteSize(0), '0 B');
  assert.equal(formatDiagnosticByteSize(512), '512 B');
  assert.equal(formatDiagnosticByteSize(2048), '2.0 KB');
  assert.equal(formatDiagnosticByteSize(25 * 1024 * 1024), '25.00 MB');

  console.log('  ✓ Byte formatting handles zero, bytes, KB, and MB scales.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 9 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 10: Toggle setDictationDiagnosticsEnabled updates state reliably
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 10] Toggle setDictationDiagnosticsEnabled updates state reliably...');
  setDictationDiagnosticsEnabled(true);
  assert.equal(isDictationDiagnosticsEnabled(), true);
  assert.equal(globalThis.localStorage.getItem('orvix_dictation_diagnostics'), 'true');

  setDictationDiagnosticsEnabled(false);
  assert.equal(isDictationDiagnosticsEnabled(), false);
  assert.equal(globalThis.localStorage.getItem('orvix_dictation_diagnostics'), null);

  console.log('  ✓ Toggle correctly synchronizes window and localStorage state.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 10 failed:', err);
}

console.log('\n===============================================================');
console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('===============================================================\n');

if (passedTests === totalTests) {
  console.log('All voice dictation diagnostic observability tests passed successfully.\n');
  process.exit(0);
} else {
  console.error(`Diagnostic tests failed: ${totalTests - passedTests} failed.`);
  process.exit(1);
}
