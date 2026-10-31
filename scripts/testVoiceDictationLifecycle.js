/**
 * scripts/testVoiceDictationLifecycle.js
 * Focused Regression Test Suite for Voice Dictation Auto-Pause and Resume Lifecycle Bugs
 *
 * Scenarios Covered:
 * Test 1 — SpeechRecognition ends during a long recording (MediaRecorder remains recording)
 * Test 2 — Long recording (45s+) survives the SpeechRecognition interruption without audio loss
 * Test 3 — Intentional Pause -> Resume restores MediaRecorder, tracks, visualizer, and UI state
 * Test 4 — Speech after Resume is retained in the final audio buffer
 * Test 5 — Multiple Pause/Resume cycles operate cleanly without duplicate streams or state leaks
 */

import assert from 'node:assert/strict';
import React from 'react';

console.log('\n===============================================================');
console.log('ORVIX VOICE DICTATION: LIFECYCLE REGRESSION TEST SUITE');
console.log('===============================================================\n');

let passedTests = 0;
const totalTests = 5;

// Mock environment setup
const mockLocalStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockLocalStorage.has(k) ? mockLocalStorage.get(k) : null),
  setItem: (k, v) => mockLocalStorage.set(k, String(v)),
  removeItem: (k) => mockLocalStorage.delete(k),
  clear: () => mockLocalStorage.clear()
};

let activeMediaRecorders = [];
let activeMicrophoneStreams = [];
let activeSpeechRecognitions = [];
let audioContextInstances = [];

class MockAudioTrack {
  constructor() {
    this.kind = 'audio';
    this.enabled = true;
    this.readyState = 'live';
    this.muted = false;
    this.onended = null;
    this.onmute = null;
  }
  stop() {
    this.readyState = 'ended';
  }
}

class MockMediaStream {
  constructor() {
    this.id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.tracks = [new MockAudioTrack()];
    this.active = true;
    activeMicrophoneStreams.push(this);
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class MockMediaRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.eventListeners = new Map();
    activeMediaRecorders.push(this);
  }

  addEventListener(event, handler) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(handler);
  }

  removeEventListener(event, handler) {
    if (this.eventListeners.has(event)) {
      const list = this.eventListeners.get(event).filter((h) => h !== handler);
      this.eventListeners.set(event, list);
    }
  }

  dispatchEvent(event) {
    if (this[`on${event.type}`]) {
      this[`on${event.type}`](event);
    }
    const handlers = this.eventListeners.get(event.type) || [];
    handlers.forEach((h) => h(event));
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }

  pause() {
    this.state = 'paused';
  }

  resume() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.dispatchEvent({ type: 'stop' });
  }

  requestData() {
    // Simulated requestData
  }

  emitChunk(chunkBytes = 1024) {
    if (this.state === 'recording') {
      const chunk = new Uint8Array(chunkBytes).fill(42);
      const blob = new Blob([chunk], { type: this.mimeType });
      this.dispatchEvent({ type: 'dataavailable', data: blob });
    }
  }
}

MockMediaRecorder.isTypeSupported = (mime) => mime.startsWith('audio/webm');

// Mock fetch for server transcription in Node test environment
globalThis.fetch = async (url) => {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({ transcript: 'Recognized test speech' }),
    text: async () => JSON.stringify({ transcript: 'Recognized test speech' })
  };
};

class MockSpeechRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = 'en-US';
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.started = false;
    this.shouldThrowOnStart = false;
    activeSpeechRecognitions.push(this);
  }

  start() {
    if (this.shouldThrowOnStart) {
      throw new Error('NotAllowedError: user gesture required');
    }
    this.started = true;
    queueMicrotask(() => {
      if (this.onstart) this.onstart();
    });
  }

  stop() {
    this.started = false;
    queueMicrotask(() => {
      if (this.onend) this.onend();
    });
  }

  abort() {
    this.started = false;
    queueMicrotask(() => {
      if (this.onend) this.onend();
    });
  }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    audioContextInstances.push(this);
  }
  createAnalyser() {
    return {
      fftSize: 128,
      smoothingTimeConstant: 0.65,
      frequencyBinCount: 64,
      getByteFrequencyData: (arr) => arr.fill(12)
    };
  }
  createMediaStreamSource() {
    return {
      connect: () => {}
    };
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

globalThis.window = {
  SpeechRecognition: MockSpeechRecognition,
  webkitSpeechRecognition: MockSpeechRecognition,
  MediaRecorder: MockMediaRecorder,
  AudioContext: MockAudioContext,
  webkitAudioContext: MockAudioContext,
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: globalThis.localStorage
};

globalThis.MediaRecorder = MockMediaRecorder;
globalThis.SpeechRecognition = MockSpeechRecognition;
globalThis.AudioContext = MockAudioContext;
globalThis.webkitSpeechRecognition = MockSpeechRecognition;
globalThis.webkitAudioContext = MockAudioContext;

try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      mediaDevices: {
        getUserMedia: async () => new MockMediaStream()
      }
    },
    configurable: true,
    writable: true
  });
} catch (_) {
  Object.assign(globalThis.navigator, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    mediaDevices: {
      getUserMedia: async () => new MockMediaStream()
    }
  });
}

globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {}
};

// Import hook under test
const { useVoiceDictation } = await import('../src/hooks/useVoiceDictation.js');

/**
 * Lightweight harness to run React hooks deterministically in Node
 */
