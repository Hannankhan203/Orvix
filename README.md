# Orvix

**Version: V 0.3.0**

An intelligent, multi-model AI conversational workspace featuring on-device Browser AI (WebGPU & WebLLM), offline PWA app-shell caching, client-side document extraction, dual-format clipboard formatting, mobile swipe navigation, live voice dictation with Whisper refinement, four specialized chat modes, and immutable Share Chat conversation collaboration.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Browser AI (WebLLM) & On-Device WebGPU Inference](#browser-ai-webllm--on-device-webgpu-inference)
   - [Local Browser Execution & Privacy](#local-browser-execution--privacy)
   - [Integrated Browser AI Models & Quantization Tiers](#integrated-browser-ai-models--quantization-tiers)
   - [Dedicated Web Worker Architecture](#dedicated-web-worker-architecture)
   - [Browser AI Status Bar & Interactive Controls](#browser-ai-status-bar--interactive-controls)
4. [Offline Functionality & PWA Caching Architecture](#offline-functionality--pwa-caching-architecture)
   - [App Shell Precache vs. Model Weight Cache](#app-shell-precache-vs-model-weight-cache)
   - [Prerequisites for Reliable Offline Use](#prerequisites-for-reliable-offline-use)
   - [Model Weight Retention & Storage Lifecycle](#model-weight-retention--storage-lifecycle)
   - [Behavior of Cloud Providers When Offline](#behavior-of-cloud-providers-when-offline)
5. [Browser-Side Document Extraction (Offline & Local)](#browser-side-document-extraction-offline--local)
   - [Supported Offline Document Formats](#supported-offline-document-formats)
   - [Document Structure Preservation & Context Formatting](#document-structure-preservation--context-formatting)
   - [Scanned PDF & Image OCR Boundaries](#scanned-pdf--image-ocr-boundaries)
   - [IndexedDB Attachment Caching](#indexeddb-attachment-caching)
6. [Step-by-Step Guide: Using Browser AI Offline](#step-by-step-guide-using-browser-ai-offline)
7. [Message Copying & Dual-Format Clipboard](#message-copying--dual-format-clipboard)
   - [Dual-Format Clipboard Generation (`text/html` and `text/plain`)](#dual-format-clipboard-generation-texthtml-and-textplain)
   - [Structured Plain-Text Record Layout for Messaging Apps](#structured-plain-text-record-layout-for-messaging-apps)
   - [Rich HTML Table Styling for Documents](#rich-html-table-styling-for-documents)
   - [Three-Tier Clipboard Writing Strategy](#three-tier-clipboard-writing-strategy)
8. [Mobile Responsiveness & Swipe Navigation](#mobile-responsiveness--swipe-navigation)
   - [Main Conversation Swipe-Right Gesture](#main-conversation-swipe-right-gesture)
   - [Excluded Zones & Interaction Safeguards](#excluded-zones--interaction-safeguards)
   - [Horizontal Intent Disambiguation](#horizontal-intent-disambiguation)
9. [Voice Dictation & Speech Architecture](#voice-dictation--speech-architecture)
   - [Hybrid Recognition & Whisper Refinement](#hybrid-recognition--whisper-refinement)
   - [Interim Transcript Handling & Deduplication](#interim-transcript-handling--deduplication)
   - [Smart Punctuation & Typography Formatting](#smart-punctuation--typography-formatting)
   - [Text-to-Speech (Read Aloud)](#text-to-speech-read-aloud)
10. [Chatbot Modes](#chatbot-modes)
    - [1. General Assistant Mode](#1-general-assistant-mode)
    - [2. Learning Mode](#2-learning-mode)
    - [3. Writing Mode](#3-writing-mode)
    - [4. Coding Mode](#4-coding-mode)
11. [AI Providers & Supported Models](#ai-providers--supported-models)
    - [Supported Providers & Models](#supported-providers--models)
    - [Provider Context Budgets](#provider-context-budgets)
    - [Streaming & Fallback System](#streaming--fallback-system)
    - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
12. [Attachments & Document Understanding](#attachments--document-understanding)
    - [Attachment Methods & Rules](#attachment-methods--rules)
    - [Supported Formats & Targeted Questioning](#supported-formats--targeted-questioning)
13. [Image Attachments & Optical Character Recognition (OCR)](#image-attachments--optical-character-recognition-ocr)
    - [Supported Image Formats & Verification](#supported-image-formats--verification)
    - [Server-Side OCR Engine](#server-side-ocr-engine)
    - [Honest No-Text Handling & Preview Modal](#honest-no-text-handling--preview-modal)
14. [Chat Management & Usability Enhancements](#chat-management--usability-enhancements)
    - [Multi-Model Alternative Responses](#multi-model-alternative-responses)
    - [Automatic Chat-Input Focus](#automatic-chat-input-focus)
    - [Live Response-Time Measurement](#live-response-time-measurement)
    - [Controlled Large-Response Continuation](#controlled-large-response-continuation)
    - [Edit & Resend with Branch Truncation](#edit--resend-with-branch-truncation)
    - [Conversation Pinning & Client-Side Export](#conversation-pinning--client-side-export)
15. [Share Chat & Conversation Collaboration](#share-chat--conversation-collaboration)
    - [Share Entire Conversations](#share-entire-conversations)
    - [Public Shared Conversation Viewer](#public-shared-conversation-viewer)
    - [Sign In and Continue](#sign-in-and-continue)
    - [Independent Conversation Import](#independent-conversation-import)
    - [Imported Chat Management](#imported-chat-management)
    - [Security and Data Isolation](#security-and-data-isolation)
    - [Persistence and Reliability](#persistence-and-reliability)
16. [Architecture & Technology Stack](#architecture--technology-stack)
17. [Authentication & Persistence Architecture](#authentication--persistence-architecture)
18. [Project Structure](#project-structure)
19. [Environment Variables & Configuration](#environment-variables--configuration)
20. [Installation & Running Locally](#installation--running-locally)
21. [Build & Deployment Instructions](#build--deployment-instructions)
    - [Firestore Security Rules Deployment for Share Chat](#firestore-security-rules-deployment-for-share-chat)
22. [Troubleshooting & Common Issues](#troubleshooting--common-issues)
    - [Troubleshooting Gemini Timeouts & Streaming](#troubleshooting-gemini-timeouts--streaming)
23. [Security Architecture](#security-architecture)
24. [Current Limitations](#current-limitations)
25. [Version History & Release Changelog](#version-history--release-changelog)
26. [Future Roadmap](#future-roadmap)

---

## Project Overview

**Orvix** is an intelligent, multi-model conversational workspace engineered for privacy, flexibility, and offline resilience. It pairs flexible cloud-hosted models (Google Gemini, Groq, OpenRouter, and Cloudflare Workers AI) with **100% on-device AI generation via WebGPU and WebLLM**, enabling private and responsive AI chat both connected to the cloud and entirely offline.

Built as a full-stack Node.js application, Orvix combines a React 19 single-page application with an Express backend running Vite in middleware mode. When internet access is present, cloud model completions, audio transcriptions, and OCR operations execute server-side to guarantee credentials remain secure. When offline, Orvix leverages Workbox PWA precaching, on-device WebLLM inference across four integrated models, and client-side document extraction to maintain an uninterrupted local experience.

---

## Key Features

- **Share Chat & Immutable Public Snapshots**: Share complete conversations via unique URLs with instant Copy Link, WhatsApp, and native OS share dialogs. Public visitors can view, copy, and listen read-only without accounts; authenticated users can preview and fork conversations into independent, full-featured private chats upon their first message turn ([learn more](#share-chat--conversation-collaboration)).
- **On-Device Browser AI (WebLLM)**: Run four integrated open-weight models (SmallLM2 135M, SmallLM2 360M, Qwen3 0.6B, Qwen2.5 1.5B) directly on your GPU via WebGPU and a dedicated Web Worker without external API calls or telemetry.
- **Offline PWA App-Shell Caching**: Workbox service worker precaches application assets, WASM bundles, and offline document extractors for instant offline re-access.
- **Client-Side Document Extraction**: Extracts and grounds text locally from Word (`.docx`), PDF (`.pdf`), PowerPoint (`.pptx`), CSV, TSV, JSON, XML, and Markdown files without cloud dependencies.
- **Dual-Format Table & Clipboard Copying**: Copies assistant responses as both styled `text/html` (with zebra striping and borders for Word, Docs, and Slack) and structured `text/plain` key-value records (`• Header: Value`) that never distort in messaging apps like WhatsApp or Telegram.
- **Mobile Swipe Navigation**: Natural swipe-right gesture across the main conversation area on mobile and tablet viewports (`<= 1024px`) to open the chat history sidebar, complete with safe exclusions for inputs, headers, code blocks, and iOS back-navigation edges.
- **Voice Dictation with Whisper Refinement**: Real-time browser speech recognition rendering interim transcript snapshots as you speak, reconciled with server-side Groq Whisper Large v3 Turbo (with Gemini audio fallback) upon completion.
- **Four Specialized Chat Modes**: Dedicated modes for **General Assistant**, **Learning** (educational callouts), **Writing** (editorial layout), and **Coding** (VS Code styling with locked 22px line heights).
- **Multi-Model Response Alternatives**: Compare answers from multiple providers for the same prompt using an `< X of Y >` pager without overwriting prior outputs.
- **Global Input Auto-Focus**: Type anywhere on the page to automatically focus the composer without losing the first keystroke, protecting active text selection and shortcuts.
- **Controlled Continuation**: Automatic segmentation of long outputs with continuation notices and an interactive composer chip (`[ → Continue response ]`).
- **Deep Multimodal Attachments**: Drag-and-drop, clipboard paste (`Ctrl+V`), and file picker staging for documents and images with server-side Tesseract OCR and honest `NO_TEXT_DETECTED` handling.
- **Zero-Key Simulation Mode**: Runs immediately out of the box without requiring API keys, providing realistic local responses for testing all UI flows.

---

## Browser AI (WebLLM) & On-Device WebGPU Inference

Orvix features an on-device local AI engine implemented in `src/services/webllmService.js` and executed inside a dedicated background worker (`src/workers/webllmWorker.js`). Powered by `@mlc-ai/web-llm` and the browser's native **WebGPU API**, Browser AI allows visitors to run compact, highly capable language models directly on their device's graphics processor.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX ON-DEVICE BROWSER AI ARCHITECTURE              │
├────────────────────────────────────────────────────────────────────────┤
│ 1. VISITOR'S BROWSER (Main UI Thread)                                  │
│    • React 19 UI & Message Composer                                    │
│    • Browser AI Status Bar (progress %, memory state, model selector)  │
│    • Client-Side Document Extractor (PDF, DOCX, PPTX, TXT, CSV, JSON)  │
│                                    ↕                                   │
│ 2. DEDICATED WEB WORKER (`src/workers/webllmWorker.js`)               │
│    • WebWorkerMLCEngineHandler off the main thread (zero UI freeze)    │
│    • Tokenizer & SentencePiece decoding                                │
│    • WASM shader compiler & prefill/decode pipeline                    │
│                                    ↕                                   │
│ 3. HARDWARE & CACHE APIS                                               │
│    • WebGPU Device Pipeline (GPU VRAM allocation & shader execution)   │
│    • Browser Cache Storage (`webllm/model`, `webllm/config`, etc.)     │
│    • 100% On-Device — 0 bytes sent to external AI servers or proxies   │
└────────────────────────────────────────────────────────────────────────┘
```

### Local Browser Execution & Privacy

- **Zero API Keys or Cloud Accounts**: Browser AI requires no credentials, external tokens, or third-party accounts.
- **Complete Data Confidentiality**: Input prompts, conversation history, and attached document contents remain strictly on the visitor's physical device.
- **Zero Server Dependencies**: Inference executes on the local GPU. Generation operates even when the Orvix backend server is unreachable.
- **Peer Provider Integration**: Browser AI is integrated as a peer option alongside cloud providers in the model selector.

### Integrated Browser AI Models & Quantization Tiers

Orvix integrates four verified Browser AI models ordered in the UI from least resource-intensive to most capable:

| Model Option | Model Identifier | Quantization | Est. Download | Required VRAM | Context Window | Target Devices |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SmallLM2 135M (Ultra-Lightweight)** | `SmolLM2-135M-Instruct-q0f16-MLC` | 16-bit (`q0f16`) | ~270 MB | ~360 MB | 4,096 tokens | Ultra-lightweight testing, fast local execution |
| **SmallLM2 135M (FP32 Fallback)** | `SmolLM2-135M-Instruct-q0f32-MLC` | 32-bit (`q0f32`) | ~270 MB | ~720 MB | 4,096 tokens | Devices without native `shader-f16` |
| **SmallLM2 360M (Compact)** | `SmolLM2-360M-Instruct-q4f16_1-MLC` | 4-bit (`q4f16_1`) | ~210 MB | ~380 MB | 4,096 tokens | Laptops, integrated GPUs, low-memory devices |
| **SmallLM2 360M (FP32 Fallback)** | `SmolLM2-360M-Instruct-q4f32_1-MLC` | 4-bit (`q4f32_1`) | ~210 MB | ~580 MB | 4,096 tokens | Devices without native `shader-f16` |
| **Qwen3 0.6B (Lightweight)** | `Qwen3-0.6B-q4f16_1-MLC` | 4-bit (`q4f16_1`) | ~335 MB | ~1,403 MB | 4,096 tokens | Compact modern reasoning, low-memory systems |
| **Qwen3 0.6B (FP32 Fallback)** | `Qwen3-0.6B-q4f32_1-MLC` | 4-bit (`q4f32_1`) | ~335 MB | ~1,925 MB | 4,096 tokens | Devices without native `shader-f16` |
| **Qwen2.5 1.5B (Standard, Default)** | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | 4-bit (`q4f16_1`) | ~960 MB | ~1,630 MB | 4,096 tokens | Modern desktop GPUs, high-memory laptops |
| **Qwen2.5 1.5B (FP32 Fallback)** | `Qwen2.5-1.5B-Instruct-q4f32_1-MLC` | 4-bit (`q4f32_1`) | ~1,120 MB | ~1,890 MB | 4,096 tokens | Desktop GPUs without `shader-f16` |

- **Automatic Shader-F16 Fallback**: `checkWebGPUSupport()` inspects the GPU adapter for the 16-bit float extension (`shader-f16`). If unsupported, `resolveWebLLMModelId()` routes automatically to the compatible FP32 variant.
- **Partitioned Cache Storage**: Shards are downloaded into partitioned browser Cache Storage (`webllm/model`, `webllm/config`, `webllm/wasm`) so interruptions can resume without re-downloading completed chunks.

### Dedicated Web Worker Architecture

- **Off-Thread Execution**: All WebLLM computation runs inside `src/workers/webllmWorker.js` via `CreateWebWorkerMLCEngine`, keeping the main UI thread responsive at 60 FPS.
- **Generation Serialization**: Requests are queued via `generationQueuePromise` to prevent WebGPU buffer contention.
- **Instant Interruption**: Clicking **Stop** (`Square` icon) calls `engine.interruptGenerate()` in the worker to halt token generation immediately and preserve partial output.

### Browser AI Status Bar & Interactive Controls

When Browser AI is selected, an interactive dock (`src/components/chat/BrowserAIStatusBar.jsx`) appears above the composer:
- **Compatibility Feedback**: Alerts if WebGPU is unsupported, hardware acceleration is disabled, or context is non-secure.
- **Download Progress**: Shows percentage (`0–100%`) and chunk download descriptions.
- **VRAM Compilation Status**: Signals shader compilation and weight transfer into GPU memory.
- **Interactive Controls**:
  - **Model Selector**: Switch between SmallLM2 135M, SmallLM2 360M, Qwen3 0.6B, and Qwen2.5 1.5B.
  - **Load Model**: Triggers on-demand initialization before typing.
  - **Cancel (`✕`)**: Halts an active download cleanly.
  - **Retry (`RotateCcw`)**: Appears on connection or initialization failures.
  - **Unload (`Trash2`)**: Releases GPU VRAM while retaining cached model shards on disk.

---

## Offline Functionality & PWA Caching Architecture

Orvix is built with Progressive Web App (PWA) compliance, enabling offline reopening and chat generation without internet connectivity.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX TWO-TIER OFFLINE CACHING MODEL                 │
├───────────────────────────────────┬────────────────────────────────────┤
│ TIER 1: APP-SHELL PRECACHE        │ TIER 2: MODEL WEIGHT CACHE         │
│ (Workbox / VitePWA)               │ (WebLLM Cache Storage)             │
├───────────────────────────────────┼────────────────────────────────────┤
│ • Production HTML, JS, and CSS    │ • Quantized Model Tensor Shards    │
│ • WebLLM Worker (`webllmWorker`)  │ • Model Configuration JSON         │
│ • Document Parsers (PDF, DOCX)    │ • WASM Shaders & Tokenizer Tables  │
│ • App Icons & PWA Manifest        │ • Scope: Browser Cache Storage     │
│ • Size: ~15.4 MB total            │ • Stored on demand, never in PWA   │
└───────────────────────────────────┴────────────────────────────────────┘
```

### App Shell Precache vs. Model Weight Cache

1. **Application Shell Precache**: Configured via `vite-plugin-pwa` in `vite.config.ts`. Precaches HTML, CSS, client scripts, icons, web manifest, WebLLM worker script, and document parsers (~15.4 MB total). API routes (`/api/*`, `/health`, `/chat`, `/config`, `/transcribe`, `/upload`) are excluded from navigation fallbacks and use `NetworkOnly`.
2. **Model Weight Cache**: Model weights (~210 MB to ~1.15 GB) are **never** bundled into the service worker precache manifest to prevent page-load stalls. Instead, WebLLM manages shards inside dedicated Cache Storage buckets on demand.

### Prerequisites for Reliable Offline Use

1. **Initial Online Visit**: Visit the Orvix site over HTTPS or localhost while online to let the service worker install and precache the application shell.
2. **Model Download Completion**: Select **Browser AI (WebLLM)**, choose your preferred model, and let it download until the status displays `"Ready on device"`.

Once cached, you can disconnect from the internet and chat offline at any time.

### Model Weight Retention & Storage Lifecycle

- **Closing Browser / PWA**: Does not evict the cached model. Shards persist in Cache Storage across reloads and device reboots.
- **Storage Persistence**: Orvix requests `navigator.storage.persist()` where available to prevent OS storage eviction.
- **Eviction Triggers**: Manually clearing browser site data, using Incognito/Private windows, or critical disk space pressure can clear cached models.

### Behavior of Cloud Providers When Offline

If a user submits a prompt to a cloud provider (Gemini, Groq, OpenRouter, Cloudflare) while offline, Orvix intercepts the request immediately with an actionable banner:
`"[Provider] requires an internet connection. Switch to Browser AI (WebLLM) to chat offline on this device."` with a one-click **"Switch to Browser AI"** button.

---

## Browser-Side Document Extraction (Offline & Local)

When running offline, document processing cannot rely on backend endpoints. Orvix includes a browser-side extraction pipeline (`src/services/browserDocumentExtractor.js`) to parse text, headings, tables, and presentation slides locally.

### Supported Offline Document Formats

| Format | Extension | Extraction Mechanism | Extracted Metadata & Structure |
| :--- | :--- | :--- | :--- |
| **Plain Text** | `.txt`, `.text` | Native `File.text()` | Word and character count, summary preview |
| **Markdown** | `.md`, `.markdown` | Native text parser | Headings (H1–H6), section counts |
| **CSV / TSV** | `.csv`, `.tsv` | Native delimiter parser | Column headers, row count, formatted Markdown table |
| **JSON** | `.json` | Native `JSON.parse` | Root keys count, pretty-printed JSON code block |
| **XML** | `.xml` | Native `DOMParser` | Structural text nodes, syntax validation |
| **Word** | `.docx` | Lazy-loaded `mammoth` | Headings, lists, bold/italics, tabular data |
| **PDF** | `.pdf` | Lazy-loaded `unpdf` | Page numbers, page boundaries (`--- Page N ---`), text layer |
| **PowerPoint** | `.pptx` | Lazy-loaded `jszip` | Slide titles, body text, slide numbers, speaker notes |

### Document Structure Preservation & Context Formatting

- **Reusing Extractions**: Documents parsed during the session are cached in memory to eliminate re-parsing overhead.
- **Context Allocation**: Extracted text is bounded and sanitized before injection into the prompt context via `prepareDocumentContext`.
- **Targeted Lookups**: Page markers (`--- Page N ---`) and slide markers (`--- Slide N: Title ---`, `[Speaker Notes]: ...`) enable pinpoint queries (e.g., *"Summarize slide 3 notes"*).

### Scanned PDF & Image OCR Boundaries

- **Scanned PDFs**: If a PDF contains only rasterized images without an embedded text layer (`nonWhitespaceChars < 10`), Orvix detects the condition and notifies the user that OCR is required.
- **Image OCR**: Image text recognition requires the server-side Tesseract engine and is unavailable offline.
- **Legacy Formats**: Binary legacy formats (`.doc`, `.ppt`, `.xls`) cannot be parsed by browser OpenXML engines; Orvix prompts users to re-save in modern formats (`.docx`, `.pptx`, `.csv`).

### IndexedDB Attachment Caching

File attachments are cached locally in the browser's IndexedDB database (`orvix_attachments_db`), allowing previews, file card rendering, and downloads to persist offline across page reloads.

---

## Step-by-Step Guide: Using Browser AI Offline

Follow these steps to set up and use Orvix offline:

1. **Open the Site Online**: Navigate to Orvix in a WebGPU-compatible browser (Chrome 113+, Edge 113+, Safari 18+). The PWA service worker precaches the app shell automatically.
2. **Select Browser AI**: Choose **Browser AI (WebLLM)** from the model selector dropdown in the header.
3. **Choose Your Preferred Model**: Select one of the four integrated offline models in the status bar:
   - **SmallLM2 135M**: Ultra-lightweight (~270 MB download, ~360 MB VRAM), fastest initialization.
   - **SmallLM2 360M**: Compact (~210 MB download, ~380 MB VRAM), efficient everyday queries.
   - **Qwen3 0.6B**: Lightweight (~335 MB download, ~1,403 MB VRAM), solid modern reasoning.
   - **Qwen2.5 1.5B**: Standard default (~960 MB download, ~1,630 MB VRAM), highest quality.
4. **Download and Initialize**: Click **Load Model** in the status bar (or submit a prompt). Wait for the progress bar to complete and display:
   `"Qwen3 0.6B — Ready on device"` *(or your chosen model)*.
5. **Send a Test Message**: Send a quick prompt (e.g., *"What is WebGPU?"*) to verify local execution.
6. **Close Orvix**: Close the tab, window, or installed PWA.
7. **Disconnect Internet**: Turn off Wi-Fi or toggle DevTools Network to **Offline**.
8. **Reopen Orvix Offline**: Relaunch Orvix or open the installed PWA. The app shell loads instantly from cache, and the status bar displays:
   `"Offline — Model is cached locally. Ready to run on your device via WebGPU."`
9. **Chat and Analyze Documents Offline**: Submit prompts or attach supported files (`.pdf`, `.docx`, `.pptx`, `.txt`, `.csv`, `.json`). Responses generate locally on your GPU.

---

## Message Copying & Dual-Format Clipboard

Orvix features a clipboard formatting pipeline (`src/utils/clipboardFormatter.js`) that produces two simultaneous payloads when copying assistant messages:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX CLIPBOARD FORMATTING PIPELINE                  │
├───────────────────────────────────┬────────────────────────────────────┤
│ 1. RICH-TEXT DESTINATIONS         │ 2. MESSAGING APPS (WHATSAPP, ETC.) │
│ - Target: Word, Docs, Slack, Mail │ - Target: WhatsApp, Telegram, SMS  │
│ - MIME type: text/html            │ - MIME type: text/plain            │
│ - Styled <table> with borders     │ - Structured record layout         │
│ - Alternating row zebra fills     │ - Clear "• Header: Value" records │
│ - Semantic typography preserved   │ - No pipe column distortion        │
└───────────────────────────────────┴────────────────────────────────────┘
```

### Dual-Format Clipboard Generation (`text/html` and `text/plain`)

When you click **Copy**, Orvix parses markdown tables, code blocks, lists, and headings, writing both a rich `text/html` fragment and an optimized `text/plain` string via `ClipboardItem` in one atomic operation.

### Structured Plain-Text Record Layout for Messaging Apps

Raw ASCII markdown tables (`| Column 1 | Column 2 |`) misalign badly in messaging apps that use variable-width proportional fonts (WhatsApp, Telegram). Orvix transforms tables in the `text/plain` payload into clear, structured record entries:

```text
• Feature: Operational Logic
  Traditional: Deterministic IF/THEN rules
  AI: Probabilistic patterns inferred from data

• Feature: Adaptability
  Traditional: Requires manual code updates
  AI: Continuously refines from context
```

Each data row becomes an indented record where values remain clearly paired with their column header regardless of font or screen width.

### Rich HTML Table Styling for Documents

For rich text destinations (Google Docs, Microsoft Word, Slack, Outlook), Orvix writes an inline-styled `<table>`:
- **Headers (`<thead>`)**: Background `#f1f5f9`, border `#cbd5e1`, semi-bold `#0f172a`.
- **Data Rows (`<tbody>`)**: Subtle zebra striping (`#ffffff` and `#f8fafc`) with `#e2e8f0` dividers.
- **Column Alignments**: Respects GFM delimiters (`left`, `center`, `right`).

### Three-Tier Clipboard Writing Strategy

1. **Tier 1 — Asynchronous Clipboard API (`ClipboardItem`)**: Writes binary `Blob`s for both `text/html` and `text/plain`.
2. **Tier 2 — Clipboard Text API (`writeText`)**: Falls back to writing plain text if HTML clipboard permissions are restricted.
3. **Tier 3 — Off-Screen Textarea Fallback (`document.execCommand`)**: Uses an off-screen `<textarea>` for older environments or strict security sandboxes.

---

## Mobile Responsiveness & Swipe Navigation

Orvix includes a responsive touch gesture pipeline in `src/components/layout/Layout.jsx`, allowing mobile and tablet users (`<= 1024px`) to open conversation history smoothly.

### Main Conversation Swipe-Right Gesture

- **Full-Viewport Activation**: Users can initiate the swipe across the main chat area without needing an awkward edge-only touch.
- **Responsive Viewport Support**: Active on screens `<= 1024px` when the sidebar is closed.

### Excluded Zones & Interaction Safeguards

To prevent gesture conflicts, `isExcludedSwipeTarget()` ignores touches originating from:
1. **iOS Native Back Margin (`< 16px`)**: Preserves native iOS Safari edge navigation.
2. **Top Navigation Header**: Excludes menu buttons, model selector, and new chat actions.
3. **Message Composer**: Excludes text input, voice dictation, and attachment tray.
4. **Interactive Controls & Code Blocks**: Excludes buttons, links, markdown tables, and horizontally scrolling `pre`/`code` blocks.
5. **Text Selection**: Suspends gesture tracking when user has selected text.

### Horizontal Intent Disambiguation

- **Movement Threshold**: Tracks initial movement until passing `10px` displacement.
- **Dominance Formula**: Confirms a horizontal swipe only if rightward movement clearly exceeds vertical motion:
  $$\Delta X > 0 \quad \text{and} \quad |\Delta X| > |\Delta Y| \times 1.25$$
- **Immediate Scroll Release**: If vertical scroll or leftward movement is detected, gesture tracking aborts immediately, letting native vertical scrolling proceed smoothly.

---

## Voice Dictation & Speech Architecture

Orvix provides a unified voice dictation engine (`src/hooks/useVoiceDictation.js`) combining real-time browser speech recognition with server-side Whisper refinement.

### Hybrid Recognition & Whisper Refinement

1. **Live Preview While Speaking**: Spoken words stream immediately into the composer using native browser `SpeechRecognition`.
2. **On Stop**: Tapping **Done** finalizes recorded audio and submits the audio `Blob` to `/api/transcribe`.
3. **Server Whisper Refinement**: Groq Whisper Large v3 Turbo (with Gemini audio fallback) transcribes the recording with technical vocabulary conditioning.
4. **Reconciliation**: The high-accuracy server transcript replaces the rough live preview while preserving any manual text edits made by the user.

### Interim Transcript Handling & Deduplication

Browser speech engines emit temporary interim hypotheses before committing final utterances. Naive concatenation causes stuttering duplication (`"I I want I want you"`). Orvix separates permanent final segments from the active interim hypothesis, replacing the interim buffer on each event:
$$\text{Composer Text} = \text{Base Text} + \sum \text{Committed Segments} + \text{Active Interim Snapshot}$$

### Smart Punctuation & Typography Formatting

- **Spoken Commands**: Converts verbal punctuation (`"comma"` → `,`, `"period"` → `.`, `"question mark"` → `?`, `"new line"` → `\n`, `"new paragraph"` → `\n\n`) across 9 supported languages.
- **Technical Acronyms**: Automatically cleans and formats programming terminology (`JavaScript`, `TypeScript`, `Python`, `JSON`, `HTML`, `CSS`, `APIs`, `Math.random`).

### Text-to-Speech (Read Aloud)

Assistant messages include audio playback controls (Play, Pause, Stop) powered by the Web Speech Synthesis API. Text is cleaned of markdown syntax and split into ~140-character clauses to avoid Chromium speech synthesis timeouts.

---

## Chatbot Modes

Orvix provides four specialized conversational modes configured in `src/config/chatModes.js`:

### 1. General Assistant Mode
- **Purpose**: Everyday questions, versatile brainstorming, and general tasks.
- **Directives**: Clear, direct answers with balanced tone, hierarchical headings, and markdown tables.

### 2. Learning Mode
- **Purpose**: Concept breakdowns, intuitive analogies, and educational recall.
- **Educational Callout Blocks**: Recognizes 8 callout types: **Important** (rose), **Warning** (amber), **Note** (sky blue), **Tip** (emerald), **Key Takeaway** (violet), **Definition** (indigo), **Example** (cyan), and **Comparison** (purple).

### 3. Writing Mode
- **Purpose**: Drafting, prose polishing, tone adjustment, and editorial refinement.
- **Styling**: Constrained 76ch reading column, relaxed line height (1.78), memo headers (`Subject:`, `To:`, `From:`), and warm quote styling.

### 4. Coding Mode
- **Purpose**: Implementation, architecture, bug diagnostics, and syntax review.
- **CodeBlock Component**: VS Code-style header, locked 22px line height (`--code-line-height: 22px;`) to eliminate vertical line-number drift over 500+ lines, sticky line gutters, syntax highlighting for 20+ languages, and pure code copying.

---

## AI Providers & Supported Models

### Supported Providers & Models

| Provider | Model Identifier | Architecture | Failover / Backup Model |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-3.8-flash` | Cloud API via `@google/genai` SDK | `gemini-3.1-flash-lite` |
| **Groq Cloud** | `openai/gpt-oss-120b` | Ultra-low latency LPU inference | `llama-3.1-8b-instant` |
| **OpenRouter** | `openrouter/free` | Dynamic free community model router | Dynamic routing |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | Serverless edge inference | Edge fallback |
| **Browser AI (WebLLM)** | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` *(Default)*<br>`Qwen3-0.6B-q4f16_1-MLC`<br>`SmolLM2-360M-Instruct-q4f16_1-MLC`<br>`SmolLM2-135M-Instruct-q0f16-MLC` | 100% on-device WebGPU inference; runs offline without cloud APIs | Automatic runtime fallback to `q4f32_1` / `q0f32` variants for devices lacking `shader-f16` |

### Provider Context Budgets

| Provider | Max Context | Document Context Budget | Best Suited For |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | 1,000,000 tokens | ~120,000 characters | Long documents, large codebases, complex reasoning |
| **Groq Cloud** | 128,000 tokens | ~24,000 characters | Rapid structured responses, fast coding assistance |
| **OpenRouter** | Variable by model | ~16,000 characters | Open-source model experimentation |
| **Cloudflare Workers AI** | 8,192 tokens | ~16,000 characters | Quick edge summaries and lightweight queries |
| **Browser AI (WebLLM)** | 4,096 tokens | ~6,000–10,000 characters | 100% offline Q&A, complete privacy, zero API costs |

### Streaming & Fallback System

- **Immediate SSE Header Priming**: Server flushes `: prime\n\n` within 50ms to establish sub-second TTFB and satisfy edge reverse proxy timeouts.
- **Heartbeat Keepalive**: Emits `: keepalive\n\n` every 8s during complex generation to prevent socket drops.
- **Error Boundaries**: Errors occurring *before* any chunk is emitted permit automatic failover (`canFallback: true`). Errors *mid-stream* strictly forbid failover (`canFallback: false`) to avoid duplicate text output.
- **Client Abort Wiring**: Closing the tab or clicking **Stop** triggers an `AbortController` signal that cancels upstream API requests immediately.

### Zero-Key Simulation Mode

Orvix works immediately without API keys. In simulation mode, realistic local responses are generated to test all UI interactions, modes, attachments, and exports. Alternatively, users can switch to **Browser AI (WebLLM)** to run real local AI models on-device without any API keys.

---

## Attachments & Document Understanding

### Attachment Methods & Rules

- **Three Staging Methods**: File picker dialog, clipboard paste (`Ctrl+V`), or drag-and-drop onto the chat area.
- **Constraints**: Strictly 1 attachment per message; maximum file size of 25 MB.
- **Docked Preview**: Staged files display a format icon, filename, size, and remove button (`✕`).

### Supported Formats & Targeted Questioning

- **PDF (`.pdf`)**: Page-by-page text layer extraction with `unpdf`.
- **Word (`.docx`)**: Heading, list, and table extraction with `mammoth`.
- **PowerPoint (`.pptx`)**: Slide-by-slide body text and presenter notes extraction with `jszip`.
- **Data & Text**: CSV, TSV, JSON, XML, Markdown, and TXT.
- **Targeted Lookups**: Inquire about specific slides or pages (e.g., *"What does slide 3 say?"*, *"Summarize page 2"*).

---

## Image Attachments & Optical Character Recognition (OCR)

### Supported Image Formats & Verification

- Formats: JPEG, PNG, WebP, GIF, BMP, and HEIC/HEIF.
- Validates binary magic numbers (`\xFF\xD8\xFF` for JPEG, `\x89PNG` for PNG, etc.) to prevent disguised files.

### Server-Side OCR Engine

- Powered by `tesseract.js` running on the Express backend with a 25s timeout.
- Extracts clean text, character counts, word counts, and confidence scores.

### Honest No-Text Handling & Preview Modal

- If an image contains no readable text, Orvix displays `NO_TEXT_DETECTED` to prevent model hallucinations.
- Clicking an image card opens a preview modal with two tabs: **Image View** (high-res inspection with zoom) and **Extracted Text** (clean OCR text with copy button).

---

## Chat Management & Usability Enhancements

### Multi-Model Alternative Responses

- Click **Another Model** (`Sparkles` icon) on any assistant response to generate an alternative output from another provider without losing the existing answer.
- Navigate between responses using the `< X of Y >` pager on the message card.

### Automatic Chat-Input Focus

- Typing alphanumeric keys anywhere on the page automatically focuses the composer without dropping the first character.
- Safeguards ignore keystrokes during active text selection, modifier shortcuts (`Ctrl+C`, `Cmd+V`), open modals, and form controls.

### Live Response-Time Measurement

- Displays a live duration counter (`Thinking... 1.4s`) updating every 100ms during streaming.
- Replaces with an immutable badge upon completion (e.g., `Response time: 2.1s`), preserved across sessions and exports.

### Controlled Large-Response Continuation

- Automatically detects extensive response intents and segments outputs cleanly.
- Displays an interactive **`[ → Continue response ]`** chip above the composer to fetch subsequent parts seamlessly.

### Edit & Resend with Branch Truncation

- Clicking **Edit** (`Pencil` icon) allows modifying prior user messages.
- Resending truncates downstream messages from that point forward, providing the AI model with a clean context window. In-flight requests are aborted to avoid state corruption.

### Conversation Pinning & Client-Side Export

- Pin up to 5 priority chats to the top of the sidebar.
- Export conversations to **Markdown (`.md`)**, **Plain Text (`.txt`)**, or **JSON (`.json`)** completely client-side.

---

## Share Chat & Conversation Collaboration

Orvix Share Chat provides privacy-preserving conversation sharing and collaborative branching. It allows authenticated users to publish immutable snapshots of their conversations, enables public visitors to inspect conversations in a high-fidelity read-only viewer, and empowers authenticated recipients to fork conversations into their own independent chat history.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX SHARE CHAT LIFECYCLE & FORKING                 │
├────────────────────────────────────────────────────────────────────────┤
│ 1. PRIVATE CONVERSATION (`users/{uid}/chats/{chatId}`)                 │
│    • User clicks "Share" in header or sidebar context menu             │
│    • Client sanitizes message payloads, removes auth & private metadata│
│    • Creates immutable snapshot in `sharedChats/{shareId}` (<= 950 KB) │
│                                    │                                   │
│                                    ▼                                   │
│ 2. PUBLIC SHARED VIEWER (`/share/{shareId}`)                           │
│    • Open to anyone without sign-in; exact document lookup             │
│    • Read-only: Copy code/messages and Read Aloud (TTS) available      │
│    • Composer disabled; 0 modifications permitted on source snapshot   │
│                                    │                                   │
│                                    ▼ (Sign in)                         │
│ 3. AUTHENTICATED TEMPORARY PREVIEW                                     │
│    • Composer unlocks; attachments & microphone locked                 │
│    • Zero database side-effects before recipient interaction           │
│                                    │                                   │
│                                    ▼ (First turn completed)            │
│ 4. INDEPENDENT FORK IMPORT (`users/{recipientUid}/chats/{newChatId}`) │
│    • Snapshot messages + recipient prompt + AI completion persisted    │
│    • Independent private chat with "Imported" provenance indicator     │
│    • Original owner conversation and shared snapshot remain unchanged  │
└────────────────────────────────────────────────────────────────────────┘
```

### Share Entire Conversations
- **One-Click Sharing**: Authenticated users can share any saved conversation using the **Share** button in the top navigation header or via the conversation action menu in the sidebar.
- **Versatile Distribution Options**: The Share modal provides one-click **Copy Link**, direct sharing to **WhatsApp**, and native OS share dialogs via the Web Share API (`navigator.share`).
- **Immutable Snapshot Creation**: Sharing freezes the conversation at that exact point in time and publishes an immutable snapshot document. Subsequent messages sent by the owner in their private chat do not alter the published snapshot.

### Public Shared Conversation Viewer
- **No Account Required for Viewing**: Anyone with the unique share URL (`/share/{shareId}`) can open and read the complete conversation transcript immediately without creating an account or logging in.
- **Strict Read-Only Enforcement**: Public visitors cannot alter, overwrite, or delete the shared snapshot. The message input composer is safely disabled with an informational callout prompting visitors to sign in to continue or fork the conversation.
- **Full Reading Utility**: Public visitors retain access to core reading tools, including dual-format clipboard copying (`text/html` and `text/plain`), syntax-highlighted code blocks with line numbers, and browser-native Text-to-Speech (Read Aloud).

### Sign In and Continue
- **Frictionless Onboarding**: Authenticated users opening a shared URL enter an **Authenticated Temporary Preview** state.
- **Temporary Preview Safety**: The shared conversation is presented in the chat window with the composer unlocked, but it is **not** immediately added to the recipient's private chat history or persisted to their database.
- **Owner Conversation Protection**: The original owner's private conversation and the shared snapshot remain entirely protected and immutable.

### Independent Conversation Import
- **Interaction-Gated Forking**: The temporary preview is imported into the recipient's account **only** after they successfully send their first prompt and the AI model finishes generating a complete response (`status: 'completed'`).
- **Zero Ghost Chats on Failure**: If the recipient cancels generation, closes the tab, or encounters an upstream API error during the first turn, no orphan chat document or history entry is left in their account.
- **Combined Transcript**: Once the first turn completes successfully, an independent private chat document is atomically created containing all original shared messages followed by the recipient's new prompt and assistant response.
- **Complete Decoupling**: The imported chat is 100% independent. Deleting, modifying, or continuing the imported chat has zero effect on the original conversation or shared snapshot.

### Imported Chat Management
- **Provenance Indicator**: Imported conversations feature an **Imported** indicator badge in the conversation header and sidebar, along with a deep link back to the source shared snapshot.
- **Standard Conversation Controls**: Recipients can rename, pin (up to 5 priority chats), search, delete, and export (Markdown, TXT, JSON) their imported chats just like any native conversation.
- **Resharing Support**: Recipients can continue chatting and choose to reshare the extended conversation at any time. Resharing creates a brand-new, independent shared snapshot with its own unique URL.

### Security and Data Isolation
- **Collection Isolation**: Shared snapshots reside in a distinct top-level `sharedChats/{shareId}` Firestore collection, completely segregated from private user paths (`users/{uid}/chats/{chatId}`).
- **Immutable Database Rules**: Firestore security rules enforce `allow update: if false;` and `allow delete: if false;`, ensuring snapshots cannot be tampered with or deleted through client operations.
- **No Collection Enumeration**: Exact document lookups are permitted (`allow get: if true;`), while collection listing is strictly blocked (`allow list: if false;`) to protect user privacy and prevent link harvesting.
- **Sanitization Pipeline**: Private user attributes (`userId`, user profile emails, private authentication tokens, local filesystem paths, and raw binary attachments) are strictly stripped during snapshot generation.
- **Strict Boundary Constraints**: Payload size is capped at 950 KB (UTF-8 encoded) to guarantee single-document Firestore integrity, and conversations are constrained to a maximum of 500 messages with titles up to 120 characters.

### Persistence and Reliability
- **History Cleanliness**: Merely visiting or reloading `/share/{shareId}` never injects placeholder entries into local storage or account history.
- **Reload Resilience**: Reloading a `/share/{shareId}` URL cleanly restores the temporary preview with full fidelity.
- **Deduplication Lock**: Fast double-submissions or concurrent import attempts are protected by an in-flight import mutex lock, preventing duplicate chats.
- **Multi-Tab Sync**: When an import completes in one tab, a lightweight `BroadcastChannel` event notifies open tabs to synchronize their sidebar history without interrupting active conversations.
- **Offline Resilience**: If network connectivity drops after an import has been established, subsequent conversation edits and new messages are buffered in the local offline write queue and replayed once the connection recovers.

---

## Architecture & Technology Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        ORVIX ARCHITECTURE                              │
├───────────────────────────────────┬────────────────────────────────────┤
│ CLIENT (React 19 SPA)             │ SERVER (Express + Vite Middleware) │
│ • React 19, Tailwind CSS v4       │ • Express in TypeScript (server.ts)│
│ • Lucide React, React-Markdown    │ • @google/genai TypeScript SDK     │
│ • WebLLM Web Worker (WebGPU)      │ • Groq, OpenRouter & Cloudflare SSE│
│ • Share Chat & Forking Service    │ • In-Memory Multer & Tesseract OCR │
│ • Dual-Format Clipboard Formatter │ • Document Parsers (unpdf, mammoth)│
│ • Web Speech API & Visualizer     │ • Host 0.0.0.0, Port 3000          │
│ • IndexedDB (Attachment Caching)  │                                    │
└───────────────────────────────────┴────────────────────────────────────┘
```

- **Frontend**: React 19, Vite 8, Tailwind CSS v4, Lucide React, `react-markdown`, `remark-gfm`.
- **Local AI**: `@mlc-ai/web-llm` running inside `webllmWorker.js` via WebGPU.
- **Backend**: Express 4 running via `tsx` in TypeScript (`server.ts`) with Vite middlewares mounted on port 3000 (`0.0.0.0`).
- **Cloud AI**: `@google/genai` TypeScript SDK (Gemini), REST streaming for Groq, OpenRouter, and Cloudflare Workers AI.
- **Audio & Documents**: Web Speech API, MediaRecorder, Groq Whisper Large v3 Turbo, `unpdf`, `mammoth`, `jszip`, `tesseract.js`.
- **Persistence & Sharing**: IndexedDB for local file blobs and offline queues, Firebase Auth, Cloud Firestore (`users/{uid}/chats` for private sync and `sharedChats/{shareId}` for immutable snapshots), and `localStorage` for Guest Mode.

---

## Authentication & Persistence Architecture

1. **Client-Side IndexedDB (`orvix_attachments_db`)**: Caches uploaded files in the browser so thumbnails and previews persist across reloads.
2. **In-Memory Server Staging**: Uploads stage in memory via `multer.memoryStorage()`, preventing read-only filesystem errors (`EROFS`) in serverless environments.
3. **Cloud Firestore**: Authenticated users sync chats and preferences under `users/{uid}/chats/{chatId}/messages/{messageId}`.
4. **Guest Mode**: Full functionality for unauthenticated visitors with persistence in `localStorage`.
5. **Immutable Shared Snapshots (`sharedChats/{shareId}`)**: Public conversation snapshots are stored separately from private user partitions. Forked conversations are imported to `users/{uid}/chats/{newChatId}` only after the recipient's first prompt and assistant response complete successfully.

---

## Project Structure

```text
├── api/                             # Serverless API routes (chat, config, transcribe, upload)
├── public/                          # Static assets, icons, manifest.webmanifest
├── src/
│   ├── components/
│   │   ├── auth/                    # AuthScreen & Guest mode components
│   │   ├── chat/                    # ChatArea, ChatMessage, ModelSelector, CodeBlock, etc.
│   │   ├── layout/                  # Layout, Header, Sidebar
│   │   ├── settings/                # SettingsModal
│   │   └── ui/                      # Button, OrvixLogo
│   ├── config/                      # appConfig, chatModes, aiGuidance, firebaseConfig
│   ├── context/                     # AuthContext, SettingsContext, SpeechContext
│   ├── hooks/                       # useVoiceDictation, usePWAInstall
│   ├── pages/                       # ChatPage
│   ├── services/                    # aiRouter, webllmService, browserAiProfiles,
│   │                                # documentExtractor, imageOcrService, etc.
│   ├── styles/                      # Tailwind CSS v4 global stylesheet
│   ├── utils/                       # clipboardFormatter, exportConversation, speechTextCleaner
│   └── workers/                     # webllmWorker.js (off-thread WebGPU execution)
├── server.ts                        # Express development & production server
├── vite.config.ts                   # Vite configuration & Workbox PWA plugin
├── tsconfig.json                    # TypeScript compiler configuration
├── package.json                     # Dependencies and scripts
└── README.md                        # Project documentation
```

---

## Environment Variables & Configuration

Create a `.env` file in the root directory based on `.env.example`:

```bash
# Server Configuration
PORT=3000
NODE_ENV=development

# Primary AI Provider (Google Gemini)
GEMINI_API_KEY=your_gemini_api_key_here

# Optional AI Providers
GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token

# Firebase Authentication & Firestore (Optional)
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

*Note*: API keys are kept strictly server-side. Orvix runs fully in Simulated Mode or Browser AI mode when keys are absent.

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
The server will start on `http://localhost:3000` (`0.0.0.0:3000`).

### 3. Verify Types & Linting
```bash
npm run lint
```

---

## Build & Deployment Instructions

### Full-Stack Production Build
```bash
npm run build
npm start
```
The Express server serves static client assets from `dist/` with SPA routing and API proxying.

### Vercel Serverless Deployment
Configured via `vercel.json` with handlers in `api/`:
- `api/chat.ts`: Serverless proxy for streaming AI completions.
- `api/transcribe.ts`: Serverless audio transcription handler.
- `api/upload.ts`: Serverless in-memory upload and OCR handler.

### Firestore Security Rules Deployment for Share Chat
> **Important Production Deployment Note for Share Chat**: Production deployment of Share Chat requires deploying the security rules in `firestore.rules` to enforce the immutability of `sharedChats/{shareId}`, prevent collection listing, and isolate user private data. The required Firestore security rules have **not yet been deployed** and must be deployed via Firebase CLI before enabling Share Chat in production:
> ```bash
> firebase deploy --only firestore:rules
> ```

---

## Troubleshooting & Common Issues

| Issue | Likely Cause | Resolution |
| :--- | :--- | :--- |
| **WebGPU not supported** | Browser lacks WebGPU or graphics acceleration is disabled | Use Chrome 113+, Edge 113+, or Safari 18+ over HTTPS or localhost; enable hardware acceleration in browser settings. |
| **Model download fails** | Network interruption during shard fetch | Click **Retry** (`RotateCcw`) in the status bar; completed shards in Cache Storage are preserved. |
| **Offline mode shows model not cached** | Cache Storage was cleared or Incognito window used | Reconnect to internet, open Orvix, and download the model until status shows `"Ready on device"`. |
| **Cloud provider fails offline** | Cloud models require internet connectivity | Click **"Switch to Browser AI"** in the offline notice to run models locally on-device. |
| **Pasted table distorted in WhatsApp** | Messaging app uses proportional fonts | Use Orvix's **Copy** button; it formats tables as clean plain-text records (`• Header: Value`). |
| **Swipe gesture does not open drawer** | Touching inside composer, header, or code block | Initiate the swipe from the neutral conversation area. |
| **Port 3000 in use (`EADDRINUSE`)** | Another process is bound to port 3000 | Stop conflicting process or run `PORT=3001 npm run dev`. |
| **`EROFS: read-only file system`** | Serverless disk write restriction | Orvix stages uploads in memory via `multer.memoryStorage()`, avoiding local disk writes. |
| **Gemini timeout (504 DEADLINE_EXCEEDED)** | Upstream model demand spike | Orvix automatically fails over to `gemini-3.1-flash-lite`. If all cloud attempts fail, switch to Groq, OpenRouter, or Browser AI. |

### Troubleshooting Gemini Timeouts & Streaming

1. **Vercel Runtime Logs**: Check your Vercel deployment logs and filter by `/api/chat` or HTTP status `504`/`503`. Orvix outputs structured logs via `logAIDiagnostic` and `sanitizeErrorLog`, keeping keys and user data redacted.
2. **DevTools EventStream Inspection**: Open Developer Tools (`F12`) > **Network** > **Fetch/XHR** > select `/api/chat` > **EventStream**. Confirm `: prime` arrives within 50ms, followed by `: keepalive` heartbeats and streaming `data:` frames.

---

## Security Architecture

1. **Zero Credential Exposure**: Cloud API keys remain on the backend server; client bundles never contain secrets.
2. **Binary Magic Number Validation**: Uploaded files undergo binary header checks to block disguised executables.
3. **Text Sanitization**: Document and OCR text is stripped of non-printable control characters before insertion into prompts.
4. **Memory Management**: Object URLs are revoked upon unmounting to avoid browser memory leaks.
5. **Microphone Release**: Audio tracks stop immediately when the tab is hidden or closed to release hardware.
6. **Share Chat Data Isolation & Immutability**: Shared snapshots exclude private user credentials, emails, and local file paths. Snapshots in `sharedChats/{shareId}` cannot be updated or deleted by clients. Collection listing is prohibited, and payload boundaries (max 950 KB UTF-8, max 500 messages, max 120 character title) are verified before document creation.

---

## Current Limitations

1. **Messaging App Plain Text**: Plain-text platforms like WhatsApp cannot render HTML tables or grid borders; Orvix formats them as structured records (`• Header: Value`).
2. **Gesture Variations**: Swipe sensitivity may vary based on touch hardware or OS gesture navigation overlays.
3. **OCR vs. Multimodal Vision**: Orvix extracts printed text via OCR; it does not perform spatial visual reasoning on image content.
4. **Binary Storage TTL**: Raw binary attachments are cached locally in browser IndexedDB; temporary server files expire after a 2-hour TTL.
5. **Initial Online Requirement**: Browser AI requires one initial online visit to precache the PWA app shell and download model weights.
6. **Online Snapshot Generation**: Creating a shared conversation snapshot requires active internet connectivity to contact Cloud Firestore; offline snapshot creation is disabled to prevent invalid or unreachable share links.
7. **Shared Snapshot Size & Message Boundaries**: Individual shared snapshots are limited to 950 KB UTF-8 and a maximum of 500 messages to ensure single-document atomic storage limits.

---

## Version History & Release Changelog

### V 0.3.0 — Orvix Share Chat, Public Previews & Independent Fork Imports
- **Orvix Share Chat Complete Lifecycle**: Implemented complete 8-stage conversation sharing architecture allowing authenticated users to create immutable snapshots of their conversations accessible via `/share/{shareId}`.
- **Public Read-Only Viewer**: Direct URL access to shared conversations without requiring authentication. Visitors can read, copy formatted code/text, and listen via Text-to-Speech (Read Aloud) while message input is locked.
- **Authenticated Temporary Preview**: Seamless transition for authenticated recipients into a temporary preview mode where composer is available without polluting account history before interaction.
- **Interaction-Gated Independent Import**: Atomic conversation forking into recipient's private history triggered only upon recipient's first message turn receiving a successfully completed AI response (`status: 'completed'`).
- **Zero Ghost Chats on Abort/Failure**: Generation errors or cancellations during the first turn cleanly leave no orphan chat documents or partial history items.
- **Provenance & Resharing**: Imported conversations display an Imported indicator badge, maintain deep-link provenance to the source snapshot, and support standard chat operations including renaming, pinning, client-side export, and resharing under a new distinct snapshot ID.
- **Data Sanitization & Strict Security Boundaries**: Automated stripping of private credentials, local file paths, and large binary attachments before snapshot generation; strict enforcement of 950 KB UTF-8 payload limit and 500-message ceiling.
- **Multi-Tab & Offline Resilience**: Integrated cross-tab `BroadcastChannel` synchronization and offline write queue protection for imported conversations.

### V 0.2.9 — AI Model Selection Guidance and Provider Ordering
- **AI Model Selection Guidance UX**: Integrated concise, static informational guidance explaining characteristics and trade-offs of all AI options across Cloud AI and Browser AI. Dynamic model-specific resolution updates immediately upon switching selections in `ModelSelector` and `BrowserAIStatusBar` with accessible `aria-describedby` announcements and zero network/generation overhead.
- **AI Provider and Model Selector Ordering**: Reordered provider and model selector options strictly in sequence from least resource-intensive to most reliable:
  - *Cloud AI Providers*: Google Gemini, Groq, OpenRouter, Cloudflare Workers AI.
  - *Browser AI Models*: SmallLM2 135M, SmallLM2 360M, Qwen3 0.6B, Qwen2.5 1.5B (Standard Default).

### V 0.2.8 — Refined Responses and Profiling for SmallLM2 and Qwen3
- **Refined Responses & Profiling for SmallLM2 135M, SmallLM2 360M, and Qwen3 0.6B**: Tuned response profiles, positive instruction formatting, calibrated temperatures, repetition penalties, stop tokens, and streaming sanitizers to eliminate token loops, thinking block leakage, and unprompted refusals in small parameter models while strictly preserving baseline defaults for Qwen2.5 1.5B and cloud providers.

### V 0.2.7 — Qwen3 0.6B Browser AI Lightweight Model
- **Qwen3 0.6B Browser AI Lightweight Model**: Added `Qwen3-0.6B-q4f16_1-MLC` (~335 MB download, 4,096-token context window) and its FP32 fallback `Qwen3-0.6B-q4f32_1-MLC` as a selectable offline Browser AI model with WebGPU shader compilation and cache isolation.

### V 0.2.6 — SmallLM2 360M Browser AI Compact Model
- **SmallLM2 360M Browser AI Compact Model**: Added `SmolLM2-360M-Instruct-q4f16_1-MLC` (~210 MB download, ~380 MB VRAM) and its FP32 fallback `SmolLM2-360M-Instruct-q4f32_1-MLC` as a user-selectable model under the Browser AI provider.

### V 0.2.5 — SmallLM2 135M Browser AI Ultra-Lightweight Model
- **SmallLM2 135M Browser AI Ultra-Lightweight Model**: Added the ultra-lightweight `SmolLM2-135M-Instruct-q0f16-MLC` (~135M parameters, ~270 MB download, ~360 MB VRAM) and its FP32 fallback `SmolLM2-135M-Instruct-q0f32-MLC` under the Browser AI provider.

### V 0.2.4 — Legacy Fallback Hardening
- **Legacy Fallback Hardening**: Hardened provider fallback normalization and legacy session handling to ensure smooth failover across supported providers.

### V 0.2.2 — Gemini Reliability and Fallback Hardening
- **Gemini Reliability & Fallback Hardening**: Configured `gemini-3.8-flash` as primary default and `gemini-3.1-flash-lite` as automatic fallback candidate for rate limits and timeouts. Added 50ms SSE header priming (`: prime`) and 8s keepalive heartbeats.

### V 0.2.1 — Empty New Chat Hero and Responsive CSS Refinements
- **Empty New Chat Hero & Responsive CSS Refinement**: Refined empty-state layout with fluid clamp sizing across screen widths from 320px mobile to 2560px widescreen.

### V 0.2.0 — Mobile UI/UX and Viewport Refinement
- **Mobile UI/UX & Viewport Refinement**: Dynamic viewport height management (`--app-viewport-height`), virtual keyboard adaptivity, compact header bar, and full-screen document preview modal.

### V 0.1.0 — Desktop UI/UX, Accessibility and Multi-Provider Core
- **Desktop UI/UX, Accessibility & Performance**: Progressive desktop scaling, memoized message rendering, accessible keyboard navigation, and unified multi-provider streaming core.

### V 0.9.4 — Browser AI, Backend Offline PWA, Pre-Caching and Document Extraction
- Embedded `@mlc-ai/web-llm` running on-device models directly on visitor GPUs via WebGPU and dedicated worker.
- Workbox service worker precaching UI assets, WASM bundles, and offline document extractors.
- Client-side document parsing for `.docx`, `.pdf`, `.pptx`, `.csv`, `.tsv`, `.json`, and `.txt`.

### V 0.9.3 — Mobile PWA Live Dictation and Interim Transcript Deduplication
- Live speech recognition displaying words in composer during speech.
- Interim snapshot replacement eliminating duplicate phrase concatenation.
- Concurrent live recognition followed by server Whisper Large v3 Turbo refinement.

### V 0.9.2 — Table Copying, Mobile Swipe Navigation and Dictation Hardening
- Dual-payload clipboard formatting: HTML tables and structured plain-text records (`• Header: Value`).
- Mobile swipe-right gesture on screens `<= 1024px` to open chat history.
- Audio transcription pipeline with Groq Whisper Large v3 Turbo and Gemini fallback.

### V 0.9.1 — High-Accuracy Voice Dictation Pipeline
- Server-side Whisper transcription at `/api/transcribe`.
- Hybrid desktop dictation and Direct-Audio mode with 9 supported locales.
- Context-aware technical polishing for programming terms.

### V 0.9.0 — Four Chatbot Modes
- Purpose-built modes for General Assistant, Learning, Writing, and Coding with custom directives and CSS themes.

### V 0.8.0 — Multi-Model Response Alternatives
- Regenerate responses with alternative providers and navigate using `< X of Y >` pager.

### V 0.7.1 — Automatic Chat-Input Focus and Code Alignment
- Global typing capture focusing the composer without dropped keystrokes.
- Locked 22px line height eliminating line-number drift.

### V 0.7.0 — Live Response-Time Measurement
- Real-time duration timer updating every 100ms during streaming, saved as an immutable badge.

### V 0.6.0 — Controlled Large-Response Continuation
- Multi-part output segmentation with interactive composer continuation chip.

### V 0.5.0 — Serverless Upload Architecture
- In-memory staging via `multer.memoryStorage()` eliminating serverless read-only filesystem errors.

### V 0.4.0 — Image Attachments and OCR
- Server-side Tesseract OCR with magic number verification and dual-tab preview modal.

---

## Future Roadmap

- **Client-Side Vector Search / RAG**: Semantic vector chunk search for large documents using local embeddings.
- **Multilingual OCR Enhancements**: Dynamic language pack downloads for non-Latin script optical character recognition.
- **Streaming Voice Input**: Real-time server-side audio streaming via WebSockets for low-latency Whisper transcription.
- **Image Generation Integration**: Generative visual creation tools alongside existing conversational modes.
