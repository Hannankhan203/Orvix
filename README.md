# Orvix

**Current Version: Orvix v0.9.3** *(Application Package: v0.9.0)*

<p align="center">
  <strong>An Intelligent, Multi-Model Conversational AI Workspace featuring Dual-Format Table & Clipboard Formatting, Expanded Mobile Swipe Navigation, Mobile PWA Live Dictation with Whisper Refinement, Specialized Chat Modes, Multi-Model Response Alternatives, Global Chat-Input Focus, Pixel-Perfect Code Blocks, Live Latency Tracking, Controlled Continuation, and Deep Document Understanding</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Message Copying, Markdown Rendering & Table Formatting](#message-copying-markdown-rendering--table-formatting)
   - [Dual-Format Clipboard Generation (`text/html` and `text/plain`)](#dual-format-clipboard-generation-texthtml-and-textplain)
   - [Plain-Text Record Layout for Messaging Applications (WhatsApp, Telegram)](#plain-text-record-layout-for-messaging-applications-whatsapp-telegram)
   - [Rich HTML Table Styling for Documents & Workspaces](#rich-html-table-styling-for-documents--workspaces)
   - [Mixed-Content Parsing & Code Block Protection](#mixed-content-parsing--code-block-protection)
   - [Three-Tier Clipboard Writing Strategy & Fallbacks](#three-tier-clipboard-writing-strategy--fallbacks)
4. [Mobile Responsiveness & Swipe Navigation](#mobile-responsiveness--swipe-navigation)
   - [Main Conversation Area Swipe-Right Activation](#main-conversation-area-swipe-right-activation)
   - [Excluded Zones & Interaction Safeguards](#excluded-zones--interaction-safeguards)
   - [Horizontal Intent Disambiguation vs. Vertical Scroll](#horizontal-intent-disambiguation-vs-vertical-scroll)
   - [Activation Thresholds & Quick Flick Detection](#activation-thresholds--quick-flick-detection)
   - [Dual Touch and Pointer Event Architecture](#dual-touch-and-pointer-event-architecture)
5. [Voice Dictation & Speech Architecture](#voice-dictation--speech-architecture)
   - [Cross-Platform Hybrid & Direct-Audio Engine Support](#cross-platform-hybrid--direct-audio-engine-support)
   - [Mobile & PWA Live Speech Recognition](#mobile--pwa-live-speech-recognition)
   - [Correct Interim Transcript Handling & Snapshot Replacement](#correct-interim-transcript-handling--snapshot-replacement)
   - [Concurrent Live Recognition & Server Whisper Refinement](#concurrent-live-recognition--server-whisper-refinement)
   - [Desktop Dictation Regression Protection](#desktop-dictation-regression-protection)
   - [Real-Time Audio Capture & Visualizer](#real-time-audio-capture--visualizer)
   - [Smart Punctuation & Typography Formatting](#smart-punctuation--typography-formatting)
   - [High-Accuracy Whisper Transcription Pipeline](#high-accuracy-whisper-transcription-pipeline)
   - [Context-Aware Technical Polishing](#context-aware-technical-polishing)
   - [Session Isolation & Stale Result Protection](#session-isolation--stale-result-protection)
   - [Text-to-Speech (Read Aloud)](#text-to-speech-read-aloud)
6. [Chatbot Modes](#chatbot-modes)
   - [1. General Assistant Mode](#1-general-assistant-mode)
   - [2. Learning Mode](#2-learning-mode)
   - [3. Writing Mode](#3-writing-mode)
   - [4. Coding Mode](#4-coding-mode)
7. [AI Providers & Supported Models](#ai-providers--supported-models)
   - [Supported Providers & Models](#supported-providers--models)
   - [Provider Context Budgets](#provider-context-budgets)
   - [Streaming & Fallback System](#streaming--fallback-system)
   - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
8. [Attachments & Deep Document Understanding](#attachments--deep-document-understanding)
   - [Three Multimodal Attachment Methods](#three-multimodal-attachment-methods)
   - [Attachment Constraints & Rules](#attachment-constraints--rules)
   - [Supported Document Formats](#supported-document-formats)
   - [Targeted Questioning & Presenter Notes](#targeted-questioning--presenter-notes)
9. [Image Attachments & Optical Character Recognition (OCR)](#image-attachments--optical-character-recognition-ocr)
   - [Supported Image Formats & Binary Verification](#supported-image-formats--binary-verification)
   - [Server-Side OCR Engine](#server-side-ocr-engine)
   - [Honest No-Readable-Text Handling](#honest-no-readable-text-handling)
   - [Dual-Tab Preview Modal](#dual-tab-preview-modal)
10. [Chat Management & Usability Enhancements](#chat-management--usability-enhancements)
    - [Multi-Model Alternative Response Regeneration](#multi-model-alternative-response-regeneration)
    - [Automatic Chat-Input Focus](#automatic-chat-input-focus)
    - [Live Response-Time Measurement](#live-response-time-measurement)
    - [Controlled Large-Response Continuation](#controlled-large-response-continuation)
    - [Conversation Pinning & Client-Side Export](#conversation-pinning--client-side-export)
11. [Architecture & Technology Stack](#architecture--technology-stack)
12. [Authentication & Persistence Architecture](#authentication--persistence-architecture)
13. [Project Structure](#project-structure)
14. [Environment Variables & Configuration](#environment-variables--configuration)
15. [Installation & Running Locally](#installation--running-locally)
16. [Build & Deployment Instructions](#build--deployment-instructions)
17. [Troubleshooting & Common Issues](#troubleshooting--common-issues)
18. [Security Architecture](#security-architecture)
19. [Current Limitations](#current-limitations)
20. [Version History & Detailed Changelog](#version-history--detailed-changelog)
21. [Future Roadmap](#future-roadmap)

---

## Project Overview

**Orvix** is an intelligent, multi-model AI conversational workspace built to deliver production-grade text generation, specialized conversational modes, multi-provider model comparisons, keyboard-first interaction, precision code rendering, transparent latency tracking, fluid mobile touch gestures, voice dictation, dual-format table copying, and multi-format document analysis.

Engineered as a full-stack Node.js application, Orvix pairs a responsive React 19 single-page application with an Express proxy backend running Vite in middleware mode. All AI completions, speech transcriptions, file uploads, and OCR operations are executed server-side to guarantee that API credentials, tokens, and storage paths remain strictly private.

---

## Key Features

- **Dual-Format Table & Message Copying**: Copies assistant responses as both rich `text/html` and optimized `text/plain`. Tables pasted into messaging apps (such as WhatsApp) render as clear, structured field-value records so values never lose their column associations, while rich destinations (Google Docs, Word, Slack) receive formatted HTML tables with borders and backgrounds.
- **Main Conversation Mobile Swipe Navigation**: Fluid swipe-right gesture active across the main conversation area on mobile and tablet screens to open chat history, with exclusions for the top header, bottom composer, interactive buttons, code blocks, and an iOS-safe margin (>16px) to avoid native edge navigation conflicts.
- **High-Accuracy Voice Dictation**: Cross-platform dual-engine dictation combining mobile/PWA and desktop live browser speech recognition with server-side Whisper Large v3 Turbo audio refinement. Features real-time interim transcript rendering with deduplication, continuous audio buffering, 9 supported locales, silence restart recovery, and context-aware technical polishing.
- **Four Specialized Chatbot Modes**: Purpose-built modes for **General Assistant**, **Learning**, **Writing**, and **Coding** with custom system prompts, specialized typography, educational callouts, editorial layouts, and VS Code-style code blocks.
- **Multi-Model Response Alternatives**: Compare outputs across different AI providers (Gemini, Groq, OpenRouter, Cloudflare Workers AI) without overwriting existing messages, navigable via an interactive `< X of Y >` pager.
- **Automatic Chat-Input Focus**: Type naturally from anywhere on the page to immediately activate the message composer without losing the first keystroke, with complete protection for text selection, keyboard shortcuts, and modal dialogs.
- **Pixel-Perfect Code Blocks**: Mathematically locked 22px line height with zero vertical line-number drift over 500+ lines, syntax highlighting for 20+ languages, sticky line number gutter, and clean source code clipboard copying.
- **Live Response-Time Tracking**: Real-time elapsed duration timer (`Thinking... X.Xs`) updating every 100ms during streaming, transitioning to an immutable duration badge (`Response time: X.Xs`) saved across sessions and exports.
- **Controlled Large-Response Continuation**: Intelligent multi-part output splitting for extensive queries with continuation notices and an interactive composer continuation chip (`[ → Continue response ]`).
- **Three Multimodal Attachment Methods**: File picker dialog, direct clipboard paste (`Ctrl + V`), and drag-and-drop staging with a 25MB limit and a strict 1-attachment-per-message policy.
- **Deep Document Understanding**: Text extraction from PDFs (`unpdf`), Word documents (`mammoth`), PowerPoint presentations with speaker notes (`jszip`), spreadsheets (CSV/TSV), JSON, XML, and Markdown.
- **Server-Side OCR Engine**: Powered by `tesseract.js` with binary magic number verification, image metadata inspection, and honest "No readable text detected" handling.
- **Flexible Data Persistence**: Browser IndexedDB for raw binary attachment caching, Cloud Firestore for authenticated cross-device sync, and `localStorage` for complete Guest Mode usage.
- **Zero-Key Simulation Mode**: Runs immediately out-of-the-box without requiring API keys, providing realistic local responses for testing all UI workflows, attachments, and exports.

---

## Message Copying, Markdown Rendering & Table Formatting

Orvix features an advanced clipboard formatting pipeline implemented in `src/utils/clipboardFormatter.js` and wired into message action buttons in `src/components/chat/ChatMessage.jsx`. When users click **Copy** on any message, Orvix formats the content to maintain structural fidelity across diverse paste destinations.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX CLIPBOARD FORMATTING PIPELINE                  │
├───────────────────────────────────┬────────────────────────────────────┤
│ 1. RICH-TEXT DESTINATIONS         │ 2. MESSAGING APPS (WHATSAPP, ETC.) │
│ - Target: Word, Docs, Slack, Mail │ - Target: WhatsApp, Telegram, SMS  │
│ - Mime-type: text/html            │ - Mime-type: text/plain            │
│ - HTML <table> with borders       │ - Structured record layout         │
│ - Alternating row zebra fills     │ - Bold "• Header: Value" pairs    │
│ - Text alignment (left/center/rt) │ - No pipe distortion in variable   │
│ - Inline bold, italic, code styling│   width proportional fonts         │
└───────────────────────────────────┴────────────────────────────────────┘
```

### Dual-Format Clipboard Generation (`text/html` and `text/plain`)

Modern operating systems and browsers support writing multiple representations of content simultaneously via `ClipboardItem`. When copying a message:
1. Orvix normalizes line breaks and parses Markdown tables, code blocks, lists, blockquotes, and paragraphs.
2. It generates two distinct payloads:
   - A fully styled **`text/html`** fragment for rich-text software.
   - An optimized **`text/plain`** string designed specifically for plain-text messaging platforms.
3. Both payloads are bound to the clipboard in a single atomic transaction.

### Plain-Text Record Layout for Messaging Applications (WhatsApp, Telegram)

**The Problem with Raw ASCII Markdown Tables:**  
Messaging applications like WhatsApp and Telegram render plain text using proportional fonts and collapse multiple spaces. When traditional Markdown tables (`| Column 1 | Column 2 |`) are pasted, columns misalign, borders break, and cell contents become detached from their headers.

**The Orvix Solution (`formatTableAsPlainText`):**  
Orvix transforms Markdown tables into an unambiguous, structured record layout:

```text
• Feature / Dimension: Operational Logic
  Traditional Software: Predefined, deterministic IF/THEN rules
  Artificial Intelligence: Probabilistic patterns inferred from training

• Feature / Dimension: Adaptability
  Traditional Software: Static; requires manual code updates
  Artificial Intelligence: Dynamic; continuously learns and refines
```

- **Header-Value Association**: Each data row is rendered as an indented block where every value is explicitly labeled with its corresponding column header.
- **Internal Break Handling**: Newlines and `<br>` tags within table cells are converted into indented sublines (`\n    `).
- **Single-Column Grace**: Single-column tables simplify automatically to clean bullet points (`• Value`).
- **Header Sanitization**: Header markers like `*`, `_`, and `` ` `` are cleaned so labels remain crisp.
- **Accurate Expectation**: This does *not* claim that WhatsApp renders an invisible spreadsheet or enforces grid column widths in plain text; rather, it structures the plain-text output so that data remains clear, readable, and associated with its correct heading on any device or font.

### Rich HTML Table Styling for Documents & Workspaces

For rich destinations (Google Docs, Microsoft Word, Apple Pages, Microsoft Outlook, and Slack), Orvix writes an HTML `<table>` element with inline CSS styles:
- **Table Container**: `border-collapse: collapse; width: 100%; font-family: sans-serif; font-size: 14px;`
- **Headers (`<thead>`)**: Background fill `#f1f5f9`, dark typography `#0f172a`, semi-bold weight `600`, and border `#cbd5e1`.
- **Data Rows (`<tbody>`)**: Subtle alternating zebra striping (`#ffffff` and `#f8fafc`) with border dividers `#e2e8f0`.
- **Column Alignments**: Respects GFM column delimiter alignments (`left`, `center`, `right`) based on colon placement (`:---`, `:---:`, `---:`).
- **Inline Formatting**: Preserves bold (`<strong>`), italic (`<em>`), code tags with background pills (`<code>`), and hyperlinks (`<a>`).

### Mixed-Content Parsing & Code Block Protection

Responses frequently combine introductory text, bullet points, data tables, and programming code blocks.
- **Code Block Tokenization**: Before table detection runs, all fenced code blocks (```` ```lang ... ``` ````) are tokenized and protected with zero-byte boundary placeholders (`\u0000FENCED_CODE_N\u0000`). This ensures that pipe characters (`|`) or dashes (`---`) inside code are never misinterpreted as table syntax.
- **Markdown Preservation**: Text outside tables retains its standard formatting in plain text, while being transformed into semantic `<p>`, `<h1>`–`<h6>`, `<ul>`, `<ol>`, and `<blockquote>` elements in the HTML payload.

### Three-Tier Clipboard Writing Strategy & Fallbacks

Orvix implements a resilient three-tier execution hierarchy in `copyFormattedMessage`:
1. **Tier 1 — Asynchronous Clipboard API (`ClipboardItem`)**: Constructs binary `Blob` objects for both `text/html` and `text/plain` and calls `navigator.clipboard.write([item])`.
2. **Tier 2 — Clipboard Text API (`writeText`)**: If `ClipboardItem` or HTML MIME-type writing is blocked by browser security policies, falls back to `navigator.clipboard.writeText(plainText)`.
3. **Tier 3 — Off-Screen Textarea Fallback (`document.execCommand`)**: If modern asynchronous clipboard APIs are unavailable or permission is denied, appends an off-screen `<textarea>`, selects the plain text, executes `document.execCommand('copy')`, and immediately removes the element.
4. **User Feedback**: The copy button provides visual feedback (`"Copied"` with check icon for 2 seconds, or `"Failed to copy"` on error).

---

## Mobile Responsiveness & Swipe Navigation

Orvix includes a responsive touch gesture navigation system implemented in `src/components/layout/Layout.jsx`. Mobile and tablet users can access their previous conversation history without reaching for the top hamburger button.

```text
┌────────────────────────────────────────────────────────────────────────┐
│               MOBILE SWIPE-TO-OPEN CHAT HISTORY REGION                 │
├────────────────────────────────────────────────────────────────────────┤
│ [Header / Action Bar]  ⛔ EXCLUDED from gesture activation             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  < 16px  │                  MAIN CONVERSATION AREA                     │
│ ┌──────┐ │                                                             │
│ │  ⛔  │ │  ✅ SWIPE-RIGHT ZONE (Across center, upper, lower chat)     │
│ │ iOS  │ │                                                             │
│ │ Back │ │  • Swiping right slides open the Chat History sidebar       │
│ │ Margin│ │  • Vertical scrolling continues completely uninterrupted   │
│ └──────┘ │  • Interactive buttons & code blocks are strictly excluded │
│          │                                                             │
├────────────────────────────────────────────────────────────────────────┤
│ [Composer / Dictation Dock]  ⛔ EXCLUDED from gesture activation       │
└────────────────────────────────────────────────────────────────────────┘
```

### Main Conversation Area Swipe-Right Activation

- **Broad Interaction Area**: Unlike restrictive edge-only gestures that require touching within 0–40px of the screen bezel, Orvix allows initiating the swipe from across the main conversation viewport (`.chat-scroll-viewport, .chat-area-container, .chatora-main`).
- **Responsive Viewports**: Operates on viewports with screen widths `<= 1024px` (smartphones and tablets in portrait/landscape) when the sidebar drawer is closed.

### Excluded Zones & Interaction Safeguards

To prevent accidental drawer activations and gesture conflicts, `isExcludedSwipeTarget()` rigorously excludes non-neutral surfaces:
1. **iOS Native Back Margin (`< 16px`)**: Touches starting within 16px of the extreme left edge are ignored. This preserves the native iOS Safari swipe-to-go-back gesture without triggering the sidebar.
2. **Top Navigation Bar (`header`)**: Touches on the title bar, model selector, export menu, and new chat buttons are excluded.
3. **Bottom Message Composer**: Touches inside the message textarea, action buttons, voice dictation strip, and attachment staging tray are excluded.
4. **Interactive Controls**: Touches on buttons, links, form inputs, dialogs, dropdowns, and popup menus are excluded.
5. **Horizontally Scrollable Elements**: Touches inside code blocks (`pre`, `code`), Markdown data tables, and suggestion chip lists are excluded so users can scroll wide content horizontally without opening the drawer.
6. **Active Text Selection**: Gestures are suspended if the user has highlighted text on the screen.

### Horizontal Intent Disambiguation vs. Vertical Scroll

To guarantee that normal reading and vertical message scrolling remain smooth:
- **Intent Evaluation Threshold**: The gesture tracks initial touch coordinates until movement exceeds `INTENT_THRESHOLD_PX = 10px`.
- **Dominance Calculation**: The gesture only locks into a horizontal swipe if the rightward horizontal movement clearly dominates vertical movement:
  $$\Delta X > 0 \quad \text{and} \quad |\Delta X| > |\Delta Y| \times 1.25$$
- **Immediate Scroll Release**: If vertical scrolling or a leftward swipe is detected, the gesture handler calls `resetTouchGesture()` immediately and stops tracking. The browser's native vertical scrolling continues without stutter or cancellation.
- **Scroll Lock on Confirmation**: Once confirmed as an intentional rightward swipe, `e.preventDefault()` prevents the underlying chat list from scrolling vertically during the gesture.

### Activation Thresholds & Quick Flick Detection

The sidebar opens upon touch completion if either condition is met:
1. **Distance Threshold**: Total rightward displacement $\Delta X \ge 50\text{px}$ (`MIN_SWIPE_PX`) with $|\Delta X| > |\Delta Y|$.
2. **Velocity Flick**: Total rightward displacement $\Delta X \ge 30\text{px}$ (`FLICK_DISTANCE_PX`) with a flick velocity exceeding $0.35\text{px/ms}$ (`FLICK_VELOCITY`).

### Dual Touch and Pointer Event Architecture

- **Primary**: Listens to native `touchstart`, `touchmove`, `touchend`, and `touchcancel` events.
- **Synthetic/Pointer Fallback**: Includes matching `pointerdown`, `pointermove`, and `pointerup` handlers for pointer devices and synthetic testing environments.
- **Collision Avoidance**: If native touch tracking begins, pointer tracking is immediately reset to prevent double-firing.
- **Device Support Note**: While engineered according to standard touch events and responsive web standards, gesture behavior may vary across specific mobile browsers, web views, or custom Android gesture navigation settings.

---

## Voice Dictation & Speech Architecture

Orvix features a robust voice dictation engine implemented in `src/hooks/useVoiceDictation.js`, coordinated through `src/components/chat/ChatArea.jsx`, `src/utils/speechTextCleaner.js`, and the `/api/transcribe` backend endpoint.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX UNIFIED DICTATION ARCHITECTURE                 │
├────────────────────────────────────────────────────────────────────────┤
│                       Mobile / Desktop Microphone                      │
│                                    ↓                                   │
│                     Live Browser Speech Recognition                    │
│                                    ↓                                   │
│        Live Words Appear in Composer (Interim Snapshot Replacement)    │
│                                    ↓                                   │
│                           User Presses Stop / Done                     │
│                                    ↓                                   │
│                   Recorded MediaStream Audio Finalized                 │
│                                    ↓                                   │
│             Server-Side Whisper Large v3 Turbo Refinement              │
│                                    ↓                                   │
│               Reconciled High-Accuracy Final Transcription             │
└────────────────────────────────────────────────────────────────────────┘
```

### Cross-Platform Hybrid & Direct-Audio Engine Support

Orvix dynamically evaluates browser and platform capabilities via `detectDictationCapabilities()` to route each client to its optimal dictation engine:
- **Hybrid Desktop Mode (Chrome, Edge, Safari macOS)**: Runs native `SpeechRecognition` in parallel with `MediaRecorder` audio buffering on a single shared `MediaStream`. Spoken words render progressively into the composer in real time. Upon tapping **Done**, the captured audio is refined on the server by Whisper Large v3 Turbo.
- **Mobile & PWA Live Mode (Android Chrome, iOS Safari, PWA)**: Runs live browser speech recognition with immediate interim composer rendering while concurrently recording audio. Continuous recognition parameters are tuned for mobile devices (`continuous = false` with silence restart auto-recovery) to ensure rapid interim frame dispatch without speech cutoffs. Upon tapping **Done**, recorded audio is finalized and submitted for server Whisper refinement.
- **Direct-Audio Mode (Mozilla Firefox & Standalone iOS PWA)**: Mozilla Firefox disables the Web Speech API by default, and standalone iOS home-screen PWAs restrict WebKit SpeechRecognition. In these environments, Orvix captures audio directly via `MediaRecorder` and `getUserMedia`, providing real-time audio visualizer feedback and delivering complete, high-accuracy Whisper transcription upon tapping **Done**.
- **Native-Only Fallback**: Graceful operating mode for restricted environments where speech recognition is available but `MediaRecorder` hardware access is constrained.
- **iOS Safari Lifecycle Management**: Automatically detects audio session pauses following silence timeouts, transitioning gracefully to a paused state so users can tap **Resume** without permission errors.

### Mobile & PWA Live Speech Recognition

On mobile devices and installed Progressive Web Apps (PWAs), Orvix provides immediate, responsive visual feedback:
- **Live Recognition While Speaking**: When the user taps the microphone and speaks, speech recognition activates instantly. Words stream directly into the composer textarea while speech is occurring.
- **No Waiting for Stop**: Users do not have to wait until tapping **Stop** or **Done** to see what has been recognized; the text appears fluidly in real time.
- **Visual Confidence**: Immediate word rendering gives mobile users instant confirmation that their microphone is active, properly authorized, and picking up clear audio.

### Correct Interim Transcript Handling & Snapshot Replacement

A major architectural challenge in browser speech recognition is handling interim (unfinalized) recognition results without duplicating words.

**The Interim Duplication Problem:**  
When speaking continuously, the browser's speech recognition engine emits successive interim snapshots representing its evolving hypothesis of the current phrase. Previously, naive listeners would append each interim emission sequentially:

```text
I
I want
I want you
I want you to
```

If appended rather than replaced, this produced repetitive accumulation: `I I want I want you I want you to`.

**The Orvix Architectural Solution:**  
Orvix strictly separates finalized text from interim hypotheses:
1. **Finalized Speech (`event.results[i].isFinal`)**: When the speech engine confirms an utterance boundary, the segment is formatted and committed to `committedSegmentsRef` as permanent, immutable text.
2. **Interim Speech (`!event.results[i].isFinal`)**: Unfinalized results are treated strictly as an ephemeral, temporary snapshot of the current unfinished phrase.
3. **Snapshot Replacement**: The latest interim hypothesis unconditionally replaces the previous interim candidate buffer (`interimTranscriptRef`), never appending to it.
4. **Deterministic Merging**: At any moment, the composer displays:
   $$\text{Composer Text} = \text{Base Text} + \sum \text{Committed Final Segments} + \text{Active Interim Snapshot}$$
5. When the user finishes speaking or pauses, the interim snapshot either finalizes into a permanent segment or is replaced by the refined server transcript upon session completion.

### Concurrent Live Recognition & Server Whisper Refinement

Live browser speech recognition and high-accuracy server-side Whisper refinement are no longer mutually exclusive. Orvix unifies both into a single seamless workflow:

```text
Mobile microphone
      ↓
Live browser speech recognition
      ↓
Live words appear in composer
      ↓
User presses Stop
      ↓
Recorded audio finalized
      ↓
Whisper refinement
      ↓
Final transcription
```

1. **During Speech**: The user benefits from zero-latency live browser speech recognition, viewing their spoken words in real time with correct interim snapshot replacement.
2. **On Stop**: Tapping **Done** cleanly disconnects the live recognition engine to prevent trailing duplicate events, finalizes the recorded audio chunks into an audio `Blob`, and submits the recording to `/api/transcribe`.
3. **Whisper Refinement**: The server processes the audio using Groq Whisper Large v3 Turbo (or fallback Gemini audio recognition) with domain-specific technical vocabulary conditioning.
4. **Non-Destructive Reconciliation**: The server transcript replaces the rough live preview, correcting phonetic slips, technical abbreviations, and punctuation. If the user made manual edits or cleared the composer during the session, their manual input is strictly preserved.

### Desktop Dictation Regression Protection

All existing desktop dictation capabilities remain fully preserved and protected against regressions:
- Desktop Chrome, Edge, and Safari continue to use the concurrent hybrid pipeline with synchronized `SpeechRecognition` and `MediaRecorder` audio buffering.
- The 5-bar Web Audio API visualizer (`AnalyserNode`) operates seamlessly across all platforms without audio pipeline contention.
- Desktop users continue to enjoy real-time word streaming, smart punctuation commands, and Whisper refinement.

### Real-Time Audio Capture & Visualizer

- **Single Shared Stream**: Acquires a single microphone `MediaStream` coordinating both the visualizer `AnalyserNode` and `MediaRecorder` without hardware renegotiation.
- **Audio Buffering Safeguards**:
  - Memory ceiling: 25 MB (`MAX_RECORDED_BYTES`).
  - Max recording duration: 15 minutes (`MAX_RECORDING_DURATION_MS`).
  - Real-time time-slicing: 250ms chunks (`CHUNK_TIMESLICE_MS`).
  - Dynamic codec negotiation: Automatically selects `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg`, or `audio/mp4`.
- **Hardware Lifecycle**: Listens to `visibilitychange` and `pagehide` events to pause recording and stop hardware tracks when the browser tab is backgrounded, immediately turning off the OS microphone indicator.
- **Track Interruption Recovery**: Handles mobile OS interruptions (incoming phone calls, headset disconnects) with clean pause states and reconnection recovery.

### Smart Punctuation & Typography Formatting

The formatting engine converts spoken punctuation commands into clean typography across 9 supported languages:
- **English Verbal Commands**:
  - *"comma"* → `,`
  - *"period"* / *"full stop"* → `.`
  - *"question mark"* → `?`
  - *"exclamation mark"* / *"exclamation point"* → `!`
  - *"colon"* → `:` | *"semicolon"* → `;`
  - *"new line"* → `\n` | *"new paragraph"* → `\n\n`
  - *"dash"* / *"hyphen"* → ` - `
- **Urdu Verbal Commands (`ur-PK`)**:
  - *"ختمہ"* / *"فل اسٹاپ"* → `۔ `
  - *"وقفہ"* / *"کوما"* → `، `
  - *"سوالیہ نشان"* → `؟ `
  - *"ندائیہ"* → `! `
  - *"نئی لائن"* → `\n`
- **Technical Acronym Formatting**: Automatically formats spoken names and acronyms: `JavaScript`, `ECMAScript`, `TypeScript`, `Python`, `React`, `Angular`, `ChatGPT`, `OpenAI`, `Orvix`, `JSON`, `HTML`, `CSS`, `URLs`, and `APIs`.
- **Dot-Notation Preservation**: Protects code identifiers and decimal numbers (such as `Math.random` and `3.14`) from having spaces inserted after periods.
- **Sentence Capitalization**: Capitalizes sentence beginnings for Latin scripts and capitalizes the English pronoun `"I"` and contractions (`"I'm"`, `"I'll"`, `"I've"`).

### High-Accuracy Whisper Transcription Pipeline

Upon stopping dictation, the audio recording is submitted to `/api/transcribe`:
- **Primary Engine**: **Groq Whisper Large v3 Turbo** (`whisper-large-v3-turbo`) with zero-temperature inference.
- **Vocabulary Conditioning**: Injected prompt context conditioning technical terms: `JavaScript`, `TypeScript`, `React`, `palindrome`, `algorithms`, `async await`, `promises`, `functions`, `objects`, `arrays`, `code`.
- **Secondary Backup**: Automatic failover to **Gemini Audio Recognition** (`gemini-3.8-flash`) if Groq encounters rate limits or connection errors.
- **Truncation Protection**: If Whisper returns an incomplete or truncated fragment (<40% the length of a long native transcript with $\ge 50$ characters), Orvix retains the complete native speech transcript and presents an informational notice.

### Context-Aware Technical Polishing

Orvix includes an optional AI-assisted transcript polishing feature (`"Improve transcript"` in `ChatArea.jsx` and `polishSpokenTranscript` in `src/utils/speechTextCleaner.js`) governed by strict disambiguation rules:
- **Algorithmic Context Disambiguation**: In JavaScript/coding contexts, phonetic recognition slips like *"pedrandom"*, *"ped random"*, or *"pelindrome"* are contextually corrected to `palindrome`.
- **API Preservation**: Valid programming APIs like `Math.random` are strictly preserved as `Math.random` and never changed to `palindrome`.
- **Asynchronous Context Disambiguation**: In programming contexts alongside terms like *"callbacks"* or *"promises"*, phonetic slips like *"sync await"* or *"sink await"* are corrected to `async/await`.
- **Keyword List Disambiguation**: Lists of declaration keywords (e.g., *"var, constant, let"*) contextually format to `const`.
- **Zero Hallucination / Omission**: Punctuation and capitalization are cleaned without deleting requested topics, summarizing, or changing the speaker's language.
- **Deterministic Offline Fallback**: If network requests to the AI provider fail or if running without API keys, `polishSpokenTranscript` executes the exact disambiguation rules locally.

### Session Isolation & Stale Result Protection

1. **Delete and Dictate Again**: Clearing the composer (`Ctrl + A` and `Backspace`) unconditionally clears all base references and in-flight transcription promises. Previously deleted text cannot reappear in subsequent dictation sessions.
2. **Asynchronous Result Safety**: If a delayed transcription completes after a session is cancelled, superseded, or cleared, it is discarded immediately via session counters (`transcriptionSessionCounterRef`) and cannot overwrite the composer.
3. **Manual Editing Protection**: If a user manually types or edits text in the composer while Whisper is transcribing in the background, their manual modifications are preserved and not overwritten.
4. **Natural Pause & Silence Restart Continuity**: Calculates `totalSessionSpeech` across all silence restarts and pauses, ensuring the entire dictated sentence is preserved without duplicating earlier portions.
5. **Stop vs. Cancel Isolation**: Tapping **Done** finalizes the session normally; tapping **Cancel** (`✕`) reverts the composer to its pre-dictation state, discards audio buffers, and clears review cards.

### Text-to-Speech (Read Aloud)

- Integrated Web Speech API speech synthesis (`SpeechContext.jsx`).
- Controls: **Play**, **Pause**, **Resume**, and **Stop** directly on assistant message cards.
- Natural Cadence Chunking: Splits long markdown text into sentence and clause chunks (~140 characters) via `splitTextIntoSpeechChunks()` to prevent Chromium 15-second speech synthesis cutoffs.
- Content Unwrapping: Markdown headings, lists, bold, italics, tables, and code blocks are stripped of syntax symbols before synthesis via `cleanTextForSpeech()`.

---

## Chatbot Modes

Orvix features four distinct conversational modes configured in `src/config/chatModes.js` and styled in `src/styles/index.css`:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        ORVIX CHATBOT MODES                             │
├──────────────────┬──────────────────┬──────────────────┬───────────────┤
│ 1. General Mode  │ 2. Learning Mode │ 3. Writing Mode  │ 4. Coding     │
│   Everyday Q&A,  │   Educational,   │   Drafting,      │   Programming,│
│   versatile,     │   step-by-step,  │   prose polish,  │   architecture│
│   rich formatting│   callout blocks │   memo/editorial │   VS Code UI  │
└──────────────────┴──────────────────┴──────────────────┴───────────────┘
```

### 1. General Assistant Mode
- **Purpose**: Versatile companion for everyday questions, multi-topic brainstorming, and general inquiries.
- **System Directive**: Delivers helpful, balanced, direct responses with clean structure and formatting.
- **Typographic Presentation**:
  - Reading typography with responsive font scaling (`line-height: 1.68; font-size: 0.95rem;`).
  - Semantic heading hierarchy (H1–H6) with adjacent margin collapse.
  - Multi-tier nested lists: Unordered (`•`, `◦`, `▪`) and Ordered (`1.`, `a.`, `i.`).
  - Task lists with interactive-style disabled checkboxes (`.markdown-task-checkbox`).
  - Horizontal-scrolling tables with distinct headers and row hover highlights.

### 2. Learning Mode
- **Purpose**: Concept mastery, educational breakdowns, intuitive analogies, and active recall.
- **System Directive**: Breaks down complex topics into logical, easily digestible steps using real-world analogies, conceptual summaries, and comprehension checkpoints.
- **Educational Callout Blocks**:
  - Automatically identifies 8 distinct educational callout types plus GFM alerts:
    1. **Important** (Rose `#f43f5e`, `AlertCircle`): Critical prerequisites and core rules.
    2. **Warning / Common Pitfalls** (Amber `#f59e0b`, `AlertTriangle`): Mistakes to avoid and edge cases.
    3. **Note / Information** (Sky Blue `#38bdf8`, `Info`): Helpful contextual remarks.
    4. **Tip / Study Tip** (Emerald `#10b981`, `Lightbulb`): Actionable study and efficiency advice.
    5. **Key Takeaway / Summary** (Violet `#8b5cf6`, `CheckCircle2`): High-yield conceptual summaries.
    6. **Definition / Key Terms** (Indigo `#6366f1`, `BookOpen`): Formal definitions and vocabulary.
    7. **Example / Everyday Analogy** (Cyan `#06b6d4`, `Bookmark`): Real-world comparisons and worked examples.
    8. **Comparison / Contrast** (Purple `#a855f7`, `Sparkles`): Trade-off analyses and side-by-side matrices.

### 3. Writing Mode
- **Purpose**: Drafting, content editing, tone adjustment, and prose polishing.
- **System Directive**: Prioritizes narrative flow, rhythm, grammatical precision, structure, varied phrasing, and tailored register.
- **Typographic Presentation**:
  - Constrained editorial line length (`max-width: 76ch`) to optimize reading cadence.
  - Relaxed line height (`1.78`) with balanced heading line wraps (`text-wrap: balance`).
  - Memo and email header card detection: formats lines beginning with `Subject:`, `To:`, `From:`, `Date:`, or `Regarding:` into an executive memo block.
  - Editorial blockquotes with warm amber borders (`#d97706`), italic styling, and soft backgrounds.

### 4. Coding Mode
- **Purpose**: Software architecture, implementation, syntax review, bug analysis, and technical problem solving.
- **System Directive**: Delivers production-grade code, minimal conversational filler, precise language identifiers, edge-case notes, and step-by-step technical guidance.
- **Typographic Presentation & CodeBlock Component**:
  - macOS / VS Code-style header with window control dots (red, yellow, green) and language icons.
  - Inline pill badge displaying total line counts (`X lines`).
  - Mathematically locked 22px line height (`--code-line-height: 22px;`) with zero vertical drift over 500+ lines.
  - Tabular numbers (`tabular-nums`) to maintain digit alignment up to 10,000+ lines.
  - Sticky line number gutter (`position: sticky; left: 0`) while code scrolls horizontally.
  - Clean source code copying: **Copy Code** extracts only pure code, completely excluding line numbers and UI headers.
  - Syntax highlighting for 20+ programming languages.

---

## AI Providers & Supported Models

Orvix connects to four distinct AI provider infrastructures through secure server-side proxies:

### Supported Providers & Models

| Provider | Model Identifier | Primary Focus | Failover / Backup Model |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-3.8-flash` | Ultra-fast inference, multimodal understanding | `gemini-3.1-flash-lite` |
| **Groq Cloud** | `llama-3.3-70b-versatile` | Low-latency inference via Groq LPUs | `openai/gpt-oss-120b` |
| **OpenRouter** | `openrouter/free` | Decentralized routing across community models | Dynamic routing |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | Low-latency edge inference | Edge fallback |

### Provider Context Budgets

Context budgets are calibrated in `src/services/documentContextService.js`:

| Provider | Max Prompt Context | Document Context Budget | Best Suited For |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | 1,000,000 tokens | ~120,000 characters | Extensive multi-page PDFs, books, large codebases |
| **Groq Cloud** | 128,000 tokens | ~24,000 characters | Rapid structured analysis, high-speed coding |
| **OpenRouter** | Variable by model | ~16,000 characters | Broad open-source experimentation |
| **Cloudflare Workers AI** | 8,192 tokens | ~16,000 characters | Edge summaries, quick queries |

### Streaming & Fallback System

- **Server-Sent Events (SSE)**: All AI completions stream tokens incrementally in real time via `POST /api/chat`.
- **Automatic Model Failover**: If `gemini-3.8-flash` encounters a rate limit (429) or temporary server error (503), Orvix automatically retries with `gemini-3.1-flash-lite`.
- **Cross-Provider Recovery**: If an active provider fails, the error card provides a **"Switch Provider & Retry"** button that redirects the exact prompt to an alternate configured provider without retyping.

### Zero-Key Simulation Mode

Orvix runs out-of-the-box without requiring API keys. When no keys are configured, Orvix operates in **Simulated Mode**, generating realistic conversational replies tailored to the active mode and prompt so that all UI workflows, attachments, code blocks, and exports can be tested immediately.

---

## Attachments & Deep Document Understanding

### Three Multimodal Attachment Methods

1. **File Picker Upload Button**: Click the paperclip icon in the composer to open the native OS file selector.
2. **Clipboard Paste (`Ctrl + V` / `Cmd + V`)**: Copy any image or screenshot to the clipboard and paste it directly into the Orvix window. Plain text and code paste normally into the textarea.
3. **Drag-and-Drop Interaction**: Drag any supported file over the chat area. The window highlights with an accented dashed border (`.is-drag-over`) and displays a `"Drop file to attach"` banner.

### Attachment Constraints & Rules

- **Strict One-Attachment-Per-Message Rule**: Users can attach strictly one file per message. Adding a second file is rejected with an explicit notice to remove the current attachment first.
- **Maximum File Size**: 25 MB. Larger files are rejected with a clear size notice.
- **Staging Preview**: Attached files dock directly above the input textarea showing a format icon, filename, size badge, and a quick remove button (`✕`).

### Supported Document Formats

- **PDF Documents (`.pdf`)**: Page-by-page extraction using `unpdf`, detecting total pages and page boundaries.
- **Microsoft Word (`.docx`)**: Heading, list, paragraph, and table extraction using `mammoth`.
- **PowerPoint Presentations (`.pptx`)**: Slide-by-slide text extraction using `jszip`.
- **Structured Data**: CSV, TSV, JSON, and XML files with table formatting.
- **Plain Text**: TXT and Markdown (`.md`).

### Targeted Questioning & Presenter Notes

- **Targeted Inquiries**: Users can ask targeted questions about specific document sections (e.g., *"What is on page 4?"*, *"Summarize slides 2 through 5"*). Orvix validates page boundaries and extracts the targeted slice to prevent hallucinations.
- **PowerPoint Presenter Notes**: For `.pptx` presentations, Orvix extracts speaker notes attached to individual slides, enabling questions about the presenter's speaking points.
- **Scanned PDF Diagnostics**: If a PDF contains only scanned raster images without an embedded text layer, Orvix detects the condition and notifies the user to extract text via OCR.

---

## Image Attachments & Optical Character Recognition (OCR)

### Supported Image Formats & Binary Verification

- Supported formats: **JPEG / JPG**, **PNG**, **WebP**, **GIF**, **BMP**, and **HEIC / HEIF**.
- Every upload undergoes binary magic number verification (`\xFF\xD8\xFF` for JPEG, `\x89PNG` for PNG, `RIFF`/`WEBP`, `GIF87a`/`GIF89a`, `BM` for BMP, `ftyp` for HEIC) to block disguised executable payloads.

### Server-Side OCR Engine

- Powered by `tesseract.js` running on the Express backend with a 25-second processing timeout.
- Extracts clean text, character counts, word counts, and confidence scores (0–100%).

### Honest No-Readable-Text Handling

If an uploaded image contains no readable text (e.g., abstract art, photos without typography, blank graphics), Orvix flags the result as `NO_TEXT_DETECTED` and immediately informs the user:
> **"No readable text detected in this image."**  
This prevents AI models from hallucinating fictitious text or contents.

### Dual-Tab Preview Modal

Clicking an image card opens `DocumentPreviewModal.jsx` with two inspection tabs:
- **Image Tab**: High-resolution image view with zoom and aspect ratio controls.
- **Extracted Text Tab**: Monospace viewer displaying the exact OCR text, word/character metrics, confidence rating, and a one-click **Copy Text** button.

---

## Chat Management & Usability Enhancements

### Multi-Model Alternative Response Regeneration

- **"Regenerate with another AI Model"**: After any assistant message completes, users can click the **Another Model** (`Sparkles` icon) button to generate a new answer from any supported provider (Gemini, Groq, OpenRouter, Cloudflare Workers AI).
- **Non-Destructive History**: Previous answers are never overwritten. Each output is stored as an independent alternative with its own model badge, timestamp, and elapsed generation duration.
- **Alternative Navigation**: An inline `< X of Y >` pager in the message action bar allows instant switching between different model responses.
- **In-Place Regenerate**: The standard **Regenerate** button (`RotateCcw`) refreshes the currently active alternative in place using its existing model.

### Automatic Chat-Input Focus

- **Global Typing Capture**: Typing on the keyboard while reviewing responses automatically focuses the message textarea and appends the first keystroke with zero dropped characters.
- **Text Selection Protection**: Selecting, highlighting, or copying text inside messages or code blocks never steals focus.
- **Shortcut & Dialog Protection**: Bypasses modifier keys (`Ctrl`, `Cmd`, `Alt`) to keep shortcuts like `Ctrl+C`, `Ctrl+V`, `Ctrl+A`, and `Ctrl+F` intact. Bypasses buttons, menus, open modals, and IME composition.

### Live Response-Time Measurement

- **Active Streaming Phase**: A live badge (`Thinking... 1.4s`) updates every 100ms during active AI generation using high-resolution browser timing (`performance.now()`).
- **Final Duration Badge**: Seamlessly transitions to a static badge upon completion (e.g., `Response time: 2.3s` or `Response time: 1m 04s`).
- **Session & Export Persistence**: Durations are permanently saved in Cloud Firestore (`responseTimeMs`), local guest storage, and client-side conversation exports.

### Controlled Large-Response Continuation

- For exhaustive prompts, `detectLargeResponseIntent()` divides massive responses into coherent sections.
- When Part 1 finishes, the assistant signs off with a clear continuation notice, and an interactive **`[ → Continue response ]`** chip appears above the composer.
- Clicking the chip or typing phrases like `"Continue"` triggers the next section while preserving the original prompt and attached documents.

### Conversation Pinning & Client-Side Export

- **Pinning**: Pin up to 5 priority conversations to a dedicated top section in the sidebar.
- **Client-Side Export**: Export complete chat threads to **Markdown (`.md`)**, **Plain Text (`.txt`)**, or **JSON (`.json`)** with zero server roundtrips, preserving timestamps, mode labels, and response durations.

---

## Architecture & Technology Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        ORVIX ARCHITECTURE                              │
├───────────────────────────────────┬────────────────────────────────────┤
│ CLIENT (React 19 SPA)             │ SERVER (Express + Vite Middleware) │
│ - React 19, Tailwind CSS v4       │ - Express in TypeScript (server.ts)│
│ - Lucide Icons, React-Markdown    │ - @google/genai TypeScript SDK     │
│ - Dual-Format Clipboard Formatter │ - Groq, OpenRouter & Cloudflare SSE│
│ - Web Speech API (Voice & TTS)    │ - In-Memory Multer & Tesseract OCR │
│ - IndexedDB (Attachment Caching)  │ - Document Parsers (unpdf, mammoth)│
│ - LocalStorage (Guest Mode)       │ - Touch & Pointer Gesture Pipeline │
└───────────────────────────────────┴────────────────────────────────────┘
```

- **Frontend**: React 19 (`react`, `react-dom`), Vite 8, Tailwind CSS v4, Lucide React, `react-markdown`, and `remark-gfm`.
- **Backend**: Express 4 running via `tsx` in TypeScript (`server.ts`) with Vite middlewares mounted in development on port 3000 (`0.0.0.0`).
- **AI Integrations**: `@google/genai` TypeScript SDK for Google Gemini; REST streaming for Groq, OpenRouter, and Cloudflare Workers AI.
- **Speech & Audio**: Web Speech API, MediaRecorder API, Web Audio API (`AnalyserNode`), Groq Whisper Large v3 Turbo, Gemini Audio Recognition.
- **Document & Image Processing**: `unpdf` (PDFs), `mammoth` (DOCX), `jszip` (PPTX), and `tesseract.js` (OCR).
- **Authentication & Database**: Firebase Authentication (Google & Email/Password) and Cloud Firestore with full guest mode fallback.

---

## Authentication & Persistence Architecture

1. **Client-Side IndexedDB (`orvix_attachments_db`)**: Caches raw uploaded files and images in the browser so that thumbnails, previews, and downloads survive page reloads even after temporary server files expire.
2. **Server-Side In-Memory Staging**: Uploads are staged in memory via `multer.memoryStorage()`, ensuring resilience on serverless environments where local filesystems are strictly read-only (`EROFS`).
3. **Cloud Firestore**: For authenticated users, conversations, messages, response alternatives, pinned states, and user preferences are persisted under `users/{uid}/chats/{chatId}/messages/{messageId}`.
4. **Guest Mode Storage**: Unauthenticated users enjoy full app functionality with conversations and settings persisted in browser `localStorage`.

---

## Project Structure

```text
├── api/                             # Serverless API handlers
│   ├── chat.ts                      # Multi-provider AI streaming router
│   ├── config.ts                    # Public configuration status endpoint
│   ├── health.ts                    # Health check endpoint
│   ├── transcribe.ts                # Audio transcription handler
│   └── upload.ts                    # Multipart file upload & OCR handler
├── public/                          # Static assets, icons & PWA manifest
├── src/
│   ├── components/
│   │   ├── auth/                    # Authentication screen & guest switcher
│   │   ├── chat/                    # Core chat interface
│   │   │   ├── AttachmentCard.jsx   # Document attachment chip & card
│   │   │   ├── ChatArea.jsx         # Composer dock, auto-focus, paste & drop
│   │   │   ├── ChatMessage.jsx      # Markdown rendering, callouts, copy & timer
│   │   │   ├── CodeBlock.jsx        # Precision syntax highlighter & copy button
│   │   │   ├── DocumentPreviewModal.jsx # Full-screen image/OCR modal
│   │   │   ├── ExportChatMenu.jsx   # Markdown / Plain Text / JSON export
│   │   │   ├── ImageAttachmentCard.jsx  # Inline image thumbnail
│   │   │   ├── MessageList.jsx      # Scrollable message list
│   │   │   ├── ModeSelector.jsx     # Conversational mode selector
│   │   │   ├── ModelSelector.jsx    # AI provider & model selector
│   │   │   ├── PromptSuggestions.jsx# Welcome starter prompt chips
│   │   │   └── TypingIndicator.jsx  # Streaming indicator dots
│   │   ├── layout/                  # Navigation header, sidebar & gesture layout
│   │   ├── settings/                # User preferences & persona modal
│   │   └── ui/                      # Reusable UI primitives (Button, Logo)
│   ├── config/                      # App config, 4 chat modes & Firebase
│   ├── context/                     # React context (Auth, Settings, Speech)
│   ├── hooks/                       # Custom hooks (PWA install, voice dictation)
│   ├── pages/                       # ChatPage main page component
│   ├── services/                    # Core business logic services
│   │   ├── aiRouter.js              # Multi-provider routing & provider options
│   │   ├── alternativeResponseService.js # Alternative response state & navigation
│   │   ├── attachmentStorageService.js   # IndexedDB blob storage
│   │   ├── authService.js           # Firebase authentication wrapper
│   │   ├── chatStorageService.js    # Firestore & localStorage chat persistence
│   │   ├── documentContextService.js# Context budgeting & document formatting
│   │   ├── documentExtractor.js     # PDF, DOCX, PPTX document parsers
│   │   ├── geminiService.js         # Google Gemini integration
│   │   ├── groqService.js           # Groq REST API integration
│   │   ├── imageOcrService.js       # Tesseract.js OCR engine
│   │   ├── multiPartResponseService.js   # Large-response continuation engine
│   │   ├── openrouterService.js     # OpenRouter completions API
│   │   └── transcriptionService.js  # Whisper audio transcription client
│   ├── styles/                      # Tailwind CSS v4 & custom stylesheet (index.css)
│   └── utils/                       # Export, speech, clipboardFormatter & highlighter
├── server.ts                        # Express development & production server
├── vite.config.ts                   # Vite configuration
├── package.json                     # Project dependencies & scripts
├── .env.example                     # Environment configuration template
└── README.md                        # Project documentation
```

---

## Environment Variables & Configuration

Create a `.env` file in the root directory based on `.env.example`:

```bash
# Server Configuration
PORT=3000
NODE_ENV=development
MAX_FILE_SIZE_BYTES=26214400
TEMP_FILE_TTL_MS=7200000

# Primary AI Provider (Google Gemini)
GEMINI_API_KEY=your_gemini_api_key_here

# Optional AI Providers (Groq Cloud, OpenRouter, Cloudflare Workers AI)
GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token

# Firebase Authentication & Firestore (Optional - Enables Cloud Sync)
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

> **Note on Security**: Never commit real API keys or `.env` files to source control. Orvix runs fully in Simulated Mode when keys are absent.

---

## Installation & Running Locally

### Prerequisites
- **Node.js**: Version 18.0.0 or higher (Node.js 22 LTS recommended).
- **npm**: Version 9.0.0 or higher.

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Development Server
```bash
npm run dev
```
The application will start on `http://localhost:3000` (`0.0.0.0:3000`).

### 3. Verify Types & Linting
```bash
npm run lint
```

---

## Build & Deployment Instructions

### Full-Stack Production Build & Server
Compile client assets and launch the production server:
```bash
npm run build
npm start
```
The Express server serves optimized static assets from `dist/` with SPA fallback routing and API proxying.

### Vercel Serverless Deployment
Orvix is pre-configured with `vercel.json` and dedicated entry points in `api/`:
- `api/chat.ts`: Serverless proxy for streaming AI completions.
- `api/transcribe.ts`: Serverless audio transcription handler.
- `api/upload.ts`: Serverless in-memory upload and OCR handler.

---

## Troubleshooting & Common Issues

| Issue | Likely Cause | Resolution |
| :--- | :--- | :--- |
| **Pasted table distorted in WhatsApp** | Messaging app uses proportional fonts | Use Orvix's built-in **Copy** button on the message card; Orvix automatically generates structured record plain text (`• Header: Value`) so column values never lose association. |
| **Swipe gesture does not open drawer** | Swiping inside composer, header, or code block | Initiate the swipe from the neutral conversation area; avoid touching the composer bar, top header, or horizontally scrollable code blocks. |
| **Microphone access denied** | Browser blocked mic permission | Click the camera/microphone icon in the browser address bar, set permission to "Allow", and reload. |
| **No live words in Firefox** | Firefox lacks Web Speech API by default | Normal behavior. Orvix automatically switches to Direct-Audio mode; audio records directly and transcribes via Whisper upon tapping Done. |
| **Dictation pauses on iOS Safari** | iOS Safari requires user gesture after silence | Tap **Resume** on the dictation strip to reactivate the microphone session. |
| **Port 3000 already in use** | Another local process is bound to port 3000 | Stop the conflicting process or run `PORT=3001 npm run dev`. |
| **`EROFS: read-only file system`** | Serverless deployment write restriction | Orvix stages uploads in memory via `multer.memoryStorage()`, preventing local disk write errors. |
| **Scanned PDF shows no text** | PDF contains image scans without a text layer | Use the Image upload option to extract text via the server-side OCR engine. |
| **HEIC image preview blank** | Browsers cannot render raw HEIC in `<img>` | Orvix displays an informational fallback card with full text inspection in the modal dialog. |

---

## Security Architecture

1. **Zero Credential Exposure**: API keys for Gemini, Groq, OpenRouter, and Cloudflare are strictly server-side. The browser never receives raw provider keys.
2. **Binary Header & Magic Number Validation**: Uploads are validated against binary signatures to prevent disguised executables.
3. **Control Character Sanitization**: Extracted document and OCR text is stripped of non-printable control characters before insertion into prompts.
4. **Client-Side Blob Revocation**: Object URLs created for preview thumbnails are explicitly revoked upon unmounting to prevent memory leaks.
5. **Microphone Hardware Release**: Microphone tracks are actively stopped on tab hide/blur, ensuring OS privacy indicators turn off immediately.

---

## Current Limitations

1. **Messaging App Plain Text Constraints**: While Orvix generates structured record plain text (`• Header: Value`), plain-text platforms like WhatsApp cannot render HTML tables or grid borders.
2. **Device-Specific Gesture Variations**: Edge swipe sensitivity and gesture handling may vary depending on device touch controllers, OS gesture settings (e.g., Android full-screen gesture navigation), or browser UI overlays.
3. **OCR vs. Visual Reasoning**: Orvix extracts printed and typographic text from images via OCR. It does not perform spatial visual reasoning or artistic descriptions beyond text extraction.
4. **Binary File Longevity**: Extracted text and chat metadata persist permanently. Raw binary files are stored in browser IndexedDB on the local device; temporary server files expire after a 2-hour TTL.
5. **Browser HEIC Rendering**: Standard web browsers cannot decode HEIC/HEIF images natively in `<img>` tags; Orvix displays an informational fallback card with direct download and modal text inspection.
6. **Firefox Live Speech Display**: Because Mozilla Firefox does not enable the native Web Speech API by default, live progressive word display is unavailable; full transcription is delivered upon tapping Done via Whisper.

---

## Version History & Detailed Changelog

Orvix adheres to Semantic Versioning (`MAJOR.MINOR.PATCH`):
- **MAJOR**: Incompatible architectural overhauls or breaking changes.
- **MINOR**: Substantial new feature additions and multi-component workflows.
- **PATCH**: Bug fixes, performance optimizations, and reliability enhancements.

> **Version Alignment Note**: The application package metadata in `package.json` specifies version `0.9.0`. The release notes below document the recent enhancements through **v0.9.3**.

### v0.9.3 — Mobile PWA Live Dictation & Interim Transcript Deduplication (October 2026) *(Current Codebase)*

**Newly Added & Enhanced**

- **A. Mobile & PWA Live Speech Recognition (`useVoiceDictation.js`, `ChatArea.jsx`)**:
  - **Real-Time Word Rendering on Mobile**: Initiating voice dictation in mobile browsers and PWA standalone mode now renders recognized words live into the message composer as the user speaks, eliminating the previous delay where mobile users had to wait until pressing Stop to view transcribed text.
  - **Coexistence of Live Recognition and Whisper Refinement**: Mobile dictation no longer forces an exclusive choice between live preview and server Whisper refinement. Live speech recognition provides immediate progressive feedback during speech, while the audio stream is concurrently recorded and finalized upon pressing Stop to trigger high-accuracy Groq Whisper Large v3 Turbo refinement.
  - **Corrected Interim Transcript Duplication**: Eliminated the critical interim result duplication bug where successive evolving hypotheses (`"I"`, `"I want"`, `"I want you"`) were being repeatedly concatenated into composer text. The engine strictly distinguishes finalized text (persistent, committed segments) from interim candidates (replaceable, temporary snapshots), guaranteeing that each incoming interim snapshot cleanly replaces the prior interim buffer.
  - **Seamless End-of-Session Reconciliation**: When Whisper completes its final pass, the refined transcription smoothly reconciles with the live preview, enhancing spelling, capitalization, and punctuation while strictly preserving any manual user edits made in the composer.

- **B. Cross-Platform Dictation Consistency & Desktop Regression Protection**:
  - **Desktop Hybrid Pipeline Preserved**: Maintained full desktop support across Chrome, Edge, and Safari with synchronized `SpeechRecognition`, `MediaRecorder` audio buffering, and reactive 5-bar Web Audio `AnalyserNode` visualizer feedback.
  - **Direct-Audio Fallback Maintained**: Preserved direct `MediaRecorder` audio capture and Whisper transcription for Mozilla Firefox (which lacks native Web Speech support by default) and standalone iOS PWAs.
  - **Silence Restart & Audio Continuity**: Retained robust stream reuse across natural pauses and silence restarts, preventing audio hardware drops or dropped opening words.
  - **Strict Session Isolation**: Preserves composer clear guards (`Ctrl+A` + `Backspace`), session counters, and stale asynchronous response discard guarantees.

---

### v0.9.2 — Table Copying, Mobile Swipe Navigation & Dictation Hardening (October 2026)

**Newly Added & Enhanced**

- **A. Improved Table Copying and Clipboard Alignment (`clipboardFormatter.js`)**:
  - **Dual-Payload Clipboard Generation**: Generates both `text/html` and `text/plain` payloads in modern browsers using `ClipboardItem`, with graceful fallback to `navigator.clipboard.writeText` and off-screen `<textarea>` selection.
  - **Messaging Application Plain-Text Layout (WhatsApp, Telegram)**: Formats Markdown tables into an unambiguous, labeled record layout (`• Header1: Value1 \n  Header2: Value2`) so table data remains readable and structured even when pasted into proportional-font messaging apps.
  - **Internal Cell Break Handling**: Normalizes `<br>` tags in table cells into indented sublines (`\n    `), preventing multiline table cell overflows.
  - **Rich HTML Table Formatting**: Generates styled HTML tables with headers (`#f1f5f9`), zebra-striped rows, borders (`#cbd5e1`, `#e2e8f0`), text alignment (`left`, `center`, `right`), and inline typography for Google Docs, Word, Outlook, and Slack.
  - **Fenced Code Block Shielding**: Protects code blocks during table parsing to prevent pipe symbols (`|`) in code from triggering false table extractions.
  - **Mixed Content Support**: Preserves surrounding headings, paragraphs, lists, and blockquotes alongside formatted tables.

- **B. Improved Mobile Chat-History Swipe Gesture (`Layout.jsx`)**:
  - **Expanded Swipe Activation Zone**: Enables swiping right to open the chat history sidebar from across the main conversation area (`.chat-scroll-viewport, .chat-area-container, .chatora-main`) on screen widths `<= 1024px`, removing the previous 0–40px edge restriction.
  - **Native iOS Back Avoidance**: Rejects touches within `< 16px` of the extreme left screen edge to prevent contention with the native iOS swipe-to-go-back gesture.
  - **Comprehensive Excluded Target Filters**: Excludes top navigation/action bar, bottom composer dock, interactive buttons, form inputs, dialogs, popovers, and horizontally scrollable code blocks or tables.
  - **Horizontal vs. Vertical Intent Disambiguation**: Evaluates movement after crossing `10px` (`INTENT_THRESHOLD_PX`); if vertical scrolling dominates, gesture tracking resets immediately so native scrolling remains smooth.
  - **Flick Acceleration**: Supports standard swipes ($\Delta X \ge 50\text{px}$) and rapid flicks ($\Delta X \ge 30\text{px}$ with velocity $> 0.35\text{px/ms}$).
  - **Dual Touch and Pointer Event Handling**: Implements native touch handlers alongside synthetic pointer event support with collision prevention.

- **C. High-Accuracy Voice Dictation & Whisper Pipeline Hardening (`useVoiceDictation.js`, `speechTextCleaner.js`)**:
  - **Server-Side Whisper Large v3 Turbo**: Integrated Groq Whisper (`whisper-large-v3-turbo`) with zero-temperature inference and technical vocabulary conditioning, with automatic backup to Gemini audio recognition.
  - **Hybrid & Direct-Audio Architecture**: Progressive Web Speech recognition in Chrome/Edge/Safari, paired with direct MediaRecorder audio capture in Firefox and restricted environments.
  - **Whisper Truncation Protection**: Retains native transcript if server-side transcription returns an unexpectedly truncated fragment (<40% of native length when $\ge 50$ characters).
  - **Context-Aware Technical Polishing**: Algorithmic correction for programming terms (`pedrandom` → `palindrome`, `sync await` → `async/await`, `Math.random` preservation, keyword lists).
  - **Session Isolation & Stale Result Protection**: Composer clears (`Ctrl+A` + `Backspace`) unconditionally invalidate in-flight transcriptions; session counters prevent delayed responses from overwriting active text; manual user edits during transcription are preserved.
  - **Hardware Track Release**: Audio tracks stop immediately when the browser tab is hidden or backgrounded (`visibilitychange`, `pagehide`).

- **D. Other Verified Enhancements & Reliability Fixes**:
  - **Visual Copy Feedback**: Message copy button provides immediate state feedback (`"Copied"` or `"Failed to copy"`).
  - **CodeBlock Clean Copying**: Code block copy button extracts pure code without line numbers or UI chrome.
  - **Response Timer Persistence**: High-resolution response durations (`responseTimeMs`) saved across Firestore, local storage, and client exports.

---

### v0.9.1 — High-Accuracy Voice Dictation & Whisper Pipeline Hardening (October 2026)

- **High-Accuracy Server Whisper Pipeline**: Integrated server-side audio transcription via Groq Whisper Large v3 Turbo with Gemini audio fallback at `/api/transcribe`.
- **Dual-Engine Dictation Architecture**: Hybrid mode for Chrome/Edge/Safari and Direct-Audio mode for Firefox with 9 supported locales.
- **Context-Aware Technical Polishing**: Added `polishSpokenTranscript()` with contextual disambiguation for programming vocabulary.
- **Session Isolation Hardening**: Reset base references on composer clearing, session counter guards for async transcription, and silence restart continuity.

---

### v0.9.0 — Four Chatbot Modes Refinement & Documentation Overhaul (October 2026)

- **Refinement of All Four Chatbot Modes**:
  - **General Mode**: Enhanced universal markdown presentation, heading hierarchy (H1–H6), multi-tier nested lists, task list checkboxes, and responsive tables.
  - **Learning Mode**: Educational interface with sequential numbered steps, comparison tables, and automated detection of 8 educational callout blocks.
  - **Writing Mode**: Constrained 76ch max-width, balanced heading wraps, formal memo/email header card detection, and warm amber styling.
  - **Coding Mode**: VS Code-style window controls, syntax highlighting for 20+ languages, line-count badge, sticky line number gutter, and locked 22px line height.

---

### v0.8.0 — Multi-Model Response Alternatives & Provider Unification (October 2026)

- **"Regenerate with another AI Model"**: Regenerate any completed assistant response using a different provider (Gemini, Groq, OpenRouter, Cloudflare Workers AI) without losing earlier outputs.
- **Non-Destructive Alternative History**: Captures every response as an independent alternative with its own model badge, timestamp, and duration metric.
- **Response Alternative Navigator**: Integrated `< X of Y >` pager in `ChatMessage.jsx`.

---

### v0.7.1 — Automatic Chat-Input Focus & Pixel-Perfect Line Alignment (October 2026)

- **Automatic Chat-Input Focus**: Global typing capture in `ChatArea.jsx` to immediately focus the composer on any alphanumeric keystroke without dropping the initial character.
- **Pixel-Perfect Code-Block Line Alignment**: Synchronized typography (`--code-line-height: 22px;`) to eliminate vertical line number drift across 100+ line code blocks.

---

### v0.7.0 — Live Response-Time Measurement & Left-Edge Swipe Gesture (October 2026)

- **Live Response-Time Measurement**: Live timer badge (`Thinking... X.Xs`) updating every 100ms during streaming, transitioning to an immutable final duration badge (`Response time: X.Xs`).
- **Initial Left-Edge Swipe Gesture**: Native touch swipe from left edge on mobile/tablet viewports to slide open chat history.

---

### v0.6.0 — Controlled Large-Response Continuation & Multimodal Inputs (October 2026)

- **Controlled Large-Response Continuation**: Split massive responses into safe parts with continuation notices and an interactive composer chip (`[ → Continue response ]`).
- **Three Multimodal Attachment Methods**: File picker dialog, clipboard paste (`Ctrl + V`), and drag-and-drop file staging with a 25MB limit.

---

### v0.5.0 — Serverless Upload Architecture & Resilience (October 2026)

- Migrated uploads to `multer.memoryStorage()`, resolving read-only filesystem errors (`EROFS`) on serverless platforms.
- Extended client upload timeout to 90 seconds for large files and OCR processing.

---

### v0.4.0 — Image Attachments & Optical Character Recognition (OCR) (October 2026)

- Server-side OCR engine using `tesseract.js` with binary magic number verification.
- Honest "No readable text detected" reporting to prevent model hallucinations.
- Dual-tab image preview modal (Image view + Extracted text view).

---

### v0.3.0 — Deep Document Understanding & Error UI Overhaul (October 2026)

- Text extraction for PDF (`unpdf`), Word DOCX (`mammoth`), and PowerPoint PPTX with speaker notes (`jszip`).
- Targeted inquiries by page, range, or slide.
- Responsive diagnostic error cards with one-click retry and provider switching.

---

### v0.2.0 — Cloudflare Workers AI Integration (October 2026)

- Integrated `@cf/meta/llama-3.1-8b-instruct` via Cloudflare's edge REST API with SSE streaming.

---

### v0.1.0 — Initial Full-Stack Release (October 2026)

- React 19 SPA frontend with Tailwind CSS v4, Obsidian Dark and Clean Light themes.
- Express backend (`server.ts`) with Vite middleware mode on port 3000.
- Google Gemini, Groq, and OpenRouter streaming.
- Web Speech voice dictation and text-to-speech read-aloud.
- Cloud Firestore and Guest Mode local storage.

---

## Future Roadmap

The following capabilities represent prospective architectural enhancements and are clearly distinguished from currently implemented features:

- **Client-Side Vector Search / RAG**: Semantic vector chunk search for 500+ page documents using local embeddings.
- **Multilingual OCR Enhancements**: Dynamic language pack downloads for non-Latin script optical character recognition.
- **Streaming Voice Input**: Real-time server-side audio streaming via WebSockets for sub-second Whisper transcription on browsers lacking Web Speech support.
- **Image Generation Integration**: Generative visual creation tools alongside existing conversational modes.
