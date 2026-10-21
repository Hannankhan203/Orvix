# Orvix

**Current Version: Orvix v0.3**

<p align="center">
  <strong>An Intelligent, Multi-Model AI Conversation Companion with Deep Document Understanding</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Project Purpose & Current Status](#project-purpose--current-status)
3. [Architecture & Technology Stack](#architecture--technology-stack)
   - [Frontend Architecture](#frontend-architecture)
   - [Backend Architecture](#backend-architecture)
   - [File Attachment & Upload Architecture](#file-attachment--upload-architecture)
   - [Database & Authentication Architecture](#database--authentication-architecture)
4. [AI Providers & Selectable Models](#ai-providers--selectable-models)
   - [Fully Implemented Providers](#fully-implemented-providers)
   - [Provider Document Context Capacities](#provider-document-context-capacities)
   - [In Progress Providers](#in-progress-providers)
   - [Planned Providers](#planned-providers)
   - [AI Provider Routing, Streaming & Fallbacks](#ai-provider-routing-streaming--fallbacks)
   - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
5. [File Attachment & Document Understanding](#file-attachment--document-understanding)
   - [Key Capabilities](#key-capabilities)
   - [Supported File Formats](#supported-file-formats)
   - [Document Questioning & Page/Slide Targeting](#document-questioning--pageslide-targeting)
   - [Attachment Viewing & Downloading](#attachment-viewing--downloading)
   - [Browser-Local IndexedDB & Server Storage Lifecycle](#browser-local-indexeddb--server-storage-lifecycle)
   - [Document Processing Limitations](#document-processing-limitations)
6. [Resilient Error UI & Recovery Architecture](#resilient-error-ui--recovery-architecture)
7. [Current Features (v0.3)](#current-features-v03)
   - [Implemented Features](#implemented-features)
   - [In Progress Features](#in-progress-features)
   - [Planned & Future Features](#planned--future-features)
8. [Project Structure & Important Files](#project-structure--important-files)
   - [Directory Tree](#directory-tree)
   - [Important Files & Modules](#important-files--modules)
9. [Environment Variables & Configuration](#environment-variables--configuration)
   - [Configuration Reference Table](#configuration-reference-table)
   - [Configuration Template (`.env.example`)](#configuration-template-envexample)
10. [Prerequisites & Setup Instructions](#prerequisites--setup-instructions)
    - [Prerequisites](#prerequisites)
    - [Installation](#installation)
    - [Running in Development](#running-in-development)
    - [Building for Production](#building-for-production)
    - [Running the Production Server](#running-the-production-server)
    - [Type Checking & Linting](#type-checking--linting)
    - [Running the Document Test Suites](#running-the-document-test-suites)
11. [Firebase Setup & Security Rules](#firebase-setup--security-rules)
12. [Deployment Information](#deployment-information)
13. [Current Limitations](#current-limitations)
14. [Version History & Changelog](#version-history--changelog)

---

## Project Overview

**Orvix v0.3** is a high-performance, full-stack conversational AI web application featuring deep multi-modal document understanding. Built with a responsive React 19 single-page frontend, an Obsidian Dark / Clean Light design system styled with Tailwind CSS, and a Node.js Express full-stack backend running Vite in middleware mode, Orvix enables users to converse with leading AI models and analyze complex documents with surgical precision.

Orvix provides seamless multi-model intelligence across four independently selectable AI providers:
- **Google Gemini** (`gemini-3.8-flash` primary with automatic `gemini-3.1-flash-lite` fallback) via the modern `@google/genai` TypeScript SDK.
- **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via Groq's high-speed OpenAI-compatible REST API.
- **OpenRouter** (`openrouter/free`) dynamically routing queries across available high-capacity free community models.
- **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct`) providing high-speed serverless inference on Cloudflare's global edge network via its official REST API.

With **release v0.3**, Orvix introduces a complete, secure file attachment and document extraction pipeline. Users can attach PDFs, Word documents, PowerPoint presentations, tabular data, and code files to their chat messages, inspect their contents, open or download the original files, and ask questions targeting whole documents, individual PDF pages, page ranges, or PowerPoint slides—all with streaming answers across all supported AI providers.

---

## Project Purpose & Current Status

### Purpose
The primary purpose of Orvix is to deliver an accessible, multi-model conversational assistant that balances privacy, flexibility, speed, and real-world utility:
1. **Multi-Model Intelligence**: Compare outputs across leading providers (Google Gemini, Groq, OpenRouter, Cloudflare Workers AI) inside the same conversation thread without losing context or attached files.
2. **Deep Document Understanding**: Upload real-world documents (PDF, DOCX, PPTX, CSV, Markdown, TXT) and ask precise, targeted questions with boundary detection and page/slide citations.
3. **True Zero-Friction Access**: Allow users to explore the application instantly via Guest Mode with simulated AI responses, local storage, and IndexedDB attachment persistence without requiring API keys or mandatory account registration.
4. **Secure Full-Stack Proxying**: Route sensitive AI completions and document extraction through a backend Express proxy (`/api/chat`, `/api/upload`) with Server-Sent Events (SSE) streaming so credentials and private paths remain protected on the server.
5. **Accessible Multimodal Speech**: Provide built-in voice input with verbal punctuation formatting and browser-synthesized audio read-aloud with voice and speed controls.
6. **Robust Data Ownership**: Offer complete cloud persistence via Firebase Cloud Firestore alongside instant client-side export to standard `.md` and `.txt` files.

### Current Status
- **Current Version**: `v0.3` (Feature release: File Attachment & Document Understanding Integration + Error UI overhaul).
- **Core Status**: Fully functional, production-ready full-stack web application. The frontend, backend proxy, streaming SSE pipeline, multipart upload pipeline, document extraction engine, IndexedDB offline cache, authentication, Firestore storage, local fallback storage, speech synthesis, voice dictation, and personalization settings are all implemented and verified on Node.js 22 and port 3000.

---

## Architecture & Technology Stack

### Frontend Architecture
- **Framework**: React 19 (`react` ^19.0.1, `react-dom` ^19.0.1) as a Single Page Application (SPA).
- **Build Tool**: Vite (`vite` ^8.3.0) with `@vitejs/plugin-react` (^6.1.1).
- **Styling & Design System**: Tailwind CSS v4 (`tailwindcss` ^4.3.3, `@tailwindcss/vite` ^4.3.3) paired with an Obsidian Dark and Clean Light CSS custom-property design system (`src/styles/index.css`).
- **Icons**: Lucide React (`lucide-react` ^0.546.0).
- **Motion & Transitions**: Motion (`motion` ^12.23.24) and CSS hardware-accelerated transitions.
- **Markdown & Code Highlighting**: `react-markdown` (^10.1.0) and `remark-gfm` (^4.0.1), featuring custom code block rendering with language detection, line numbers, and one-click clipboard copying.
- **Client Document Persistence**: IndexedDB (`src/services/attachmentStorageService.js`) using database `orvix_attachments_db` to persist raw file blobs in the browser across page reloads and network reconnects.
- **State Management**: React Context architecture:
  - `AuthContext`: Tracks user session, login, signup, logout, and guest identity.
  - `SettingsContext`: Synchronizes user preferences (theme, response length, beginner mode, chat mode, timestamps, enter-to-send) between Firestore and local storage.
  - `SpeechContext`: Controls Web Speech Synthesis playback, voice selection, speech rate, and read-aloud state.

### Backend Architecture
- **Server**: Express (`express` ^4.22.3) written in TypeScript (`server.ts`).
- **Development Execution**: `tsx` (^4.21.0) executes `server.ts` directly, mounting Vite in middleware mode (`appType: 'spa'`) for rapid hot module execution on a single port (3000).
- **Production Execution**: Serves compiled static frontend assets from `dist/` with wildcard SPA routing fallback to `index.html`.
- **API Endpoints**:
  - `GET /api/health`: System uptime and health verification.
  - `GET /api/config`: Returns provider configuration booleans (`geminiConfigured`, `groqConfigured`, `openrouterConfigured`, `cloudflareConfigured`) without exposing secrets.
  - `POST /api/chat`: Central AI dispatch supporting both Server-Sent Events (SSE) streaming and atomic JSON responses.
  - `POST /api/upload`: Multipart file upload handler accepting up to 5 attachments per message (up to 25 MB each).
  - `GET /api/upload/config`: Returns upload limits, allowed file extensions, and file retention TTL.
  - `GET /api/upload/:id`: Returns attachment metadata and parsing status.
  - `GET /api/upload/:id/extraction`: Returns structured text extraction with page/slide boundaries.
  - `GET /api/upload/:id/file` (or `/download`): Serves original file with inline or attachment disposition.
  - `DELETE /api/upload/:id`: Deletes staged file before message dispatch.
- **Vercel Serverless Compatibility**: Lightweight handler wrappers in `api/chat.ts`, `api/config.ts`, `api/health.ts`, and `api/upload.ts` enable deployment on Vercel Functions.

### File Attachment & Upload Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              CLIENT BROWSER                            │
│                                                                        │
│  [File Input] ──────► [IndexedDB Blob Cache] (Local Persistence)       │
│       │                      │                                         │
│       │ FormData             │ Blob Fallback for Download / Preview    │
│       ▼                      ▼                                         │
│  POST /api/upload      GET /api/upload/:id/file                        │
└───────┬──────────────────────┬─────────────────────────────────────────┘
        │                      │
        ▼                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        EXPRESS SERVER (server.ts)                      │
│                                                                        │
│  1. Multer Storage: writes to uploads/temp/{uuid}.{ext}                │
│  2. Magic Number & Signature Verification: prevents masquerading files │
│  3. Document Extractor (src/services/documentExtractor.js):            │
│     - PDF (unpdf): page count, per-page text & boundaries              │
│     - DOCX (mammoth): headings, paragraphs, formatted tables           │
│     - PPTX (jszip): slide count, per-slide text & presenter notes      │
│     - Tabular (CSV/TSV): structured tables & markdown grid             │
│     - Text/MD/JSON/XML: clean text, sections & hierarchical trees      │
│  4. Automated TTL Cleanup: sweeps expired uploads every 15 minutes     │
│  5. Context Injection (src/services/documentContextService.js):        │
│     - Targets specific page/slide or whole document                    │
│     - Bounds context size to provider limits (Gemini, Groq, etc.)      │
│     - Appends document system prompt & user query                      │
└────────────────────────────────────────────────────────────────────────┘
```

### Database & Authentication Architecture
- **Firebase SDK**: Firebase Web SDK (`firebase` ^11.4.0).
- **Authentication**: Firebase Authentication with Email and Password provider. Includes session persistence, automated auth state synchronization, and friendly error normalization.
- **Cloud Database**: Cloud Firestore using a subcollection hierarchy:
  - Top-level user chat document: `/users/{userId}/chats/{chatId}`
  - Nested chronological message subcollection: `/users/{userId}/chats/{chatId}/messages/{messageId}`
- **Security Rules**: `firestore.rules` enforces user isolation (`request.auth.uid == userId`), message content validation (up to 100,000 characters), and title constraints.
- **Local Fallback Storage**: If Firebase is not configured or if the user chooses **Guest Mode**, chat threads, message histories, pinned statuses, and settings persist safely in browser `localStorage` and `sessionStorage`, while file attachments persist in browser `IndexedDB`.

---

## AI Providers & Selectable Models

Orvix implements a multi-model architecture where models are selectable via the top navigation dropdown (`ModelSelector.jsx`). Switching models retains the entire ongoing conversation history and any attached document context.

### Fully Implemented Providers

| Provider Name | Exact Model ID | Dropdown Label in UI | Streaming Support | Transport / Implementation |
|---|---|---|---|---|
| **Google Gemini** | `gemini-3.8-flash` (fallback: `gemini-3.1-flash-lite`) | `Gemini (Gemini 3.1 Flash Lite)` | Yes (SSE) | Server-side `@google/genai` TypeScript SDK with automatic jitter retries and model failover. |
| **Groq** | `llama-3.3-70b-versatile` / `openai/gpt-oss-120b` | `Groq (Llama 3.3 70B)` | Yes (SSE) | Server-side native `fetch` calling Groq's OpenAI-compatible completions endpoint. |
| **OpenRouter** | `openrouter/free` | `OpenRouter (Llama 3.3 70B (Free))` | Yes (SSE) | Server-side native `fetch` dynamically routing to available high-capacity free community models. |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | `Cloudflare Workers AI — Llama 3.1 8B` | Yes (SSE) | Server-side native `fetch` calling Cloudflare Workers AI REST API with streaming and JSON adaptation. |

### Provider Document Context Capacities

Because AI models possess differing prompt window sizes and token quotas, Orvix implements provider-aware document context bounding (`src/services/documentContextService.js`):

| Provider Name | Maximum Injected Context | Behavior on Large Documents |
|---|---|---|
| **Google Gemini** | **120,000 characters** (~30,000 words) | Full document ingested into broad Gemini context window. |
| **Groq** | **24,000 characters** (~6,000 words) | Safely bounded with transparent notice if content is truncated. |
| **OpenRouter** | **16,000 characters** (~4,000 words) | Safely bounded to prevent free gateway rate/token limits. |
| **Cloudflare Workers AI** | **16,000 characters** (~4,000 words) | Safely bounded to stay within edge worker context constraints. |

### In Progress Providers
- *(None currently in progress; all four listed providers are fully integrated and verified).*

### Planned Providers
- **Cerebras Inference** *(Planned)*: Ultra-high speed Llama inference.
- **Mistral AI** *(Planned)*: Native integration with Mistral Large and Codestral models.

---

### AI Provider Routing, Streaming & Fallbacks

- **Server-Sent Events (SSE)**: When the client requests streaming (`stream: true`), the server sends standard SSE chunks (`data: {"type":"chunk","text":"..."}`) and a completion marker (`data: {"type":"done", ...}`).
- **Pre-Stream Demand Check**: For Google Gemini, the server checks the initial token before sending HTTP 200 headers. If Google Gemini returns HTTP 503 high demand, the server retries with exponential backoff or fails over to `gemini-3.1-flash-lite`.
- **Cloudflare Streaming Adapter**: If Cloudflare responds with non-streaming JSON, `server.ts` automatically converts the JSON response into compliant SSE events (`start`, `chunk`, `done`), preserving the client streaming contract without failure.
- **Client Disconnection Safeguard**: When the user navigates away or stops generating, `res.on('close')` fires, immediately cancelling upstream fetch streams and saving API quota.
- **Context Retention Across Switching**: Switching between Gemini, Groq, OpenRouter, and Cloudflare Workers AI preserves all prior messages. Up to the last 12 messages and all active document references are formatted into the active provider's expected schema.

### Zero-Key Simulation Mode
If API keys or credentials (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) are missing or unconfigured:
- The server produces rich, context-aware simulated responses matching the selected Chat Mode, personalization settings, and uploaded document contents.
- When streaming, simulated responses are delivered token-by-token over SSE to test UI rendering, animations, and voice synthesis without friction.

---

## File Attachment & Document Understanding

Orvix features a complete, secure file attachment and document analysis pipeline that allows users to ask questions about uploaded files directly inside chat threads.

### Key Capabilities

1. **Multi-File Attachment**: Attach up to **5 files per message** via the paperclip button in the composer dock.
2. **Pre-Send Verification**: Preview attached files before sending, showing file name, file size badge, and format pill, with one-click staging removal.
3. **Sent Attachment Display**: Render sent attachments inside or directly alongside user messages with original filenames, format badges, and formatted sizes.
4. **Referenced Attachment Context**: Assistant messages visually display which documents were referenced to formulate the answer, maintaining clear provenance.
5. **Original File Viewing & Downloading**: Click any attachment card to open it inline in a new browser tab (for PDFs, text, and images) or download the original file with its exact original name.
6. **Persistence Across Reloads**: Original file blobs are cached in browser `IndexedDB`. If the user refreshes the page or reopens an old chat, attachments remain clickable and downloadable even if the server temporary cache has expired.
7. **Graceful Unavailable State**: If an attachment is no longer available locally or remotely, Orvix renders a clear unavailable-file badge rather than a broken link.
8. **Multi-Turn Document Memory**: Follow-up questions continue to reference the uploaded document without requiring re-uploading.

### Supported File Formats

| Format | Extension(s) | Parsing Engine | Capabilities & Notes |
|---|---|---|---|
| **PDF Document** | `.pdf` | `unpdf` | Page-level text extraction, page boundary tagging, total page counting, out-of-bounds page detection. |
| **Word Document** | `.docx` | `mammoth` | Structured markdown headings, paragraphs, lists, tables. Formats without rigid page boundaries are structured by section headings. |
| **PowerPoint** | `.pptx` | `jszip` | Per-slide text extraction, slide count detection, presenter speaker notes extraction (`ppt/notesSlides/`). |
| **Legacy PowerPoint** | `.ppt` | Binary detector | Detects legacy binary `.ppt` format and provides a helpful advisory to save as `.pptx` or `.pdf`. |
| **Plain Text & Markdown** | `.txt`, `.md`, `.markdown` | UTF-8 parser | Full text extraction, heading hierarchy detection, character/word counting. |
| **Tabular Data** | `.csv`, `.tsv` | Custom parser | Parses delimiters, generates formatted Markdown tables for AI reasoning, preserves raw rows. |
| **JSON Data** | `.json` | Native parser | Validates syntax, formats JSON tree, extracts top-level schema keys for AI context. |
| **XML Data** | `.xml` | Regex text parser | Strips tags for clean text content while retaining structural code snippet representation. |

### Document Questioning & Page/Slide Targeting

Users can query uploaded files in several ways:

- **Whole-File Summaries**:
  - *"Summarize this document"*
  - *"What are the main findings in this quarterly report?"*
  - *"Give me a bulleted executive overview of the attached PDF"*
- **Page-Specific PDF Inquiries**:
  - *"Explain page 3 of this document"*
  - *"What does page 5 say about revenue growth?"*
  - *(If a user requests page 12 on an 8-page document, Orvix detects the boundary and honestly explains that page 12 does not exist, rather than hallucinating).*
- **Page-Range Inquiries**:
  - *"Summarize pages 2 to 4"*
  - *"What topics are covered across pages 6 through 9?"*
- **Slide-Specific PowerPoint Inquiries**:
  - *"Explain slide 4"*
  - *"What does slide 2 show, and are there any presenter notes on it?"*
- **Multi-Document Synthesis**:
  - Attach multiple files (e.g., a PDF and a CSV) and ask: *"Compare the projected revenue in the report with the figures in the CSV."*

### Attachment Viewing & Downloading

- **Inline Preview**: For formats supported by modern browsers (PDF, TXT, images), clicking the attachment card opens the file in a new tab using a safe Blob URL or server stream.
- **Direct Download**: For presentations, documents, or spreadsheets, clicking **Download** retrieves the original binary file with its exact original filename preserved.
- **Copy Filename**: Users can copy the original filename with one click from the attachment action bar.

### Browser-Local IndexedDB & Server Storage Lifecycle

To provide resilient persistence without introducing expensive paid cloud storage:
- **Server Lifecycle**: Uploaded files are staged in `uploads/temp/` with secure UUIDs. An automated background sweep runs every 15 minutes to delete files older than `TEMP_FILE_TTL_MS` (default: 2 hours).
- **Client IndexedDB**: When a user selects a file, the raw `File`/`Blob` object is concurrently stored in browser `IndexedDB` under store `attachments`. When opening or downloading an attachment from chat history, Orvix checks IndexedDB first. This means attachments remain viewable and downloadable indefinitely on the user's device across browser sessions.
- **Security & Path Traversal Prevention**: Files are strictly stored using random UUIDs and whitelisted extensions. Server paths are never exposed to the client.

### Document Processing Limitations

- **Scanned / Rasterized PDFs**: PDFs that contain only scanned images without an embedded text layer cannot be parsed by text extraction. Orvix honestly identifies this condition and advises the user that OCR is required, rather than fabricating content.
- **Maximum File Size**: Default 25 MB per file (`MAX_FILE_SIZE_BYTES`).
- **Maximum Attachments**: Default 5 files per message (`MAX_ATTACHMENTS_PER_UPLOAD`).
- **Maximum Extraction Length**: Document text is capped at 500,000 characters (~100,000 words) to prevent runaway server memory usage.
- **Context Limits per Provider**: While Gemini ingests up to 120,000 characters, smaller providers (Groq, OpenRouter, Cloudflare) bound document context between 16,000 and 24,000 characters.

---

## Resilient Error UI & Recovery Architecture

When an upstream AI request fails (e.g. rate limit / quota exceeded, 503 high demand, network interruption), Orvix renders a dedicated, polished error card:

- **Contextual Diagnostics Header**: Displays a high-contrast icon badge, clear header (*"Rate Limit or Quota Exceeded"*, *"Service Temporarily Busy"*, *"AI Provider Service Error"*), and a model tag indicating which provider encountered the error.
- **Referenced Attachment Retention**: If an error occurs during document analysis, the attached document card remains visible inside the error container so the user knows which file was being analyzed.
- **Responsive Multi-Line Button Wrapping**: Recovery actions (`Retry with [Current]`, `Try with Gemini`, `Try with Groq`, `Try with OpenRouter`, `Edit prompt`) cleanly wrap across multiple lines on desktop, tablet, and mobile viewports (`display: flex; flex-wrap: wrap; gap: 8px; width: 100%;`).
- **Overflow Prevention**: Strict box-sizing, `max-width: 100%`, and `word-break: break-word` prevent long URLs, token IDs, or provider messages from overflowing outside the chat container.
- **Obsidian Dark & Clean Light Themes**: Custom styling with deep red/amber tints in dark mode and clean `#fff5f5` cards with dark crimson `#7f1d1d` text in light mode.

---

## Current Features (v0.3)

### Implemented Features

#### Document Understanding & Attachments (New in v0.3)
- **Multi-File Attachment**: Attach up to 5 files per message via the composer paperclip button.
- **Text & Structure Extraction**: Built-in parsers for PDF (`unpdf`), DOCX (`mammoth`), PPTX (`jszip`), CSV/TSV, TXT, MD, JSON, and XML.
- **Page & Slide Targeting**: Surgical question answering for specific PDF pages, page ranges, and PowerPoint slides.
- **Presenter Notes Extraction**: Extracts speaker notes associated with PowerPoint presentation slides.
- **Original File Download & Inline Preview**: Open PDFs and text inline in the browser or download original files.
- **IndexedDB Local Storage**: Client-side storage of attachment blobs in IndexedDB for persistent reloads.
- **Server Lifecycle Cleanup**: Automatic 15-minute sweep unlinking temporary files older than the configured TTL.
- **Provider Context Bounding**: Dynamic context truncation tailored to Gemini, Groq, OpenRouter, and Cloudflare.
- **Honest Scanned-PDF Detection**: Identifies image-only PDFs and requests OCR instead of hallucinating.

#### Conversational & AI Capabilities
- **Multi-Model Selection**: Seamlessly switch between Google Gemini, Groq, OpenRouter, and Cloudflare Workers AI.
- **Real-Time Token Streaming**: Server-Sent Events (SSE) streaming with progressive token reveal.
- **Multi-Turn Context Memory**: Passes up to the last 12 messages in chronological order to maintain multi-turn context.
- **Context Preservation across Providers**: Switch providers mid-conversation while retaining full context and attachments.
- **Simulated Demo AI**: Fully responsive in-memory response generator for local testing when API keys are absent.
- **Chat Modes**: Select from 4 modes (`General`, `Coding`, `Writing`, `Learning`) with specialized starter prompts and model instructions.
- **Starter Prompt Suggestions**: Category-tagged starter prompts on the welcome screen.
- **Message Retry & Edit-Resend**: One-click **Retry** for failed requests, or **Edit prompt** to load previous user text back into the composer.

#### Speech & Audio
- **Voice Dictation (Speech-to-Text)**: Speak directly into the message composer via browser Web Speech Recognition. Includes live recording indicator, audio wave animation, and pause/resume.
- **Verbal Punctuation Engine**: Automatically converts spoken verbal cues ("comma", "period", "question mark", "new line") into typography, with phonetic tech corrections (e.g. "Orvix", "JavaScript", "API").
- **Multilingual Dictation**: Supports 9 spoken language options (English US/UK/PK, Urdu, Spanish, French, German, Arabic, Hindi).
- **Text-to-Speech (Read Aloud)**: Click the speaker icon on any assistant message to read it aloud using Web Speech Synthesis.
- **Speech Controls**: Pause, resume, stop, adjust playback speed (0.75x to 2.0x), and select system voices in Settings.

#### Persistence & Conversation Management
- **Cloud Firestore Storage**: Automatically syncs chats and messages for authenticated users with real-time updates (`onSnapshot`).
- **Subcollection Message Architecture**: Messages are stored in subcollections to eliminate 1MB single-document limits.
- **Atomic Batch Deletion**: Safely purges message subcollections in batches before removing the parent chat document.
- **Guest / Demo Mode**: Instant access with no credentials needed. Conversations persist across browser refreshes via `localStorage` and `sessionStorage`, while file attachments persist in `IndexedDB`.
- **Conversation Pinning (5-Chat Limit)**: Pin up to 5 priority chats to the top of the sidebar.
- **Inline Renaming**: Rename any conversation directly from the sidebar item.
- **Auto-Generated Titles**: Automatically derives concise titles from the user's initial prompt.

#### UI, Personalization & Export
- **Obsidian Dark & Clean Light Themes**: Instant theme switching (`Dark`, `Light`, `System`) with zero-flash early initialization.
- **Personalization Settings**: Modal to configure theme, response length (`Concise`, `Balanced`, `Detailed`), beginner-friendly explanation toggle, default chat mode, Enter-to-send toggle, and timestamps.
- **Client-Side Export**: Export the active conversation to **Markdown (`.md`)** or **Plain Text (`.txt`)** directly in the browser with sanitized filenames.
- **Responsive Layout**: Collapsible sidebar navigation, mobile drawer overlay, auto-resizing composer textarea, and custom scrollbars.
- **PWA Ready**: Web App Manifest (`manifest.webmanifest`), home screen icons, theme color, and install prompt integration.

### In Progress Features
- *(All core features scheduled for v0.3 are fully implemented and verified)*.

### Planned & Future Features
- **Optical Character Recognition (OCR)** *(Planned)*: Extract text from scanned/image-only PDFs via Tesseract or Google Cloud Vision.
- **Guest-to-Account History Migration** *(Planned)*: Transfer locally cached guest conversations and IndexedDB attachments into a new user account upon registration.
- **Image Generation & Visual Modalities** *(Planned)*: Support image generation and image analysis via Gemini 2.5 Flash Image.
- **Global Message Search** *(Planned)*: Full-text search across all saved conversation titles and message contents in the sidebar.
- **Custom System Instructions Editor** *(Planned)*: Allow users to specify arbitrary custom prompt directives beyond the predefined chat modes.

---

## Project Structure & Important Files

### Directory Tree

```text
Orvix/
├── .env.example                       # Environment variable reference template
├── .gitignore                         # Git ignore specifications
├── README.md                          # Comprehensive project documentation
├── api/                               # Serverless entry points for Vercel deployment
│   ├── chat.ts                        # /api/chat handler wrapper
│   ├── config.ts                      # /api/config handler wrapper
│   ├── health.ts                      # /api/health handler wrapper
│   └── upload.ts                      # /api/upload handler wrapper
├── firebase-blueprint.json            # Blueprint database schema definition
├── firestore.rules                    # Production Firestore database security rules
├── index.html                         # SPA HTML entry point with theme bootstrap
├── metadata.json                      # AI Studio applet capabilities and metadata
├── package.json                       # NPM dependencies, scripts, and package metadata
├── public/                            # Static public assets, icons, and PWA manifest
│   ├── apple-touch-icon.png           # iOS home screen icon
│   ├── favicon.ico                    # Browser favicon
│   ├── favicon.svg                    # SVG vector favicon
│   ├── icon-192.png                   # 192x192 PWA manifest icon
│   ├── icon-512.png                   # 512x512 PWA manifest icon
│   └── manifest.webmanifest           # Progressive Web App manifest
├── server.ts                          # Express server, Vite middleware, upload & AI proxy
├── src/                               # React 19 client application source code
│   ├── App.jsx                        # Root application container & auth router
│   ├── index.css                      # Global CSS entry loading Tailwind and styles
│   ├── main.jsx                       # Application entry point mounting to DOM
│   ├── components/                    # Modular UI components
│   │   ├── auth/
│   │   │   └── AuthScreen.jsx         # Email/password authentication & guest mode launcher
│   │   ├── chat/
│   │   │   ├── AttachmentCard.jsx     # Interactive attachment card (view, download, copy)
│   │   │   ├── ChatArea.jsx           # Message viewport, composer dock & file staging
│   │   │   ├── ChatMessage.jsx        # Message bubble, error card, markdown, speech & copy
│   │   │   ├── CodeBlock.jsx          # Syntax-highlighted code block with copy action
│   │   │   ├── ExportChatMenu.jsx     # Export dropdown for Markdown and Plain Text
│   │   │   ├── MessageList.jsx        # Virtualized message list with auto-scroll pinning
│   │   │   ├── ModeSelector.jsx       # Chat mode switcher (General, Coding, Writing, Learning)
│   │   │   ├── ModelSelector.jsx      # AI provider switcher (Gemini, Groq, OpenRouter, Cloudflare)
│   │   │   ├── PromptSuggestions.jsx  # Welcome screen starter prompt cards
│   │   │   ├── TypingIndicator.jsx    # Pulsing three-dot thinking indicator
│   │   │   └── WelcomeScreen.jsx      # Empty conversation welcome state
│   │   ├── layout/
│   │   │   ├── Header.jsx             # Navigation bar, model selector, title & actions
│   │   │   ├── Layout.jsx             # Responsive shell managing sidebar and backdrop
│   │   │   ├── Sidebar.jsx            # Conversations drawer, pinned list & user profile
│   │   │   └── SidebarChatItem.jsx    # Chat item with pin, inline rename & delete
│   │   ├── settings/
│   │   │   └── SettingsModal.jsx      # Personalization settings dialog
│   │   └── ui/
│   │       ├── Button.jsx             # Reusable button primitive with variants
│   │       └── OrvixLogo.jsx          # Orvix branding logo component
│   ├── config/                        # Static configuration and constants
│   │   ├── appConfig.js               # App metadata, defaults, and starter prompt templates
│   │   ├── chatModes.js               # Chat mode definitions, icons, and instructions
│   │   ├── firebaseConfig.js          # Firebase SDK initialization and validation
│   │   └── sampleData.js              # Offline mock conversation demonstration data
│   ├── context/                       # React Context state providers
│   │   ├── AuthContext.jsx            # Authentication state, login, signup, and guest mode
│   │   ├── SettingsContext.jsx        # Theme, response preferences, and composer settings
│   │   └── SpeechContext.jsx          # Web Speech synthesis, voices, and read-aloud state
│   ├── hooks/                         # Reusable React hooks
│   │   ├── usePWAInstall.js           # PWA install prompt handler
│   │   └── useVoiceDictation.js       # Web Speech recognition and verbal punctuation hook
│   ├── pages/
│   │   └── ChatPage.jsx               # Primary chat screen orchestrating state & attachments
│   ├── services/                      # Business logic and external API integrations
│   │   ├── aiRouter.js                # Central AI dispatch, streaming, and error parsing
│   │   ├── attachmentStorageService.js# Browser IndexedDB attachment blob persistence
│   │   ├── authService.js             # Firebase Auth wrapper with error normalization
│   │   ├── chatStorageService.js      # Firestore CRUD, batch deletion, and pinning logic
│   │   ├── documentContextService.js  # Targeted document formatting & context bounding
│   │   ├── documentExtractor.js       # Server-side text & structure extraction engine
│   │   ├── geminiService.js           # Google Gemini client fallback integration
│   │   ├── groqService.js             # Groq client fallback integration
│   │   ├── index.js                   # Service module index
│   │   ├── mockChatService.js         # Local simulated response generator
│   │   ├── openrouterService.js       # OpenRouter client fallback integration
│   │   ├── userProfileService.js      # Firestore user profile read/write
│   │   └── userSettingsService.js     # User settings persistence in Firestore & localStorage
│   ├── styles/
│   │   └── index.css                  # Comprehensive Obsidian & Light theme design system
│   └── utils/                         # Helper utilities
│       ├── exportConversation.js      # Markdown and Plain Text file generation & download
│       ├── speechTextCleaner.js       # Cleans markdown for natural voice synthesis
│       └── syntaxHighlighter.js       # Keyword syntax highlighter for code blocks
├── test_all_providers_documents.js    # Multi-provider document context test suite
├── test_document_handling.js          # Document extraction & page-boundary test suite
├── tsconfig.json                      # TypeScript compiler configuration
├── uploads/                           # Temporary file staging directory (auto-cleaned)
│   └── temp/                          # Staging files with UUID filenames
├── vercel.json                        # Vercel deployment configuration
└── vite.config.ts                     # Vite bundler, plugin, and dev server configuration
```

### Important Files & Modules

- **`server.ts`**: The backend server. Handles `/api/chat` SSE streaming, `/api/upload` multipart file handling with magic number validation, temporary file lifecycle management, and mounts Vite in development.
- **`src/services/documentExtractor.js`**: Core document parser utilizing `unpdf` for PDF, `mammoth` for DOCX, `jszip` for PPTX, and dedicated parsers for CSV, TSV, JSON, XML, and Markdown.
- **`src/services/documentContextService.js`**: Analyzes user prompts for page/slide targets, formats extracted text, and bounds context sizes to fit specific provider token limits.
- **`src/services/attachmentStorageService.js`**: Browser IndexedDB database manager (`orvix_attachments_db`) ensuring attached files remain viewable and downloadable offline across reloads.
- **`src/components/chat/AttachmentCard.jsx`**: User-facing attachment badge displaying original filename, format pill, size indicator, and actions (Open, Download, Copy filename).
- **`src/components/chat/ChatMessage.jsx`**: Message bubble rendering, referenced document chips, Markdown formatting, and responsive multi-line error recovery cards.
- **`src/pages/ChatPage.jsx`**: Coordinates active conversation state, staged attachments, streaming response tokens, Firestore/local persistence, and provider failover.

---

## Environment Variables & Configuration

Environment variables are defined in `.env` in the root directory. Use `.env.example` as a template.

> **Security Note**: Never commit actual API keys or credentials to version control. Variables prefixed with `VITE_` are exposed to the client bundle. AI provider keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) belong exclusively in the server-side environment to protect secrets.

### Configuration Reference Table

| Variable Name | Required? | Environment Scope | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Optional | Server-side | Google Gemini API key used by the backend Express proxy (`server.ts`). |
| `GROQ_API_KEY` | Optional | Server-side | Groq API key used by the backend Express proxy (`server.ts`). |
| `OPENROUTER_API_KEY` | Optional | Server-side | OpenRouter API key used by the backend Express proxy (`server.ts`). |
| `CLOUDFLARE_ACCOUNT_ID` | Optional | Server-side | Cloudflare Account ID for Workers AI REST API requests. |
| `CLOUDFLARE_API_TOKEN` | Optional | Server-side | Cloudflare API Token with Workers AI read/execute permissions. |
| `MAX_FILE_SIZE_BYTES` | Optional | Server-side | Maximum upload file size in bytes (defaults to `26214400` = 25 MB). |
| `MAX_ATTACHMENTS_PER_UPLOAD` | Optional | Server-side | Maximum files allowed per upload (defaults to `5`). |
| `TEMP_FILE_TTL_MS` | Optional | Server-side | Retention time for temporary server files in milliseconds (defaults to `7200000` = 2 hours). |
| `PORT` | Optional | Server-side | Server port (defaults to `3000`). |
| `NODE_ENV` | Optional | Server-side | Runtime environment (`development` or `production`). |
| `VITE_FIREBASE_API_KEY` | Optional | Client-side | Firebase Web API key for authentication and Firestore sync. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Optional | Client-side | Firebase Auth domain (e.g., `your-project.firebaseapp.com`). |
| `VITE_FIREBASE_PROJECT_ID` | Optional | Client-side | Firebase project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET`| Optional | Client-side | Firebase Cloud Storage bucket URL. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Optional | Client-side | Firebase Cloud Messaging sender ID. |
| `VITE_FIREBASE_APP_ID` | Optional | Client-side | Firebase Web application ID. |

### Configuration Template (`.env.example`)

```ini
# Server-Side AI API Keys (Recommended for security)
GEMINI_API_KEY=your_gemini_api_key_here
GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id_here
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token_here

# File Upload & Attachment Lifecycle Configuration
MAX_FILE_SIZE_BYTES=26214400
MAX_ATTACHMENTS_PER_UPLOAD=5
TEMP_FILE_TTL_MS=7200000

# Client-Side Firebase Configuration (Optional - for cloud persistence & auth)
VITE_FIREBASE_API_KEY=your_firebase_api_key_here
VITE_FIREBASE_AUTH_DOMAIN=your-app.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-app-id
VITE_FIREBASE_STORAGE_BUCKET=your-app.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id

# Server Runtime Configuration
PORT=3000
NODE_ENV=development
```

---

## Prerequisites & Setup Instructions

### Prerequisites
- **Node.js**: Version `20.x` or `22.x` LTS (`node -v`).
- **NPM**: Version `10.x` or higher (`npm -v`).
- **Web Browser**: Modern browser with IndexedDB, Web Speech API, and JavaScript enabled (Chrome, Edge, Safari, Firefox).

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Hannankhan203/AI-Studio.git
   cd AI-Studio
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:
   ```bash
   cp .env.example .env
   ```
   Add your API keys to `.env` if available. If no keys are provided, Orvix automatically operates in **Guest / Demo Mode** with simulated responses.

### Running in Development

To start the full-stack development server:

```bash
npm run dev
```

- Runs `tsx server.ts`.
- Binds Express to `http://0.0.0.0:3000`.
- Mounts Vite in middleware mode for hot client reloads while serving live `/api/chat` and `/api/upload` endpoints.
- Open your browser to `http://localhost:3000`.

### Building for Production

To create a production build of the frontend:

```bash
npm run build
```

This compiles client assets into the `dist/` directory.

### Running the Production Server

To run the full-stack application in production mode:

```bash
npm start
```

This runs `node server.ts`, which serves the compiled static files from `dist/` and handles API requests on port 3000.

### Type Checking & Linting

To run static type checking across the codebase:

```bash
npm run lint
```

This executes `tsc --noEmit` to validate all TypeScript files without generating output files.

### Running the Document Test Suites

To verify document extraction, page boundary detection, and multi-provider compatibility:

```bash
# Test document handling and page/slide boundary logic (9 test suites)
node test_document_handling.js

# Test multi-provider context bounding and live /api/chat integration (8 test suites)
node test_all_providers_documents.js
```

---

## Firebase Setup & Security Rules

To enable cloud authentication and persistent synchronization across devices:

1. Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** and activate the **Email/Password** provider.
3. Enable **Cloud Firestore Database** in production mode.
4. Copy the web app configuration parameters into your `.env` file under `VITE_FIREBASE_*`.
5. Deploy the provided `firestore.rules`:
   - Can be pasted directly in the Firebase Console under **Firestore Database > Rules**.
   - Ensures users can only read, write, and delete their own `/users/{userId}/chats/*` records.

*Note: If Firebase credentials are not provided, Orvix automatically activates Guest Mode with local storage and IndexedDB persistence.*

---

## Deployment Information

Orvix is structured for flexible deployment across various platforms:

### 1. Node.js Container / Cloud Run / VPS
Because Orvix includes a self-contained Express server (`server.ts`), it can be deployed directly on any Node.js container or server:
```bash
npm install
npm run build
export NODE_ENV=production
export PORT=3000
npm start
```

### 2. Vercel
The repository includes `vercel.json` and standalone function handlers in `api/`:
- `api/chat.ts` routes chat completions to the AI proxy.
- `api/upload.ts` routes multipart file uploads.
- `api/health.ts` and `api/config.ts` provide serverless utility endpoints.
- Vite build output is configured to `dist/`.

---

## Current Limitations

- **Scanned PDFs Without OCR**: PDFs containing exclusively rasterized images cannot be parsed without an OCR engine. Orvix returns a transparent diagnostic indicating OCR is required.
- **Legacy PowerPoint Binary Format (`.ppt`)**: Direct binary text extraction is only supported for modern OpenXML `.pptx` presentations. For `.ppt` files, Orvix advises saving as `.pptx` or `.pdf`.
- **Guest-to-Account Migration**: Conversations created in Guest Mode reside in local browser storage; registering an account does not currently migrate guest chats or IndexedDB files into Firestore.
- **Client-Side Pin Limit Enforcement**: The 5-pinned-chat constraint is enforced in client application state and Firestore query logic, but not in database security rules due to Firestore rule constraints on aggregate counts.
- **Speech Synthesis Browser Variance**: Voices available for Read Aloud depend on the host operating system and browser synthesizer capabilities.

---

## Version History & Changelog

### v0.3 — File Attachment & Document Understanding Integration
- **File Attachment & Multipart Upload Pipeline**:
  - Implemented secure multipart file upload endpoint (`POST /api/upload`) using `multer` with configurable limits (`MAX_FILE_SIZE_BYTES=25MB`, `MAX_ATTACHMENTS_PER_UPLOAD=5`).
  - Added binary magic number and file signature verification to prevent file masquerading or malicious execution.
  - Implemented secure server-side file isolation with UUID-based disk names in `uploads/temp/` to prevent path traversal attacks.
  - Added automated background cleanup task running every 15 minutes to unlink temporary files exceeding the configurable TTL (default: 2 hours).
- **Document Text & Structure Extraction**:
  - Integrated `unpdf` for PDF documents, supporting per-page text extraction, page boundary tagging, and total page counting.
  - Integrated `mammoth` for Word documents (`.docx`), extracting structured headings, paragraphs, and formatted tables.
  - Integrated `jszip` for PowerPoint presentations (`.pptx`), parsing slide-by-slide text, slide counts, and presenter speaker notes (`ppt/notesSlides/`).
  - Added structured parsing for Tabular Data (`.csv`, `.tsv`), JSON data, XML, and Markdown/Plain Text.
  - Implemented honest detection for scanned/image-only PDFs and legacy `.ppt` files with actionable diagnostics.
- **Targeted Document Questioning**:
  - Built `documentContextService.js` to parse user queries for targeted pages (*"Explain page 3"*), page ranges (*"Summarize pages 2 to 4"*), and slides (*"Explain slide 2"*).
  - Added boundary validation to honestly notify users if a requested page or slide exceeds the document's bounds.
  - Implemented provider-aware context bounding, providing up to 120,000 characters for Google Gemini and safely bounding Groq, OpenRouter, and Cloudflare.
- **Attachment Display, Viewing & Downloading**:
  - Created interactive `AttachmentCard.jsx` displaying original filename, format badge, and formatted size.
  - Enabled inline viewing for supported formats (PDF, text) and one-click downloading for original files with preserved filenames.
  - Added `src/services/attachmentStorageService.js` using browser `IndexedDB` (`orvix_attachments_db`) to cache raw file blobs locally, ensuring attachments persist across page reloads and browser sessions.
  - Added referenced document chips on assistant messages to maintain visual provenance while models explain files.
- **Error UI & Recovery Redesign**:
  - Completely overhauled `error-message-box` into a responsive card with contextual header (*"Rate Limit or Quota Exceeded"*, *"Service Temporarily Busy"*), provider badge, and referenced attachments.
  - Added responsive multi-line wrapping (`flex-wrap: wrap`) for all recovery buttons (`Retry with [Model]`, `Try with Gemini`, `Try with Groq`, `Try with OpenRouter`, `Edit prompt`), preventing horizontal overflow across desktop, tablet, and mobile screens.
  - Added first-class Light Theme support with dark crimson `#7f1d1d` text and clean card borders.

### v0.2 — Cloudflare Workers AI Integration
- **Single AI Model Addition**:
  - Integrated **Cloudflare Workers AI — Llama 3.1 8B** (`@cf/meta/llama-3.1-8b-instruct`) as an independently selectable AI provider.
  - Connected via Cloudflare's official REST API endpoint: `https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`.
  - Implemented Server-Sent Events (SSE) streaming support and server-side JSON fallback adaptation in `server.ts`.
  - Added multi-turn conversation history conversion and dynamic persona/mode system instructions.
  - Created selectable dropdown option labeled `Cloudflare Workers AI — Llama 3.1 8B` in `ModelSelector.jsx`.
  - Added server-side environment variables `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to `.env.example` and documentation.
  - Added simulated fallback responses for zero-friction testing when Cloudflare credentials are unconfigured.
  - Added `cloudflareConfigured` status property to the `/api/config` endpoint.

### v0.1 — Initial Development Version
- **Initial Release**:
  - Implemented React 19 SPA frontend with Obsidian Dark and Clean Light themes.
  - Implemented Express backend (`server.ts`) with Vite middleware mode on port 3000.
  - Integrated Google Gemini (`gemini-3.8-flash` / `gemini-3.1-flash-lite`) via `@google/genai` with streaming SSE and model failover.
  - Integrated Groq (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via OpenAI-compatible REST endpoint.
  - Integrated OpenRouter (`openrouter/free`) via OpenAI-compatible REST endpoint.
  - Built zero-key simulated response fallback engine for instant prototype testing.
  - Added 4 conversational Chat Modes (`General`, `Coding`, `Writing`, `Learning`) with specialized instructions and starter prompts.
  - Implemented Web Speech Recognition voice dictation with verbal punctuation engine and 9 language options.
  - Implemented Web Speech Synthesis read-aloud with voice selection, rate adjustments, and markdown cleaning.
  - Implemented Cloud Firestore persistence with subcollections, real-time sync, and batch deletions.
  - Implemented Guest / Demo Mode with `localStorage` and `sessionStorage` fallback.
  - Added conversation pinning with a 5-chat limit and inline title editing.
  - Added client-side Markdown (`.md`) and Plain Text (`.txt`) conversation export.
  - Configured Progressive Web App manifest and install hooks.
