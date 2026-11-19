# 🤖 Orvix | 🚀 v5.3.0

Orvix is a multi-model AI chatbot built for flexibility, privacy, and everyday productivity. It combines cloud AI models with private, on-device Browser AI powered by WebGPU and WebLLM, offline PWA support, local and cloud document and image understanding, real-time voice dictation, and shareable conversations for seamless collaboration.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Key Features](#2-key-features)
3. [Browser AI, WebLLM and On-Device WebGPU Inference](#3-browser-ai-webllm-and-on-device-webgpu-inference)
   - [Local Browser Execution & Privacy](#local-browser-execution--privacy)
   - [Integrated Browser AI Models & Quantization Tiers](#integrated-browser-ai-models--quantization-tiers)
   - [Dedicated Web Worker Architecture](#dedicated-web-worker-architecture)
   - [Browser AI Status Bar & Interactive Controls](#browser-ai-status-bar--interactive-controls)
4. [Offline Functionality and PWA Caching](#4-offline-functionality-and-pwa-caching)
   - [App Shell Precache vs. Model Weight Cache](#app-shell-precache-vs-model-weight-cache)
   - [Prerequisites for Reliable Offline Use](#prerequisites-for-reliable-offline-use)
   - [Model Weight Retention & Storage Lifecycle](#model-weight-retention--storage-lifecycle)
   - [Behavior of Cloud Providers When Offline](#behavior-of-cloud-providers-when-offline)
5. [Browser-Side Document Extraction (Offline and Local)](#5-browser-side-document-extraction-offline-and-local)
   - [Supported Offline Document Formats](#supported-offline-document-formats)
   - [Document Structure Preservation & Context Formatting](#document-structure-preservation--context-formatting)
   - [Scanned PDF, Encrypted Office & Image OCR Boundaries](#scanned-pdf-encrypted-office--image-ocr-boundaries)
   - [IndexedDB Attachment Caching](#indexeddb-attachment-caching)
6. [Step-by-Step Guide: Using Browser AI Offline](#6-step-by-step-guide-using-browser-ai-offline)
7. [Message Copying and Dual-Format Clipboard](#7-message-copying-and-dual-format-clipboard)
   - [Dual-Format Clipboard Generation (`text/html` and `text/plain`)](#dual-format-clipboard-generation-texthtml-and-textplain)
   - [Structured Plain-Text Record Layout for Messaging Apps](#structured-plain-text-record-layout-for-messaging-apps)
   - [Rich HTML Table Styling for Documents](#rich-html-table-styling-for-documents)
   - [Three-Tier Clipboard Writing Strategy](#three-tier-clipboard-writing-strategy)
8. [Mobile Responsiveness and Swipe Navigation](#8-mobile-responsiveness-and-swipe-navigation)
   - [Main Conversation Swipe-Right Gesture](#main-conversation-swipe-right-gesture)
   - [Excluded Zones & Interaction Safeguards](#excluded-zones--interaction-safeguards)
   - [Horizontal Intent Disambiguation](#horizontal-intent-disambiguation)
9. [Voice Dictation and Speech Architecture](#9-voice-dictation-and-speech-architecture)
   - [Bi-Directional WebSocket Voice Streaming (AudioWorklet + PCM)](#bi-directional-websocket-voice-streaming-audioworklet--pcm)
   - [Vercel Serverless & Deployment Architecture Considerations](#vercel-serverless--deployment-architecture-considerations)
   - [Hybrid Recognition & Whisper Refinement](#hybrid-recognition--whisper-refinement)
   - [Interim Transcript Handling & Deduplication](#interim-transcript-handling--deduplication)
   - [Smart Punctuation & Typography Formatting](#smart-punctuation--typography-formatting)
   - [Text-to-Speech (Read Aloud)](#text-to-speech-read-aloud)
   - [iOS 15 & Mobile Device Compatibility](#ios-15--mobile-device-compatibility)
10. [Chat Modes](#10-chat-modes)
    - [General Assistant Mode](#general-assistant-mode)
    - [Learning Mode](#learning-mode)
    - [Writing Mode](#writing-mode)
    - [Coding Mode](#coding-mode)
11. [AI Providers and Supported Models](#11-ai-providers-and-supported-models)
    - [Supported Providers & Models](#supported-providers--models)
    - [Provider Context Budgets](#provider-context-budgets)
    - [Streaming & Fallback System](#streaming--fallback-system)
    - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
12. [Attachment and Document Understanding](#12-attachment-and-document-understanding)
    - [Attachment Methods & Rules](#attachment-methods--rules)
    - [Supported Formats & Targeted Questioning](#supported-formats--targeted-questioning)
13. [Image Attachment and Optical Character Recognition (OCR)](#13-image-attachment-and-optical-character-recognition-ocr)
    - [Supported Image Formats & Verification](#supported-image-formats--verification)
    - [Server-Side OCR Engine](#server-side-ocr-engine)
    - [Honest No-Text Handling & Preview Modal](#honest-no-text-handling--preview-modal)
14. [Smart Compression Pipeline](#14-smart-compression-pipeline)
    - [Image Compression](#image-compression)
    - [PDF Compression](#pdf-compression)
    - [Office Document Compression](#office-document-compression)
    - [Transparent Storage Compression (`orvix-gzip-v1`)](#transparent-storage-compression-orvix-gzip-v1)
15. [Chat Management and Usability Enhancements](#15-chat-management-and-usability-enhancements)
    - [Multi-Model Alternative Responses](#multi-model-alternative-responses)
    - [Automatic Chat-Input Focus](#automatic-chat-input-focus)
    - [Live Response-Time Measurement](#live-response-time-measurement)
    - [Controlled Large-Response Continuation](#controlled-large-response-continuation)
    - [Edit & Resend with Branch Truncation](#edit--resend-with-branch-truncation)
    - [Conversation Pinning & Client-Side Export](#conversation-pinning--client-side-export)
16. [Shared Chat and Conversation Collaboration](#16-shared-chat-and-conversation-collaboration)
    - [Share Entire Conversations](#share-entire-conversations)
    - [Public Shared Conversation Viewer](#public-shared-conversation-viewer)
    - [Sign In and Continue](#sign-in-and-continue)
    - [Independent Conversation Import](#independent-conversation-import)
    - [Imported Chat Management](#imported-chat-management)
    - [Security and Data Isolation](#security-and-data-isolation)
    - [Persistence and Reliability](#persistence-and-reliability)
17. [Architecture and Technology Stack](#17-architecture-and-technology-stack)
    - [Verified Platform & Device Compatibility](#verified-platform--device-compatibility)
18. [Authentication and Persistence Architecture](#18-authentication-and-persistence-architecture)
19. [Project Structure](#19-project-structure)
20. [Environment Variables and Configuration](#20-environment-variables-and-configuration)
21. [Installation and Running Locally](#21-installation-and-running-locally)
22. [Build and Deployment Instructions](#22-build-and-deployment-instructions)
    - [Firestore Security Rules Deployment for Share Chat](#firestore-security-rules-deployment-for-share-chat)
23. [Troubleshooting Common Issues](#23-troubleshooting-common-issues)
    - [Troubleshooting Gemini Timeouts & Streaming](#troubleshooting-gemini-timeouts--streaming)
24. [Security Architecture](#24-security-architecture)
    - [Dependency Security Audit](#dependency-security-audit)
25. [Verification and Security Coverage](#25-verification-and-security-coverage)
26. [Current Limitations](#26-current-limitations)
27. [Version History and Release Changelog](#27-version-history-and-release-changelog)

---

## 1. Project Overview

**Orvix** is a privacy-focused, multi-model AI chat workspace built with React and Express that works seamlessly both online and offline. When connected, it routes requests securely through the backend to cloud providers including Google Gemini, Groq, OpenRouter, and Cloudflare Workers AI, while supporting voice dictation, OCR, cloud attachment storage, and shareable conversations for collaboration. When offline, Orvix uses PWA caching, local document extraction, and on-device WebGPU/WebLLM inference across four integrated models so conversations continue privately on your own device.

---

## 2. Key Features

- **Share Chat & Public Snapshots**: Share immutable conversation links via Copy Link, WhatsApp, or native OS sharing, allowing anyone to view read-only without an account and signed-in users to fork chats on their first message ([learn more](#16-shared-chat-and-conversation-collaboration)).
- **On-Device Browser AI (WebLLM)**: Run four integrated open-weight models (SmallLM2 135M, SmallLM2 360M, Qwen3 0.6B, and Qwen2.5 1.5B) directly on your GPU via WebGPU and a dedicated Web Worker with zero API keys or external data transmission.
- **Offline PWA Support**: Precaches the app shell, WASM bundles, and local document extractors via Workbox so Orvix launches and operates offline.
- **Local Document Extraction & Semantic RAG**: Extracts and grounds text locally and on the server from Word (`.docx`, `.doc`), PDF (`.pdf`), PowerPoint (`.pptx`, `.ppt`), Excel (`.xlsx`, `.xls`), CSV, TSV, JSON, XML, and Markdown with semantic chunking and retrieval.
- **Smart Compression Pipeline**: Optimizes PNG, JPEG, WebP, GIF (static and animated), PDF, DOCX, PPTX, and XLSX uploads client-side under strict quality and protection gates, and compresses TXT, MD, DOC, PPT, and XLS cloud payloads in `orvix-gzip-v1` envelopes.
- **Dual-Format Clipboard & Table Copying**: Copies responses as styled HTML tables for Google Docs, Word, and Slack alongside clean plain-text records (`• Header: Value`) that never distort in messaging apps like WhatsApp.
- **Mobile Swipe Navigation**: Swipe right across the conversation area on mobile and tablet screens (`<= 1024px`) to open chat history while protecting inputs, headers, code blocks, and iOS back gestures.
- **Voice Dictation & Read Aloud**: Streams live browser speech previews refined on completion by server-side Groq Whisper Large v3 Turbo (with Gemini fallback), paired with built-in Text-to-Speech playback.
- **Four Specialized Chat Modes**: Switch between **General Assistant**, **Learning**, **Writing**, and **Coding** modes, each tailored with dedicated directives and visual formatting.
- **Multi-Model Alternatives & History Preservation**: Compare or regenerate answers across AI providers using `< X of Y >` navigation while keeping prior valid responses intact across regenerations, retries, and prompt restores.
- **Smart Composer & Continuation Controls**: Type anywhere on the page to focus the composer automatically, and fetch subsequent parts of long responses via the `[ → Continue response ]` chip.
- **Multimodal Attachments & OCR**: Stage documents or images via file picker, paste (`Ctrl+V`), or drag-and-drop with server-side Tesseract OCR and explicit `NO_TEXT_DETECTED` reporting.
- **Zero-Key Browser AI & Demo Mode**: Run local Browser AI out of the box without credentials, or set `ORVIX_ENABLE_DEMO_MODE=true` for simulated cloud responses during UI testing.

---

## 3. Browser AI, WebLLM and On-Device WebGPU Inference

Orvix features an on-device local AI engine implemented in `src/services/webllmService.js` and executed inside a dedicated background worker (`src/workers/webllmWorker.js`). Powered by `@mlc-ai/web-llm` and the browser's native **WebGPU API**, Browser AI lets users run compact language models directly on their device GPU.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX ON-DEVICE BROWSER AI ARCHITECTURE              │
├────────────────────────────────────────────────────────────────────────┤
│ 1. VISITOR'S BROWSER (Main UI Thread)                                  │
│    • React 19 UI & Message Composer                                    │
│    • Browser AI Status Bar (progress %, memory state, model selector)  │
│    • Client-Side Extractor (PDF, Word, PowerPoint, Excel, Text, CSV)   │
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
- **Complete Data Confidentiality**: Prompts, conversation history, and attached document contents stay strictly on the user's physical device.
- **Zero Server Dependencies**: Inference executes on the local GPU and continues working even when the Orvix backend is unreachable.
- **Peer Provider Integration**: Browser AI appears alongside cloud providers in the model selector.

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
- **Partitioned Cache Storage**: Shards are downloaded into partitioned browser Cache Storage (`webllm/model`, `webllm/config`, `webllm/wasm`) so interrupted downloads can resume without re-fetching completed chunks.

### Dedicated Web Worker Architecture

- **Off-Thread Execution**: WebLLM computation runs inside `src/workers/webllmWorker.js` via `CreateWebWorkerMLCEngine`, keeping the UI responsive at 60 FPS.
- **Generation Serialization**: Requests are queued via `generationQueuePromise` to prevent WebGPU buffer contention.
- **Instant Interruption**: Clicking **Stop** (`Square` icon) calls `engine.interruptGenerate()` in the worker to halt generation immediately and keep partial output.

### Browser AI Status Bar & Interactive Controls

When Browser AI is selected, `src/components/chat/BrowserAIStatusBar.jsx` displays above the composer:
- **Compatibility Feedback**: Alerts if WebGPU is unsupported, hardware acceleration is disabled, or the context is insecure.
- **Download & VRAM Status**: Shows download percentage (`0–100%`), chunk progress, and GPU shader compilation state.
- **Interactive Controls & Recovery**:
  - **Model Selector**: Switch between SmallLM2 135M, SmallLM2 360M, Qwen3 0.6B, and Qwen2.5 1.5B.
  - **Fallback Indicators & One-Click Recovery**: Displays FP32 fallback status across all lifecycle states and offers **Try `<lighter model>`** or **Switch to Cloud AI** actions on OOM/error or unsupported WebGPU environments.
  - **Load Model / Cancel (`✕`) / Retry (`RotateCcw`) / Unload (`Trash2`)**: Initialize on demand, abort downloads cleanly, retry failures, or release GPU VRAM while keeping cached shards on disk.

---

## 4. Offline Functionality and PWA Caching

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
2. **Model Weight Cache**: Model weights (~210 MB to ~1.15 GB) are **never** bundled into the service worker precache manifest to prevent page-load stalls; WebLLM manages shards inside dedicated Cache Storage buckets on demand.

### Prerequisites for Reliable Offline Use

1. **Initial Online Visit**: Visit Orvix over HTTPS or localhost while online so the service worker installs and precaches the application shell.
2. **Model Download Completion**: Select **Browser AI (WebLLM)**, choose a model, and wait until the status displays `"Ready on device"`.

### Model Weight Retention & Storage Lifecycle

- **Closing Browser / PWA**: Cached model shards persist in Cache Storage across reloads and device reboots.
- **Storage Persistence**: Orvix requests `navigator.storage.persist()` where available to reduce OS storage eviction.
- **Eviction Triggers**: Clearing site data manually, using Incognito/Private windows, or low disk space can clear cached models.

### Behavior of Cloud Providers When Offline

Submitting a prompt to a cloud provider (Gemini, Groq, OpenRouter, Cloudflare) while offline immediately displays an actionable notice:
`"[Provider] requires an internet connection. Switch to Browser AI (WebLLM) to chat offline on this device."` with a one-click **"Switch to Browser AI"** button.

---

## 5. Browser-Side Document Extraction (Offline and Local)

When running offline, Orvix parses text, headings, tables, and presentation slides locally using `src/services/browserDocumentExtractor.js`.

### Supported Offline Document Formats

| Format | Extension | Extraction Mechanism | Extracted Metadata & Structure |
| :--- | :--- | :--- | :--- |
| **Plain Text** | `.txt`, `.text` | Native `File.text()` | Word and character count, summary preview |
| **Markdown** | `.md`, `.markdown` | Native text parser | Headings (H1–H6), section counts |
| **CSV / TSV** | `.csv`, `.tsv` | Native delimiter parser | Column headers, row count, formatted Markdown table |
| **JSON** | `.json` | Native `JSON.parse` | Root keys count, pretty-printed JSON code block |
| **XML** | `.xml` | Native `DOMParser` | Structural text nodes, syntax validation |
| **Word** | `.docx` | Lazy-loaded `mammoth` | Headings, lists, bold/italics, tabular data |
| **Word (Legacy)** | `.doc` | Lazy-loaded `cfb` + pure-JS MS-DOC parser | OLE2 compound document text & piece-table extraction |
| **PDF** | `.pdf` | Lazy-loaded `unpdf` | Page numbers, page boundaries (`--- Page N ---`), text layer |
| **PowerPoint** | `.pptx` | Lazy-loaded `jszip` | Slide titles, body text, slide numbers, speaker notes |
| **PowerPoint (Legacy)** | `.ppt` | Lazy-loaded `cfb` + pure-JS MS-PPT parser | Slide text atoms, headers, and speaker notes |
| **Excel** | `.xlsx`, `.xls` | Lazy-loaded `@e965/xlsx` + `jszip` / `cfb` | Worksheet names, cell formatting, formulas, Markdown tables |

### Document Structure Preservation & Context Formatting

- **Reusing Extractions**: Documents parsed during a session are cached in memory to avoid redundant parsing.
- **Context Allocation & Semantic RAG**: Extracted text is bounded and sanitized via `prepareDocumentContext`, and large documents are indexed into semantic chunks (`semanticChunkingService.js`, `semanticRetrievalService.js`) across PDF pages, PPT/PPTX slides and speaker notes, DOCX/DOC sections, and XLSX/XLS sheets.
- **Targeted Lookups**: Page markers (`--- Page N ---`), slide markers (`--- Slide N: Title ---`, `[Speaker Notes]: ...`), and worksheet Markdown tables support targeted queries (e.g., *"Summarize slide 3 notes"* or *"Compare Q2 totals in Sheet 2"*).

### Scanned PDF, Encrypted Office & Image OCR Boundaries

- **Scanned PDFs**: PDFs containing only rasterized images without an embedded text layer (`nonWhitespaceChars < 10`) are detected and flagged as requiring OCR.
- **Image OCR**: Image text recognition relies on the server-side Tesseract engine (or cached browser OCR language packs in preview workflows) and is otherwise unavailable offline.
- **Encrypted & Corrupted Office Files**: Both server-side (`documentExtractor.js`) and browser-side (`browserDocumentExtractor.js` via `officeDocumentExtractors.js`) parsers detect password-protected or corrupted files (`EncryptedPackage`, `EncryptionInfo`, BIFF `FILEPASS`) and return clear diagnostic errors without crashing.

### IndexedDB Attachment Caching

File attachments are cached locally in the browser's IndexedDB database (`orvix_attachments_db`), preserving previews, file cards, and downloads across offline reloads.

---

## 6. Step-by-Step Guide: Using Browser AI Offline

1. **Open the Site Online**: Visit Orvix in a WebGPU-compatible browser (Chrome 113+, Edge 113+, Safari 18+) so the PWA service worker precaches the app shell.
2. **Select Browser AI**: Choose **Browser AI (WebLLM)** from the model selector in the header.
3. **Choose Your Preferred Model**: Pick one of the four integrated models in the status bar:
   - **SmallLM2 135M**: Ultra-lightweight (~270 MB download, ~360 MB VRAM), fastest initialization.
   - **SmallLM2 360M**: Compact (~210 MB download, ~380 MB VRAM), efficient everyday queries.
   - **Qwen3 0.6B**: Lightweight (~335 MB download, ~1,403 MB VRAM), solid modern reasoning.
   - **Qwen2.5 1.5B**: Standard default (~960 MB download, ~1,630 MB VRAM), highest quality.
4. **Download and Initialize**: Click **Load Model** (or send a prompt) and wait until the status shows `"Qwen3 0.6B — Ready on device"` *(or your selected model)*.
5. **Send a Test Message**: Send a quick prompt (e.g., *"What is WebGPU?"*) to confirm local execution.
6. **Close & Disconnect**: Close the browser/PWA, turn off internet access, and reopen Orvix.
7. **Chat and Analyze Documents Offline**: The app shell loads from cache, the status bar confirms the cached model is ready, and prompts plus supported attachments (`.pdf`, `.docx`, `.doc`, `.pptx`, `.ppt`, `.xlsx`, `.xls`, `.txt`, `.md`, `.csv`, `.json`) run locally on your GPU.

---

## 7. Message Copying and Dual-Format Clipboard

Orvix includes a clipboard formatting pipeline (`src/utils/clipboardFormatter.js`) that writes two simultaneous payloads whenever an assistant message is copied:

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

Clicking **Copy** parses markdown tables, code blocks, lists, and headings, writing both a styled `text/html` fragment and an optimized `text/plain` string via `ClipboardItem` in one atomic operation.

### Structured Plain-Text Record Layout for Messaging Apps

Because variable-width fonts in WhatsApp and Telegram break ASCII markdown tables (`| Col 1 | Col 2 |`), Orvix converts tables in `text/plain` into structured records:

```text
• Feature: Operational Logic
  Traditional: Deterministic IF/THEN rules
  AI: Probabilistic patterns inferred from data

• Feature: Adaptability
  Traditional: Requires manual code updates
  AI: Continuously refines from context
```

### Rich HTML Table Styling for Documents

For rich-text targets (Google Docs, Microsoft Word, Slack, Outlook), Orvix writes an inline-styled `<table>`:
- **Headers (`<thead>`)**: `#f1f5f9` background, `#cbd5e1` border, semi-bold `#0f172a` text.
- **Data Rows (`<tbody>`)**: Alternating `#ffffff` / `#f8fafc` zebra striping with `#e2e8f0` dividers.
- **Column Alignments**: Preserves GFM column alignments (`left`, `center`, `right`).

### Three-Tier Clipboard Writing Strategy

1. **Tier 1 — `ClipboardItem`**: Writes both `text/html` and `text/plain` blobs simultaneously.
2. **Tier 2 — `navigator.clipboard.writeText`**: Falls back to plain text if HTML clipboard access is restricted.
3. **Tier 3 — `document.execCommand`**: Off-screen `<textarea>` fallback for restricted or legacy browser environments.

---

## 8. Mobile Responsiveness and Swipe Navigation

Orvix provides a touch gesture pipeline in `src/components/layout/Layout.jsx` so mobile and tablet users (`<= 1024px`) can open the sidebar naturally.

### Main Conversation Swipe-Right Gesture

- **Full-Viewport Activation**: Swipe right anywhere across the neutral conversation area on screens `<= 1024px` when the sidebar is closed.

### Excluded Zones & Interaction Safeguards

`isExcludedSwipeTarget()` ignores touches starting inside:
1. **iOS Native Back Margin (`< 16px`)**: Preserves native Safari edge swipe-back.
2. **Top Navigation Header**: Menu button, model selector, and new chat controls.
3. **Message Composer**: Text input, microphone button, and attachment tray.
4. **Interactive Controls & Code Blocks**: Buttons, links, tables, and horizontally scrollable `pre`/`code` blocks.
5. **Text Selection**: Suspends swipe tracking while text is selected.

### Horizontal Intent Disambiguation

- **Movement Threshold & Dominance Formula**: Tracks initial movement past `10px` displacement and confirms a swipe only when rightward motion clearly dominates vertical scrolling:
  $$\Delta X > 0 \quad \text{and} \quad |\Delta X| > |\Delta Y| \times 1.25$$
- **Immediate Scroll Release**: Vertical scrolling or leftward movement cancels swipe tracking immediately.

---

## 9. Voice Dictation and Speech Architecture

Orvix unifies real-time browser speech recognition with server-side Whisper refinement in `src/hooks/useVoiceDictation.js`.

### Bi-Directional WebSocket Voice Streaming (AudioWorklet + PCM)

1. **Browser-Side Capture (`AudioWorklet`)**: Captures microphone audio via `public/audioWorkletProcessor.js` (with inline Blob worker or `ScriptProcessorNode` fallback on legacy browsers), downsampling frames to 16-bit linear PCM (`Int16Array`) off the UI thread.
2. **Authenticated WebSocket (`/api/voice-stream`)**: Supplies a Firebase ID token via `Authorization: Bearer` or the `Sec-WebSocket-Protocol` `orvix-auth` subprotocol (unauthenticated upgrades and `?token=` query params return HTTP `401`).
3. **Streaming Messages**: Supports `start`, `pause`/`resume`, binary `audio` PCM chunks, live `interim` updates, `stop` (triggering WAV synthesis with a 44-byte RIFF header), and final `done` transcripts.
4. **Resource Safeguards**: Caps accumulated PCM buffers at 25 MB per session, enforces a 15-minute session limit, and runs 30-second heartbeat ping/pong watchdogs.

### Vercel Serverless & Deployment Architecture Considerations

- **Graceful HTTP Fallback**: Because Vercel Serverless Functions do not support persistent WebSockets (`websocketStreamingSupported: false`), `useVoiceDictation` automatically falls back to native Web Speech API previews plus HTTP multipart Whisper refinement (`/api/transcribe`).
- **Persistent WebSocket Hosting**: For live WebSocket voice streaming in production, host the Express server on a persistent container runtime (e.g., Google Cloud Run, Railway, Render, Fly.io, or AWS ECS/EC2).

### Hybrid Recognition & Whisper Refinement

1. **Live Preview**: Native `SpeechRecognition` displays words in the composer as you speak.
2. **Whisper Refinement**: Tapping **Done** submits recorded audio to `/api/transcribe`, where Groq Whisper Large v3 Turbo (with Gemini audio fallback) generates a technical-vocabulary-conditioned transcript.
3. **Reconciliation**: Replaces the rough live preview while preserving any manual text edits.

### Interim Transcript Handling & Deduplication

Orvix separates committed final segments from the active interim buffer so speech engines never stutter or duplicate phrases:
$$\text{Composer Text} = \text{Base Text} + \sum \text{Committed Segments} + \text{Active Interim Snapshot}$$

### Smart Punctuation & Typography Formatting

- **Spoken Commands**: Converts verbal punctuation (`"comma"` → `,`, `"period"` → `.`, `"question mark"` → `?`, `"new line"` → `\n`, `"new paragraph"` → `\n\n`) across 9 supported languages.
- **Technical Acronyms**: Normalizes programming terms (`JavaScript`, `TypeScript`, `Python`, `JSON`, `HTML`, `CSS`, `APIs`, `Math.random`).

### Text-to-Speech (Read Aloud)

Assistant messages include Play, Pause, and Stop controls via the Web Speech Synthesis API, stripping markdown syntax and splitting text into ~140-character clauses to avoid Chromium synthesis timeouts.

### iOS 15 & Mobile Device Compatibility

- **Safari on iPhone 7 (iOS 15.8.8)**: Long-form dictation with interim previews and Whisper refinement is verified in Safari on iOS 15.8.8.
- **Standalone PWA Microphone Limitation**: On iOS 15, WebKit may block microphone access inside standalone Home Screen PWAs even after permission is granted; use Safari for voice dictation on iOS 15 when this occurs.

---

## 10. Chat Modes

Orvix provides four specialized conversational modes configured in `src/config/chatModes.js`:

### General Assistant Mode
- **Purpose**: Everyday questions, brainstorming, and general tasks.
- **Directives**: Clear, balanced answers with structured headings and markdown tables.

### Learning Mode
- **Purpose**: Concept breakdowns, intuitive analogies, and study recall.
- **Educational Callout Blocks**: Renders 8 themed callouts: **Important**, **Warning**, **Note**, **Tip**, **Key Takeaway**, **Definition**, **Example**, and **Comparison**.

### Writing Mode
- **Purpose**: Drafting, prose polishing, tone shifts, and editorial formatting.
- **Styling**: Constrained `76ch` reading column, relaxed `1.78` line height, memo headers (`Subject:`, `To:`, `From:`), and quote styling.

### Coding Mode
- **Purpose**: Implementation, architecture, debugging, and code review.
- **CodeBlock Component**: VS Code-style header, locked `22px` line height (`--code-line-height: 22px;`) preventing gutter drift across 500+ lines, sticky line numbers, syntax highlighting for 20+ languages, and one-click code copy.

---

## 11. AI Providers and Supported Models

### Supported Providers & Models

| Provider | Model Identifier | Architecture | Failover / Backup Model |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-2.5-flash` | Cloud API via `@google/genai` SDK | `gemini-2.5-flash-lite` |
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

- **Immediate SSE Priming & Keepalives**: Sends `: prime\n\n` within 50ms and `: keepalive\n\n` every 8s to satisfy edge proxy timeouts.
- **Safe Failover Boundaries**: Errors before the first emitted chunk allow automatic failover (`canFallback: true`); mid-stream errors forbid failover (`canFallback: false`) to avoid duplicated text.
- **Client Abort Wiring**: Closing a tab or clicking **Stop** aborts upstream requests immediately via `AbortController`.

### Zero-Key Simulation Mode

Set `ORVIX_ENABLE_DEMO_MODE=true` to generate simulated local cloud responses for testing UI flows without API keys. With demo mode off, **Browser AI (WebLLM)** still runs real local models with zero API keys.

---

## 12. Attachment and Document Understanding

### Attachment Methods & Rules

- **Three Staging Methods**: File picker dialog, clipboard paste (`Ctrl+V`), or drag-and-drop onto the chat area.
- **Constraints**: 1 attachment per message; maximum 25 MB per file.
- **Authenticated Cloud Storage**: Uploads require a verified Firebase account (guest uploads return HTTP `401 UNAUTHENTICATED`) and persist in private per-user Supabase Storage (`{userId}/{conversationId}/{attachmentId}.{ext}`). Files `>= 4 MB` use signed direct-to-Supabase uploads to bypass serverless body limits, with IndexedDB caching for offline preview and a 2-hour TTL cleanup lifecycle for temporary attachments.
- **Daily Upload Quota & Midnight PKT Reset**: Authenticated accounts are limited to **5 attachment uploads per PKT calendar day** across standard (`/api/upload`) and direct (`/api/upload/direct/*`) uploads. Quotas reset at **midnight Pakistan Standard Time (`12:00 AM Asia/Karachi`, UTC+05:00 — `19:00:00.000Z`)** and sync live in the composer via `X-RateLimit-*` headers and `GET /api/upload/quota`.
- **Docked Preview**: Staged files display a format icon, filename, size, and remove button (`✕`).

### Supported Formats & Targeted Questioning

- **PDF (`.pdf`)**: Page-by-page text layer extraction via `unpdf`.
- **Word (`.docx`, `.doc`)**: Heading, list, and table extraction for `.docx` via `mammoth`, and OLE2 MS-DOC text extraction for `.doc` via `cfb` and `officeDocumentExtractors.js`.
- **PowerPoint (`.pptx`, `.ppt`)**: Slide text and speaker notes extraction for `.pptx` via `jszip` and legacy `.ppt` binary streams via `cfb`.
- **Excel (`.xlsx`, `.xls`)**: Multi-sheet workbook parsing via `@e965/xlsx` (`jszip` for `.xlsx`, `cfb` for `.xls`), emitting structured Markdown tables (bounded up to 50 sheets, 2,000 rows, and 64 columns per sheet).
- **Data & Text**: CSV, TSV, JSON, XML, Markdown, and TXT.
- **Unified Extraction & Semantic RAG**: Server (`documentExtractor.js`) and browser (`browserDocumentExtractor.js`) pipelines produce consistent output, feed Semantic RAG (`semanticChunkingService.js`, `semanticRetrievalService.js`), open in `DocumentPreviewModal`, and report encrypted or corrupted files cleanly.
- **Targeted Lookups**: Ask about specific pages, slides, or sheets (e.g., *"What does slide 3 say?"*, *"Summarize page 2"*, *"Analyze the Revenue sheet"*).

---

## 13. Image Attachment and Optical Character Recognition (OCR)

### Supported Image Formats & Verification

- Supports JPEG, PNG, WebP, GIF, BMP, and HEIC/HEIF with binary magic-number validation (`\xFF\xD8\xFF`, `\x89PNG`, etc.).

### Server-Side OCR Engine

- Powered by `tesseract.js` on the Express backend (25s timeout) using the bundled gzipped English pack (`eng.traineddata.gz`, also served via `/api/ocr/packs/:file`) plus on-demand multilingual packs (Spanish, French, German, Arabic RTL, Urdu RTL) cached in browser Cache Storage via `src/services/ocrLanguagePackService.js`.

### Honest No-Text Handling & Preview Modal

- Images without readable text return `NO_TEXT_DETECTED` to avoid model hallucinations.
- Clicking an image card opens a dual-tab modal with **Image View** (zoomable inspection) and **Extracted Text** (clean OCR output with copy).

---

## 14. Smart Compression Pipeline

Orvix applies client-side pre-upload optimization (`smartCompressionService.js`, `attachmentCompressionCoordinator.js`) alongside transparent storage compression (`storageEnvelopeService.js`):

- **Minimum 10% Savings Gate**: Candidates saving less than `10%` are discarded in favor of the untouched original `File`.
- **Deduplication & Fail-Safe Fallback**: `WeakMap`/`WeakSet` tracking avoids re-compressing files across retries, and timeouts (20s default), errors, or `AbortSignal` cancellations fall back safely to the original file.
- **Binary Signature Verification**: Formats are identified via magic bytes (`detectFormatFromSignature`).

### Image Compression

- **PNG**: Lossless `@jsquash/oxipng` WASM optimization (with Canvas fallback), preserving dimensions and transparency.
- **JPEG and WebP**: Attempts lossless metadata stripping first (`optimizeJpegMetadataLossless` / `optimizeWebpMetadataLossless`, preserving Orientation, ICC profiles, VP8/VP8L, ALPH, and ANIM chunks); canvas optimization uses pixel detail detection (`detectFineDetailAndText`) to protect screenshots, diagrams, and text.
- **GIF**: Lossless `@fe-daily/gifsicle-wasm-browser` (`-O2`) inside a dedicated Web Worker with timeout/`AbortSignal` support, verifying dimensions, transparency, frame order, loops, and per-frame delays for static and animated GIFs.

### PDF Compression

- Uses `pdf-lib` (`useObjectStreams: true`) for lossless structural compaction without rasterizing pages or altering text/fonts, skipping encrypted and digitally signed PDFs (`/Encrypt`, `/Sig`, `/ByteRange`, `SigFlags`, `Perms`) untouched.

### Office Document Compression

- **DOCX, PPTX, and XLSX**: Recompresses ZIP containers via `jszip` (`DEFLATE` level 9) and selectively optimizes eligible embedded media under `word/media/`, `ppt/media/`, and `xl/media/`.
- **Decoded-Pixel Quality Gates**: Lossy re-encoding is allowed only for opaque continuous-tone photos meeting `PSNR >= 41.0 dB`, `SSIM >= 0.985`, `edgeSharpnessRetentionPct >= 95.0%`, and zero alpha drift; lossless WebP (`VP8L`), transparency, text/diagrams, GIFs, and vector graphics (`SVG`, `EMF`, `WMF`) are never degraded.
- **Protection Preservation**: Keeps formulas, styles, notes, and VBA macros intact, and skips encrypted, signed, or write-protected documents.

### Transparent Storage Compression (`orvix-gzip-v1`)

- Losslessly wraps **TXT, MD, DOC, PPT, and XLS** uploads in a binary `orvix-gzip-v1` envelope (`ORVXENV\0`) via `fflate` streaming gzip when saving `>= 10%`, verifying CRC-32 and SHA-256 digests (with a pure-JS SHA-256 fallback for Safari 15 / non-HTTPS contexts) and bounding streaming decompression to 25 MB.
- `server/uploadSubsystem.ts` and `src/services/attachmentStorageService.js` decode envelopes transparently across downloads, previews, extraction, and IndexedDB rehydration.

---

## 15. Chat Management and Usability Enhancements

### Multi-Model Alternative Responses

- Click **Another Model** (`Sparkles`) or **Regenerate** to append a new response alternative and browse options with the `< X of Y >` pager without overwriting prior answers from Gemini, Grok, or other providers.
- Error recovery (**Retry**, **Switch Provider & Retry**, **Restore Prompt**) preserves valid alternatives, while Firestore snapshot subscriptions guard active streaming messages from stale updates.

### Automatic Chat-Input Focus

- Typing alphanumeric keys anywhere on the page focuses the composer without losing the first keystroke, while ignoring active text selections, modifier shortcuts (`Ctrl+C`, `Cmd+V`), open modals, and inputs.

### Live Response-Time Measurement

- Displays a live counter (`Thinking... 1.4s`) during streaming and saves an immutable `Response time: 2.1s` badge upon completion.

### Controlled Large-Response Continuation

- Automatically segments long responses and displays an interactive **`[ → Continue response ]`** composer chip to fetch subsequent parts.

### Edit & Resend with Branch Truncation

- Clicking **Edit** (`Pencil`) updates prior user prompts and truncates downstream messages cleanly, aborting any in-flight generation.

### Conversation Pinning & Client-Side Export

- Pin up to 5 chats to the top of the sidebar and export conversations client-side as **Markdown (`.md`)**, **Plain Text (`.txt`)**, or **JSON (`.json`)**.

---

## 16. Shared Chat and Conversation Collaboration

Orvix Share Chat lets authenticated users publish immutable conversation snapshots for read-only public viewing and interaction-gated private forking.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX SHARE CHAT LIFECYCLE & FORKING                 │
├────────────────────────────────────────────────────────────────────────┤
│ 1. PRIVATE CONVERSATION (`users/{uid}/chats/{chatId}`)                 │
│    • User clicks "Share" in header or sidebar context menu             │
│    • Client sanitizes message payloads, removes auth & private metadata│
│    • Creates immutable snapshot in `sharedChats/{shareId}` (<= 900 KB) │
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
- Click **Share** in the top bar or sidebar menu to publish a frozen snapshot and distribute via **Copy Link**, **WhatsApp**, or native OS sharing (`navigator.share`).

### Public Shared Conversation Viewer
- Anyone with `/share/{shareId}` can read, copy messages/code, and listen via Read Aloud without signing in; editing is disabled.

### Sign In and Continue
- Signed-in visitors enter an **Authenticated Temporary Preview** with the composer unlocked and zero account history mutations until they submit a message.

### Independent Conversation Import
- A private forked chat is created in the recipient's account **only** after their first prompt receives a completed AI response (`status: 'completed'`); aborted or failed first turns leave no ghost chats, and edits/deletions to the fork never affect the original snapshot.

### Imported Chat Management
- Imported chats show an **Imported** provenance badge linked to the source snapshot and support renaming, pinning, searching, deleting, exporting, and resharing under a new snapshot ID.

### Security and Data Isolation
- Snapshots reside in `sharedChats/{shareId}` with immutable Firestore rules (`allow update: if false;`, `allow delete: if false;`, `allow list: if false;`), strip private user fields, enforce server-side ownership, expiration (`410 SHARE_EXPIRED`), and revocation (`410 SHARE_REVOKED`) via `/api/share/*`, and cap payloads at 900 KB UTF-8, 500 messages, and 120-character titles.

### Persistence and Reliability
- Reloading `/share/{shareId}` preserves the temporary preview cleanly; concurrent imports are guarded by a mutex lock, synchronized across tabs via `BroadcastChannel`, and buffered offline once imported.

---

## 17. Architecture and Technology Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        ORVIX ARCHITECTURE                              │
├───────────────────────────────────┬────────────────────────────────────┤
│ CLIENT (React 19 SPA)             │ SERVER (Express + Vite Middleware) │
│ • React 19, Tailwind CSS v4       │ • Express in TypeScript (server.ts)│
│ • WebLLM & WASM Workers (WebGPU)  │ • @google/genai TypeScript SDK     │
│ • Smart Compression & orvix-gzip  │ • Groq, OpenRouter & Cloudflare SSE│
│ • Office/PDF/RAG Extractors       │ • In-Memory Multer & Tesseract OCR │
│ • Share Chat & Forking Service    │ • Document Parsers (unpdf, mammoth,│
│ • Dual-Format Clipboard Formatter │   jszip, cfb, @e965/xlsx, fflate)  │
│ • Web Speech API & AudioWorklet   │ • Supabase Storage & Signed URLs   │
│ • IndexedDB (Attachment Caching)  │ • Host 0.0.0.0, Port 3000          │
└───────────────────────────────────┴────────────────────────────────────┘
```

- **Frontend**: React 19, Vite 8 (`target: ['es2020', 'safari15']`), Tailwind CSS v4, Lucide React, `react-markdown`, `remark-gfm`.
- **Local AI & Web Workers**: `@mlc-ai/web-llm` in `src/workers/webllmWorker.js` via WebGPU and WASM shaders, plus a dedicated GIF compression worker (`@fe-daily/gifsicle-wasm-browser`).
- **Backend**: Express 4 running in TypeScript via `tsx` (`server.ts`) with Vite middlewares on `0.0.0.0:3000`.
- **Cloud AI**: `@google/genai` TypeScript SDK (Gemini) and REST SSE streaming for Groq, OpenRouter, and Cloudflare Workers AI.
- **Compression & Extraction**: `@jsquash/oxipng`, `@fe-daily/gifsicle-wasm-browser`, `pdf-lib`, `jszip`, `fflate`, `unpdf`, `mammoth`, `cfb`, `@e965/xlsx`, and `tesseract.js`.
- **Browser & iOS 15 Compatibility**: Vite targets `['es2020', 'safari15']` with `safariLookbehindPlugin`, pure-JS SHA-256 and Windows-1252/UTF-16LE decoding fallbacks, and runtime capability detection.
- **Persistence & Sharing**: IndexedDB (`orvix_attachments_db`), Firebase Auth, Cloud Firestore (`users/{uid}/chats` and `sharedChats/{shareId}`), Supabase Storage, Redis/in-memory rate limiting, and `localStorage` for Guest Mode.

### Verified Platform & Device Compatibility

- **Windows 11** — Chrome, Microsoft Edge, Brave, PWA
- **Windows 7** — Chrome
- **Android** — Chrome, PWA
- **iPhone 7** — iOS 15.8.8 Safari, iOS 15.8.8 PWA
- **Modern iPhones** — Safari

---

## 18. Authentication and Persistence Architecture

1. **Client-Side IndexedDB (`orvix_attachments_db`)**: Caches uploaded attachment blobs for offline previews across reloads.
2. **In-Memory Server Staging**: `multer.memoryStorage()` processes uploads in memory to avoid read-only filesystem (`EROFS`) failures in serverless runtimes.
3. **Cloud Firestore**: Syncs authenticated user conversations and preferences under `users/{uid}/chats/{chatId}/messages/{messageId}`.
4. **Guest Mode**: Stores unauthenticated sessions locally in `localStorage`.
5. **Immutable Shared Snapshots (`sharedChats/{shareId}`)**: Isolates public snapshots from private user trees and materializes forks under `users/{uid}/chats/{newChatId}` only after the first completed turn.
6. **Private Supabase Attachment Storage & Quota State**: Stores authenticated files privately under `{userId}/{conversationId}/{attachmentId}.{ext}`, while server-only Firestore collections (`uploadQuotas` and `uploadTickets`) enforce atomic 5-upload/day PKT transactions and direct-upload verification.

---

## 19. Project Structure

```text
├── .github/workflows/ci.yml         # CI workflow (build-and-test, security-audit, e2e)
├── api/                             # Vercel serverless API entry points (chat, config, health, share, transcribe, upload)
├── e2e/                             # Playwright E2E specs (auth, chat, settings, sharing, responsive-a11y)
├── public/                          # Static assets, icons, manifest.webmanifest, audioWorkletProcessor.js
├── server/                          # Modular Express backend subsystems:
│   ├── chatSubsystem.ts             # Multi-provider chat routing, failover, and SSE streaming
│   ├── geminiStreamHandler.ts       # Google Gen AI SDK streaming client and timeout stages
│   ├── uploadSubsystem.ts           # Multipart/direct uploads, signed URLs, OCR packs, and extraction
│   ├── transcriptionSubsystem.ts    # Groq Whisper & Gemini audio transcription
│   ├── shareSubsystem.ts            # Server-validated Share Chat create, fetch, and revoke endpoints
│   ├── voiceWebSocketSubsystem.ts   # Authenticated PCM WebSocket voice streaming (/api/voice-stream)
│   ├── rateLimiter.ts               # Redis Lua & in-memory rate limiting policies
│   ├── redisClient.ts               # Managed Redis client with TLS & mock/fallback controls
│   ├── trustedProxy.ts              # Explicit reverse-proxy hop/CIDR & client IP resolution
│   ├── supabaseClient.ts            # Supabase Storage client initialization
│   ├── supabaseStorageService.ts    # Per-user private attachment storage operations
│   ├── supabaseAttachmentCleanupService.ts # Scheduled expired attachment cleanup
│   ├── uploadQuotaService.ts        # Atomic daily PKT upload quota enforcement
│   ├── directUploadTicketService.ts # Durable direct-to-Supabase upload tickets
│   ├── firebaseAuthHelper.ts        # Firebase ID token verification
│   ├── serverConfig.ts              # Environment validation, CORS allowlist, timeouts
│   ├── sentryService.ts             # Backend Sentry integration
│   ├── diagnosticLogger.ts          # Sanitized structured diagnostics
│   └── serverTypes.ts               # Shared backend TypeScript types
├── src/
│   ├── components/
│   │   ├── auth/                    # AuthScreen & Guest mode components
│   │   ├── chat/                    # ChatArea, BrowserAIStatusBar, ChatMessage, ModelSelector, CodeBlock, etc.
│   │   ├── layout/                  # Layout, Header, Sidebar, SidebarChatItem
│   │   ├── settings/                # SettingsModal
│   │   └── ui/                      # Button, OrvixLogo
│   ├── config/                      # appConfig, chatModes, aiGuidance, firebaseConfig, sampleData, webllmModels
│   ├── context/                     # AuthContext, SettingsContext, SpeechContext
│   ├── hooks/                       # useVoiceDictation, usePWAInstall
│   ├── pages/                       # ChatPage
│   ├── services/                    # aiRouter, webllmService, browserAiProfiles, attachmentStorageService,
│   │                                # smartCompressionService, storageEnvelopeService,
│   │                                # attachmentCompressionCoordinator, officeDocumentExtractors,
│   │                                # documentExtractor, browserDocumentExtractor, imageOcrService,
│   │                                # ocrLanguagePackService, semanticChunkingService, semanticEmbeddingService,
│   │                                # semanticRetrievalService, semanticVectorStorage, shareChatService,
│   │                                # voiceStreamClient, etc.
│   ├── styles/                      # Tailwind CSS v4 global stylesheet
│   ├── utils/                       # clipboardFormatter, exportConversation, speechTextCleaner, etc.
│   └── workers/                     # webllmWorker.js, pdfExtractorWorker.js
├── tests/                           # Node unit & integration test suites
├── eng.traineddata.gz               # Gzipped offline English Tesseract OCR pack
├── firestore.rules                  # Firestore security rules for private chats and sharedChats
├── playwright.config.ts             # Playwright E2E configuration (Bun-compatible webServer)
├── server.ts                        # Express development & production server entry point
├── tsconfig.json                    # TypeScript compiler configuration
├── tsconfig.checkjs.json            # Full src/ JS/JSX static checking configuration
├── vercel.json                      # Vercel serverless functions, rewrites, and headers
├── vite.config.ts                   # Vite configuration & Workbox PWA plugin
├── package.json                     # Dependencies and scripts
└── README.md                        # Project documentation
```

---

## 20. Environment Variables and Configuration

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

# Sentry Error Monitoring & APM (Optional)
SENTRY_DSN=your_backend_sentry_dsn_here
VITE_SENTRY_DSN=your_frontend_sentry_dsn_here
SENTRY_ENVIRONMENT=production
VITE_SENTRY_ENVIRONMENT=production

# Redis Distributed Rate Limiting (Optional - uses in-memory fallback when omitted)
REDIS_URL=redis://localhost:6379
REDIS_CONNECT_TIMEOUT_MS=3000
REDIS_COMMAND_TIMEOUT_MS=1500
RATE_LIMIT_ENABLED=true
RATE_LIMIT_KEY_PREFIX=orvix:rl
ORVIX_RATE_LIMIT_KEY_SALT=
RATE_LIMIT_CHAT_MAX=30
RATE_LIMIT_CHAT_WINDOW_MS=60000
RATE_LIMIT_TRANSCRIBE_MAX=30
RATE_LIMIT_TRANSCRIBE_WINDOW_MS=60000
RATE_LIMIT_UPLOAD_MAX=30
RATE_LIMIT_UPLOAD_WINDOW_MS=60000
RATE_LIMIT_UPLOAD_READ_MAX=120
RATE_LIMIT_UPLOAD_READ_WINDOW_MS=60000
RATE_LIMIT_SHARE_MAX=10
RATE_LIMIT_SHARE_WINDOW_MS=60000
RATE_LIMIT_CONFIG_MAX=120
RATE_LIMIT_CONFIG_WINDOW_MS=60000
RATE_LIMIT_VOICE_WS_MAX=20
RATE_LIMIT_VOICE_WS_WINDOW_MS=60000
```

*Note*: See `.env.example` for the complete list of operational variables including CORS (`ALLOWED_ORIGINS`, `CORS_ALLOWED_ORIGINS`, `APP_URL`, `VITE_PUBLIC_APP_URL`), trusted proxy handling (`TRUST_PROXY`), demo mode (`ORVIX_ENABLE_DEMO_MODE`), Firebase Admin, Supabase storage & cleanup intervals, signed URL/guest secrets, distributed rate-limit failure modes (`RATE_LIMIT_REQUIRE_DISTRIBUTED`, `RATE_LIMIT_FAILURE_MODE`), and upstream Gemini timeouts. API keys stay strictly server-side; Browser AI (WebLLM) works with zero keys, Sentry disables gracefully without a DSN, and Redis (`REDIS_URL`) falls back to per-process in-memory rate limiting when omitted unless fail-closed mode is enabled.

---

## 21. Installation and Running Locally

### Prerequisites
- **Node.js**: Version 18.0.0 or higher (`engines.node: ">=18.0.0"`, Node.js 22 LTS recommended).
- **Bun**: Version 1.0.0 or higher (package manager and lockfile `bun.lock`).

### 1. Install Dependencies
```bash
bun install
```

### 2. Start the Development Server
```bash
bun run dev
```
The server starts on `http://localhost:3000` (`0.0.0.0:3000`).

### 3. Verify Types & Linting
```bash
bun run lint
bun run lint:js
```

### 4. Run Unit, Integration & Browser E2E Tests
```bash
# Node unit & integration suite
bun run test

# Install Playwright Chromium browser binaries (first-time setup)
bunx playwright install chromium

# Run full Playwright E2E suite (desktop-chromium + mobile-chromium)
bun run test:e2e

# Run a specific browser project
bun run test:e2e:desktop
bun run test:e2e:mobile
```
Playwright starts an isolated server on port `3100` (`PLAYWRIGHT_PORT=3100`) and executes deterministic specs under `e2e/` (`auth`, `chat`, `settings`, `sharing`, `responsive-a11y`) across `desktop-chromium` (`1280x800`) and `mobile-chromium` (`Pixel 7`, `390x844`).

---

## 22. Build and Deployment Instructions

### Full-Stack Production Build
```bash
bun run build
bun run start
```
`bun run start` runs `tsx server.ts`, supporting Node.js `>=18.0.0` (including versions prior to Node.js 22.6). In production (`NODE_ENV=production`), Express serves static client assets from `dist/` alongside SPA routing and API routes.

### Vercel Serverless Deployment
Configured via `vercel.json` with handlers in `api/`:
- `api/chat.ts`: Streaming AI proxy (bundles `eng.traineddata*` and Tesseract assets for OCR).
- `api/config.ts`: Public runtime capability and provider availability (`/api/config`).
- `api/health.ts`: Health and persistence readiness (`/api/health`).
- `api/share.ts`: Server-validated Share Chat create, lookup, expiration, and revocation (`/api/share/:shareId`).
- `api/transcribe.ts`: Serverless audio transcription (`/api/transcribe`).
- `api/upload.ts`: In-memory upload, direct-upload tickets, quota, signed downloads, OCR packs, and extraction (`/api/upload/*`, `/api/ocr/packs/:file`).

### Firestore Security Rules Deployment for Share Chat
> **Important Production Deployment Note for Share Chat**: Production Share Chat requires deploying `firestore.rules` to enforce `sharedChats/{shareId}` immutability, block collection listing, and isolate private user data:
> ```bash
> firebase deploy --only firestore:rules
> ```

---

## 23. Troubleshooting Common Issues

| Issue | Likely Cause | Resolution |
| :--- | :--- | :--- |
| **WebGPU not supported** | Browser lacks WebGPU or graphics acceleration is disabled | Use Chrome 113+, Edge 113+, or Safari 18+ over HTTPS or localhost; enable hardware acceleration in browser settings. |
| **Model download fails** | Network interruption during shard fetch | Click **Retry** (`RotateCcw`) in the status bar; completed shards in Cache Storage are preserved. |
| **Offline mode shows model not cached** | Cache Storage was cleared or Incognito window used | Reconnect to the internet, open Orvix, and download the model until status shows `"Ready on device"`. |
| **Cloud provider fails offline** | Cloud models require internet connectivity | Click **"Switch to Browser AI"** in the offline notice to run models locally on-device. |
| **Pasted table distorted in WhatsApp** | Messaging app uses proportional fonts | Use Orvix's **Copy** button; it formats tables as clean plain-text records (`• Header: Value`). |
| **Swipe gesture does not open drawer** | Touching inside composer, header, or code block | Initiate the swipe from the neutral conversation area. |
| **Port 3000 in use (`EADDRINUSE`)** | Another process is bound to port 3000 | Stop the conflicting process or run `PORT=3001 bun run dev`. |
| **`EROFS: read-only file system`** | Serverless disk write restriction | Orvix stages uploads in memory via `multer.memoryStorage()`, avoiding local disk writes. |
| **Gemini timeout (504 DEADLINE_EXCEEDED)** | Upstream model demand spike | Orvix automatically fails over to `gemini-2.5-flash-lite`. If all cloud attempts fail, switch to Groq, OpenRouter, or Browser AI. |

### Troubleshooting Gemini Timeouts & Streaming

1. **Vercel Runtime Logs**: Filter `/api/chat` logs or HTTP `504`/`503` responses; `logAIDiagnostic` and `sanitizeErrorLog` keep keys and user payloads redacted.
2. **DevTools EventStream Inspection**: Open **DevTools (`F12`) > Network > Fetch/XHR > `/api/chat` > EventStream** and verify `: prime` arrives within 50ms followed by `: keepalive` heartbeats and `data:` frames.

---

## 24. Security Architecture

1. **Zero Credential Exposure**: Cloud API keys remain strictly server-side; client bundles never embed server secrets.
2. **Binary Magic Number Validation**: Uploaded files undergo header verification to block disguised executables.
3. **Text Sanitization**: Extracted document and OCR text strips non-printable control characters before prompt insertion.
4. **Memory & Microphone Hygiene**: Object URLs revoke on unmount, and microphone tracks stop immediately when hidden or closed.
5. **Share Chat Isolation & Immutability**: Snapshots strip private user metadata, block client updates/deletes/collection listing, and cap payloads at 900 KB UTF-8, 500 messages, and 120-character titles.
6. **Envelope Integrity & Signed Download URLs**: `orvix-gzip-v1` payloads validate CRC-32, SHA-256, extension/MIME parity, and 25 MB decompression bounds; `/api/upload/:id/file` URLs require valid HMAC-SHA256 signatures (`ORVIX_SIGNED_URL_SECRET`) and Firebase user ownership checks.

### Dependency Security Audit

Dependency vulnerabilities are checked with Bun (`bun run audit` / `bun audit --json`) in the `security-audit` CI job (`.github/workflows/ci.yml`) and currently report **0 open vulnerabilities** across `bun.lock`.

---

## 25. Verification and Security Coverage

Orvix includes automated test suites across compression, extraction, security, and offline resilience:

- **Smart Compression Coverage**: Verifies magic-byte detection, `>= 10%` savings gates, quality thresholds for text/diagrams, signed/encrypted PDF skipping, OpenXML protection gates, and fail-safe original-file fallbacks.
- **Upload Integration & Envelope Integrity**: Validates end-to-end compression in `ChatPage`/`ChatArea`, `/api/upload`, direct signed-to-Supabase uploads, deduplication, abort safety, CRC-32/SHA-256 verification, and decompression limits.
- **Document Extraction & Semantic RAG**: Verifies `.docx`, `.doc`, `.pptx`, `.ppt`, `.xlsx`, and `.xls` extraction across server and browser extractors, encrypted/corrupted file errors, and semantic chunking/retrieval.
- **Auth, Quotas & Offline Resilience**: Verifies Firebase ID token checks, per-user path isolation, atomic PKT upload quota accounting, signed download URLs, and offline fallbacks.

---

## 26. Current Limitations

1. **Messaging App Plain Text**: Apps like WhatsApp cannot render HTML tables; Orvix converts tables in `text/plain` into structured records (`• Header: Value`).
2. **Gesture Variations**: Swipe sensitivity can vary by touch hardware or OS gesture overlays.
3. **OCR vs. Multimodal Vision**: Orvix extracts printed text via OCR rather than performing spatial visual reasoning on images.
4. **Binary Storage TTL**: Raw binary attachments cache locally in IndexedDB, while temporary server/cloud files expire after a 2-hour TTL.
5. **Initial Online Requirement**: Browser AI requires one online visit to precache the PWA app shell and download model weights.
6. **Online Snapshot Generation**: Creating a shared snapshot requires internet connectivity to write to Cloud Firestore.
7. **Shared Snapshot Boundaries**: Snapshots are capped at 900 KB UTF-8 and 500 messages to fit single-document Firestore limits.
8. **iOS 15 Standalone PWA Microphone Limitation**: WebKit on iOS 15 may block microphone access in standalone Home Screen PWAs; use Safari on iOS 15 for voice dictation.

---

## 27. Version History and Release Changelog

### v5.3.0 — Smart Compression Pipeline and Expanded Office Document Extraction
- **Smart Compression Pipeline**: Added client-side pre-upload optimization (`smartCompressionService.js`, `attachmentCompressionCoordinator.js`) for PNG (`@jsquash/oxipng`), JPEG/WebP metadata stripping and quality-gated optimization, Web Worker GIF optimization (`@fe-daily/gifsicle-wasm-browser`), structural PDF compaction (`pdf-lib`, skipping signed/encrypted PDFs), and DOCX/PPTX/XLSX optimization (`jszip` with PSNR/SSIM/sharpness gates).
- **Transparent Storage Compression (`orvix-gzip-v1`)**: Added `storageEnvelopeService.js` (`fflate` streaming gzip) for TXT, MD, DOC, PPT, and XLS uploads with a `>= 10%` savings gate, CRC-32/SHA-256 checks, 25 MB decompression bounds, and transparent decoding across downloads, previews, and extraction.
- **Expanded Office Extraction**: Added `.doc`, `.ppt`, `.xls`, and `.xlsx` parsing across server and browser extractors via `officeDocumentExtractors.js`, `cfb`, and `@e965/xlsx`, with Semantic RAG support, `DocumentPreviewModal` rendering, and encrypted/corrupted file handling.

### v5.2.0 — Non-Destructive Response Regeneration and History Preservation
- **Non-Destructive Regeneration & Recovery**: Normal regeneration, retries, and switch-provider actions append new alternatives rather than overwriting existing valid responses from Gemini, Grok, or other providers, preserving `< X of Y >` navigation and prompt-restore history while protecting active streams from stale Firestore snapshots.

### v5.1.0 — Daily Attachment Upload Quota and Midnight PKT Reset
- **5 Uploads per PKT Calendar Day**: Enforced a 5-upload/day limit per authenticated account across `/api/upload` and `/api/upload/direct/*`, resetting at midnight Pakistan Standard Time (`Asia/Karachi`, `T19:00:00.000Z`) via atomic Firestore `uploadQuotas` transactions and synced live in the composer via `X-RateLimit-*` headers and `GET /api/upload/quota`.

### v5.0.0 — Supabase Private Cloud Storage and Attachment Lifecycle
- **Private Cloud Attachments & Direct Uploads**: Integrated per-user Supabase Storage (`{userId}/{conversationId}/{attachmentId}.{ext}`), signed direct-upload URLs for files `>= 4 MB` backed by Firestore `uploadTickets`, magic-number verification, and automated 2-hour TTL plus conversation/branch deletion cleanup.

### v4.0.0 — Security, Performance and Architecture Improvements
- **Audit Remediation (ORVIX-001 through ORVIX-009)**: Enforced server-only credential isolation, serverless in-memory Multer staging, strict CORS origin allowlisting, self-healing IndexedDB LRU quota recovery, modular `server/` subsystems, second-boundary `LiveResponseTimer` optimization, cleaned `package.json` `clean` script, WebGPU SwiftShader FP32 fallback, and centralized Gemini model config with automated failover (separate from ongoing dependency audits tracked under [Dependency Security Audit](#dependency-security-audit)).

### v3.3.0 — iOS 15 Compatibility and Production Reliability Release
- **iPhone 7 / iOS 15.8.8 Reliability**: Eliminated unsupported regex lookbehind assertions across speech/dictation utilities and `remark-gfm` (`mdast-util-gfm-autolink-literal@2.0.0` + `safariLookbehindPlugin`), set `target: ['es2020', 'safari15']`, isolated `vendor-react` chunks, and verified Safari and Home Screen PWA launches on iOS 15.8.8.

### v3.2.0 — Orvix Shared Chat Public Previews and Independent Fork Imports
- **8-Stage Share Chat & Forking**: Added immutable `/share/{shareId}` snapshots (`sharedChats`), public read-only viewing with TTS/copy, authenticated temporary previews, interaction-gated independent forks upon first completed turn, `BroadcastChannel` multi-tab sync, and 900 KB / 500-message sanitization bounds.

### v3.1.0 — AI Model Selection Guidance and Provider Ordering
- **Guidance UX & Selector Ordering**: Added static `aria-describedby` selection guidance in `ModelSelector` and `BrowserAIStatusBar`, and ordered cloud providers (Gemini, Groq, OpenRouter, Cloudflare) and Browser AI models (SmallLM2 135M to Qwen2.5 1.5B) from lightest to most capable.

### v3.0.0 — Refined Responses and Profiling for SmallLM2 and Qwen3
- **Refined Responses & Profiling**: Tuned response profiles, positive instruction formatting, calibrated temperatures, repetition penalties, stop tokens, and streaming sanitizers to eliminate token loops, thinking-block leakage, and unprompted refusals in SmallLM2 135M, SmallLM2 360M, and Qwen3 0.6B while preserving defaults for Qwen2.5 1.5B and cloud providers.

### v2.7.0 — Qwen3 0.6B Browser AI Lightweight Model
- **Qwen3 0.6B**: Added `Qwen3-0.6B-q4f16_1-MLC` (~335 MB download, 4,096-token context window) and its FP32 fallback `Qwen3-0.6B-q4f32_1-MLC` as a selectable offline Browser AI model with WebGPU shader compilation and cache isolation.

### v2.6.0 — SmallLM2 360M Browser AI Compact Model
- **SmallLM2 360M**: Added `SmolLM2-360M-Instruct-q4f16_1-MLC` (~210 MB download, ~380 MB VRAM) and its FP32 fallback `SmolLM2-360M-Instruct-q4f32_1-MLC` under the Browser AI provider.

### v2.5.0 — SmallLM2 135M Browser AI Ultra-Lightweight Model
- **SmallLM2 135M**: Added `SmolLM2-135M-Instruct-q0f16-MLC` (~135M parameters, ~270 MB download, ~360 MB VRAM) and its FP32 fallback `SmolLM2-135M-Instruct-q0f32-MLC` under the Browser AI provider.

### v2.4.0 — Legacy Fallback Hardening
- **Legacy Fallback Hardening**: Hardened provider fallback normalization and legacy session handling to ensure smooth failover across supported providers.

### v2.2.0 — Gemini Reliability and Fallback Handling
- **Gemini Reliability & Fallback**: Configured `gemini-2.5-flash` as primary default and `gemini-2.5-flash-lite` as automatic fallback for rate limits and timeouts, plus 50ms SSE priming (`: prime`) and 8s keepalive heartbeats.

### v2.1.0 — Empty New Chat Hero and Responsive CSS Refinement
- **Empty New Chat Hero**: Refined the empty-state layout with fluid clamp sizing across screen widths from 320px mobile to 2560px widescreen.

### v2.0.0 — Mobile UI/UX and Viewport Refinement
- **Mobile UI/UX & Viewport**: Added dynamic viewport height management (`--app-viewport-height`), virtual keyboard adaptivity, a compact header bar, and a full-screen document preview modal.

### v1.0.0 — Desktop UI/UX Accessibility and Multi-Provider Core
- **Desktop UI/UX & Core**: Introduced progressive desktop scaling, memoized message rendering, accessible keyboard navigation, and a unified multi-provider streaming core.

### v0.9.4 — Browser AI Backend, Offline PWA Pre-Caching and Document Extraction
- Embedded `@mlc-ai/web-llm` running on-device models on visitor GPUs via WebGPU and a dedicated worker.
- Added Workbox service worker precaching for UI assets, WASM bundles, and offline document extractors.
- Added client-side parsing for `.docx`, `.pdf`, `.pptx`, `.csv`, `.tsv`, `.json`, and `.txt`.

### v0.9.3 — Mobile PWA Live Dictation Interim Transcript Deduplication
- Added live speech recognition rendering in the composer during speech.
- Replaced naive concatenation with interim snapshot replacement to eliminate duplicate phrase stuttering.
- Added server-side Whisper Large v3 Turbo refinement after live recognition completes.

### v0.9.2 — Table Copying, Mobile Swipe Navigation and Dictation Hardening
- Added dual-format clipboard output (styled HTML tables and `• Header: Value` plain-text records).
- Added mobile swipe-right sidebar navigation on viewports `<= 1024px`.
- Hardened audio transcription with Groq Whisper Large v3 Turbo and Gemini fallback.

### v0.9.1 — High-Accuracy Voice Dictation Pipeline
- Added server-side Whisper transcription at `/api/transcribe`.
- Implemented hybrid desktop dictation and Direct-Audio mode across 9 supported locales with technical term polishing.

### v0.9.0 — Four Chatbot Modes
- Added General Assistant, Learning, Writing, and Coding modes with custom directives and CSS themes.

### v0.8.0 — Multi-Model Response Alternative Version
- Added alternative response regeneration across providers with `< X of Y >` navigation.

### v0.7.1 — Automatic Chat Input Focus and Code Alignment
- Added global keystroke focus capture for the composer.
- Locked code block line height to 22px to eliminate line-number gutter drift.

### v0.7.0 — Live Response Time Management
- Added a real-time duration timer during streaming, saved as an immutable completion badge.

### v0.6.0 — Controlled Large Response Continuation
- Added multi-part output segmentation with an interactive composer continuation chip.

### v0.5.0 — Serverless Upload Architecture
- Switched uploads to in-memory staging via `multer.memoryStorage()` to eliminate serverless `EROFS` errors.

### v0.4.0 — Image Attachment and OCR
- Added server-side Tesseract OCR with magic-number validation and a dual-tab preview modal.
