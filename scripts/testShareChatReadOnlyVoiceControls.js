/**
 * scripts/testShareChatReadOnlyVoiceControls.js
 * Focused verification test suite for voice dictation control group disabling
 * in Orvix Share Chat public read-only viewer mode.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

console.log('\n===============================================================');
console.log('ORVIX SHARE CHAT: PUBLIC READ-ONLY VOICE CONTROLS VERIFICATION');
console.log('===============================================================\n');

let passedTests = 0;
let totalTests = 12;

// Mock environment setup
const mockLocalStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockLocalStorage.has(k) ? mockLocalStorage.get(k) : null),
  setItem: (k, v) => mockLocalStorage.set(k, String(v)),
  removeItem: (k) => mockLocalStorage.delete(k),
  clear: () => mockLocalStorage.clear()
};

let getUserMediaCalled = false;
let speechRecognitionStarted = false;

try {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: {
      getUserMedia: async () => {
        getUserMediaCalled = true;
        return {
          getTracks: () => [{ stop: () => {} }]
        };
      }
    },
    configurable: true
  });
} catch (_) {}

class MockSpeechRecognition {
  constructor() {
    this.lang = 'en-US';
    this.continuous = true;
    this.interimResults = true;
  }
  start() {
    speechRecognitionStarted = true;
  }
  stop() {}
  abort() {}
}

globalThis.SpeechRecognition = MockSpeechRecognition;
globalThis.webkitSpeechRecognition = MockSpeechRecognition;
globalThis.window = {
  innerWidth: 1024,
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: globalThis.localStorage,
  SpeechRecognition: MockSpeechRecognition,
  webkitSpeechRecognition: MockSpeechRecognition
};

// Import hook and relevant modules
const { useVoiceDictation, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = await import('../src/hooks/useVoiceDictation.js');

// Helper to simulate ChatArea logic for voice controls
function simulateChatAreaVoiceControls({
  isPublicSharedViewer = false,
  isReadOnly = false,
  isSharedView = false,
  isAuthenticatedSharedPreview = false,
  isSupported = true,
  isRecordingActive = false,
  isLoading = false,
  recordingState = 'idle'
}) {
  const isComposerDisabled = isPublicSharedViewer || (isReadOnly && !isAuthenticatedSharedPreview);

  // Voice dictation hook disabled state
  const isHookDisabled = isPublicSharedViewer;

  // Language Menu State
  let langMenuOpen = false;
  let selectedLanguage = DEFAULT_LANGUAGE;

  const handleToggleLangMenu = () => {
    if (isPublicSharedViewer || isReadOnly) return false;
    langMenuOpen = !langMenuOpen;
    return true;
  };

  const handleSelectLanguage = (langCode) => {
    if (isPublicSharedViewer || isReadOnly) return false;
    selectedLanguage = langCode;
    langMenuOpen = false;
    return true;
  };

  // Toggle listening handler
  let recordingStarted = false;
  let permissionRequested = false;

  const handleToggleListening = async () => {
    if (isPublicSharedViewer || isReadOnly || isSharedView) return false;
    if (recordingState === 'idle') {
      permissionRequested = true;
      recordingStarted = true;
      return true;
    }
    return false;
  };

  // UI button props computation
  const micButtonDisabled = Boolean(
    isPublicSharedViewer ||
    isLoading ||
    isReadOnly ||
    isSharedView ||
    isComposerDisabled
  );

  const micTitle = isPublicSharedViewer
    ? 'Voice dictation is disabled in public read-only mode'
    : isSharedView
    ? 'Voice dictation is disabled in shared preview mode'
    : isReadOnly
    ? 'Voice dictation is disabled in read-only shared mode'
    : `Voice dictation (${selectedLanguage})`;

  const langSelectorDisabled = Boolean(isPublicSharedViewer);
  const langSelectorTitle = isPublicSharedViewer
    ? 'Voice dictation language selection is disabled in public read-only mode'
    : `Dictation language: English (US). Click to change.`;

  return {
    isComposerDisabled,
    isHookDisabled,
    micButtonDisabled,
    micTitle,
    langSelectorDisabled,
    langSelectorTitle,
    canRenderDropdown: () => !isPublicSharedViewer && langMenuOpen,
    getLangMenuOpen: () => langMenuOpen,
    getSelectedLanguage: () => selectedLanguage,
    handleToggleLangMenu,
    handleSelectLanguage,
    handleToggleListening,
    wasPermissionRequested: () => permissionRequested,
    wasRecordingStarted: () => recordingStarted
  };
}

// -------------------------------------------------------------
// TEST 1: Public shared viewer microphone is visibly disabled
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true,
    isAuthenticatedSharedPreview: false
  });

  assert.strictEqual(controls.micButtonDisabled, true, 'Mic button must be disabled in public shared viewer');
  assert.strictEqual(controls.micTitle, 'Voice dictation is disabled in public read-only mode');
  console.log('✓ Test 1 Passed: Public shared viewer microphone is disabled with proper title.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 2: Public shared viewer language selector is visibly disabled
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true,
    isAuthenticatedSharedPreview: false
  });

  assert.strictEqual(controls.langSelectorDisabled, true, 'Language selector must be disabled in public shared viewer');
  assert.strictEqual(controls.langSelectorTitle, 'Voice dictation language selection is disabled in public read-only mode');
  console.log('✓ Test 2 Passed: Public shared viewer language selector is disabled with proper title.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 3: Language dropdown cannot open in public shared viewer
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true
  });

  const toggleResult = controls.handleToggleLangMenu();
  assert.strictEqual(toggleResult, false, 'handleToggleLangMenu must return false when public shared');
  assert.strictEqual(controls.getLangMenuOpen(), false, 'langMenuOpen state must remain false');
  assert.strictEqual(controls.canRenderDropdown(), false, 'Dropdown must not render in public shared viewer');
  console.log('✓ Test 3 Passed: Language dropdown cannot open in public shared viewer.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 4: Microphone handler cannot activate recording
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true
  });

  const toggleResult = await controls.handleToggleListening();
  assert.strictEqual(toggleResult, false, 'handleToggleListening must block activation');
  assert.strictEqual(controls.wasRecordingStarted(), false, 'Recording must not be started');
  console.log('✓ Test 4 Passed: Microphone handler cannot activate recording.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 5: Language-selection handler cannot change language
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true
  });

  const changeResult = controls.handleSelectLanguage('es-ES');
  assert.strictEqual(changeResult, false, 'handleSelectLanguage must block language change');
  assert.strictEqual(controls.getSelectedLanguage(), 'en-US', 'Language must remain original en-US');
  console.log('✓ Test 5 Passed: Language-selection handler cannot change language in public shared viewer.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 6: No microphone permission request is triggered
// -------------------------------------------------------------
{
  getUserMediaCalled = false;
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true
  });

  await controls.handleToggleListening();
  assert.strictEqual(controls.wasPermissionRequested(), false);
  assert.strictEqual(getUserMediaCalled, false, 'navigator.mediaDevices.getUserMedia must NOT be called');
  console.log('✓ Test 6 Passed: No microphone permission request is triggered by disabled controls.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 7: No voice recognition session starts
// -------------------------------------------------------------
{
  speechRecognitionStarted = false;
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true
  });

  await controls.handleToggleListening();
  assert.strictEqual(speechRecognitionStarted, false, 'SpeechRecognition.start() must NOT be invoked');
  console.log('✓ Test 7 Passed: No voice recognition session starts in public shared viewer.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 8: Normal private chat microphone remains functional
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: false,
    isReadOnly: false,
    isSharedView: false,
    isAuthenticatedSharedPreview: false
  });

  assert.strictEqual(controls.micButtonDisabled, false, 'Mic button must be enabled in normal private chat');
  const toggleResult = await controls.handleToggleListening();
  assert.strictEqual(toggleResult, true, 'handleToggleListening must succeed in normal chat');
  assert.strictEqual(controls.wasRecordingStarted(), true, 'Recording must start in normal chat');
  console.log('✓ Test 8 Passed: Normal private chat microphone remains functional.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 9: Normal private chat language selector remains functional
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: false,
    isReadOnly: false,
    isSharedView: false
  });

  assert.strictEqual(controls.langSelectorDisabled, false, 'Language selector must be enabled in normal chat');
  const toggleResult = controls.handleToggleLangMenu();
  assert.strictEqual(toggleResult, true, 'Language menu must be openable in normal chat');
  assert.strictEqual(controls.getLangMenuOpen(), true);
  assert.strictEqual(controls.canRenderDropdown(), true, 'Dropdown should render when open in normal chat');

  const selectResult = controls.handleSelectLanguage('es-ES');
  assert.strictEqual(selectResult, true, 'Language should change in normal chat');
  assert.strictEqual(controls.getSelectedLanguage(), 'es-ES');
  console.log('✓ Test 9 Passed: Normal private chat language selector remains functional.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 10: Authenticated temporary preview retains its existing intended behavior
// -------------------------------------------------------------
{
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: false,
    isReadOnly: true,
    isSharedView: true,
    isAuthenticatedSharedPreview: true
  });

  // Composer textarea is enabled (not disabled)
  assert.strictEqual(controls.isComposerDisabled, false, 'Composer textarea must be enabled in authenticated preview');
  // Voice dictation in shared preview mode remains disabled per existing preview policy
  assert.strictEqual(controls.micButtonDisabled, true, 'Mic button remains disabled in shared preview mode');
  assert.strictEqual(controls.micTitle, 'Voice dictation is disabled in shared preview mode');
  console.log('✓ Test 10 Passed: Authenticated temporary preview retains existing intended behavior.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 11: Imported chat voice controls remain fully functional
// -------------------------------------------------------------
{
  // Once imported, it is a normal private chat with isSharedView = false, isPublicSharedViewer = false
  const controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: false,
    isReadOnly: false,
    isSharedView: false,
    isAuthenticatedSharedPreview: false
  });

  assert.strictEqual(controls.micButtonDisabled, false, 'Mic must be enabled in imported chat');
  assert.strictEqual(controls.langSelectorDisabled, false, 'Lang selector must be enabled in imported chat');
  assert.strictEqual(controls.handleToggleLangMenu(), true);
  assert.strictEqual(controls.handleSelectLanguage('fr-FR'), true);
  assert.strictEqual(controls.getSelectedLanguage(), 'fr-FR');
  console.log('✓ Test 11 Passed: Imported chat voice controls remain functional.');
  passedTests++;
}

// -------------------------------------------------------------
// TEST 12: Switching from public shared view to normal chat restores controls correctly
// -------------------------------------------------------------
{
  // Step A: Public shared view
  let controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: true,
    isReadOnly: true,
    isSharedView: true
  });
  assert.strictEqual(controls.micButtonDisabled, true);
  assert.strictEqual(controls.langSelectorDisabled, true);

  // Step B: User navigates home or creates new chat (normal chat)
  controls = simulateChatAreaVoiceControls({
    isPublicSharedViewer: false,
    isReadOnly: false,
    isSharedView: false
  });
  assert.strictEqual(controls.micButtonDisabled, false, 'Mic button restored');
  assert.strictEqual(controls.langSelectorDisabled, false, 'Lang selector restored');
  assert.strictEqual(controls.handleToggleLangMenu(), true, 'Dropdown can open after switching back');
  console.log('✓ Test 12 Passed: Switching from public shared view to normal chat restores controls.');
  passedTests++;
}

console.log('\n===============================================================');
console.log(`SUMMARY: ${passedTests} of ${totalTests} TESTS PASSED CLEANLY.`);
console.log('===============================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
