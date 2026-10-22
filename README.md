# Orvix

**Current Version: Orvix v0.4.0**

<p align="center">
  <strong>An Intelligent, Multi-Model AI Conversation Companion with Deep Document Understanding and Image Optical Character Recognition (OCR)</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Project Purpose & Current Status](#project-purpose--current-status)
3. [Architecture & Technology Stack](#architecture--technology-stack)
   - [Frontend Architecture](#frontend-architecture)
   - [Backend Architecture](#backend-architecture)
   - [File, Document & Image Upload Pipeline](#file-document--image-upload-pipeline)
   - [Database & Authentication Architecture](#database--authentication-architecture)
4. [AI Providers & Selectable Models](#ai-providers--selectable-models)
   - [Fully Implemented Providers](#fully-implemented-providers)
   - [Provider Context Capacities](#provider-context-capacities)
   - [AI Provider Routing, Streaming & Fallbacks](#ai-provider-routing-streaming--fallbacks)
   - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
5. [Conversational & Text Chat Features](#conversational--text-chat-features)
   - [Multi-Turn Memory & Context Retention](#multi-turn-memory--context-retention)
   - [Chat Modes & Persona Directives](#chat-modes--persona-directives)
   - [Personalization & Response Length Controls](#personalization--response-length-controls)
   - [Voice Dictation & Verbal Punctuation Engine](#voice-dictation--verbal-punctuation-engine)
   - [Text-to-Speech (Read Aloud)](#text-to-speech-read-aloud)
   - [Conversation Management & Client-Side Export](#conversation-management--client-side-export)
6. [Document Understanding & Analysis](#document-understanding--analysis)
   - [Supported Document Formats](#supported-document-formats)
   - [Targeted Questioning (Pages, Ranges, Slides)](#targeted-questioning-pages-ranges-slides)
   - [Presenter Notes Extraction](#presenter-notes-extraction)
   - [Scanned & Rasterized PDF Diagnostics](#scanned--rasterized-pdf-diagnostics)
7. [Image Attachments & Optical Character Recognition (OCR)](#image-attachments--optical-character-recognition-ocr)
   - [Image Upload & Verification Pipeline](#image-upload--verification-pipeline)
   - [Supported Image Formats](#supported-image-formats)
   - [Server-Side OCR Extraction Engine](#server-side-ocr-extraction-engine)
   - [Handling Images with No Readable Text](#handling-images-with-no-readable-text)
   - [Image Thumbnail Cards & User Message Display](#image-thumbnail-cards--user-message-display)
   - [Image Preview Modal & OCR Text Inspection](#image-preview-modal--ocr-text-inspection)
   - [Multi-Image & Mixed Document Questions](#multi-image--mixed-document-questions)
   - [Important Clarification: OCR vs Native Visual Reasoning](#important-clarification-ocr-vs-native-visual-reasoning)
8. [Storage & Persistence Architecture](#storage--persistence-architecture)
   - [Client-Side IndexedDB Storage](#client-side-indexeddb-storage)
   - [Server-Side Temporary Staging & Lifecycle](#server-side-temporary-staging--lifecycle)
   - [Cloud Firestore Message History](#cloud-firestore-message-history)
   - [Guest Mode Storage](#guest-mode-storage)
9. [Resilient Error UI & Recovery Architecture](#resilient-error-ui--recovery-architecture)
10. [Project Structure & Important Files](#project-structure--important-files)
    - [Directory Tree](#directory-tree)
    - [Important Files & Modules](#important-files--modules)
11. [Environment Variables & Configuration](#environment-variables--configuration)
    - [Configuration Reference Table](#configuration-reference-table)
    - [Configuration Template (`.env.example`)](#configuration-template-envexample)
12. [Prerequisites & Setup Instructions](#prerequisites--setup-instructions)
    - [Prerequisites](#prerequisites)
    - [Installation](#installation)
    - [Running in Development](#running-in-development)
    - [Building for Production](#building-for-production)
    - [Running the Production Server](#running-the-production-server)
    - [Type Checking & Linting](#type-checking--linting)
    - [Executing Test Suites](#executing-test-suites)
13. [Firebase Setup & Security Rules](#firebase-setup--security-rules)
14. [Deployment Information](#deployment-information)
15. [Security Architecture](#security-architecture)
16. [Known Limitations](#known-limitations)
17. [Version History & Changelog](#version-history--changelog)
18. [Future Improvements](#future-improvements)

---

## Project Overview

**Orvix** is an intelligent, multi-model conversational AI web application designed for high-performance text conversation, surgical document comprehension, and image Optical Character Recognition (OCR). Built as a full-stack Node.js 22 application with a responsive React 19 single-page frontend and an Express proxy backend running Vite in middleware mode, Orvix provides access to leading open and proprietary language models while ensuring zero credential exposure, robust client-side caching, and complete data ownership.

Orvix integrates four selectable AI providers:
- **Google Gemini** (`gemini-3.8-flash` primary, with automatic failover to `gemini-3.1-flash-lite`) via the modern `@google/genai` TypeScript SDK.
- **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via high-speed OpenAI-compatible REST completions.
- **OpenRouter** (`openrouter/free`) routing across high-capacity free community models.
- **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct`) providing serverless inference on Cloudflare's global network.

With **version v0.4.0**, Orvix expands beyond text and office documents to incorporate a complete **Image Attachment and OCR Text Extraction Engine**. Users can attach photos, screenshots, receipts, invoices, and handwritten diagrams (JPG, PNG, WebP, GIF, BMP, HEIC), view image previews in the message composer, inspect thumbnails in chat messages, open an accessible preview modal to examine extracted text, and query the text contained in images across all four AI providers with real-time streaming answers.

---

## Project Purpose & Current Status

### Purpose
Orvix was engineered to deliver an accessible, flexible, and privacy-conscious AI workspace:
1. **Multi-Model Flexibility**: Switch models on the fly (Gemini, Groq, OpenRouter, Cloudflare Workers AI) within the same conversation without losing message history or attached file contexts.
2. **Deep Document & Image Text Understanding**: Extract and analyze text from complex multi-page PDFs, Word documents, PowerPoint presentations, spreadsheets, data files, and images (OCR) with precise page/slide/section boundary citations.
3. **Frictionless Onboarding**: Explore the complete application immediately via Guest Mode without requiring API keys, cloud subscriptions, or account creation.
4. **Secure Server-Side Proxying**: Route all AI completions, uploads, and OCR through a protected Express server (`/api/chat`, `/api/upload`), ensuring API keys, file system paths, and raw payloads are never exposed to the client.
5. **Accessible Multimodal Speech**: Built-in voice dictation with spoken verbal punctuation conversion and Web Speech synthesis read-aloud with playback speed adjustments.
6. **Local-First Reliability**: Original files are cached in browser IndexedDB to survive page reloads and network reconnects even when temporary server files have expired.

### Current Status
- **Current Version**: `v0.4.0` (Semantic Versioning: `MAJOR.MINOR.PATCH`).
- **Build Status**: Verified on Node.js 22 LTS. All TypeScript checks (`npm run lint`), Vite builds (`npm run build`), and 6 automated test suites pass with 100% test coverage.

---

## Architecture & Technology Stack

### Frontend Architecture
- **Framework**: React 19 (`react` ^19.0.1, `react-dom` ^19.0.1) Single Page Application.
- **Build Tool**: Vite (`vite` ^8.3.0) with `@vitejs/plugin-react` (^6.1.1).
- **Styling**: Tailwind CSS v4 (`tailwindcss` ^4.3.3, `@tailwindcss/vite` ^4.3.3) paired with an Obsidian Dark and Clean Light CSS custom-property design system (`src/styles/index.css`).
- **Icons**: Lucide React (`lucide-react` ^0.546.0).
- **Markdown & Code**: `react-markdown` (^10.1.0) and `remark-gfm` (^4.0.1) with syntax-highlighted code blocks and one-click clipboard copying.
- **Client Cache**: Browser `IndexedDB` (`src/services/attachmentStorageService.js`) using database `orvix_attachments_db` for persisting raw file and image blobs locally.
- **State Management**: React Context providers (`AuthContext`, `SettingsContext`, `SpeechContext`).

### Backend Architecture
- **Server**: Express (`express` ^4.22.3) written in TypeScript (`server.ts`).
- **Development Runtime**: `tsx` (^4.21.0) executing `server.ts` with Vite mounted in middleware mode (`appType: 'spa'`) on port 3000 (`0.0.0.0`).
- **Production Server**: Serves pre-built assets from `dist/` with SPA routing fallback to `index.html`.
- **API Endpoints**:
  - `GET /api/health`: Uptime and system status check.
  - `GET /api/config`: Provider configuration status without leaking keys.
  - `POST /api/chat`: Multi-provider AI router supporting Server-Sent Events (SSE) streaming and atomic JSON.
  - `POST /api/upload`: Multipart upload handling with file signature validation, document parsing, and OCR text extraction.
  - `GET /api/upload/config`: Returns upload bounds (25 MB max file size, 5 attachments per message).
  - `GET /api/upload/:id`: Returns attachment metadata, MIME type, dimensions, and parsing status.
  - `GET /api/upload/:id/extraction`: Returns structured OCR text or document section boundaries.
  - `GET /api/upload/:id/file` (or `/download`): Serves raw file data with inline or attachment headers.
  - `DELETE /api/upload/:id`: Removes staged attachments prior to message submission.

### File, Document & Image Upload Pipeline

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              CLIENT BROWSER                            │
│                                                                        │
│  [File / Image Input] ──────► [IndexedDB Blob Cache] (Local Store)     │
│       │                              │                                 │
│       │ FormData (Multipart)         │ Blob Fallback for Preview       │
│       ▼                              ▼                                 │
│  POST /api/upload              GET /api/upload/:id/file                │
└───────┬──────────────────────────────┬─────────────────────────────────┘
        │                              │
        ▼                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        EXPRESS SERVER (server.ts)                      │
│                                                                        │
│  1. Multer Engine: writes to uploads/temp/{uuid}.{ext}                 │
│  2. Magic Number & Signature Verification:                             │
│     - Validates JPEG (FF D8 FF), PNG, WebP (RIFF/WEBP), GIF, BMP, HEIC │
│     - Rejects binary executables (ELF, Windows PE/MZ, Mach-O)          │
│  3. Extraction Dispatch:                                               │
│     ├─ Documents (documentExtractor.js): PDF, DOCX, PPTX, CSV, TXT     │
│     └─ Images (imageOcrService.js): Tesseract.js OCR text extraction    │
│  4. Automated TTL Cleanup: sweeps expired files every 15 minutes       │
│  5. Context Preparation (documentContextService.js):                   │
│     - Bounds extracted text to provider token limits                   │
│     - Detects "No readable text detected in this image." condition     │
│     - Injects structured OCR/document context into AI prompt           │
└────────────────────────────────────────────────────────────────────────┘
```

### Database & Authentication Architecture
- **Firebase SDK**: Firebase Web SDK (`firebase` ^11.4.0).
- **Authentication**: Firebase Authentication with Email and Password provider.
- **Cloud Database**: Cloud Firestore using subcollections:
  - Chat metadata: `/users/{userId}/chats/{chatId}`
  - Message subcollection: `/users/{userId}/chats/{chatId}/messages/{messageId}`
- **Security Rules**: `firestore.rules` enforces user isolation (`request.auth.uid == userId`) and payload validation.
- **Guest Fallback**: `localStorage` and `sessionStorage` persist chat threads, message histories, and preferences when Firebase is unconfigured or in Guest Mode.

---

## AI Providers & Selectable Models

Orvix features an interchangeable AI provider architecture. Users can toggle models at any point via the top navigation dropdown. Switching models preserves active conversation history and attached document/image context.

### Fully Implemented Providers

| Provider Name | Model Identifier | UI Selector Label | Streaming | Integration Details |
|---|---|---|---|---|
| **Google Gemini** | `gemini-3.8-flash` (failover: `gemini-3.1-flash-lite`) | `Gemini (Gemini 3.1 Flash Lite)` | Yes (SSE) | Server-side `@google/genai` TypeScript SDK with automated backoff and model failover. |
| **Groq** | `llama-3.3-70b-versatile` / `openai/gpt-oss-120b` | `Groq (Llama 3.3 70B)` | Yes (SSE) | High-speed OpenAI-compatible completions endpoint. |
| **OpenRouter** | `openrouter/free` | `OpenRouter (Llama 3.3 70B (Free))` | Yes (SSE) | Multi-model gateway routing to high-capacity free community models. |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | `Cloudflare Workers AI — Llama 3.1 8B` | Yes (SSE) | Cloudflare REST API with server-side SSE event formatting and JSON stream adaptation. |

### Provider Context Capacities

Because models possess different token contexts, Orvix dynamically bounds extracted text (`src/services/documentContextService.js`):

| Provider Name | Injected Text Context Limit | Large Document / Image Behavior |
|---|---|---|
| **Google Gemini** | **120,000 characters** (~30,000 words) | Full document/OCR text ingested into Gemini's broad context window. |
| **Groq** | **24,000 characters** (~6,000 words) | Bounded with an explicit notice to prevent context limit errors. |
| **OpenRouter** | **16,000 characters** (~4,000 words) | Bounded to safeguard against free tier request token caps. |
| **Cloudflare Workers AI** | **16,000 characters** (~4,000 words) | Bounded to respect edge worker payload constraints. |

### AI Provider Routing, Streaming & Fallbacks
- **Server-Sent Events (SSE)**: Streaming responses are delivered token-by-token using standard SSE chunks (`data: {"type":"chunk","text":"..."}`) and completed with a done marker (`data: {"type":"done", ...}`).
- **Pre-Stream Demand Check**: For Google Gemini, the server checks the initial token before transmitting HTTP 200 headers. If Gemini returns HTTP 503 (high demand), the server retries with jitter or fails over cleanly.
- **Client Disconnection Safeguard**: When the user navigates away or stops generating, `res.on('close')` fires, aborting upstream requests to preserve API quotas.

### Zero-Key Simulation Mode
If API keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, etc.) are not configured, Orvix automatically runs in simulated demonstration mode:
- Produces context-aware simulated answers matching the selected Chat Mode and uploaded document/OCR text.
- Streams responses progressively over SSE to test UI animations, syntax highlighting, and voice synthesis without external network dependencies.

---

## Conversational & Text Chat Features

- **Multi-Turn Memory**: Chronologically tracks up to the last 12 messages in conversation history.
- **4 Chat Modes**:
  - `General`: Well-balanced, versatile assistant.
  - `Coding`: Technical software engineering focus with clean, syntax-highlighted code blocks.
  - `Writing`: Tone-focused drafting, copy-editing, and prose refinement.
  - `Learning`: Educational breakdowns with plain-language analogies and comprehension checks.
- **Personalization**: Configure response length (`Concise`, `Balanced`, `Detailed`) and toggle `Beginner-Friendly Explanations` in Settings.
- **Voice Dictation (Speech-to-Text)**: Built on Web Speech Recognition. Includes a live waveform animation, pause/resume, and verbal punctuation conversion (e.g., saying "comma", "period", "new line" formats punctuation automatically). Supports 9 languages.
- **Text-to-Speech (Read Aloud)**: Click the speaker button on any assistant message to listen via Web Speech Synthesis, with voice and speed controls (0.75x to 2.0x).
- **Conversation Management**: Pin up to 5 priority chats, rename threads inline, and export conversations to **Markdown (`.md`)** or **Plain Text (`.txt`)**.

---

## Document Understanding & Analysis

### Supported Document Formats
- **PDF Documents (`.pdf`)**: Parsed via `unpdf`. Extracts page text, detects total pages, and maps page boundaries.
- **Word Documents (`.docx`)**: Parsed via `mammoth`. Extracts structured headings, paragraphs, lists, and tables.
- **PowerPoint Presentations (`.pptx`)**: Parsed via `jszip`. Extracts per-slide text, slide counts, and presenter notes (`ppt/notesSlides/`).
- **Legacy PowerPoint (`.ppt`)**: Binary detector identifies legacy binary presentation format and suggests saving as `.pptx` or `.pdf`.
- **Tabular Data (`.csv`, `.tsv`)**: Delimiter parser generates structured Markdown tables for AI reasoning.
- **Plain Text & Code (`.txt`, `.md`, `.json`, `.xml`)**: Extracts full hierarchy, formatted code, and schema trees.

### Targeted Questioning (Pages, Ranges, Slides)
Users can ask surgical questions targeting specific document sections:
- *"Explain page 3 of this document"*
- *"Summarize pages 2 to 4"*
- *"What does slide 4 say about revenue?"*
- *(If a user requests page 15 on a 6-page document, Orvix detects the boundary and explains that page 15 does not exist instead of hallucinating).*

### Presenter Notes Extraction
When PowerPoint presentations are uploaded, Orvix reads the embedded XML speaker notes (`ppt/notesSlides/`), enabling questions such as: *"Are there any speaker notes on slide 3?"*

### Scanned & Rasterized PDF Diagnostics
If an uploaded PDF contains only scanned raster images without a text layer, Orvix detects this and honestly notifies the user that the document is image-only rather than fabricating a summary.

---

## Image Attachments & Optical Character Recognition (OCR)

Orvix v0.4.0 introduces an image attachment and text extraction pipeline powered by server-side Tesseract.js.

### Image Upload & Verification Pipeline
1. **User Selection**: Select one or more images using the composer paperclip button or system file picker.
2. **Pre-Send Preview**: Selected images immediately appear in the composer staging dock with an instant visual thumbnail, filename, format badge, file size, and remove button (`ChatArea.jsx`).
3. **Multipart Upload & Validation**: Images are uploaded to `POST /api/upload` where they undergo strict binary signature validation:
   - Validates magic numbers: JPEG (`\xFF\xD8\xFF`), PNG (`\x89PNG`), WebP (`RIFF`...`WEBP`), GIF (`GIF87a`/`GIF89a`), BMP (`BM`), and HEIC/HEIF (`ftyp` ISOBMFF).
   - Rejects binary executables (ELF, Windows PE, Mach-O) disguised under image file extensions.
   - Enforces the 25 MB file size limit and 5-attachment limit.
4. **Server-Side OCR Extraction**: `imageOcrService.js` processes the image using Tesseract.js to extract readable alphanumeric text.
5. **AI Context Feeding**: If readable text is detected, the OCR text and image metadata are supplied to the selected AI provider.
6. **Chat Message Rendering**: Sent images appear inside the user message bubble as responsive thumbnail cards (`ImageAttachmentCard.jsx`).
7. **Interactive Preview Modal**: Clicking any image thumbnail opens `DocumentPreviewModal.jsx` to view the original image or inspect the extracted OCR text.

### Supported Image Formats

| Format | Extension(s) | MIME Type | OCR Support | In-Browser Visual Display |
|---|---|---|---|---|
| **JPEG / JPG** | `.jpg`, `.jpeg` | `image/jpeg` | Yes (Tesseract.js) | Full native browser rendering |
| **PNG** | `.png` | `image/png` | Yes (Tesseract.js) | Full native browser rendering |
| **WebP** | `.webp` | `image/webp` | Yes (Tesseract.js) | Full native browser rendering |
| **GIF** | `.gif` | `image/gif` | Yes (Tesseract.js) | Full native browser rendering |
| **BMP** | `.bmp` | `image/bmp` | Yes (Tesseract.js) | Full native browser rendering |
| **HEIC / HEIF** | `.heic`, `.heif` | `image/heic` | Unsupported format (no native HEVC in container) | Fallback card with direct open & download |

### Server-Side OCR Extraction Engine
- **Engine**: Tesseract.js (`tesseract.js` ^7.0.0) running in a managed server-side worker queue.
- **Safety Limits**: 25-second timeout safeguard (`OCR_TIMEOUT_MS`) prevents hanging on pathological inputs.
- **Extracted Metadata**:
  - `text`: Normalized, cleaned readable text.
  - `hasText`: Boolean indicator confirming meaningful alphanumeric characters.
  - `confidence`: Tesseract confidence percentage (0-100%).
  - `totalCharacters` & `totalWords`: Accurate character and word counts.
  - `lineCount`: Segmented line count.
  - `status`: `'ready'` (text detected) | `'NO_TEXT_DETECTED'` | `'unsupported_format'` | `'error'`.

### Handling Images with No Readable Text
When an uploaded image contains no readable text (e.g., abstract artwork, solid graphics, blank canvases, or photography without text):
- The OCR engine marks `status: 'NO_TEXT_DETECTED'` and `hasText: false`.
- When the user asks a question about the image, Orvix does not send fabricated text to the AI model. Instead, the user immediately receives the exact honest diagnostic:
  > **"No readable text detected in this image."**
- This response is delivered identically across all four AI providers in both streaming SSE and non-streaming modes.

### Image Thumbnail Cards & User Message Display
Uploaded images are rendered inside user message bubbles via `ImageAttachmentCard.jsx`:
- **Responsive Grid**: Automatically arranges single or multiple images into a clean, responsive layout.
- **Visual Thumbnail**: Displays a scaled visual thumbnail with hover overlay (*"View Larger"*).
- **Metadata Badge**: Displays original filename, format badge (e.g., `PNG`, `JPG`), and formatted file size.
- **Direct Actions**: Quick-action buttons to open preview or download original file.

### Image Preview Modal & OCR Text Inspection
Clicking any image card opens `DocumentPreviewModal.jsx`:
- **Dual View Switcher**:
  - **Image Tab**: View the full-size original image with zoom and fit controls.
  - **Extracted Text Tab**: Inspect the exact text extracted by the OCR engine in a monospace, copyable viewer with word count, character count, and confidence rating.
- **Direct Actions**: **Copy Text** button to copy extracted text to clipboard and **Download** button to retrieve the original file.
- **Graceful No-Text Display**: If no text was detected, the modal shows a clean notice explaining that no readable text was detected.

### Multi-Image & Mixed Document Questions
Users can combine multiple images or mix images with documents in the same prompt:
- *"Compare the receipt in this image with the expense report PDF"*
- *"Summarize the text from both of these images"*
Each image's filename and extracted text are isolated and identified in the context fed to the AI model.

### Important Clarification: OCR vs Native Visual Reasoning
> **Technical Scope Distinction**:  
> Orvix's image capability is an **Optical Character Recognition (OCR)** text extraction pipeline. It is designed to extract readable, typographic, and printed text from images (such as receipts, menus, document photos, code screenshots, signs, and labels) and provide that text to the conversational models.  
> Orvix does **not** perform native computer vision, spatial visual reasoning, object detection, or pixel-level art description beyond its extracted text. When an image contains no readable text, Orvix honestly reports *"No readable text detected in this image."* rather than attempting to guess visual contents.

---

## Storage & Persistence Architecture

### Client-Side IndexedDB Storage
- **Database**: `orvix_attachments_db` (Store: `attachments`).
- When a user attaches any document or image, the client concurrently stores the raw `File`/`Blob` in browser `IndexedDB`.
- When reopening conversations from sidebar history or refreshing the browser, attachments load their thumbnails and file data directly from IndexedDB. This ensures images and documents remain viewable and downloadable offline indefinitely on that device.

### Server-Side Temporary Staging & Lifecycle
- Uploaded files are written to `/uploads/temp/{uuid}.{ext}` with secure random UUIDs.
- An automated background sweep runs every 15 minutes to delete temporary files exceeding `TEMP_FILE_TTL_MS` (default: 2 hours).

### Cloud Firestore Message History
- Signed-in users have their conversation metadata stored in `/users/{userId}/chats/{chatId}` and messages in `/users/{userId}/chats/{chatId}/messages/{messageId}`.
- Attachment metadata (UUID, filename, format, size, OCR text, and extraction status) is stored directly on the message document, ensuring conversation history retains complete text context across devices.

### Guest Mode Storage
- For guest sessions, conversation metadata and message histories are persisted in browser `localStorage` (`orvix_guest_chats`), active sessions in `sessionStorage`, and binary files in `IndexedDB`.

---

## Resilient Error UI & Recovery Architecture

When upstream provider requests encounter errors (rate limits, 503 high demand, authentication errors), Orvix renders a dedicated error card:
- **Diagnostic Header**: Contextual title (*"Rate Limit or Quota Exceeded"*, *"Service Temporarily Busy"*, *"AI Provider Service Error"*).
- **Referenced Attachment Retention**: Attached documents and images remain visible in the error card so the user retains file context.
- **Responsive Multi-Line Action Wrapping**: Recovery buttons (`Retry with [Model]`, `Try with Gemini`, `Try with Groq`, `Try with OpenRouter`, `Edit prompt`) wrap cleanly across viewports (`display: flex; flex-wrap: wrap; gap: 8px; width: 100%;`).
- **No Overflow**: Word-break prevention stops long error strings or token IDs from breaking container bounds.

---

## Project Structure & Important Files

### Directory Tree

```text
Orvix/
├── .env.example                       # Environment variable template
├── .gitignore                         # Git ignore specifications
├── README.md                          # Comprehensive project documentation
├── api/                               # Serverless function handlers for Vercel
│   ├── chat.ts                        # /api/chat handler wrapper
│   ├── config.ts                      # /api/config handler wrapper
│   ├── health.ts                      # /api/health handler wrapper
│   └── upload.ts                      # /api/upload handler wrapper
├── eng.traineddata                    # Tesseract English OCR trained data
├── firebase-blueprint.json            # Database schema blueprint
├── firestore.rules                    # Production Firestore security rules
├── index.html                         # SPA HTML entry point
├── metadata.json                      # AI Studio metadata & capabilities
├── package.json                       # Dependencies, scripts, and version (v0.4.0)
├── public/                            # Static public assets, icons, and PWA manifest
│   ├── apple-touch-icon.png           # iOS home screen icon
│   ├── favicon.ico                    # Browser favicon
│   ├── favicon.svg                    # Vector favicon
│   ├── icon-192.png                   # 192x192 PWA manifest icon
│   ├── icon-512.png                   # 512x512 PWA manifest icon
│   └── manifest.webmanifest           # Progressive Web App manifest
├── server.ts                          # Express server, Vite middleware, upload & AI proxy
├── src/                               # React 19 client source code
│   ├── App.jsx                        # Root application container & auth router
│   ├── index.css                      # Global CSS entry loading Tailwind and styles
│   ├── main.jsx                       # Application DOM mounting entry point
│   ├── components/                    # Modular UI components
│   │   ├── auth/                      # Authentication & guest entry screens
│   │   ├── chat/                      # ChatArea, ChatMessage, CodeBlock, AttachmentCard,
│   │   │                              # ImageAttachmentCard, DocumentPreviewModal, etc.
│   │   ├── layout/                    # Header, Sidebar, Layout shell, SidebarChatItem
│   │   ├── settings/                  # SettingsModal dialog
│   │   └── ui/                        # Reusable primitives (Button, OrvixLogo)
│   ├── config/                        # Static app constants, chat modes, Firebase config
│   ├── context/                       # AuthContext, SettingsContext, SpeechContext
│   ├── hooks/                         # useVoiceDictation, usePWAInstall
│   ├── pages/                         # ChatPage main conversational view
│   ├── services/                      # aiRouter, imageOcrService, documentExtractor,
│   │                                  # documentContextService, attachmentStorageService, etc.
│   ├── styles/                        # Obsidian Dark & Clean Light design system CSS
│   └── utils/                         # exportConversation, speechTextCleaner, syntaxHighlighter
├── test_all_providers_documents.js    # Document multi-provider test suite
├── test_all_providers_image_ocr.js    # Image OCR multi-provider context test suite
├── test_document_handling.js          # Document extraction & page boundary test suite
├── test_full_image_verification.js    # 23-test end-to-end image verification test suite
├── test_image_ocr_extraction.js       # Image text extraction unit test suite
├── test_image_upload_handling.js      # Image upload & signature security test suite
├── test_server_all_providers_image.js # E2E HTTP image chat test suite across all 4 providers
├── tsconfig.json                      # TypeScript configuration
├── uploads/                           # Temporary file staging directory (auto-cleaned)
│   └── temp/                          # Staging files with UUID filenames
├── vercel.json                        # Vercel deployment configuration
└── vite.config.ts                     # Vite bundler, plugin, and server configuration
```

### Important Files & Modules
- **`server.ts`**: Express backend server handling `/api/chat` SSE streaming, `/api/upload` multipart file handling with magic-number validation, Tesseract OCR dispatch, and Vite middleware.
- **`src/services/imageOcrService.js`**: Managed Tesseract.js OCR worker queue, word count, confidence scoring, text normalization, and noise rejection.
- **`src/services/documentExtractor.js`**: Document parser utilizing `unpdf` for PDF, `mammoth` for DOCX, `jszip` for PPTX, and delimiter parsers for CSV/TSV/JSON/XML.
- **`src/services/documentContextService.js`**: Analyzes prompts for document and image queries, formats OCR text, and bounds context sizes per provider.
- **`src/services/attachmentStorageService.js`**: Browser IndexedDB database manager (`orvix_attachments_db`) caching raw file and image blobs locally.
- **`src/components/chat/ImageAttachmentCard.jsx`**: Responsive visual thumbnail card rendered inside chat messages with hover overlay, metadata badges, and click-to-preview.
- **`src/components/chat/DocumentPreviewModal.jsx`**: Accessible modal with dual "Image" and "Extracted Text" tabs for viewing original images or inspecting OCR text.
- **`src/pages/ChatPage.jsx`**: Coordinates active chat state, attachments staging, streaming response tokens, and Firestore/local persistence.

---

## Environment Variables & Configuration

Environment variables are configured in `.env` in the root directory. Use `.env.example` as a template.

### Configuration Reference Table

| Variable Name | Required? | Scope | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Optional | Server-side | Google Gemini API key used by the backend Express proxy (`server.ts`). |
| `GROQ_API_KEY` | Optional | Server-side | Groq API key used by the backend Express proxy (`server.ts`). |
| `OPENROUTER_API_KEY` | Optional | Server-side | OpenRouter API key used by the backend Express proxy (`server.ts`). |
| `CLOUDFLARE_ACCOUNT_ID` | Optional | Server-side | Cloudflare Account ID for Workers AI REST API requests. |
| `CLOUDFLARE_API_TOKEN` | Optional | Server-side | Cloudflare API Token with Workers AI read/execute permissions. |
| `MAX_FILE_SIZE_BYTES` | Optional | Server-side | Maximum upload file size in bytes (defaults to `26214400` = 25 MB). |
| `MAX_ATTACHMENTS_PER_UPLOAD` | Optional | Server-side | Maximum files allowed per upload (defaults to `5`). |
| `TEMP_FILE_TTL_MS` | Optional | Server-side | Retention time for temporary server files in ms (defaults to `7200000` = 2 hours). |
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
# Server-Side AI API Keys (Kept strictly on backend)
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# File Upload & Attachment Lifecycle Configuration
MAX_FILE_SIZE_BYTES=26214400
MAX_ATTACHMENTS_PER_UPLOAD=5
TEMP_FILE_TTL_MS=7200000

# Client-Side Firebase Configuration (Optional - for cloud persistence & auth)
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=

# Server Runtime Configuration
PORT=3000
NODE_ENV=development
```

---

## Prerequisites & Setup Instructions

### Prerequisites
- **Node.js**: Version `20.x` or `22.x` LTS (`node -v`).
- **NPM**: Version `10.x` or higher (`npm -v`).
- **Modern Browser**: Chrome, Edge, Safari, or Firefox with IndexedDB enabled.

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/Hannankhan203/AI-Studio.git
   cd AI-Studio
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up environment variables:
   ```bash
   cp .env.example .env
   ```
   Add any available API keys to `.env`. If no keys are provided, Orvix automatically operates in **Guest / Demo Mode** with simulated responses.

### Running in Development
```bash
npm run dev
```
Starts `server.ts` with Vite middleware mode on `http://0.0.0.0:3000`.

### Building for Production
```bash
npm run build
```
Compiles client assets into `dist/`.

### Running the Production Server
```bash
npm start
```
Starts `node server.ts` serving static files from `dist/` on port 3000.

### Type Checking & Linting
```bash
npm run lint
```
Runs `tsc --noEmit` to validate all TypeScript code with zero errors.

### Executing Test Suites
```bash
# 1. Full Image Attachment & OCR Verification Suite (23 end-to-end tests)
node test_full_image_verification.js

# 2. Image Upload & Magic-Number Security Suite (10 tests)
node test_image_upload_handling.js

# 3. Server-Side Image Chat E2E Suite Across All 4 Providers
node test_server_all_providers_image.js

# 4. Multi-Provider Image Context Bounding Suite (7 tests)
node test_all_providers_image_ocr.js

# 5. Multi-Provider Document Integration Suite (8 tests)
node test_all_providers_documents.js

# 6. Document Extraction & Page-Boundary Suite (9 tests)
node test_document_handling.js
```

---

## Firebase Setup & Security Rules

To enable cloud authentication and real-time database sync:
1. Create a project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** with the **Email/Password** provider.
3. Enable **Cloud Firestore Database** in production mode.
4. Copy the web credentials into `.env` under `VITE_FIREBASE_*`.
5. Deploy `firestore.rules` via the Firebase Console to enforce per-user document isolation.

---

## Deployment Information

- **Node.js Container / Cloud Run / VPS**: Run `npm install && npm run build && npm start`. The server binds to `0.0.0.0:3000`.
- **Vercel**: Deploy directly. The root `vercel.json` and handlers in `api/` route requests to `/api/chat`, `/api/upload`, `/api/health`, and `/api/config`.

---

## Security Architecture

- **Path Traversal Containment**: Uploaded files receive cryptographically random UUID names. File serving routes validate UUID formats (`/^[0-9a-fA-F-]{36}$/`) and strictly check that resolved paths remain within `UPLOAD_DIR`.
- **Executable Binary Disguise Prevention**: Inspects binary magic numbers before processing. Explicitly rejects executable binaries (Linux ELF, Windows PE/MZ, Mach-O) even if uploaded with an image extension.
- **MIME & Magic Number Validation**: Validates image headers (JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `GIF89a`, WebP `RIFF`/`WEBP`, BMP `BM`, HEIC `ftyp`).
- **Cross-Conversation Isolation**: Documents and images are mapped to specific conversation IDs in memory and database records, preventing cross-conversation data leakage.
- **OCR Timeout Limit**: Server-side OCR is bounded by a 25-second timeout (`OCR_TIMEOUT_MS`) to protect server threads.
- **Credential Redaction**: Internal diagnostic logs scrub API keys, Bearer tokens, and user queries.
- **Private Path Concealment**: Upload responses return only public metadata and file IDs; server-internal filesystem paths are never sent to the client.

---

## Known Limitations

1. **OCR vs Visual Understanding**: Orvix extracts readable printed/typographic text from images using OCR. It does not perform native visual understanding, object detection, or artistic description beyond its extracted text.
2. **Binary Storage Longevity**:
   - Message metadata and extracted OCR text are permanently persisted (to Firestore for authenticated users or `localStorage` for guests).
   - Original binary files are stored client-side in browser **IndexedDB** (`orvix_attachments_db`) for local image reload and preview. On the server, raw binary files are stored in `/uploads/temp` with a 2-hour retention TTL (`TEMP_FILE_TTL_MS`).
   - If a conversation is opened on a different browser device after the temporary server TTL has expired, the conversation history and extracted text remain visible, but the raw binary file cannot be redownloaded from the server disk.
3. **HEIC Browser Native Rendering**: Standard web browsers cannot decode HEIC/HEIF images natively in `<img>` tags without client-side wasm transcoders; the UI displays a clean fallback card with direct download and modal inspection.
4. **Scanned PDFs Without OCR**: PDFs containing exclusively rasterized scans without a text layer require image extraction.
5. **Legacy PowerPoint Binary Format (`.ppt`)**: Direct binary text extraction is supported for modern OpenXML `.pptx` presentations; legacy `.ppt` files trigger a conversion recommendation.

---

## Version History & Changelog

### v0.4.0 — Image Attachment & Optical Character Recognition (OCR) Integration *(Current Release)*
- **Image Attachment & Upload Pipeline**:
  - Added support for attaching image formats: JPEG, JPG, PNG, WebP, GIF, BMP, and HEIC/HEIF.
  - Implemented client-side image preview in the composer dock before sending with instant thumbnail generation, format pill, file size, and remove action.
  - Extended `/api/upload` with binary header and magic number verification for JPEG (`\xFF\xD8\xFF`), PNG (`\x89PNG`), WebP (`RIFF`/`WEBP`), GIF (`GIF87a`/`GIF89a`), BMP (`BM`), and HEIC (`ftyp`).
  - Added security protection against executable binaries (Linux ELF, Windows PE, Mach-O) disguised as image files.
- **Server-Side OCR Text Extraction Engine**:
  - Integrated `tesseract.js` (^7.0.0) with managed worker queue and a 25-second safety timeout.
  - Extracts normalized readable text, confidence percentage (0-100%), word count, character count, and line segmentation.
  - Generates structured OCR metadata accessible via `GET /api/upload/:id/extraction`.
- **Honest No-Readable-Text Handling**:
  - Gracefully detects images containing no readable text (solid graphics, blank canvas, noisy photos).
  - Categorizes status as `NO_TEXT_DETECTED` and immediately returns the exact honest message:
    > **"No readable text detected in this image."**
  - Bypasses unnecessary model hallucinations in both streaming SSE and non-streaming modes across all providers.
- **Image Message Display & Preview Modal**:
  - Implemented `ImageAttachmentCard.jsx` rendering responsive visual thumbnails directly inside user messages.
  - Implemented `DocumentPreviewModal.jsx` with a dual view switcher:
    - **Image Tab**: View full-size original image with fit and zoom.
    - **Extracted Text Tab**: Monospace viewer displaying OCR text, word/character metrics, confidence rating, and one-click **Copy Text**.
  - Added direct file download preserving original filenames and fallback cards for non-browser-native formats (HEIC).
- **Multi-Model Image Text Integration**:
  - Verified image question-answering across all 4 AI providers: Google Gemini, Groq, OpenRouter, and Cloudflare Workers AI.
  - Verified real-time SSE streaming for image questions.
  - Verified multi-image attachments and mixed image + document queries.
- **Regression Testing & Fixes**:
  - Established 23 automated tests in `test_full_image_verification.js`.
  - Fixed server port binding to strictly honor `--port` and port `3000` (`0.0.0.0`).
  - Cleaned up duplicated nested folder structures (`src/src/`, `src/package.json`, `src/server.ts`) from previous repository migration.

### v0.3.0 — File Attachment & Document Understanding Integration + Error UI Overhaul
- **Document Extraction Pipeline**:
  - Integrated `unpdf` for PDF documents with per-page extraction and page boundary detection.
  - Integrated `mammoth` for Word documents (`.docx`), structuring headings and tables into Markdown.
  - Integrated `jszip` for PowerPoint presentations (`.pptx`), parsing slides and presenter speaker notes.
  - Added structured parsers for Tabular Data (CSV, TSV), JSON, XML, and Plain Text / Markdown.
- **Targeted Document Inquiries**:
  - Added query intent detection for page-specific (*"Explain page 3"*), page-range (*"Summarize pages 2 to 4"*), and slide-specific (*"Explain slide 4"*) questions.
  - Implemented boundary validation detecting out-of-bounds page and slide requests without hallucinating.
  - Implemented provider-aware document context bounding (Gemini: 120k chars, Groq: 24k chars, OpenRouter/Cloudflare: 16k chars).
- **Attachment Display & IndexedDB Caching**:
  - Implemented `AttachmentCard.jsx` with inline opening and original file download.
  - Added `attachmentStorageService.js` using browser `IndexedDB` (`orvix_attachments_db`) to cache raw blobs locally for reload persistence.
  - Added referenced document chips on assistant messages to track file provenance.
- **Error UI Redesign**:
  - Overhauled error presentation into responsive diagnostic cards with contextual titles.
  - Added responsive multi-line wrapping for recovery buttons, preventing overflow across viewports.

### v0.2.0 — Cloudflare Workers AI Integration
- **Cloudflare Edge Model Addition**:
  - Integrated **Cloudflare Workers AI — Llama 3.1 8B** (`@cf/meta/llama-3.1-8b-instruct`) as a selectable provider.
  - Connected via Cloudflare's REST API with Server-Sent Events (SSE) streaming and JSON stream adaptation.
  - Added `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to server configuration.

### v0.1.0 — Initial Development Release
- **Foundational Architecture**:
  - React 19 SPA frontend with Tailwind CSS v4 and Obsidian Dark / Clean Light design system.
  - Express backend (`server.ts`) with Vite middleware mode on port 3000.
  - Integrated Google Gemini, Groq, and OpenRouter with streaming SSE.
  - Zero-key simulated response fallback mode.
  - 4 conversational Chat Modes (General, Coding, Writing, Learning).
  - Web Speech voice dictation with verbal punctuation conversion and 9 language options.
  - Web Speech synthesis read-aloud with playback speed adjustments.
  - Cloud Firestore subcollection persistence and Guest Mode local storage.
  - Conversation pinning (5-chat limit) and Markdown/Text client-side export.
  - Progressive Web App manifest and install support.

---

## Future Improvements

*(The following capabilities are planned for future releases and are clearly separated from currently implemented features)*:

1. **Native Multimodal Visual Reasoning**: Connect to vision-capable models (such as `gemini-3.1-flash-lite-image` or native multimodal vision endpoints) for spatial visual reasoning, artwork description, and object segmentation beyond text extraction.
2. **Client-Side HEIC/HEIF Decoding**: Integrate a lightweight WASM/libheif decoder to render HEIC/HEIF images natively in the browser without server transcoding.
3. **Guest-to-Account History Migration**: Automatically transfer local guest conversations and IndexedDB attachment blobs into a newly registered Cloud Firestore account.
4. **Permanent Cloud Binary Object Storage**: Integrate Firebase Cloud Storage or Google Cloud Storage buckets for long-term multi-device raw binary persistence beyond the local device's IndexedDB cache.
5. **Full-Text Message Search**: Implement client-side indexing across all saved conversation titles, message contents, and extracted attachment text.