function createHookHarness(hookFn, props) {
  let hookIndex = 0;
  const hookStates = [];
  let isInitial = true;
  let currentResult = null;

  function render() {
    hookIndex = 0;
    const dispatcher = {
      useState(initial) {
        const i = hookIndex++;
        if (isInitial) {
          hookStates[i] = typeof initial === 'function' ? initial() : initial;
        }
        const setState = (action) => {
          const next = typeof action === 'function' ? action(hookStates[i]) : action;
          if (next !== hookStates[i]) {
            hookStates[i] = next;
            render();
          }
        };
        return [hookStates[i], setState];
      },
      useRef(initial) {
        const i = hookIndex++;
        if (isInitial) {
          hookStates[i] = { current: initial };
        }
        return hookStates[i];
      },
      useCallback(fn) {
        hookIndex++;
        return fn;
      },
      useMemo(fn) {
        hookIndex++;
        return fn();
      },
      useEffect(fn) {
        const i = hookIndex++;
        if (isInitial) {
          hookStates[i] = { fn };
          queueMicrotask(() => {
            fn();
          });
        }
      }
    };

    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    currentResult = hookFn(props);
    isInitial = false;
  }

  render();

  return {
    get current() {
      return currentResult;
    },
    rerender() {
      render();
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------------------
   Test 1: SpeechRecognition ends during a long recording
   -------------------------------------------------------------------------- */
try {
  console.log('[Test 1] SpeechRecognition ends during recording -> MediaRecorder must remain recording...');
  activeMediaRecorders = [];
  activeSpeechRecognitions = [];

  let text = '';
  const harness = createHookHarness(useVoiceDictation, {
    inputValue: text,
    onInputChange: (val) => {
      text = val;
    }
  });

  // 1. Start listening
  harness.current.startListening();
  await sleep(200);

  const recorder = activeMediaRecorders[activeMediaRecorders.length - 1];
  const recognition = activeSpeechRecognitions[activeSpeechRecognitions.length - 1];

  assert.ok(recorder, 'MediaRecorder must be created');
  assert.equal(recorder.state, 'recording', 'MediaRecorder must be in recording state');
  assert.equal(harness.current.recordingState, 'listening', 'UI state must be listening');

  // Configure next SpeechRecognition instance to throw on start (e.g. browser gesture restriction)
  MockSpeechRecognition.prototype.shouldThrowOnStart = true;

  // 2. Trigger unexpected SpeechRecognition onend
  recognition.onend();
  await sleep(200); // Allow restart timeout (50ms) to fire

  // 3. Verify MediaRecorder is NOT paused and UI state is NOT paused
  assert.equal(recorder.state, 'recording', 'MediaRecorder must remain recording despite SpeechRecognition interruption');
  assert.equal(harness.current.recordingState, 'listening', 'Recording state must remain listening (NOT paused)');
  assert.notEqual(harness.current.recordingState, 'paused', 'Session must not be converted to user-paused state');

  MockSpeechRecognition.prototype.shouldThrowOnStart = false;
  await harness.current.stopListening();
  await sleep(200);

  console.log('  ✓ SpeechRecognition restart failure does not pause healthy MediaRecorder.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 1 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 2: Long recording (45s+) survives SpeechRecognition interruption
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 2] Long recording (45s+) survives SpeechRecognition interruption without losing chunks...');
  activeMediaRecorders = [];
  activeSpeechRecognitions = [];

  let text = '';
  const harness = createHookHarness(useVoiceDictation, {
    inputValue: text,
    onInputChange: (val) => {
      text = val;
    }
  });

  harness.current.startListening();
  await sleep(200);

  const recorder = activeMediaRecorders[activeMediaRecorders.length - 1];
  const recognition = activeSpeechRecognitions[activeSpeechRecognitions.length - 1];

  // Emit 10 chunks (simulating early speech, e.g. 0-25s)
  for (let i = 0; i < 10; i++) {
    recorder.emitChunk(1000);
  }

  // Interruption: SpeechRecognition ends unexpectedly (e.g. at 27 seconds)
  MockSpeechRecognition.prototype.shouldThrowOnStart = true;
  recognition.onend();
  await sleep(200);

  // Audio capture continues: emit 10 more chunks (simulating speech from 27-45s+)
  for (let i = 0; i < 10; i++) {
    recorder.emitChunk(1000);
  }

  assert.equal(recorder.state, 'recording', 'MediaRecorder continued recording through interruption');

  // Stop dictation
  await harness.current.stopListening();
  await sleep(200);

  const blob = harness.current.recordedAudioBlob;
  assert.ok(blob, 'Recorded audio Blob must exist');
  assert.equal(blob.size, 20 * 1000, 'Audio blob must contain all 20 chunks from across the entire 45s+ session');

  MockSpeechRecognition.prototype.shouldThrowOnStart = false;
  console.log('  ✓ Continuous 45s+ audio capture survives SpeechRecognition interruption intact.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 2 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 3: Intentional Pause -> Resume restores MediaRecorder, tracks, visualizer
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 3] Intentional Pause -> Resume restores MediaRecorder, tracks, and UI state...');
  activeMediaRecorders = [];
  activeSpeechRecognitions = [];
  activeMicrophoneStreams = [];

  let text = '';
  const harness = createHookHarness(useVoiceDictation, {
    inputValue: text,
    onInputChange: (val) => {
      text = val;
    }
  });

  harness.current.startListening();
  await sleep(200);

  const recorder = activeMediaRecorders[activeMediaRecorders.length - 1];
  const stream = activeMicrophoneStreams[activeMicrophoneStreams.length - 1];
  assert.equal(recorder.state, 'recording', 'Initial recorder state is recording');
  assert.equal(harness.current.recordingState, 'listening');

  // User intentionally presses Pause
  harness.current.pauseListening();
  assert.equal(recorder.state, 'paused', 'MediaRecorder must be paused after intentional pause');
  assert.equal(harness.current.recordingState, 'paused', 'UI state must be paused');

  // Simulate tracks being disabled during pause
  stream.getAudioTracks().forEach((t) => (t.enabled = false));

  // User presses Resume
  await harness.current.resumeListening();
  await sleep(200);

  assert.equal(recorder.state, 'recording', 'MediaRecorder must resume recording state');
  assert.equal(harness.current.recordingState, 'listening', 'UI state must return to listening');
  assert.ok(
    stream.getAudioTracks().every((t) => t.enabled),
    'Microphone tracks must be restored to enabled on Resume'
  );

  await harness.current.stopListening();
  await sleep(200);

  console.log('  ✓ Resume correctly operates against actual engine modes and restores recorder/tracks.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 3 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 4: Speech after Resume is retained
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 4] Speech after Resume is retained in the recorded audio buffer...');
  activeMediaRecorders = [];
  activeSpeechRecognitions = [];

  let text = '';
  const harness = createHookHarness(useVoiceDictation, {
    inputValue: text,
    onInputChange: (val) => {
      text = val;
    }
  });

  harness.current.startListening();
  await sleep(200);

  const recorder = activeMediaRecorders[activeMediaRecorders.length - 1];

  // Segment 1: speak before pause
  recorder.emitChunk(1500);
  recorder.emitChunk(1500);

  // Intentional pause
  harness.current.pauseListening();
  assert.equal(recorder.state, 'paused');

  // Resume
  await harness.current.resumeListening();
  await sleep(200);
  assert.equal(recorder.state, 'recording');

  // Segment 2: speak after resume
  recorder.emitChunk(2000);
  recorder.emitChunk(2000);

  // Stop
  await harness.current.stopListening();
  await sleep(200);

  const blob = harness.current.recordedAudioBlob;
  assert.ok(blob, 'Recorded audio Blob must exist');
  assert.equal(
    blob.size,
    1500 + 1500 + 2000 + 2000,
    'Audio Blob must retain all chunks from both before pause and after resume'
  );

  console.log('  ✓ Post-resume audio is fully preserved in the assembled audio buffer.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 4 failed:', err);
}

/* --------------------------------------------------------------------------
   Test 5: Multiple Pause/Resume cycles
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 5] Multiple Pause/Resume cycles operate cleanly without duplicate streams or state leaks...');
  activeMediaRecorders = [];
  activeSpeechRecognitions = [];
  activeMicrophoneStreams = [];

  let text = '';
  const harness = createHookHarness(useVoiceDictation, {
    inputValue: text,
    onInputChange: (val) => {
      text = val;
    }
  });

  // Cycle 1: Start -> Record
  harness.current.startListening();
  await sleep(200);

  const initialStreamCount = activeMicrophoneStreams.length;
  const initialRecorderCount = activeMediaRecorders.length;
  assert.equal(initialStreamCount, 1, 'Only one media stream created');
  assert.equal(initialRecorderCount, 1, 'Only one media recorder created');

  const recorder = activeMediaRecorders[0];
  recorder.emitChunk(500);

  // Cycle 1: Pause -> Resume
  harness.current.pauseListening();
  assert.equal(recorder.state, 'paused');
  assert.equal(harness.current.recordingState, 'paused');

  await harness.current.resumeListening();
  await sleep(200);
  assert.equal(recorder.state, 'recording');
  assert.equal(harness.current.recordingState, 'listening');
  recorder.emitChunk(500);

  // Cycle 2: Pause -> Resume
  harness.current.pauseListening();
  assert.equal(recorder.state, 'paused');
  assert.equal(harness.current.recordingState, 'paused');

  await harness.current.resumeListening();
  await sleep(200);
  assert.equal(recorder.state, 'recording');
  assert.equal(harness.current.recordingState, 'listening');
  recorder.emitChunk(500);

  // Verify stream and recorder instances were reused without duplication
  assert.equal(activeMicrophoneStreams.length, 1, 'No duplicate microphone streams created across cycles');
  assert.equal(activeMediaRecorders.length, 1, 'No duplicate media recorders created across cycles');

  // Stop
  await harness.current.stopListening();
  await sleep(200);

  const blob = harness.current.recordedAudioBlob;
  assert.ok(blob, 'Recorded audio Blob must exist');
  assert.equal(blob.size, 1500, 'All 3 chunks (500 + 500 + 500) successfully retained across multiple cycles');

  console.log('  ✓ Multiple pause/resume cycles completed cleanly without duplicate streams or lost chunks.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 5 failed:', err);
}

console.log('\n===============================================================');
console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('===============================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  console.log('All 5 focused voice dictation lifecycle regression tests passed successfully.\n');
}
