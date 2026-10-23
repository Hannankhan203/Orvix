# Orvix

**Current Version: Orvix v0.9.0**

<p align="center">
  <strong>An Intelligent, Multi-Model Conversational AI Workspace featuring four refined modes — General, Learning, Writing, and Coding — with multi-model response alternatives, multimodal attachments, deep document understanding, and advanced chat usability features.</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Chatbot Modes (v0.9.0 Refinements)](#chatbot-modes-v090-refinements)
   - [1. General Assistant Mode](#1-general-assistant-mode)
   - [2. Learning Mode](#2-learning-mode)
   - [3. Writing Mode](#3-writing-mode)
   - [4. Coding Mode](#4-coding-mode)
4. [AI Providers & Selectable Models](#ai-providers--selectable-models)
   - [Supported Providers](#supported-providers)
   - [Provider Context Capacities](#provider-context-capacities)
   - [Streaming & Fallback System](#streaming--fallback-system)
   - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
5. [Attachments & Deep Document Understanding](#attachments--deep-document-understanding)
   - [Three Attachment Methods](#three-attachment-methods)
   - [Attachment Constraints & Rules](#attachment-constraints--rules)
   - [Supported Document Formats](#supported-document-formats)
   - [Targeted Inquiries & Speaker Notes](#targeted-inquiries--speaker-notes)
6. [Image Attachments & Optical Character Recognition (OCR)](#image-attachments--optical-character-recognition-ocr)
   - [Supported Image Formats & Validation](#supported-image-formats--validation)
   - [Server-Side OCR Engine](#server-side-ocr-engine)
   - [Honest No-Readable-Text Handling](#honest-no-readable-text-handling)
   - [Thumbnail Cards & Dual-Tab Preview Modal](#thumbnail-cards--dual-tab-preview-modal)
7. [Chat Management & Usability Enhancements](#chat-management--usability-enhancements)
   - [Multi-Model Alternative Response Regeneration](#multi-model-alternative-response-regeneration)
   - [Automatic Chat-Input Focus](#automatic-chat-input-focus)
   - [Live Response-Time Measurement](#live-response-time-measurement)
   - [Left-Edge Swipe Gesture for Chat History](#left-edge-swipe-gesture-for-chat-history)
   - [Controlled Large-Response Continuation](#controlled-large-response-continuation)
   - [Voice Dictation & Text-to-Speech](#voice-dictation--text-to-speech)
   - [Conversation Pinning & Client-Side Export](#conversation-pinning--client-side-export)
8. [Architecture & Technology Stack](#architecture--technology-stack)
9. [Storage & Persistence Architecture](#storage--persistence-architecture)
10. [Project Structure](#project-structure)
11. [Environment Variables & Configuration](#environment-variables--configuration)
12. [Installation & Running Locally](#installation--running-locally)
13. [Build & Deployment Instructions](#build--deployment-instructions)
14. [Security Architecture](#security-architecture)
15. [Known Limitations](#known-limitations)
16. [Version History & Changelog](#version-history--changelog)

---

## Project Overview

**Orvix** is an intelligent, multi-model AI conversational workspace engineered for high-performance text generation, specialized conversational modes, multi-model response comparisons, keyboard-first usability, precision code rendering, transparent latency tracking, touch gesture navigation, and multi-format document analysis.

Built as a full-stack Node.js application, Orvix combines a modern React 19 single-page application with an Express proxy backend running Vite in middleware mode. All AI completions, uploads, and OCR operations are proxied server-side to guarantee that API credentials, tokens, and storage paths remain strictly confidential.

---

## Key Features

- **Four Refined Chatbot Modes**: Purpose-built modes for **General Assistant**, **Learning**, **Writing**, and **Coding** with custom system prompts, specialized typographic layouts, educational callouts, editorial formatting, and macOS/VS Code-style code blocks.
- **Multi-Model Response Alternatives**: Regenerate any assistant reply using another AI provider (Gemini, Groq, OpenRouter, Cloudflare Workers AI) without overwriting previous answers, navigated via an interactive `< X of Y >` pager.
- **Automatic Chat-Input Focus**: Type naturally from anywhere on the page to immediately activate the chat input without losing the first keystroke, with complete protection for text selection, keyboard shortcuts, and modal dialogs.
- **Pixel-Perfect Code Blocks**: Mathematically locked 22px line height with zero vertical drift over 100+ lines, syntax highlighting for 20+ languages, sticky line number gutter, and clean source code copying.
- **Live Response-Time Tracking**: Real-time elapsed duration timer (`Thinking... X.Xs`) updating every 100ms during streaming, followed by an immutable duration badge (`Response time: X.Xs`) saved across sessions and exports.
- **Left-Edge Swipe Navigation**: Natural mobile/tablet edge swipe gesture (0–40px) to slide open conversation history without conflicting with vertical scrolling.
- **Controlled Large-Response Continuation**: Intelligent multi-part output splitting for massive queries with continuation notices and an interactive composer continuation chip (`[ → Continue response ]`).
- **Three Multimodal Attachment Methods**: File picker dialog, direct clipboard paste (`Ctrl + V`), and drag-and-drop with a 25MB limit and a strict 1-attachment-per-message policy.
- **Deep Document Understanding**: Text extraction from PDFs (`unpdf`), Word documents (`mammoth`), PowerPoint presentations with speaker notes (`jszip`), spreadsheets (CSV/TSV), JSON, XML, and Markdown.
- **Server-Side OCR Engine**: Powered by `tesseract.js` with binary magic number verification, image metadata inspection, and honest "No readable text detected" handling.
- **Flexible Data Persistence**: Browser IndexedDB for raw binary file caching, Cloud Firestore for authenticated cross-device sync, and `localStorage` for complete Guest Mode usage.
- **Voice & Accessibility**: Web Speech voice dictation with automatic verbal punctuation conversion (comma, period, question mark, new line) and customizable Text-to-Speech read-aloud.
- **Zero-Key Simulation Mode**: Runs immediately out-of-the-box without API keys, providing realistic local responses for testing all UI features.

---

## Chatbot Modes (v0.9.0 Refinements)

Orvix features four distinct conversational modes configured in `src/config/chatModes.js` and styled in `src/styles/index.css`. Each mode pairs tailored AI system instructions with customized frontend Markdown styling, component structures, and visual hierarchies.

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

- **Purpose**: Versatile companion for everyday questions, multi-topic brainstorming, and general problem solving.
- **System Directive**: Provides helpful, balanced, and direct answers with clear structure and clean markdown formatting.
- **Typographic Presentation**:
  - Balanced reading typography (`line-height: 1.68; font-size: 0.95rem;`).
  - Strict semantic heading hierarchy (H1 through H6) with automatic margin collapse when headings appear directly adjacent.
  - Responsive font scaling across mobile and desktop viewports.
  - Multi-tier nested list rendering:
    - Unordered lists: Disc (`•`), Circle (`◦`), and Square (`▪`) tiers.
    - Ordered lists: Decimal (`1.`), Lower-alpha (`a.`), and Lower-roman (`i.`) tiers with tabular digit alignment.
  - Task lists with clean, disabled checkbox items (`.markdown-task-checkbox`).
  - Responsive horizontal-scrolling tables with distinct header backgrounds, border dividers, and row hover highlights.
  - Hairline border blockquotes and styled inline code pills (`.inline-code`).

### 2. Learning Mode

- **Purpose**: Concept mastery, educational breakdowns, intuitive analogies, and active recall.
- **System Directive**: Deconstructs complex topics into logical, easily digestible steps using real-world analogies, conceptual summaries, and comprehension checkpoints.
- **Typographic Presentation**:
  - Dedicated `.mode-learning` class applied to the response container with expanded reading line height (`1.72`).
  - Structured educational heading hierarchy:
    - **Topic Title (H1)**: Emphasized title with a purple underline rule.
    - **Concept Heading (H2)**: Highlighted with a vertical violet accent bar (`border-left: 3.5px solid #8b5cf6`).
    - **Subconcept Heading (H3)**: Soft violet styling (`#c4b5fd`) for secondary conceptual tiers.
    - **Step Heading (H4)**: Step-by-step procedure labels.
  - Numbered procedure steps with bold violet tabular markers (`1.`, `2.`, `3.`) and multi-tier sub-steps (`a.`, `i.`).
  - High-contrast educational comparison tables and matrices featuring violet-tinted headers and borders.
- **Educational Callout Blocks**:
  - Automatically detects educational callouts in AI responses via `detectCalloutType()` in `ChatMessage.jsx`, supporting both GitHub Flavored Markdown (GFM) alert tags (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) and natural text patterns (e.g., `**Important:**`, `**Key Takeaway:**`):
    1. **Important** (Rose `#f43f5e`, `AlertCircle` icon): Critical warnings and prerequisites.
    2. **Warning / Common Pitfalls** (Amber `#f59e0b`, `AlertTriangle` icon): Mistakes to avoid and edge cases.
    3. **Note / Information** (Sky Blue `#38bdf8`, `Info` icon): Helpful contextual remarks.
    4. **Tip / Study Tip** (Emerald `#10b981`, `Lightbulb` icon): Actionable study and efficiency advice.
    5. **Key Takeaway / Summary** (Violet `#8b5cf6`, `CheckCircle2` icon): High-yield conceptual summaries.
    6. **Definition / Key Terms** (Indigo `#6366f1`, `BookOpen` icon): Formal definitions and vocabulary.
    7. **Example / Everyday Analogy** (Cyan `#06b6d4`, `Bookmark` icon): Real-world comparisons and worked examples.
    8. **Comparison / Contrast** (Purple `#a855f7`, `Sparkles` icon): Trade-off analyses and side-by-side matrices.
  - Comprehensive dark and light theme palettes for every callout type.

### 3. Writing Mode

- **Purpose**: Drafting, content editing, tone adjustment, and prose polishing.
- **System Directive**: Prioritizes narrative flow, rhythm, grammatical precision, compelling structure, varied phrasing, and tailored register.
- **Typographic Presentation**:
  - Dedicated `.mode-writing` class applied to the message container.
  - Constrained editorial line length (`max-width: 76ch`) to optimize reading cadence and prevent eye fatigue.
  - Relaxed editorial line height (`1.78`) with balanced heading line wraps (`text-wrap: balance`).
  - Warm amber-accented section dividers and headings (`writing-h1`, `writing-h2`, `writing-divider`).
  - Formal memo and email header card detection (`writing-memo-field`):
    - Automatically formats lines starting with `Subject:`, `To:`, `From:`, `Date:`, or `Regarding:` into an executive memo block.
  - Editorial blockquotes (`writing-blockquote`) with an amber left border (`#d97706`), italic styling, and soft background.
  - Multi-tier bulleted and numbered lists with amber markers and generous spacing.
  - Document-style tables with warm amber accents, formatted headers, and responsive horizontal scrolling.

### 4. Coding Mode

- **Purpose**: Software architecture, code implementation, syntax review, bug analysis, and technical problem solving.
- **System Directive**: Delivers production-grade code, minimal conversational filler, precise language identifiers, edge case notes, and step-by-step technical guidance.
- **Typographic Presentation & CodeBlock Component**:
  - Dedicated `.mode-coding` styling across message bubbles and code blocks.
  - **macOS / VS Code-Style Header**: Displays window control dots (red, yellow, green) alongside language icons and friendly names.
  - **Total Line-Count Badge**: Renders an inline pill badge (`X lines`) in the block header.
  - **Zero-Drift Line Number Gutter**:
    - Gutter line numbers lock to an exact 22px block height (`--code-line-height: 22px;`).
    - Eliminates vertical drift between code text and line numbers over 100+, 200+, and 500+ lines.
    - Uses tabular numbers (`tabular-nums`) to maintain digit alignment from single digits up to 10,000+ lines.
  - **Sticky Gutter Pinning**: The line number column remains pinned (`position: sticky; left: 0`) while long lines scroll horizontally.
  - **Pure Source Code Copying**: Clicking **Copy Code** or selecting text copies only pristine source code, completely excluding line numbers and UI headers.
  - **Internal Syntax Highlighting**: Lightweight tokenizer supporting 20+ languages (JavaScript, TypeScript, JSX, TSX, HTML, CSS, Python, SQL, Bash/Shell, Java, C/C++, C#, PHP, Go, Rust, JSON, YAML, Markdown) with safe fallback to plain text during streaming.
  - Coding-specific inline code pills (`.coding-inline-code`), dark code tables, and terminal icons.

---

## AI Providers & Selectable Models

Orvix features an intelligent multi-provider architecture connecting to four distinct AI infrastructures:

### Supported Providers

| Provider | Model Identifier | Primary Focus | Failover / Alternative Model |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-3.8-flash` | Ultra-fast inference, high context window | `gemini-3.1-flash-lite` |
| **Groq Cloud** | `llama-3.3-70b-versatile` | Low-latency streaming via Groq LPUs | `openai/gpt-oss-120b` |
| **OpenRouter** | `openrouter/free` | Decentralized routing across free community models | Dynamic routing |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | Low-latency inference across Cloudflare's edge | Edge fallback |

### Provider Context Capacities

Each provider operates with calibrated context budgets configured in `src/services/documentContextService.js`:

| Provider | Max Prompt Context | Document Context Budget | Best Suited For |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | 1,000,000 tokens | ~120,000 characters | Extensive multi-page PDFs, books, large codebases |
| **Groq Cloud** | 128,000 tokens | ~24,000 characters | Rapid structured analysis, high-speed coding |
| **OpenRouter** | Variable by model | ~16,000 characters | Broad open-source experimentation |
| **Cloudflare Workers AI** | 8,192 tokens | ~16,000 characters | Edge summaries, quick queries |

### Streaming & Fallback System

- **Server-Sent Events (SSE)**: All AI completions stream tokens incrementally in real time via `POST /api/chat`.
- **Automatic Model Failover**: If `gemini-3.8-flash` encounters a rate limit (429) or temporary server error (503), Orvix automatically retries with `gemini-3.1-flash-lite`.
- **Cross-Provider Recovery**: If an active provider fails completely, the error card provides a one-click **"Switch Provider & Retry"** button that redirects the exact prompt to an alternate configured provider without retyping.

### Zero-Key Simulation Mode

Orvix runs out-of-the-box without requiring any API keys. When no keys are configured, Orvix switches to **Simulated Mode**, generating responsive, realistic conversational replies tailored to the active mode and prompt so that all UI workflows, attachments, and exports can be tested immediately.

---

## Attachments & Deep Document Understanding

### Three Attachment Methods

Orvix provides three unified methods to attach files to any conversation:

1. **File Picker Upload Button**: Click the paperclip icon in the composer to open the native OS file selector, pre-filtered for supported document and image types.
2. **Clipboard Paste (`Ctrl + V` / `Cmd + V`)**: Copy any image or screenshot to the clipboard and paste it directly into the Orvix window. Plain text and code paste normally into the textarea.
3. **Drag-and-Drop Interaction**: Drag any supported file over the chat area. The window highlights with an accented dashed border (`.is-drag-over`) and displays a `"Drop file to attach"` banner.

### Attachment Constraints & Rules

- **Strict One-Attachment-Per-Message Rule**: To preserve focused contextual reasoning, users can attach strictly one file per message. Adding a second file is rejected with an explicit notice to remove the current attachment first.
- **Maximum File Size**: 25 MB. Larger files are rejected with a clear size notice.
- **Staging Preview**: Attached files dock directly above the input textarea showing a format icon, filename, size badge, and a quick `(X)` remove button.

### Supported Document Formats

Orvix extracts and structures text from a wide variety of formats:
- **PDF Documents (`.pdf`)**: Page-by-page extraction using `unpdf`, detecting total pages and page boundaries.
- **Microsoft Word (`.docx`)**: Heading, list, paragraph, and table extraction using `mammoth`.
- **PowerPoint Presentations (`.pptx`)**: Slide-by-slide text extraction using `jszip`.
- **Structured Data**: CSV, TSV, JSON, and XML files with table formatting.
- **Plain Text**: TXT and Markdown (`.md`).

### Targeted Inquiries & Speaker Notes

- **Targeted Questioning**: Users can ask targeted questions about specific document sections (e.g., *"What is on page 4?"*, *"Summarize slides 2 through 5"*). Orvix validates page boundaries and extracts the targeted slice to prevent hallucinations.
- **PowerPoint Presenter Notes**: For `.pptx` presentations, Orvix extracts speaker notes attached to individual slides, enabling questions about the presenter's speaking points.
- **Scanned PDF Diagnostics**: If a PDF contains only scanned raster images without an embedded text layer, Orvix detects the condition and notifies the user to extract text via OCR.

---

## Image Attachments & Optical Character Recognition (OCR)

### Supported Image Formats & Validation

- Supported formats: **JPEG / JPG**, **PNG**, **WebP**, **GIF**, **BMP**, and **HEIC / HEIF**.
- Every upload undergoes binary magic number verification (`\xFF\xD8\xFF` for JPEG, `\x89PNG` for PNG, `RIFF`/`WEBP`, `GIF87a`/`GIF89a`, `BM` for BMP, `ftyp` for HEIC) to block disguised executable payloads (ELF, PE, Mach-O).

### Server-Side OCR Engine

- Powered by `tesseract.js` running on the Express backend with a 25-second processing timeout.
- Extracts clean text, character counts, word counts, and confidence scores (0–100%).

### Honest No-Readable-Text Handling

If an uploaded image contains no readable text (e.g., abstract art, photos without typography, blank graphics), Orvix flags the result as `NO_TEXT_DETECTED` and immediately informs the user:
> **"No readable text detected in this image."**  
This prevents AI models from hallucinating fictitious text or contents.

### Thumbnail Cards & Dual-Tab Preview Modal

- Attached images render as responsive thumbnail cards directly inside user message bubbles, complete with format tags, file dimensions, and file sizes.
- Clicking an image card opens `DocumentPreviewModal.jsx` with two inspection tabs:
  - **Image Tab**: High-resolution image view with zoom and aspect ratio controls.
  - **Extracted Text Tab**: Monospace viewer displaying the exact OCR text, word/character metrics, confidence rating, and a one-click **Copy Text** button.

---

## Chat Management & Usability Enhancements

### Multi-Model Alternative Response Regeneration

- **Regenerate with Another Model**: After any assistant message completes, users can click the **Another Model** (`Sparkles` icon) button to generate a new answer from any supported provider (Gemini, Groq, OpenRouter, Cloudflare Workers AI).
- **Non-Destructive Alternatives**: Previous answers are never overwritten. Each output is stored as an independent alternative with its own model badge, timestamp, and elapsed generation duration.
- **Alternative Navigation**: An inline `< X of Y >` pager in the message action bar allows instant switching between different model responses.
- **Dedicated In-Place Regenerate**: The standard **Regenerate** button (`RotateCcw`) refreshes the currently active alternative in place using its existing model.

### Automatic Chat-Input Focus

- **Global Typing Capture**: Typing on the keyboard while reviewing responses automatically focuses the message textarea and appends the first keystroke with zero dropped characters.
- **Text Selection Protection**: Selecting, highlighting, or copying text inside messages or code blocks never steals focus.
- **Shortcut & Dialog Protection**: Bypasses modifier keys (`Ctrl`, `Cmd`, `Alt`) to keep shortcuts like `Ctrl+C`, `Ctrl+V`, `Ctrl+A`, and `Ctrl+F` intact. Bypasses buttons, menus, open modals, and IME composition.

### Live Response-Time Measurement

- **Active Streaming Phase**: A live badge (`Thinking... 1.4s`) updates every 100ms during active AI generation using high-resolution browser timing (`performance.now()`).
- **Final Response Duration Badge**: Seamlessly transitions to a static badge upon completion (e.g., `Response time: 2.3s` or `Response time: 1m 04s`).
- **Session & Export Persistence**: Durations are permanently saved in Cloud Firestore (`responseTimeMs`), local guest storage, and client-side conversation exports.

### Left-Edge Swipe Gesture for Chat History

- Mobile and tablet users (`window.innerWidth <= 1024`) can swipe right from the left screen edge (within 0–40px) to slide open the chat history sidebar.
- Integrated intent resolution (`INTENT_THRESHOLD_PX = 8`) separates horizontal swipes from vertical scrolling, ensuring smooth native chat scrolling.

### Controlled Large-Response Continuation

- For exhaustive prompts, `detectLargeResponseIntent()` divides massive responses into coherent sections.
- When Part 1 finishes, the assistant signs off with a clear continuation notice, and an interactive **`[ → Continue response ]`** chip appears above the composer.
- Clicking the chip or typing phrases like `"Continue"` or `"Send the rest"` triggers the next section while preserving the original prompt and attached documents.

### Voice Dictation & Text-to-Speech

- **Voice Dictation**: Uses the Web Speech API with multi-language recognition and verbal punctuation conversion:
  - *"comma"* → `,` | *"period"* → `.` | *"question mark"* → `?` | *"exclamation mark"* → `!` | *"new line"* → `\n`
- **Text-to-Speech (Read Aloud)**: Browser speech synthesis with Play, Pause, Resume, Stop controls, speed adjustments (0.75x to 2.0x), and system voice selection.

### Conversation Pinning & Client-Side Export

- **Pinning**: Pin up to 5 priority conversations to a dedicated top section in the sidebar.
- **Client-Side Export**: Export complete chat threads to **Markdown (`.md`)** or **Plain Text (`.txt`)** with zero server roundtrips, preserving timestamps, mode labels, and response durations.

---

## Architecture & Technology Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        ORVIX ARCHITECTURE                              │
├───────────────────────────────────┬────────────────────────────────────┤
│ CLIENT (React 19 SPA)             │ SERVER (Express + Vite Middleware) │
│ - React 19, Tailwind CSS v4       │ - Express in TypeScript (server.ts)│
│ - Lucide Icons, React-Markdown    │ - @google/genai TypeScript SDK     │
│ - Web Speech API (Voice & TTS)    │ - Groq, OpenRouter & Cloudflare SSE│
│ - IndexedDB (Attachment Caching)  │ - In-Memory Multer & Tesseract OCR │
│ - LocalStorage (Guest Mode)       │ - Document Parsers (unpdf, mammoth)│
└───────────────────────────────────┴────────────────────────────────────┘
```

- **Frontend**: React 19 (`react`, `react-dom`), Vite 8, Tailwind CSS v4, Lucide React, `react-markdown`, and `remark-gfm`.
- **Backend**: Express 4 running via `tsx` in TypeScript (`server.ts`) with Vite middlewares mounted in development on port 3000 (`0.0.0.0`).
- **AI Integrations**: `@google/genai` TypeScript SDK for Google Gemini; REST streaming for Groq, OpenRouter, and Cloudflare Workers AI.
- **Document & Image Processing**: `unpdf` (PDFs), `mammoth` (DOCX), `jszip` (PPTX), and `tesseract.js` (OCR).
- **Authentication & Database**: Firebase Authentication (Google & Email/Password) and Cloud Firestore with full guest mode fallback.

---

## Storage & Persistence Architecture

1. **Client-Side IndexedDB (`orvix_attachments_db`)**: Caches raw uploaded files and images in the browser so that thumbnails, previews, and downloads survive page reloads even after server temporary files expire.
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
│   └── upload.ts                    # Multipart file upload & OCR handler
├── public/                          # Static assets, icons & PWA manifest
├── src/
│   ├── components/
│   │   ├── auth/                    # Authentication screen & guest switcher
│   │   ├── chat/                    # Core chat interface
│   │   │   ├── AttachmentCard.jsx   # Document attachment chip & card
│   │   │   ├── ChatArea.jsx         # Composer dock, auto-focus, paste & drop
│   │   │   ├── ChatMessage.jsx      # Markdown rendering, callouts, alternatives & timer
│   │   │   ├── CodeBlock.jsx        # Precision syntax highlighter & copy button
│   │   │   ├── DocumentPreviewModal.jsx # Full-screen image/OCR modal
│   │   │   ├── ExportChatMenu.jsx   # Markdown / Plain Text export
│   │   │   ├── ImageAttachmentCard.jsx  # Inline image thumbnail
│   │   │   ├── MessageList.jsx      # Scrollable message list
│   │   │   ├── ModeSelector.jsx     # Conversational mode selector
│   │   │   ├── ModelSelector.jsx    # AI provider & model selector
│   │   │   ├── PromptSuggestions.jsx# Welcome starter prompt chips
│   │   │   └── TypingIndicator.jsx  # Streaming indicator dots
│   │   ├── layout/                  # Navigation header, sidebar & layout
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
│   │   └── openrouterService.js     # OpenRouter completions API
│   ├── styles/                      # Tailwind CSS v4 & custom stylesheet (index.css)
│   └── utils/                       # Export, speech, formatResponseTime & highlighter
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
MAX_FILE_SIZE_BYTES=26214400
TEMP_FILE_TTL_MS=7200000

# AI Provider Keys (At least one recommended for live AI responses)
GEMINI_API_KEY=your_gemini_api_key_here
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
The Express server serves optimized static assets from `dist/` with SPA routing and API proxying.

### Vercel Serverless Deployment
Orvix is pre-configured with `vercel.json` and dedicated entry points in `api/`:
- `api/chat.ts`: Serverless proxy for streaming AI completions.
- `api/upload.ts`: Serverless in-memory upload and OCR handler.

---

## Security Architecture

1. **Zero Credential Exposure**: API keys for Gemini, Groq, OpenRouter, and Cloudflare are strictly server-side. The browser never receives raw provider keys.
2. **Binary Header & Magic Number Validation**: Uploads are validated against binary signatures to prevent disguised executables.
3. **Control Character Sanitization**: Extracted document and OCR text is stripped of non-printable control characters before insertion into prompts.
4. **Client-Side Blob Revocation**: Object URLs created for preview thumbnails are explicitly revoked upon unmounting to prevent memory leaks.

---

## Known Limitations

1. **OCR vs. Visual Reasoning**: Orvix extracts printed and typographic text from images via OCR. It does not perform spatial visual reasoning or artistic descriptions beyond text extraction.
2. **Binary File Longevity**: Extracted text and chat metadata persist permanently. Raw binary files are stored in browser IndexedDB on the local device; temporary server files expire after a 2-hour TTL.
3. **Browser HEIC Rendering**: Standard web browsers cannot decode HEIC/HEIF images natively in `<img>` tags; Orvix displays an informational fallback card with direct download and modal text inspection.
4. **Scanned PDFs Without Embedded Text**: PDFs containing exclusively rasterized scans require image extraction for OCR parsing.

---

## Version History & Changelog

### v0.9.0 — Four Chatbot Modes Refinement & Documentation Overhaul (October 2026) *(Current Release)*

**Added & Refined**
- **Refinement of All Four Chatbot Modes**:
  - **General Mode**: Enhanced universal markdown presentation, refined heading hierarchy (H1–H6) with adjacent margin collapse, improved paragraph flow, multi-tier nested unordered (disc, circle, square) and ordered lists (decimal, lower-alpha, lower-roman), task list checkboxes, and responsive tables.
  - **Learning Mode**: Purpose-built educational interface with topic, concept, and step heading tiers; sequential numbered steps with purple tabular markers; educational comparison tables; and automated detection of 8 distinct educational callout blocks (*Important*, *Warning*, *Note*, *Tip*, *Key Takeaway*, *Definition*, *Example*, *Comparison*) plus GFM alert tags.
  - **Writing Mode**: Refined editorial formatting constrained to 76ch max-width, balanced heading wraps, formal memo/email header card detection (`Subject:`, `To:`, `From:`, `Date:`, `Regarding:`), warm amber styling, editorial blockquotes, and document-style tables.
  - **Coding Mode**: Developer-focused workspace featuring macOS/VS Code-style window controls (red/yellow/green dots), syntax highlighting for 20+ languages, total line-count badge, sticky line number gutter, mathematically locked 22px line height with zero vertical drift over 100+ lines, and pure source code clipboard copying.
- **Project Documentation & Version Alignment**:
  - Completely cleaned up and verified the entire `README.md` against actual codebase files, removing obsolete claims, speculative items, and duplicate sections.
  - Synchronized application version across `package.json`, `src/config/appConfig.js`, and the sidebar UI.
  - Updated package test script to execute TypeScript validation cleanly.

### v0.8.0 — Multi-Model Response Alternatives & Provider Unification (October 2026)
- **"Regenerate with another AI Model"**: Allows users to regenerate any completed assistant response using a different provider (Gemini, Groq, OpenRouter, Cloudflare Workers AI) without losing earlier outputs.
- **Non-Destructive Alternative History**: Captures every response as an independent alternative with its own model badge, timestamp, and duration metric.
- **Response Alternative Navigator**: Integrated `< X of Y >` pager in `ChatMessage.jsx` with active model badges.
- **Provider Unification**: Unified model selector and alternative generation options to support Gemini, Groq, OpenRouter, and Cloudflare Workers AI.

### v0.7.1 — Automatic Chat-Input Focus & Pixel-Perfect Line Alignment (October 2026)
- **Automatic Chat-Input Focus**: Global typing capture in `ChatArea.jsx` to immediately focus the composer on any alphanumeric keystroke without dropping the initial character.
- **Pixel-Perfect Code-Block Line Alignment**: Synchronized typography (`--code-line-height: 22px;`) to eliminate vertical line number drift across 100+ line code blocks.

### v0.7.0 — Live Response-Time Measurement & Left-Edge Swipe Gesture (October 2026)
- **Live Response-Time Measurement**: Live timer badge (`Thinking... X.Xs`) updating every 100ms during streaming, transitioning to an immutable final duration badge (`Response time: X.Xs`).
- **Left-Edge Swipe Gesture**: Native touch swipe (0–40px from left edge) on mobile/tablet viewports to slide open chat history.

### v0.6.0 — Controlled Large-Response Continuation & Multimodal Inputs (October 2026)
- **Controlled Large-Response Continuation**: Split massive responses into safe parts with continuation notices and an interactive composer chip (`[ → Continue response ]`).
- **Three Multimodal Attachment Methods**: File picker dialog, clipboard paste (`Ctrl + V`), and drag-and-drop file staging with a 25MB limit.

### v0.5.0 — Serverless Upload Architecture & Resilience (October 2026)
- Migrated uploads to `multer.memoryStorage()`, resolving read-only filesystem errors (`EROFS`) on serverless platforms.
- Extended client upload timeout to 90 seconds for large files and OCR processing.

### v0.4.0 — Image Attachments & Optical Character Recognition (OCR) (October 2026)
- Server-side OCR engine using `tesseract.js` with binary magic number verification.
- Honest "No readable text detected" reporting to prevent model hallucinations.
- Dual-tab image preview modal (Image view + Extracted text view).

### v0.3.0 — Deep Document Understanding & Error UI Overhaul (October 2026)
- Text extraction for PDF (`unpdf`), Word DOCX (`mammoth`), and PowerPoint PPTX with speaker notes (`jszip`).
- Targeted inquiries by page, range, or slide.
- Responsive diagnostic error cards with one-click retry and provider switching.

### v0.2.0 — Cloudflare Workers AI Integration (October 2026)
- Integrated `@cf/meta/llama-3.1-8b-instruct` via Cloudflare's edge REST API with SSE streaming.

### v0.1.0 — Initial Full-Stack Release (October 2026)
- React 19 SPA frontend with Tailwind CSS v4, Obsidian Dark and Clean Light themes.
- Express backend (`server.ts`) with Vite middleware mode on port 3000.
- Google Gemini, Groq, and OpenRouter streaming.
- Web Speech voice dictation and text-to-speech read-aloud.
- Cloud Firestore and Guest Mode local storage.
