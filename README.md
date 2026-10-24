# Orvix

![Version](https://img.shields.io/badge/version-0.1.0-2563eb)
![React](https://img.shields.io/badge/React-19.0-61dafb)
![Vite](https://img.shields.io/badge/Vite-8.3-646cff)
![TypeScript](https://img.shields.io/badge/Server-Express%20%2B%20TS-3178c6)

**Current Version: v0.1.0**

**Orvix** is a full-stack, multi-model AI conversational workspace built with React 19, Vite, Tailwind CSS v4, and an Express + TypeScript backend proxy. It supports cloud AI streaming (Google Gemini, Groq, OpenRouter, Cloudflare Workers AI), local server inference (Ollama), and **on-device WebGPU inference (Browser AI via WebLLM)** with Progressive Web App (PWA) offline app-shell caching, client- and server-side document extraction, dual-format clipboard copying, voice dictation, and four specialized chat modes.

---

## Table of Contents

1. [Key Features](#1-key-features)
2. [What's New in v0.1.0 (Changelog)](#2-whats-new-in-v010-changelog)
3. [Technologies & Architecture Overview](#3-technologies--architecture-overview)
4. [AI Providers & Chat Modes](#4-ai-providers--chat-modes)
5. [PWA, Offline Capabilities & Browser AI Requirements](#5-pwa-offline-capabilities--browser-ai-requirements)
6. [Document & Image Attachments](#6-document--image-attachments)
7. [Voice Dictation & Read-Aloud](#7-voice-dictation--read-aloud)
8. [Installation & Local Setup](#8-installation--local-setup)
9. [Environment Variables & API Key Configuration](#9-environment-variables--api-key-configuration)
10. [Available Scripts](#10-available-scripts)
11. [Project Structure](#11-project-structure)
12. [Known Limitations & Setup Notes](#12-known-limitations--setup-notes)

---

## 1. Key Features

- **Multi-Provider AI Routing**: Switch between **Google Gemini**, **Groq**, **OpenRouter**, **Cloudflare Workers AI**, **Local AI (Ollama)**, and **Browser AI (WebLLM)**. Compare outputs across models on any assistant turn via non-destructive `< X of Y >` response alternatives.
- **On-Device Browser AI (WebLLM & WebGPU)**: Run quantized **Qwen 2.5 Instruct** models (`0.5B` lightweight and `1.5B` standard) directly in the browser inside a dedicated Web Worker off the main thread—requiring zero API keys and sending zero prompt data to external servers.
- **Offline PWA App-Shell & Local Document Parsing**: Workbox precaches the production application shell, WebLLM worker chunks, and client-side document parsers (`unpdf`, `mammoth`, `jszip`). After an initial online visit and model download, Orvix can reopen offline to chat and extract text from supported documents locally.
- **Four Specialized Chat Modes**: Dedicated **General Assistant**, **Coding**, **Writing**, and **Learning** modes with tailored system instructions, starter prompts, educational callout detection, editorial prose layouts, and VS Code-style code blocks.
- **Dual-Format Clipboard Copying**: Copies assistant responses simultaneously as styled `text/html` (for Google Docs, Word, Slack, and email) and structured `text/plain` record layouts (`• Header: Value`) so Markdown tables remain readable in plain-text messaging apps such as WhatsApp and Telegram.
- **Multimodal Attachments & Server OCR**: Attach one file per message (up to 25 MB) via file picker, clipboard paste (`Ctrl+V` / `Cmd+V`), or drag-and-drop. Supports PDFs, Word (`.docx`), PowerPoint (`.pptx` with speaker notes), CSV/TSV, JSON, XML, TXT/Markdown, and images (with server-side `tesseract.js` OCR and binary header verification).
- **Cross-Platform Voice Dictation & Read-Aloud**: Combines live browser speech recognition (interim snapshot replacement without word duplication) with optional server-side Whisper Large v3 Turbo refinement, 9 language locales, and Web Speech API text-to-speech playback (`Play`, `Pause`, `Resume`, `Stop`).
- **Flexible Persistence & Zero-Key Simulation Mode**: Supports Firebase Authentication + Cloud Firestore sync for signed-in users, `localStorage` + `IndexedDB` persistence for Guest Mode, and an automatic Simulated Mode when cloud API keys are not configured.

---

## 2. What's New in v0.1.0 (Changelog)

Version **0.1.0** consolidates the Orvix application metadata under a unified version (`0.1.0`, replacing the previous `0.9.4` / `0.9.0` split) and delivers a comprehensive **Desktop UI/UX, Accessibility, and Performance** update while preserving mobile and PWA workflows:

### Desktop Layout, Navigation & Composer Enhancements
- **Responsive Desktop Viewport Scaling**: Added progressive layout sizing across standard and widescreen desktop monitors (`1280px`, `1441px+`, `1921px+`, and `2560px+`), scaling the sidebar (`280px`–`320px`) and reading/composer column (`780px`–`980px`) for balanced line lengths and margins.
- **Header & Sidebar Polish**: Improved active conversation title truncation, header control alignment, account popover dialog behavior, and sidebar conversation actions (`Pin`, `Rename`, `Delete`). Replaced icon-only delete confirmation in the sidebar with an explicit labeled inline confirmation bar (`Delete?` → `Delete` / `Cancel`).
- **Balanced Desktop Message Composer**: Refined composer padding, placeholder clarity, multiline auto-resize alignment (up to `180px`), attachment staging chips, and dictation strip layout so controls remain aligned and unobscured as input grows. Clearly distinguished **Send** (`Enter`) and **Stop** (`Esc`) states.

### Secondary Desktop Interfaces, Modals & Status Displays
- **Browser AI Status Bar**: Improved visual distinction between **Ready**, **Cached**, **Downloading**, **Offline**, **Unavailable**, and **Error** states with semantic badges, determinate/indeterminate progress bars (`role="progressbar"`), and actionable next-step guidance.
- **Settings, Preview & Auth Screens**: Enhanced the Personalization Settings modal, dual-tab Document/Image Preview modal, Export Conversation menu, and Authentication / Guest Mode screen with consistent spacing, clear labels, and light/dark theme contrast.

### Accessibility & Keyboard Interaction
- **Dialog & Menu Keyboard Navigation**: Added focus trapping (`Tab` / `Shift+Tab`), `Escape` dismissal (including nested reset confirmation handling), and trigger focus restoration to `SettingsModal` and `DocumentPreviewModal`. Added arrow-key navigation (`ArrowDown`, `ArrowUp`, `Home`, `End`) to the Mode Selector, Export Chat menu, Alternative Model selector, and Auth/Preview tablists.
- **Focus Visibility & Nested Controls**: Added consistent `:focus-visible` outlines across interactive cards, buttons, and scrollable code/table regions (`tabIndex={0}`), plus `:focus-within` rules so hover-revealed action buttons on sidebar items and attachment cards become visible when tabbed to via keyboard. Fixed nested keyboard activation on `AttachmentCard` and `ImageAttachmentCard` so pressing `Enter` or `Space` on inner Preview/Download buttons triggers them cleanly.
- **Global Type-to-Focus & Reduced Motion**: Updated global typing capture guards to respect `[role="alertdialog"]`, `role="radio"`, `role="tab"`, `role="switch"`, and `role="checkbox"`, and added `Escape` dismissal to the transcript polish review dialog. Expanded `@media (prefers-reduced-motion: reduce)` to disable non-essential pulsing, bouncing, and modal entrance animations.

### Rendering Performance & Bug Fixes
- **Isolated Streaming & Composer Rendering**: Wrapped `MessageList`, `ChatMessage`, and `CodeBlock` in `React.memo` and stabilized message action callbacks in `ChatArea.jsx`, preventing full-thread Markdown and syntax-highlighting re-renders on every composer keystroke and isolating streaming updates to the active message.
- **Resource & Lifecycle Fixes**: Fixed a premature `URL.revokeObjectURL` cleanup in `ChatArea.jsx` that revoked image attachment `previewUrl` blobs upon message submission; gated the `SpeechContext` 1-second watchdog interval so it runs only while speech is actively playing; and removed hardcoded client-side API key fallbacks in `groqService.js` and `openrouterService.js`.

*(Note: Mobile-specific features such as main-area swipe-to-open navigation and mobile PWA live dictation remain preserved from prior iterations.)*

---

## 3. Technologies & Architecture Overview

Orvix uses a client-server architecture where the Express backend serves the Vite middleware in development and the compiled `dist/` bundle in production, while proxying all cloud AI, transcription, and upload/OCR requests server-side.

- **Frontend**: React 19 (`react`, `react-dom`), Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`), Lucide React icons, `react-markdown`, and `remark-gfm`.
- **Backend Server (`server.ts` & `api/*`)**: Express 4 running on Node.js with `tsx` in development and serverless route adapters (`api/chat.ts`, `api/config.ts`, `api/health.ts`, `api/transcribe.ts`, `api/upload.ts`) for Vercel deployments.
- **On-Device & Cloud AI**: `@mlc-ai/web-llm` in a dedicated Web Worker (`src/workers/webllmWorker.js`) for local WebGPU inference; `@google/genai` SDK for Google Gemini; REST/SSE streaming for Groq, OpenRouter, Cloudflare Workers AI, and local Ollama.
- **Document & OCR Processing**: `unpdf` (PDF text extraction), `mammoth` (DOCX parsing), `jszip` (PPTX slide & speaker note extraction), and `tesseract.js` (server-side image OCR with `multer` in-memory staging).
- **Persistence & PWA**: Firebase Authentication & Cloud Firestore (authenticated cloud sync), `localStorage` (Guest Mode chats & settings), `IndexedDB` (`orvix_attachments_db` for binary attachments), and `vite-plugin-pwa` / Workbox (`dist/sw.js`).

---

## 4. AI Providers & Chat Modes

### Supported AI Providers

| Provider | Default / Configured Model(s) | Execution Location | Requirements |
| :--- | :--- | :--- | :--- |
| **Google Gemini** *(Default)* | `gemini-3.8-flash` (fallback: `gemini-3.1-flash-lite`) | Server-side proxy (`/api/chat`) | Internet + `GEMINI_API_KEY` |
| **Groq** | `llama-3.3-70b-versatile` / `openai/gpt-oss-120b` | Server-side proxy (`/api/chat`) | Internet + `GROQ_API_KEY` |
| **OpenRouter** | `openrouter/free` (Llama 3.3 70B Free / dynamic routing) | Server-side proxy (`/api/chat`) | Internet + `OPENROUTER_API_KEY` |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | Server-side proxy (`/api/chat`) | Internet + `CLOUDFLARE_ACCOUNT_ID` & `CLOUDFLARE_API_TOKEN` |
| **Local AI (Ollama)** | `qwen2.5:1.5b` (or local Ollama model) | Local server proxy (`127.0.0.1:11434`) | Local Orvix server + running Ollama daemon |
| **Browser AI (WebLLM)** | `Qwen2.5-0.5B-Instruct` & `Qwen2.5-1.5B-Instruct` (`q4f16_1` / `q4f32_1`) | 100% client-side in browser Web Worker | WebGPU-capable browser + one-time model download (~420 MB or ~960 MB); works offline once cached |

> **Simulated Fallback Mode**: When cloud provider API keys are not set in `.env`, cloud provider requests automatically fall back to Orvix's built-in Simulated Mode (`mockChatService.js`) so the UI, modes, attachments, and export workflows can be explored immediately without credentials.

### Available Chat Modes

1. **General Assistant (`general`)**: Balanced, versatile assistant for everyday questions, planning, and comparisons.
2. **Coding (`coding`)**: Prioritizes clean software architecture, debugging, edge-case analysis, and VS Code-styled code blocks with locked 22px line-number alignment and pure-source copying.
3. **Writing (`writing`)**: Tuned for drafting, editing, and tone adjustment with editorial line widths (`76ch`), memo/email header formatting (`Subject:`, `To:`, `From:`), and styled blockquotes.
4. **Learning (`learning`)**: Step-by-step explanations with analogies and automatic detection of 8 semantic educational callout blocks (*Important*, *Warning*, *Note*, *Tip*, *Key Takeaway*, *Definition*, *Example*, *Comparison*).

---

## 5. PWA, Offline Capabilities & Browser AI Requirements

Orvix separates offline caching into two independent tiers:

1. **Tier 1 — App-Shell Precache (Workbox Service Worker)**:
   - Configured in `vite.config.ts` via `vite-plugin-pwa`. Precaches the HTML entry point, CSS, JS bundles, icons, WebLLM worker, and client document parsers (`mammoth`, `unpdf`, `jszip`).
   - API routes (`/api/*`, `/chat`, `/config`, `/health`, `/transcribe`, `/upload`) are excluded via `navigateFallbackDenylist` and `NetworkOnly` rules so API calls never return cached HTML.
2. **Tier 2 — Model Weight Cache (Browser Cache Storage)**:
   - WebLLM stores quantized model shards (~420 MB for `0.5B`, ~960 MB for `1.5B`) inside browser Cache Storage (`webllm/model`, `webllm/config`, `webllm/wasm`).
   - Model weights are downloaded on demand when the user clicks **Load Model** or sends a message with Browser AI selected.

### Requirements for Offline Use
- **Initial Online Setup**: You must open Orvix while online at least once so the service worker precaches the app shell, and you must download a Browser AI model until the status bar shows **Ready**.
- **Compatible Hardware & Browser**: Browser AI requires a WebGPU-enabled browser (Chrome 113+, Edge 113+, or Safari 18+) over HTTPS or `localhost` with hardware acceleration enabled. Devices without `shader-f16` automatically fall back to `q4f32_1` model variants.
- **Offline Scope**: Once cached, the UI, local chat history, Browser AI generation, and client-side document extraction (`.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.xml`, `.docx`, `.pptx`, and digital-text `.pdf`) work offline. Cloud providers, Firebase authentication/cloud sync, server Whisper transcription, and image/scanned-PDF OCR require an active network connection.

---

## 6. Document & Image Attachments

- **Attachment Methods**: Click the composer paperclip button, paste from clipboard (`Ctrl+V` / `Cmd+V`), or drag and drop a file onto the chat viewport.
- **Limits**: 1 attachment per message; maximum file size of 25 MB.
- **Supported Documents**: `.pdf` (digital text layers via `unpdf`), `.docx` (`mammoth`), `.pptx` (slides and speaker notes via `jszip`), `.csv`, `.tsv`, `.json`, `.xml`, `.txt`, and `.md`.
- **Supported Images (Server OCR)**: `.jpg`/`.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, and `.heic`/`.heif`. Image uploads are validated via binary magic numbers and processed server-side with `tesseract.js`. If an image contains no readable text, Orvix reports `"No readable text detected in this image"` rather than hallucinating content.

---

## 7. Voice Dictation & Read-Aloud

- **Voice Dictation (`useVoiceDictation.js`)**:
  - Uses live browser `SpeechRecognition` (where supported in Chrome, Edge, and Safari) to display spoken words in real time, replacing interim snapshots cleanly without duplicating words.
  - Concurrently records audio via `MediaRecorder` and, when `/api/transcribe` is configured with `GROQ_API_KEY` or `GEMINI_API_KEY`, refines the final transcript using Whisper Large v3 Turbo (or Gemini audio fallback). In Firefox or environments without Web Speech API, Orvix uses Direct-Audio recording and transcribes on completion.
- **Read-Aloud (`SpeechContext.jsx`)**:
  - Uses the browser's native `window.speechSynthesis` API to read assistant responses aloud with sentence chunking, strip-markdown cleaning, selectable system voices, adjustable playback speed (`0.75x`–`2.0x`), and per-message `Play`, `Pause`, `Resume`, and `Stop` controls.

---

## 8. Installation & Local Setup

### Prerequisites
- **Node.js**: v18.0.0 or higher (Node.js 20+ / 22 LTS recommended)
- **npm**: v9.0.0 or higher

### Steps

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Copy `.env.example` to `.env` and fill in any desired API keys (all keys are optional for local UI testing or Browser AI use):
   ```bash
   cp .env.example .env
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

---

## 9. Environment Variables & API Key Configuration

All supported environment variables are listed in [`.env.example`](./.env.example). Server-side API keys are read exclusively by `server.ts` / `api/*` and are never exposed to the browser bundle:

```env
# AI Provider Keys (Server-Side)
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# Firebase Configuration (Optional — Enables Google/Email Auth & Firestore Sync)
FIREBASE_API_KEY=
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=

# Server & Storage Configuration
PORT=3000
UPLOAD_DIR=
```

- **Security Note**: Never commit `.env` files or real credentials to version control. Client-accessible variables must use the `VITE_` prefix and should only contain public Firebase project identifiers.

---

## 10. Available Scripts

The following scripts are defined in `package.json`:

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the full-stack Express + Vite development server (`tsx server.ts`) on port `3000`. |
| `npm run build` | Builds the production client bundle and generates the Workbox PWA service worker (`vite build`) into `dist/`. |
| `npm start` | Runs the production server (`node server.ts`). |
| `npm run preview` | Previews the Vite production build locally (`vite preview`). |
| `npm run lint` | Runs TypeScript type-checking across the project (`tsc --noEmit`). |
| `npm test` | Runs `npm run lint` followed by the offline reliability & extraction test suite (`node scripts/auditOfflineReliability.js`). |
| `npm run clean` | Removes build artifacts (`rm -rf dist server.js`). |

---

## 11. Project Structure

```text
├── api/                          # Vercel serverless route entry points
│   ├── chat.ts                   # Streaming AI completion proxy
│   ├── config.ts                 # Provider configuration status endpoint
│   ├── health.ts                 # Server health check endpoint
│   ├── transcribe.ts             # Audio transcription endpoint
│   └── upload.ts                 # Multipart file upload & image OCR endpoint
├── public/                       # Favicons, PWA icons & manifest.webmanifest
├── scripts/
│   └── auditOfflineReliability.js # Automated tests for extraction, WebLLM & PWA precache
├── src/
│   ├── components/
│   │   ├── auth/                 # AuthScreen (Login, Sign Up & Guest Mode)
│   │   ├── chat/                 # ChatArea, MessageList, ChatMessage, CodeBlock,
│   │   │                         # BrowserAIStatusBar, ModeSelector, ModelSelector,
│   │   │                         # AttachmentCard, ImageAttachmentCard,
│   │   │                         # DocumentPreviewModal, ExportChatMenu, WelcomeScreen
│   │   ├── layout/               # Layout shell, Header & Sidebar / SidebarChatItem
│   │   ├── settings/             # SettingsModal (persona, theme, speech preferences)
│   │   └── ui/                   # Reusable Button and OrvixLogo components
│   ├── config/                   # appConfig.js, chatModes.js & firebaseConfig.js
│   ├── context/                  # AuthContext, SettingsContext & SpeechContext
│   ├── hooks/                    # useVoiceDictation.js & usePWAInstall.js
│   ├── pages/                    # ChatPage.jsx main conversation controller
│   ├── services/                 # AI routing, WebLLM, document extraction, OCR,
│   │                             # Firestore/localStorage/IndexedDB persistence & PWA
│   ├── styles/                   # Global stylesheet & Tailwind CSS v4 (index.css)
│   ├── utils/                    # Clipboard formatter, speech cleaner, export & syntax
│   └── workers/                  # webllmWorker.js (off-thread WebGPU worker)
├── .env.example                  # Environment variable template
├── package.json                  # Project metadata (v0.1.0), scripts & dependencies
├── server.ts                     # Express backend server & Vite middleware host
└── vite.config.ts                # Vite bundler & Workbox PWA configuration
```

---

## 12. Known Limitations & Setup Notes

1. **Cloud API Keys Required for Live Cloud Models**: Without `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, or Cloudflare credentials in `.env`, cloud providers operate in Simulated Mode. To run real AI without API keys, select **Browser AI (WebLLM)** or connect a local **Ollama** instance.
2. **WebGPU Hardware & Memory Requirements**: Browser AI requires a WebGPU-capable browser over HTTPS or `localhost`. On mobile devices or systems with limited memory (<6 GB RAM), use the default **Qwen 2.5 0.5B Instruct** (~420 MB) model rather than the **1.5B** (~960 MB) model to avoid browser memory eviction.
3. **Offline OCR & Scanned PDFs**: Client-side PDF extraction reads embedded digital text layers. Scanned/image-only PDFs and image attachments require the server-side `tesseract.js` OCR endpoint (`/api/upload`) and an active server connection.
4. **Browser HEIC Preview**: Most browsers do not natively decode `.heic`/`.heif` in `<img>` elements; Orvix displays a fallback card with download and modal OCR text inspection.
5. **Plain-Text Table Paste in Messaging Apps**: Messaging apps like WhatsApp do not support HTML tables; Orvix formats copied tables in `text/plain` as labeled `• Header: Value` records for readability while providing full `<table>` HTML for rich-text editors.
