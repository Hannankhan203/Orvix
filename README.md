# Orvix

**Version: v0.2.2**

<p align="center">
  <strong>An Intelligent, Multi-Model Conversational AI Workspace featuring On-Device Browser AI (WebLLM & WebGPU), Offline PWA App-Shell Caching, Client-Side Document Extraction, Dual-Format Table & Clipboard Formatting, Expanded Mobile Swipe Navigation, Mobile PWA Live Dictation with Whisper Refinement, Specialized Chat Modes, Multi-Model Response Alternatives, Global Chat-Input Focus, Pixel-Perfect Code Blocks, Live Latency Tracking, Controlled Continuation, and Deep Document Understanding</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Browser AI (WebLLM) & On-Device WebGPU Inference](#browser-ai-webllm--on-device-webgpu-inference)
   - [Strictly Local Browser Execution & Zero-API Privacy](#strictly-local-browser-execution--zero-api-privacy)
   - [Configured Qwen 2.5 Model Variants & Quantization Tiers](#configured-qwen-25-model-variants--quantization-tiers)
   - [Dedicated Web Worker Architecture](#dedicated-web-worker-architecture)
   - [Browser AI Status Bar & Interactive Controls](#browser-ai-status-bar--interactive-controls)
4. [Offline Functionality & PWA Caching Architecture](#offline-functionality--pwa-caching-architecture)
   - [App Shell Precache vs. Model Weight Cache](#app-shell-precache-vs-model-weight-cache)
   - [Prerequisites for Reliable Offline Use](#prerequisites-for-reliable-offline-use)
   - [Model Weight Retention & Storage Lifecycle](#model-weight-retention--storage-lifecycle)
   - [Behavior of Cloud Providers & Local Ollama When Offline](#behavior-of-cloud-providers--local-ollama-when-offline)
   - [Mobile Device Hardware Realities](#mobile-device-hardware-realities)
5. [Browser-Side Document Extraction (Offline & Local)](#browser-side-document-extraction-offline--local)
   - [Supported Offline Document Formats](#supported-offline-document-formats)
   - [Document Structure Preservation & Context Formatting](#document-structure-preservation--context-formatting)
   - [Scanned PDF & Image OCR Limitations Offline](#scanned-pdf--image-ocr-limitations-offline)
   - [IndexedDB Binary Attachment Caching](#indexeddb-binary-attachment-caching)
6. [Step-by-Step Guide: Using Browser AI Offline](#step-by-step-guide-using-browser-ai-offline)
7. [Message Copying, Markdown Rendering & Table Formatting](#message-copying-markdown-rendering--table-formatting)
   - [Dual-Format Clipboard Generation (`text/html` and `text/plain`)](#dual-format-clipboard-generation-texthtml-and-textplain)
   - [Plain-Text Record Layout for Messaging Applications (WhatsApp, Telegram)](#plain-text-record-layout-for-messaging-applications-whatsapp-telegram)
   - [Rich HTML Table Styling for Documents & Workspaces](#rich-html-table-styling-for-documents--workspaces)
   - [Mixed-Content Parsing & Code Block Protection](#mixed-content-parsing--code-block-protection)
   - [Three-Tier Clipboard Writing Strategy & Fallbacks](#three-tier-clipboard-writing-strategy--fallbacks)
8. [Mobile Responsiveness & Swipe Navigation](#mobile-responsiveness--swipe-navigation)
   - [Main Conversation Area Swipe-Right Activation](#main-conversation-area-swipe-right-activation)
   - [Excluded Zones & Interaction Safeguards](#excluded-zones--interaction-safeguards)
   - [Horizontal Intent Disambiguation vs. Vertical Scroll](#horizontal-intent-disambiguation-vs-vertical-scroll)
   - [Activation Thresholds & Quick Flick Detection](#activation-thresholds--quick-flick-detection)
   - [Dual Touch and Pointer Event Architecture](#dual-touch-and-pointer-event-architecture)
9. [Voice Dictation & Speech Architecture](#voice-dictation--speech-architecture)
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
12. [Attachments & Deep Document Understanding](#attachments--deep-document-understanding)
    - [Three Multimodal Attachment Methods](#three-multimodal-attachment-methods)
    - [Attachment Constraints & Rules](#attachment-constraints--rules)
    - [Supported Document Formats](#supported-document-formats)
    - [Targeted Questioning & Presenter Notes](#targeted-questioning--presenter-notes)
13. [Image Attachments & Optical Character Recognition (OCR)](#image-attachments--optical-character-recognition-ocr)
    - [Supported Image Formats & Binary Verification](#supported-image-formats--binary-verification)
    - [Server-Side OCR Engine](#server-side-ocr-engine)
    - [Honest No-Readable-Text Handling](#honest-no-readable-text-handling)
    - [Dual-Tab Preview Modal](#dual-tab-preview-modal)
14. [Chat Management & Usability Enhancements](#chat-management--usability-enhancements)
    - [Multi-Model Alternative Response Regeneration](#multi-model-alternative-response-regeneration)
    - [Automatic Chat-Input Focus](#automatic-chat-input-focus)
    - [Live Response-Time Measurement](#live-response-time-measurement)
    - [Controlled Large-Response Continuation](#controlled-large-response-continuation)
    - [Edit & Resend Flow with Clean Branch Truncation](#edit--resend-flow-with-clean-branch-truncation)
    - [Conversation Pinning & Client-Side Export](#conversation-pinning--client-side-export)
15. [Architecture & Technology Stack](#architecture--technology-stack)
16. [Authentication & Persistence Architecture](#authentication--persistence-architecture)
17. [Project Structure](#project-structure)
18. [Environment Variables & Configuration](#environment-variables--configuration)
19. [Installation & Running Locally](#installation--running-locally)
20. [Build & Deployment Instructions](#build--deployment-instructions)
21. [Troubleshooting & Common Issues](#troubleshooting--common-issues)
    - [Troubleshooting Gemini Timeouts & Streaming (DevTools & Vercel)](#troubleshooting-gemini-timeouts--streaming-devtools--vercel)
22. [Security Architecture](#security-architecture)
23. [Current Limitations](#current-limitations)
24. [Version History & Release Changelog](#version-history--release-changelog)
25. [Future Roadmap](#future-roadmap)

---

## Project Overview

**Orvix** is an intelligent, multi-model AI conversational workspace built to deliver production-grade text generation, specialized conversational modes, multi-provider model comparisons, keyboard-first interaction, precision code rendering, transparent latency tracking, fluid mobile touch gestures, voice dictation, dual-format table copying, multi-format document analysis, and **fully offline on-device AI generation via WebGPU and WebLLM**.

Engineered as a full-stack Node.js application, Orvix pairs a responsive React 19 single-page application with an Express proxy backend running Vite in middleware mode. When connected to the internet, all cloud AI completions, speech transcriptions, file uploads, and OCR operations are executed server-side to guarantee that API credentials, tokens, and storage paths remain strictly private. When offline, Orvix leverages Workbox PWA app-shell precaching, on-device WebLLM inference, and browser-side document extraction to allow visitors to reopen the application and chat with locally running models without any network connection.

---

## Key Features

- **On-Device Browser AI (WebLLM)**: Run verified Qwen 2.5 Instruct models (`0.5B` lightweight and `1.5B` standard) directly inside the browser using WebGPU and a dedicated Web Worker off the main thread. Delivers completely private, zero-API local inference without sending prompts or documents to external servers.
- **Offline PWA App-Shell & Model Caching**: Workbox service worker precaches all production code, styles, WebLLM workers, and client document parsers. Reopen and use the deployed Orvix application completely offline after initial setup, with independent model weight caching in browser Cache Storage.
- **Client-Side Document Parsing for Offline Context**: Offline text extraction for TXT, Markdown, CSV, TSV, JSON, XML, Word (`.docx` via `mammoth`), PDF (`.pdf` via `unpdf`), and PowerPoint (`.pptx` via `jszip` with speaker notes), enabling grounded, local document Q&A without cloud dependencies.
- **Dual-Format Table & Message Copying**: Copies assistant responses as both rich `text/html` and optimized `text/plain`. Tables pasted into messaging apps (such as WhatsApp) render as clear, structured field-value records so values never lose their column associations, while rich destinations (Google Docs, Word, Slack) receive formatted HTML tables with borders and backgrounds.
- **Main Conversation Mobile Swipe Navigation**: Fluid swipe-right gesture active across the main conversation area on mobile and tablet screens to open chat history, with exclusions for the top header, bottom composer, interactive buttons, code blocks, and an iOS-safe margin (>16px) to avoid native edge navigation conflicts.
- **High-Accuracy Voice Dictation**: Cross-platform dual-engine dictation combining mobile/PWA and desktop live browser speech recognition with server-side Whisper Large v3 Turbo audio refinement. Features real-time interim transcript rendering with deduplication, continuous audio buffering, 9 supported locales, silence restart recovery, and context-aware technical polishing.
- **Four Specialized Chatbot Modes**: Purpose-built modes for **General Assistant**, **Learning**, **Writing**, and **Coding** with custom system prompts, specialized typography, educational callouts, editorial layouts, and VS Code-style code blocks.
- **Multi-Model Response Alternatives**: Compare outputs across different AI providers (Gemini, Groq, OpenRouter, Cloudflare Workers AI, Browser AI) without overwriting existing messages, navigable via an interactive `< X of Y >` pager.
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

## Browser AI (WebLLM) & On-Device WebGPU Inference

Orvix features an on-device local AI engine implemented in `src/services/webllmService.js` and executed inside a dedicated background worker (`src/workers/webllmWorker.js`). Powered by `@mlc-ai/web-llm` and the browser's native **WebGPU API**, Browser AI allows visitors to run compact, highly capable open-weight language models directly on their own device's graphics processor.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX ON-DEVICE BROWSER AI ARCHITECTURE              │
├────────────────────────────────────────────────────────────────────────┤
│ 1. VISITOR'S BROWSER (Main UI Thread)                                  │
│    • React 19 UI & Composer                                            │
│    • Browser AI Status Bar (progress %, memory state, model picker)    │
│    • Client-Side Document Extractor (PDF, DOCX, PPTX, TXT, CSV, JSON)  │
│                                    ↕                                   │
│ 2. DEDICATED WEB WORKER (`src/workers/webllmWorker.js`)               │
│    • WebWorkerMLCEngineHandler off the main thread (zero UI stutter)   │
│    • Tokenizer & SentencePiece decoding                                │
│    • WASM shader compiler & prefill/decode pipeline                    │
│                                    ↕                                   │
│ 3. HARDWARE & CACHE APIS                                               │
│    • WebGPU Device Pipeline (GPU VRAM allocation & shader execution)   │
│    • Browser Cache Storage (`webllm/model`, `webllm/config`, etc.)     │
│    • 100% On-Device — 0 bytes sent to external AI servers or proxies   │
└────────────────────────────────────────────────────────────────────────┘
```

### Strictly Local Browser Execution & Zero-API Privacy

Unlike cloud-based providers (Gemini, Groq, OpenRouter, Cloudflare Workers AI) that transmit prompts, conversation history, and document contents across the internet to external datacenters, **Browser AI executes entirely within the visitor's local browser context**:

- **No API Keys or Cloud Accounts Required**: Browser AI requires zero credentials, billing accounts, or proxy tokens.
- **Complete Data Confidentiality**: Input prompts, system instructions, conversation context, and extracted file attachments remain on the user's physical machine. Prompts are never logged, routed through server endpoints, or used for model training.
- **Zero Server Infrastructure Dependencies**: Token generation runs on the client's local graphics processor (GPU). Even if the Orvix backend server is unreachable or offline, on-device generation continues without interruption.
- **Companion Provider Option**: Browser AI is integrated as a peer option alongside Orvix's cloud providers and Local AI (Ollama). Users can switch between cloud models and Browser AI at any time using the model selector dropdown in the navigation header.

### Configured Qwen 2.5 Model Variants & Quantization Tiers

Orvix packages verified model configurations from the prebuilt **Qwen 2.5 Instruct** series, quantized for WebGPU execution:

| Model Option | Model Identifier | Quantization | Est. Download | Required VRAM | Context Window | Target Devices |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Qwen 2.5 0.5B Instruct (Lightweight)** | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` | 4-bit (`q4f16_1`) | ~420 MB | ~945 MB | 4,096 tokens | Mobile phones, tablets, laptops, integrated GPUs |
| **Qwen 2.5 0.5B (FP32 Fallback)** | `Qwen2.5-0.5B-Instruct-q4f32_1-MLC` | 4-bit (`q4f32_1`) | ~490 MB | ~1,060 MB | 4,096 tokens | Devices without native `shader-f16` support |
| **Qwen 2.5 1.5B Instruct (Standard)** | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | 4-bit (`q4f16_1`) | ~960 MB | ~1,630 MB | 4,096 tokens | Modern desktop GPUs, high-memory laptops |
| **Qwen 2.5 1.5B (FP32 Fallback)** | `Qwen2.5-1.5B-Instruct-q4f32_1-MLC` | 4-bit (`q4f32_1`) | ~1,120 MB | ~1,890 MB | 4,096 tokens | Desktop GPUs without `shader-f16` |

- **Mobile-Friendly Default**: To maximize compatibility on resource-constrained mobile hardware, battery-powered laptops, and integrated GPUs, Orvix provides the lightweight **Qwen 2.5 0.5B** variant, which downloads in roughly half the time and requires less than 1 GB of GPU memory.
- **Automatic Shader-F16 Compatibility Fallback**: Before loading model weights, `checkWebGPUSupport()` inspects the active graphics adapter for the WebGPU 16-bit floating point extension (`shader-f16`). If the visitor's hardware does not support `shader-f16`, `resolveWebLLMModelId()` automatically routes to the compatible `q4f32_1` variant, preventing initialization crashes.
- **Browser-Managed Weight Storage**: Model weights are stored in browser Cache Storage across partitioned tensor shards. They are never downloaded in a single monolithic file. If a network interruption occurs during download, already-cached shards are preserved and resume automatically on the next attempt.

### Dedicated Web Worker Architecture

To prevent heavy tokenization and WebGPU shader compilation from locking the user interface:
- **Dedicated Worker Thread (`src/workers/webllmWorker.js`)**: All WebLLM runtime code, tensor operations, tokenizer lookups, and WebGPU queue dispatches run off the main DOM thread inside a dedicated Web Worker instantiated via `CreateWebWorkerMLCEngine`.
- **Fluid UI Interaction**: Animations, typing into the composer, scrolling chat history, switching tabs, and opening modals remain smooth at 60 FPS while the model compiles or streams tokens.
- **Strict Serialization**: Model generation calls are serialized through a generation queue (`generationQueuePromise`) so concurrent requests or rapid clicks do not corrupt the WebGPU command buffers.
- **Clean Cancellation**: Users can click the **Stop** button (`Square` icon) at any time. Orvix calls `engine.interruptGenerate()` in the worker, instantly halting token generation and preserving the partial response generated so far without reloading the engine.

### Browser AI Status Bar & Interactive Controls

When Browser AI is selected in the provider dropdown, an interactive status and progress dock (`src/components/chat/BrowserAIStatusBar.jsx`) mounts directly above the message composer:

- **Hardware Compatibility Indicator**: Surfaces immediate feedback if WebGPU is unsupported, hardware acceleration is disabled, or an insecure (non-HTTPS) context is detected.
- **Granular Shard Download Progress**: Displays active download percentage (`0–100%`), total elapsed time, and human-readable progress descriptions (`"Fetching param_shard_3.bin (45%)..."`).
- **GPU Memory Compilation State**: Indicates when weights are being loaded from browser disk cache into GPU VRAM (`"Compiling WebGPU shaders and loading cached weights..."`).
- **Interactive Controls**:
  - **Model Selector Dropdown**: Switch between the 0.5B Lightweight model and the 1.5B Standard model.
  - **Load Model**: Triggers on-demand download and initialization without requiring a message submission.
  - **Cancel (`✕`)**: Halts an active model download or initialization attempt cleanly.
  - **Retry (`RotateCcw`)**: Appears on connection or GPU initialization errors to retry with a single click.
  - **Unload (`Trash2`)**: Releases the model from GPU VRAM when finished to free device memory for other tabs, while **keeping all downloaded model shards intact in browser disk cache** for instant reloading later.

---

## Offline Functionality & PWA Caching Architecture

Orvix is built with Progressive Web App (PWA) compliance and offline resilience, allowing users to reopen the deployed application and engage with Browser AI even when completely disconnected from the internet.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   ORVIX TWO-TIER OFFLINE CACHING MODEL                 │
├───────────────────────────────────┬────────────────────────────────────┤
│ TIER 1: APP-SHELL PRECACHE        │ TIER 2: MODEL WEIGHT CACHE         │
│ (Managed via Workbox / VitePWA)   │ (Managed via WebLLM Cache Storage) │
├───────────────────────────────────┼────────────────────────────────────┤
│ • Production HTML (`index.html`)  │ • Quantized Model Weight Shards    │
│ • Application JS & CSS Bundles    │ • Model Configuration JSON         │
│ • WebLLM Web Worker (`webllmWorker`)│ • Model WASM Runtime Binary      │
│ • WebLLM Library Chunk (`lib-*.js`)│ • Tokenizer Vocabulary            │
│ • Client Parsers (PDF, DOCX, PPTX)│                                    │
│ • App Icons & PWA Webmanifest     │ • Size: ~420 MB – 1.15 GB          │
│ • Size: ~15.4 MB total            │ • Scope: Device storage            │
└───────────────────────────────────┴────────────────────────────────────┘
```

### App Shell Precache vs. Model Weight Cache

A fundamental design principle in Orvix is the strict separation between the **Application Shell Precache** and the **AI Model Weight Cache**:

1. **Application Shell Precache (Workbox / Service Worker)**:
   - Configured in `vite.config.ts` via `vite-plugin-pwa` with `maximumFileSizeToCacheInBytes: 8 * 1024 * 1024` (8 MB).
   - Precaches the production HTML, CSS stylesheets, application JavaScript chunks, icon assets, web app manifest, the dedicated WebLLM Web Worker, and lazy-loaded document parsing libraries (`mammoth`, `unpdf`, `jszip`).
   - Ensures the entire user interface, composer, sidebar, settings, and offline parsers load instantly offline.
   - **Excludes API endpoints**: Explicitly excludes `/api/*`, `/health`, `/chat`, `/config`, `/transcribe`, and `/upload` from the SPA navigation fallback denylist (`navigateFallbackDenylist`) and enforces `NetworkOnly` runtime caching so API requests never accidentally return cached HTML.
2. **AI Model Weight Cache (WebLLM / Cache API)**:
   - WebLLM manages its own model shards inside dedicated Cache Storage buckets (`webllm/model`, `webllm/config`, `webllm/wasm`).
   - **Model weights (~420 MB to ~1.15 GB) are NEVER precached via Workbox**. Storing ~1 GB of model weights in the service worker precache manifest would cause excessive network bloat, slow down initial page loads, and fail service worker installations on slower connections.
   - Model weights are downloaded strictly on demand when the user requests or loads Browser AI.

### Prerequisites for Reliable Offline Use

To use Orvix offline, two prerequisites must be completed while an internet connection is available:

1. **Initial Online Visit**: The visitor must open the deployed Orvix website (over HTTPS or localhost) while connected to the internet. The service worker installs and precaches the application shell in the background.
2. **Model Download Completion**: The visitor must select **Browser AI (WebLLM)** and download their preferred model (either by clicking **Load Model** in the status bar or by sending a first prompt). The status bar must reach `"Ready on device"`.

Once both conditions are fulfilled, the visitor can disconnect from the internet, close the tab or PWA, reopen Orvix offline at any time, and generate AI responses locally.

> **Important**: Do not expect an uncached visitor to open the deployed website offline for the very first time. An initial online visit is mathematically required for the browser to download the code, service worker, and model weights.

### Model Weight Retention & Storage Lifecycle

- **Closing the Browser / PWA**: Closing the browser window, closing the installed PWA, or shutting down the device **does not delete the cached model**. Shards remain stored in the browser's Cache Storage.
- **Reopening Offline**: When reopening Orvix offline, `isWebLLMModelCached()` checks the local cache. If the model shards, config, and WASM binary are present, Orvix displays:  
  `"Offline mode — App shell & Qwen 2.5 0.5B are cached on this device."`  
  Clicking **Load Model** or sending a prompt loads the cached model directly into GPU memory without touching the network.
- **What Causes Model Eviction?**:
  - Manually clearing browser site data, cookies, or cache in browser settings.
  - Using **Private Browsing / Incognito Mode** (browsers discard Cache Storage when the private window closes).
  - Browser storage pressure eviction (if device free disk space drops critically low, browsers may evict non-persistent caches). Orvix proactively requests `navigator.storage.persist()` to minimize eviction risk.
  - Switching to an entirely different web browser or operating system profile (browser caches are isolated per browser).

### Behavior of Cloud Providers & Local Ollama When Offline

When Orvix detects that the browser is offline (`!navigator.onLine`):
- **Cloud AI Providers (Gemini, Groq, OpenRouter, Cloudflare Workers AI)**: Cloud providers rely on remote API datacenters. If a user submits a prompt with a cloud provider selected while offline, Orvix intercepts the submission immediately with a helpful notice:  
  `"[Provider] requires an internet connection. Switch to Browser AI (WebLLM) to chat offline on this device."`  
  The offline banner includes a one-click **"Switch to Browser AI"** button.
- **Local AI (Ollama)**: Local Ollama runs on `http://127.0.0.1:11434` and does not require an external internet connection. However, it requires the Orvix local Node.js backend server (`server.ts`) to be running on the host machine to proxy Ollama requests.
- **Browser AI (WebLLM)**: **Requires neither internet nor a running local backend server**. It runs purely client-side inside the browser sandbox.

### Mobile Device Hardware Realities

While Orvix's service worker and offline UI function across all standard modern mobile browsers:
- On-device AI generation via WebGPU requires capable graphics hardware and sufficient system memory.
- For smartphones and tablets, the **Qwen 2.5 0.5B Instruct (Lightweight)** model variant is strongly recommended.
- The standard **Qwen 2.5 1.5B** variant requires ~1.6 GB of dedicated GPU VRAM and may be terminated by mobile operating system low-memory managers (OOM) on devices with 4 GB or 6 GB of total system RAM.
- iOS devices require iOS 18+ for WebGPU support in Safari.

---

## Browser-Side Document Extraction (Offline & Local)

When using Browser AI offline, documents cannot be uploaded to the `/api/upload` backend endpoint. Orvix integrates a client-side document extraction pipeline implemented in `src/services/browserDocumentExtractor.js` that parses document text, headings, tables, and presentation slides directly in the visitor's browser.

```text
┌────────────────────────────────────────────────────────────────────────┐
│               OFFLINE BROWSER-SIDE DOCUMENT EXTRACTION                 │
├────────────────────────────────────────────────────────────────────────┤
│ Attached File (Drop, Paste, or File Picker)                            │
│                                ↓                                       │
│ Format Router (Evaluates MIME type & file extension client-side)       │
│                                ↓                                       │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ Client Parsing Engines (Lazy-imported, precached in PWA):          │ │
│ │ • Word DOCX: Lazy `mammoth` (Markdown conversion, headings, tables)│ │
│ │ • PDF: Lazy `unpdf` / PDF.js (Page-by-page text layer extraction)  │ │
│ │ • PowerPoint PPTX: Lazy `jszip` (Slide XML & speaker notes)        │ │
│ │ • Structured Tables: Native CSV / TSV quoted delimiter parser      │ │
│ │ • Plain Text / Code: Native TXT, Markdown, JSON, XML parsers       │ │
│ │ └──────────────────────────────────────────────────────────────────┘ │
│                                ↓                                       │
│ Normalized Document Context (Boundaries, word count, character count)  │
│                                ↓                                       │
│ Injected into Qwen 2.5 KV Context for 100% Offline Document Q&A        │
└────────────────────────────────────────────────────────────────────────┘
```

### Supported Offline Document Formats

The following file formats are verified for browser-side text extraction when operating offline:

| Format | Extension | Browser Extraction Mechanism | Extracted Metadata & Features |
| :--- | :--- | :--- | :--- |
| **Plain Text** | `.txt`, `.text` | Native browser `File.text()` | Word count, character count, summary preview |
| **Markdown** | `.md`, `.markdown` | Native text parsing + section splitter | Structured headings (H1–H6), section counts |
| **Comma-Separated Values** | `.csv` | Native quoted delimiter parser | Column headers, row count, formatted Markdown table |
| **Tab-Separated Values** | `.tsv` | Native tab delimiter parser | Column headers, row count, formatted Markdown table |
| **JSON** | `.json` | Native `JSON.parse` with structural summary | Top-level keys count, pretty-printed JSON code block |
| **XML** | `.xml` | Native browser `DOMParser` | Structural text nodes, malformed syntax detection |
| **Microsoft Word** | `.docx` | Lazy-loaded `mammoth` (precached in PWA) | Headings, lists, bold/italics, tabular data |
| **PDF Documents** | `.pdf` | Lazy-loaded `unpdf` (precached in PWA) | Page numbers, page boundaries (`--- Page N ---`), text layer |
| **PowerPoint Presentations**| `.pptx` | Lazy-loaded `jszip` (precached in PWA) | Slide titles, slide bodies, slide numbers, speaker notes |

### Document Structure Preservation & Context Formatting

- **Reusing Pre-Extracted Text**: If a document was already parsed or uploaded during the session, Orvix reuses the existing extraction result rather than reading the file again.
- **Bounded Context Allocation**: Extracted text is sanitized, truncated if exceeding safety limits (up to 10,000 characters for 1.5B, 8,000 for 0.5B), and formatted cleanly into the prompt using verified prompt grounding templates (`prepareDocumentContext` and `adaptDocumentContextForProvider`).
- **Targeted Slide & Page Lookups**: Page markers (`--- Page 1 ---`, `--- Page 2 ---`) and slide markers (`--- Slide 1: Title ---`, `[Speaker Notes]: ...`) allow users to ask targeted offline questions (e.g., *"What is covered on slide 3?"*, *"Summarize the notes on page 2"*).

### Scanned PDF & Image OCR Limitations Offline

- **Scanned / Image-Only PDFs**: Orvix's browser-side PDF extractor extracts embedded digital text layers. If a PDF consists solely of scanned raster images with no embedded text (`nonWhitespaceChars < 10`), Orvix detects the condition and honestly notifies the user:  
  `"No readable text could be extracted from this PDF. This document appears to be scanned or contains rasterized pages without a text layer. Optical Character Recognition (OCR) is required."`
- **Image Attachments & OCR**: Image text recognition requires the server-side `tesseract.js` OCR engine. **Image OCR is unavailable offline**. Attaching an image while offline produces a clear notice to attach a text-based document or reconnect to the internet.
- **Legacy Office Formats**: Binary legacy formats (`.doc`, `.ppt`, `.xls`) cannot be parsed client-side by modern OpenXML parsers. Orvix detects these extensions and prompts the user to save the file in modern format (`.docx`, `.pptx`, `.csv`).

### IndexedDB Binary Attachment Caching

All attached file blobs are stored locally in the browser's IndexedDB database (`orvix_attachments_db`). Even when operating completely offline, users can inspect document attachments, preview file cards, and download attached files across page reloads.

---

## Step-by-Step Guide: Using Browser AI Offline

Follow these steps to prepare and use Orvix offline:

```text
Step 1: Open online → Step 2: Select Browser AI → Step 3: Choose Model
                                                         ↓
Step 6: Go offline  ← Step 5: Test online query  ← Step 4: Click Load Model
       ↓
Step 7: Reopen Orvix offline → Step 8: Confirm status → Step 9: Chat offline!
```

### 1. Open the Live Site While Online
Navigate to the deployed Orvix website (e.g., `https://your-orvix-deployment.vercel.app`) using a compatible browser (Google Chrome 113+, Microsoft Edge 113+, or Safari 18+ on macOS/iOS).

### 2. Select Browser AI
Open the AI model selector dropdown in the navigation header or message composer and select **Browser AI (WebLLM)**.

### 3. Choose Your Preferred Model
In the Browser AI status bar that appears above the composer, select your preferred model tier:
- **Qwen 2.5 0.5B Instruct (Lightweight ~420 MB)**: Recommended for mobile devices, laptops, and faster downloads.
- **Qwen 2.5 1.5B Instruct (~960 MB)**: Recommended for desktop computers with dedicated GPUs.

### 4. Download and Initialize the Model
Click **Load Model** in the status bar (or submit a prompt). Watch the progress bar as the model shards download into browser Cache Storage. Wait until the status bar displays:  
`"Qwen 2.5 0.5B — Ready on device"`

### 5. Send a Test Message While Online
Type a prompt (e.g., *"Explain quantum entanglement in two sentences"*) and press Enter. Confirm that tokens stream smoothly and that the response finishes with a response duration badge.

### 6. Close Orvix
Close the Orvix browser tab, window, or installed PWA.

### 7. Disconnect from the Internet
Disconnect your computer or mobile device from Wi-Fi or cellular data (or toggle DevTools Network to **Offline**).

### 8. Reopen Orvix Offline
Reopen your browser and navigate back to the Orvix URL (or launch the installed Orvix PWA from your desktop/home screen).
- The application shell will load instantly from the Workbox service worker precache.
- The offline banner will confirm:  
  `"Offline mode — App shell & Qwen 2.5 0.5B are cached on this device. Supported documents can be extracted locally."`
- The status bar will show:  
  `"Offline — Model is cached locally. Ready to run on your device via WebGPU."`

### 9. Chat and Analyze Documents Offline
- Type a prompt and send it: Qwen generates the answer entirely on your GPU without a network connection.
- Attach a supported document (`.txt`, `.pdf`, `.docx`, `.pptx`, `.csv`, `.json`): Orvix extracts the text client-side and answers questions grounded in your document.
- The Stop button (`Square` icon) remains fully operational to halt generation at any time.

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

Live browser speech recognition and high-accuracy server-side Whisper refinement are unified into a single seamless workflow:
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
- **Audio Buffering Safeguards**: Memory ceiling of 25 MB (`MAX_RECORDED_BYTES`), max recording duration of 15 minutes (`MAX_RECORDING_DURATION_MS`), and real-time time-slicing with dynamic codec negotiation (`audio/webm;codecs=opus`, `audio/webm`, `audio/ogg`, or `audio/mp4`).
- **Hardware Lifecycle**: Listens to `visibilitychange` and `pagehide` events to pause recording and stop hardware tracks when the browser tab is backgrounded, immediately turning off the OS microphone indicator.
- **Track Interruption Recovery**: Handles mobile OS interruptions (incoming phone calls, headset disconnects) with clean pause states and reconnection recovery.

### Smart Punctuation & Typography Formatting

The formatting engine converts spoken punctuation commands into clean typography across 9 supported languages:
- **English Verbal Commands**: `"comma"` → `,`, `"period"` / `"full stop"` → `.`, `"question mark"` → `?`, `"exclamation mark"` → `!`, `"colon"` → `:`, `"semicolon"` → `;`, `"new line"` → `\n`, `"new paragraph"` → `\n\n`, `"dash"` / `"hyphen"` → ` - `.
- **Urdu Verbal Commands (`ur-PK`)**: `"ختمہ"` / `"فل اسٹاپ"` → `۔ `, `"وقفہ"` / `"کوما"` → `، `, `"سوالیہ نشان"` → `؟ `, `"ندائیہ"` → `! `, `"نئی لائن"` → `\n`.
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

Orvix connects to multiple distinct AI provider architectures: serverless cloud APIs, local on-premise inference, and **100% on-device WebGPU inference (Browser AI)** that operates completely offline inside the browser sandbox:

### Supported Providers & Models

| Provider | Model Identifier | Primary Focus | Failover / Backup Model |
| :--- | :--- | :--- | :--- |
| **Browser AI (WebLLM)** | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` *(Default)*<br>`Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | 100% on-device private WebGPU inference; runs offline without cloud APIs or server | Automatic runtime fallback to `q4f32_1` variants for devices lacking `shader-f16` |
| **Google Gemini** | `gemini-3.8-flash` | Ultra-fast cloud inference, massive multimodal understanding | `gemini-3.1-flash-lite` |
| **Groq Cloud** | `llama-3.3-70b-versatile` | Ultra-low latency cloud inference via Groq LPUs | `openai/gpt-oss-120b` |
| **OpenRouter** | `openrouter/free` | Decentralized routing across free community models | Dynamic routing |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | Low-latency edge inference | Edge fallback |
| **Local AI (Ollama)** | `qwen2.5:1.5b` *(or configured local model)* | Local on-premise inference via local Ollama daemon (`127.0.0.1:11434`) | Requires local Orvix backend |

### Provider Context Budgets

Context budgets are calibrated in `src/services/documentContextService.js`:

| Provider | Max Prompt Context | Document Context Budget | Best Suited For |
| :--- | :--- | :--- | :--- |
| **Browser AI (WebLLM)** | 4,096 tokens | ~8,000–10,000 characters | 100% offline document Q&A, complete privacy, zero API costs |
| **Google Gemini** | 1,000,000 tokens | ~120,000 characters | Extensive multi-page PDFs, books, large codebases |
| **Groq Cloud** | 128,000 tokens | ~24,000 characters | Rapid structured analysis, high-speed coding |
| **Local AI (Ollama)** | 4,096 tokens | ~16,000 characters | Local privacy, offline server inference without cloud dependencies |
| **OpenRouter** | Variable by model | ~16,000 characters | Broad open-source experimentation |
| **Cloudflare Workers AI** | 8,192 tokens | ~16,000 characters | Edge summaries, quick queries |

### Streaming & Fallback System

- **Dedicated Web Worker Streaming (Browser AI)**: Browser AI completions execute entirely client-side inside `src/workers/webllmWorker.js`. Generated tokens stream directly from WebGPU command queues into the UI state without making network requests.
- **Server-Sent Events (SSE) Streaming Architecture**:
  - **Immediate Header Priming**: The server immediately transmits initial SSE headers (`Content-Type: text/event-stream; charset=utf-8`, `Connection: keep-alive`) and flushes an initial comment (`: prime\n\n`) within 50ms of receiving the request. This provides an immediate Time-to-First-Byte (TTFB) to satisfy reverse proxy and Vercel edge idle timeout thresholds before the upstream model returns its initial chunk.
  - **Reverse Proxy Buffering Disabled**: Sets `X-Accel-Buffering: no` on all streaming responses to prevent intermediate reverse proxies (Vercel, Nginx, Cloudflare) from buffering chunks.
  - **Active Keepalive Heartbeat**: Periodic SSE comment frames (`: keepalive\n\n`) are emitted every 8 seconds while awaiting upstream model generation, preventing idle socket teardown during complex reasoning or large context ingestion.
  - **Strict Pre-Stream vs. Mid-Stream Error Boundary**: If an error or timeout occurs *before* any generated chunk is received, the system flags `canFallback: true` and `partial: false`, permitting retry or automated failover. Once any generated chunk has been emitted to the client, the error is marked with `partial: true` and `canFallback: false`, strictly prohibiting retries or provider switching to prevent duplicate text or contradictory partial replays.
  - **Client Disconnect Cancellation**: Outbound upstream requests are wired to `AbortController` signals that trigger immediately when the client disconnects or clicks **Stop**, aborting upstream calls and freeing server resources.
- **Gemini Model Configuration & Fallback Candidate Strategy**:
  - `gemini-3.8-flash` is configured as the primary default model and `gemini-3.1-flash-lite` is the fallback candidate model (`const fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite']`).
  - If `gemini-3.8-flash` encounters a rate limit (`429`), temporary upstream server error (`503 UNAVAILABLE`), or upstream deadline timeout (`504 DEADLINE_EXCEEDED`) before any tokens are streamed, Orvix automatically advances to `gemini-3.1-flash-lite` without re-invoking the failing model.
  - *Availability Notice*: The automated fallback strategy helps maintain availability during temporary load spikes, but does not guarantee that every Gemini timeout is eliminated or that every model is continuously available under all network, regional, or quota conditions.
- **Production Verification**:
  - In production testing, live streaming was successfully verified using `gemini-3.1-flash-lite`.
  - Streaming completed cleanly with a normal `STOP` finish reason.
  - The Edit & Resend flow was subsequently tested and verified in production, demonstrating proper branch truncation and isolated re-generation.
- **Cross-Provider Recovery**: If an active cloud provider fails or goes offline, Orvix provides a **"Switch Provider & Retry"** button that redirects the exact prompt to an alternate provider without retyping. When offline, Orvix offers a one-click **"Switch to Browser AI"** button.

### Zero-Key Simulation Mode

Orvix runs out-of-the-box without requiring API keys. When no keys are configured, Orvix operates in **Simulated Mode**, generating realistic conversational replies tailored to the active mode and prompt so that all UI workflows, attachments, code blocks, and exports can be tested immediately. Alternatively, users can select **Browser AI (WebLLM)** to run real local AI without any API keys.

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

### Edit & Resend Flow with Clean Branch Truncation

- **In-Place Prompt Revision**: Users can edit any previously sent user message directly within the conversation thread by clicking the **Edit** (`Pencil`) action button on the message card.
- **Clean Branch Truncation**: Editing a prior message automatically truncates subsequent downstream messages from that point forward in the active conversation thread. This ensures that the AI model receives a clean, non-contradictory context window reflecting the edited intent without being confused by obsolete future turns.
- **Request Isolation & Stale Stream Safety**: Coordinated through `src/services/requestIsolationService.js`, initiating an edit immediately supersedes any active generation in that chat, aborts in-flight network connections, and blocks late-arriving chunks from corrupting the newly generated response.
- **Production Verification**: The Edit & Resend flow was verified in live production testing, confirming responsive branch truncation, clean SSE streaming, and zero cross-request state leakage.

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
│   │   │   ├── BrowserAIStatusBar.jsx # Browser AI status, model progress & controls
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
│   │   ├── browserDocumentExtractor.js # Client-side offline document extractor
│   │   ├── chatStorageService.js    # Firestore & localStorage chat persistence
│   │   ├── documentContextService.js# Context budgeting & document formatting
│   │   ├── documentExtractor.js     # Server-side PDF, DOCX, PPTX document parsers
│   │   ├── geminiService.js         # Google Gemini integration
│   │   ├── groqService.js           # Groq REST API integration
│   │   ├── imageOcrService.js       # Tesseract.js OCR engine
│   │   ├── multiPartResponseService.js   # Large-response continuation engine
│   │   ├── openrouterService.js     # OpenRouter completions API
│   │   ├── serviceWorkerManager.js  # PWA service worker registration & offline state
│   │   ├── transcriptionService.js  # Whisper audio transcription client
│   │   └── webllmService.js         # Browser AI WebLLM engine & cache manager
│   ├── styles/                      # Tailwind CSS v4 & custom stylesheet (index.css)
│   ├── utils/                       # Export, speech, clipboardFormatter & highlighter
│   └── workers/                     # Web Workers off the main thread
│       └── webllmWorker.js          # Dedicated WebLLM WebGPU execution worker
├── server.ts                        # Express development & production server
├── vite.config.ts                   # Vite configuration & Workbox PWA setup
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
| **WebGPU not supported / Browser AI disabled** | Browser lacks WebGPU support, site is insecure (HTTP), or GPU acceleration is off | Use Google Chrome 113+, Microsoft Edge 113+, or Safari 18+ over HTTPS or `localhost`; ensure hardware acceleration is enabled in browser settings (`Settings` > `System` > `Use graphics acceleration when available`). |
| **Browser AI model download fails / hangs** | Network glitch or timeout during tensor shard retrieval | Click the **Retry** (`RotateCcw`) button in the Browser AI status bar. Shards already stored in browser Cache Storage are retained and will not be re-downloaded. |
| **Offline mode shows model not cached** | Cache Storage was evicted or private/incognito browsing was used | Reconnect to the internet, open Orvix, and download the model until the status bar displays `"Ready on device"`. Avoid Incognito mode if you want model weights to persist across sessions. |
| **Cloud provider fails with offline warning** | Gemini, Groq, OpenRouter, or Cloudflare was queried while disconnected | Click **"Switch to Browser AI"** in the offline notification banner to run inference directly on your device without an internet connection. |
| **Scanned PDF or image cannot be processed offline** | Image OCR requires the server-side OCR engine (`/api/upload`) | Reconnect to the internet for image OCR and scanned PDFs, or attach text-based documents (`.docx`, `.pptx`, `.txt`, `.md`, `.csv`, `.json`, `.pdf` with text layers) which extract client-side offline. |
| **Pasted table distorted in WhatsApp** | Messaging app uses proportional fonts | Use Orvix's built-in **Copy** button on the message card; Orvix automatically generates structured record plain text (`• Header: Value`) so column values never lose association. |
| **Swipe gesture does not open drawer** | Swiping inside composer, header, or code block | Initiate the swipe from the neutral conversation area; avoid touching the composer bar, top header, or horizontally scrollable code blocks. |
| **Microphone access denied** | Browser blocked mic permission | Click the camera/microphone icon in the browser address bar, set permission to "Allow", and reload. |
| **No live words in Firefox** | Firefox lacks Web Speech API by default | Normal behavior. Orvix automatically switches to Direct-Audio mode, capturing audio directly and transcribing via Whisper when you click Done. |
| **Port 3000 in use (`EADDRINUSE`)** | Another process is bound to port 3000 | Stop the conflicting process or run `PORT=3001 npm run dev`. |
| **`EROFS: read-only file system`** | Serverless deployment write restriction | Orvix stages uploads in memory via `multer.memoryStorage()`, preventing local disk write errors. |
| **Scanned PDF shows no text** | PDF contains image scans without a text layer | Use the Image upload option to extract text via the server-side OCR engine. |
| **HEIC image preview blank** | Browsers cannot render raw HEIC in `<img>` | Orvix displays an informational fallback card with full text inspection in the modal dialog. |
| **Gemini timeout (504 DEADLINE_EXCEEDED) / 503 UNAVAILABLE** | Upstream Gemini model experiencing temporary demand spikes or response header deadline exceeded | Orvix automatically advances to `gemini-3.1-flash-lite` on pre-stream timeouts. If all cloud attempts fail, click **"Switch Provider & Retry"** to query Groq or OpenRouter, or click **"Switch to Browser AI"** to run local inference. Inspect Vercel runtime logs and DevTools Network EventStream for diagnostics. |

### Troubleshooting Gemini Timeouts & Streaming (DevTools & Vercel)

When troubleshooting streaming completions or intermittent upstream latency on serverless deployments:

#### 1. Inspecting Vercel Runtime Logs
1. Navigate to the **Vercel Dashboard** and open your Orvix project.
2. Select the **Deployments** tab and click on the active production deployment.
3. Open the **Logs** (or **Runtime Logs**) tab.
4. Filter log entries by searching for `/api/chat` or filtering by HTTP status codes `504` or `503`.
5. Review the structured diagnostic log entries generated by Orvix's diagnostic logger:
   ```text
   [AI Diagnostic][provider timeout] Provider: gemini | Model: gemini-3.8-flash | Phase: pre-stream | Status: HTTP 504 [DEADLINE_EXCEEDED] | Action: Will retry (attempt 2/2) | Sanitized: The request to Google Gemini timed out...
   ```
6. **Log Retention Notice**: Log retention windows and real-time log search capabilities depend on your active Vercel plan (e.g., Vercel Hobby accounts provide 1-hour log retention, whereas Pro and Enterprise tiers offer extended retention and external log drain integrations).
7. **Security Guarantee**: All server-side error logging runs through `sanitizeErrorLog`, ensuring API keys, authorization tokens, and personal credentials are never exposed in log outputs.

#### 2. Verifying `/api/chat` Streaming Responses in Browser DevTools
1. Open your browser's Developer Tools (`F12`, or `Ctrl + Shift + I` / `Cmd + Option + I`).
2. Switch to the **Network** tab and click the **Fetch/XHR** filter.
3. Submit a prompt using Google Gemini in the Orvix conversation area.
4. Click on the active `/api/chat` POST request in the network list.
5. Select the **Response** (or **EventStream**) sub-tab to inspect raw SSE events as they arrive:
   - Initial Header Priming: `: prime` (confirms sub-50ms TTFB connection establishment)
   - Periodic Heartbeat: `: keepalive` (emitted every 8s to prevent proxy idle disconnection)
   - Stream Initialization: `data: {"type":"start","modelUsed":"gemini-3.8-flash","provider":"gemini"}` (or fallback model `gemini-3.1-flash-lite`)
   - Text Chunks: `data: {"type":"chunk","text":"..."}`
   - Stream Finalization: `data: {"type":"done","text":"...","modelUsed":"...","finishReason":"STOP"}`
6. If a pre-stream timeout occurs before token generation starts, you will observe a structured error frame:
   ```json
   data: {"type":"error","code":504,"status":"DEADLINE_EXCEEDED","provider":"gemini","retryable":false,"canFallback":true}
   ```
   This confirms that the server properly flagged the error as fallback-eligible without emitting broken partial text.

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
7. **WebGPU Hardware & Browser Prerequisites**: Browser AI requires a browser with WebGPU enabled (Chrome 113+, Edge 113+, Safari 18+) served over a secure origin (HTTPS or `localhost`). Hardware graphics acceleration must be enabled in browser settings.
8. **Initial Online Caching Requirement**: Orvix cannot be opened offline on a new device or browser profile that has never loaded the site before. An initial online visit is mathematically required to precache the PWA app shell and download the selected WebLLM model weights.
9. **Mobile Memory (VRAM) Constraints for 1.5B Model**: Running the larger `Qwen2.5-1.5B-Instruct` model on mobile devices with limited system memory (<6 GB RAM) may cause browser tab crashes or OS memory evictions. Mobile users should use the default `Qwen2.5-0.5B-Instruct` model (~420 MB).
10. **Offline Document Scope**: Offline document parsing supports digital text formats (`.pdf`, `.docx`, `.pptx`, `.csv`, `.tsv`, `.json`, `.xml`, `.txt`, `.md`). Image OCR and scanned raster PDFs without digital text layers require an active server connection.

---

## Version History & Release Changelog

Orvix adheres to Semantic Versioning (`MAJOR.MINOR.PATCH`). Below is the concise, scannable history of all releases and development milestones.

### v0.2.2 — Gemini Reliability, Fallback Hardening & Production Verification *(Current)*
- **Gemini Model Configuration & Automated Failover**: Established `gemini-3.8-flash` as the primary default model and `gemini-3.1-flash-lite` as the verified fallback candidate (`fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite']`). Automatically reroutes requests upon encountering upstream rate limits (`429`), temporary server unavailability (`503 UNAVAILABLE`), or deadline timeouts (`504 DEADLINE_EXCEEDED`) without repeating the failing model.
- **SSE Streaming Architecture & Latency Safeguards**: Introduced immediate SSE header priming (`: prime\n\n` within 50ms), reverse proxy buffering bypass (`X-Accel-Buffering: no`), and active 8-second keepalive heartbeats (`: keepalive\n\n`) to eliminate idle socket drops on Vercel and edge proxies during upstream model initialization.
- **Strict Fallback Boundaries**: Implemented strict pre-stream vs. mid-stream error boundaries. Pre-chunk timeouts allow clean retries or automated failover (`partial: false, canFallback: true`), while mid-stream errors strictly forbid failover (`partial: true, canFallback: false`) to prevent duplicate text replay.
- **Successful Production Verification**: Validated live streaming response generation using `gemini-3.1-flash-lite`, confirming clean token streaming and normal `STOP` completion. Verified the Edit & Resend message revision flow in production with clean branch truncation and isolated execution.
- **Audio Pipeline Verification**: Verified `/api/transcribe` dual pipeline combining Groq Whisper (`whisper-large-v3-turbo`) with Gemini audio fallback (`gemini-3.5-transcribe` / `gemini-3.8-flash`).
- **Comprehensive Troubleshooting Guide**: Added step-by-step diagnostic procedures for inspecting Vercel runtime logs (with plan retention notices) and verifying live `/api/chat` SSE EventStream events in browser DevTools.

### v0.2.1 — Empty New Chat Hero & Responsive CSS Refinement
- **Hero Centerpiece Sizing**: Rebalanced the empty-state Orvix logo and personalized greeting (`"What can I help you with, [username]?"`) to serve as a bold, intentional visual anchor on large laptop and desktop viewports.
- **7-Tier Fluid CSS Clamp Sizing**: Implemented fluid responsive typography and logo dimensions (`clamp(4rem, 8vw, 7.5rem)` for the icon, `clamp(1.5rem, 3vw, 2.5rem)` for the greeting) across 7 screen widths (320px mobile to 2560px+ ultra-wide).
- **Distraction-Free Layout**: Maintained removal of obsolete chat-mode selection chips, four duplicate mode buttons, and starter prompts, keeping focus on the clean hero and input dock.
- **Visual Polish**: Subtle radial background gradient glow (`radial-gradient(ellipse at 50% 40%, ...)`) and refined vertical rhythm without layout shifts or horizontal clipping.

### v0.2.0 — Mobile UI/UX & Responsive Viewport Refinement
- **Dynamic Mobile Viewport Management**: Bound CSS custom property `--app-viewport-height` to window `visualViewport` height to eliminate mobile browser URL-bar shifting and keyboard overlap.
- **Virtual Keyboard Detection & Layout Adaptivity**: Automatically toggles `.is-keyboard-open` when the virtual keyboard pops up, adjusting message composer positioning and locking scroll anchor to the newest message.
- **Compact Two-Tier Mobile Header**: Streamlined top navigation bar with collapsible menu toggles, 44px minimum touch targets, and consolidated title bar.
- **Full-Screen Mobile Document Modal**: Responsive full-screen presentation for `.docx`, `.pdf`, and `.pptx` previews with native touch scroll on narrow viewports.

### v0.1.0 — Desktop UI/UX, Accessibility & Performance Release
- **Progressive Desktop Viewport Scaling**: Optimized widescreen reading ergonomics (`max-width: 82ch` reading column) scaling gracefully up to 2560px 4K displays.
- **Isolated React Streaming Rendering**: Wrapped message items in `React.memo` to isolate real-time token streaming to the active assistant card, preventing unnecessary re-renders of previous conversation history.
- **Keyboard-First Focus & Accessibility**: Implemented strict `:focus-visible` ring indicators, accessible ARIA landmarks (`role="main"`, `aria-live="polite"`), and keyboard focus trapping in modal dialogs.
- **Unified Multi-Provider Core**: Standardized streaming pipeline across Gemini, Groq, OpenRouter, and Cloudflare Workers AI with fallback switching.

---

### Historical Feature Milestones & Architectural Releases

#### v0.9.4 — Browser AI (WebLLM), Offline PWA Precaching & Browser Document Extractor
- **100% On-Device WebGPU Inference**: Embedded `@mlc-ai/web-llm` running Qwen 2.5 (`0.5B` lightweight and `1.5B` standard) directly on visitor GPUs via a dedicated off-thread Web Worker (`webllmWorker.js`).
- **Offline PWA App-Shell Precaching**: Workbox service worker precaches UI assets, WASM bundles, and offline document parsers (~15.4 MB total), excluding model weights (~420 MB–1.15 GB) which are cached independently in Cache Storage.
- **Client-Side Document Parsing**: Offline in-browser text extraction for `.docx` (`mammoth`), `.pdf` (`unpdf`), `.pptx` (`jszip`), `.csv`, `.tsv`, `.json`, and `.txt` without server roundtrips.
- **Interactive Browser AI Status Dock**: Real-time download progress %, shader compilation feedback, model switcher, unload memory control, and manual offline loading.

#### v0.9.3 — Mobile PWA Live Dictation & Interim Transcript Deduplication
- **Live Mobile Speech Recognition**: Spoken words render live into the composer as the user speaks on mobile browsers and standalone PWAs.
- **Interim Transcript Deduplication**: Separated immutable final segments from temporary interim snapshots, eliminating duplicate word concatenation (`"I I want I want you"`).
- **Concurrent Live Recognition & Server Whisper**: Immediate visual feedback during speech followed by high-accuracy Groq Whisper Large v3 Turbo refinement upon tapping Done.
- **Desktop Regression Protection**: Preserved desktop hybrid dictation, Web Audio 5-bar visualizer, and Firefox direct-audio fallback.

#### v0.9.2 — Table Copying, Mobile Swipe Navigation & Dictation Hardening
- **Dual-Payload Clipboard Formatter**: Copies responses as both styled HTML tables (`text/html`) and structured plain text records (`text/plain` with `• Header: Value`) to avoid table distortion in messaging apps (WhatsApp, Telegram).
- **Main Conversation Mobile Swipe**: Open chat history by swiping right across the main conversation area on screens `<= 1024px`, with exclusions for composer, header, code blocks, and an iOS back margin (>16px).
- **Groq Whisper Large v3 Turbo**: Integrated server-side Whisper pipeline with technical vocabulary conditioning and Gemini audio fallback.
- **Session Isolation**: Fixed composer clearing guards (`Ctrl+A` + `Backspace`) so deleted text cannot reappear in subsequent voice sessions.

#### v0.9.1 — High-Accuracy Voice Dictation & Whisper Pipeline Hardening
- **Server-Side Whisper Pipeline**: Integrated Groq Whisper Large v3 Turbo at `/api/transcribe` with zero-temperature inference.
- **Dual-Engine Dictation Architecture**: Hybrid mode for Chrome/Edge/Safari and Direct-Audio mode for Firefox with 9 supported locales.
- **Context-Aware Technical Polishing**: Added `polishSpokenTranscript` with contextual disambiguation for programming vocabulary.

#### v0.9.0 — Four Chatbot Modes Refinement & Documentation Overhaul
- **Four Distinct Modes**: Purpose-built modes for General Assistant (rich markdown), Learning (educational callouts), Writing (76ch line length), and Coding (VS Code styling).
- **Standardized Directives**: Custom system prompt directives and CSS themes for each conversational mode.

#### v0.8.0 — Multi-Model Response Alternatives & Provider Unification
- **"Regenerate with another AI Model"**: Regenerate completed assistant responses using an alternate provider without losing earlier outputs.
- **Non-Destructive Alternative History**: Captures every response as an independent alternative with its own model badge, timestamp, and duration metric.
- **Response Alternative Navigator**: Integrated `< X of Y >` pager in `ChatMessage.jsx`.

#### v0.7.1 — Automatic Chat-Input Focus & Pixel-Perfect Line Alignment
- **Global Typing Capture**: Typing alphanumeric keys anywhere immediately focuses the composer without dropping the first character.
- **Pixel-Perfect Code Alignment**: Locked 22px line height (`--code-line-height: 22px;`) eliminating line-number vertical drift in code blocks.

#### v0.7.0 — Live Response-Time Measurement & Left-Edge Swipe Gesture
- **Live Response-Time Measurement**: Real-time latency tracking badge (`Thinking... X.Xs`) updating every 100ms, transitioning to an immutable badge saved in Firestore and local storage.
- **Initial Left-Edge Swipe Gesture**: Native touch swipe from left edge on mobile/tablet viewports to slide open chat history.

#### v0.6.0 — Controlled Large-Response Continuation & Multimodal Inputs
- **Controlled Large-Response Continuation**: Split massive responses into safe parts with continuation notices and an interactive composer chip (`[ → Continue response ]`).
- **Three Multimodal Attachment Methods**: File picker dialog, clipboard paste (`Ctrl + V`), and drag-and-drop file staging with a 25MB limit.

#### v0.5.0 — Serverless Upload Architecture & Resilience
- **In-Memory Upload Staging**: Migrated uploads to `multer.memoryStorage()`, eliminating read-only filesystem errors (`EROFS`) on serverless platforms.
- **Extended Client Timeout**: Extended upload and OCR timeout to 90 seconds for reliable processing.

#### v0.4.0 — Image Attachments & Optical Character Recognition (OCR)
- **Server-Side OCR Engine**: Powered by `tesseract.js` with binary magic number verification.
- **Honest Text Reporting**: Informative "No readable text detected" handling to prevent model hallucinations.
- **Dual-Tab Preview Modal**: Full-screen modal with high-resolution image inspection and extracted text tabs.

#### v0.3.0 — Deep Document Understanding & Error UI Overhaul
- **Document Text Extraction**: Multi-page parsing for PDF (`unpdf`), Word DOCX (`mammoth`), and PowerPoint PPTX with speaker notes (`jszip`).
- **Targeted Lookups & Error Cards**: Targeted questions by page or slide, paired with responsive diagnostic error cards.

#### v0.2.0 (Historical) — Cloudflare Workers AI Integration
- Integrated `@cf/meta/llama-3.1-8b-instruct` via Cloudflare's edge REST API with SSE streaming.

#### v0.1.0 (Historical) — Initial Full-Stack Workspace
- React 19 SPA frontend with Tailwind CSS v4, Obsidian Dark and Clean Light themes.
- Express backend (`server.ts`) with Vite middleware mode on port 3000.
- Google Gemini and Groq streaming, Web Speech voice dictation, Firestore, and Guest Mode.

#### v0.0.1 – v0.0.3 — Foundational Prototypes
- Initial UI wireframes, basic chat loops, and foundational prototype validation.

---

## Future Roadmap

The following capabilities represent prospective architectural enhancements and are clearly distinguished from currently implemented features:

- **Client-Side Vector Search / RAG**: Semantic vector chunk search for 500+ page documents using local embeddings.
- **Multilingual OCR Enhancements**: Dynamic language pack downloads for non-Latin script optical character recognition.
- **Streaming Voice Input**: Real-time server-side audio streaming via WebSockets for sub-second Whisper transcription on browsers lacking Web Speech support.
- **Image Generation Integration**: Generative visual creation tools alongside existing conversational modes.
