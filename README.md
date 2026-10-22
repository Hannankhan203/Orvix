# Orvix

**Current Version: Orvix v0.7.0**

<p align="center">
  <strong>An Intelligent, Multi-Model AI Conversation Companion with Live Response-Time Measurement, Left-Edge Swipe Gesture Navigation, Controlled Large-Response Continuation, Multimodal Attachment Inputs, Deep Document Understanding, Image Optical Character Recognition (OCR), and Serverless Production Resilience</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Project Purpose & Current Status](#project-purpose--current-status)
3. [Latest Update: v0.7.0 Usability & Interface Update](#latest-update-v070-usability--interface-update)
   - [Live Response-Time Measurement](#live-response-time-measurement)
   - [Left-Edge Swipe Gesture for Chat History](#left-edge-swipe-gesture-for-chat-history)
4. [Controlled Large-Response Continuation](#controlled-large-response-continuation)
   - [Overview & Safe Output Budgeting](#overview--safe-output-budgeting)
   - [Continuation Notices & User Triggers](#continuation-notices--user-triggers)
   - [Interactive Composer Continuation Chip](#interactive-composer-continuation-chip)
   - [Context, Prompt & Attachment Preservation](#context-prompt--attachment-preservation)
   - [Multiple Continuations & History Persistence](#multiple-continuations--history-persistence)
5. [Three Attachment Methods & Multimodal Inputs](#three-attachment-methods--multimodal-inputs)
   - [Method 1: File Picker Upload Button](#method-1-file-picker-upload-button)
   - [Method 2: Clipboard Paste (`Ctrl + V`)](#method-2-clipboard-paste-ctrl--v)
   - [Method 3: Drag-and-Drop Interaction](#method-3-drag-and-drop-interaction)
   - [Strict One-Attachment-Per-Message Rule](#strict-one-attachment-per-message-rule)
   - [Unified Processing Pipeline & 25MB Limit](#unified-processing-pipeline--25mb-limit)
   - [Composer Attachment Preview & Removal](#composer-attachment-preview--removal)
6. [AI Providers & Selectable Models](#ai-providers--selectable-models)
   - [Fully Implemented Providers](#fully-implemented-providers)
   - [Provider Context Capacities](#provider-context-capacities)
   - [AI Provider Routing, Streaming & Fallbacks](#ai-provider-routing-streaming--fallbacks)
   - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
7. [Conversational & Text Chat Features](#conversational--text-chat-features)
   - [Multi-Turn Memory & Context Retention](#multi-turn-memory--context-retention)
   - [Chat Modes & Persona Directives](#chat-modes--persona-directives)
   - [Personalization & Response Preferences](#personalization--response-preferences)
   - [Voice Dictation & Verbal Punctuation Engine](#voice-dictation--verbal-punctuation-engine)
   - [Text-to-Speech (Read Aloud)](#text-to-speech-read-aloud)
   - [Conversation Management & Client-Side Export](#conversation-management--client-side-export)
8. [Document Understanding & Analysis](#document-understanding--analysis)
   - [Supported Document Formats](#supported-document-formats)
   - [Targeted Questioning (Pages, Ranges, Slides)](#targeted-questioning-pages-ranges-slides)
   - [Presenter Notes Extraction](#presenter-notes-extraction)
   - [Scanned & Rasterized PDF Diagnostics](#scanned--rasterized-pdf-diagnostics)
9. [Image Attachments & Optical Character Recognition (OCR)](#image-attachments--optical-character-recognition-ocr)
   - [Image Upload & Verification Pipeline](#image-upload--verification-pipeline)
   - [Supported Image Formats](#supported-image-formats)
   - [Server-Side OCR Extraction Engine](#server-side-ocr-extraction-engine)
   - [Honest No-Readable-Text Handling](#honest-no-readable-text-handling)
   - [Image Thumbnail Cards & User Message Display](#image-thumbnail-cards--user-message-display)
   - [Image Preview Modal & OCR Text Inspection](#image-preview-modal--ocr-text-inspection)
   - [OCR vs Native Visual Reasoning Clarification](#ocr-vs-native-visual-reasoning-clarification)
10. [Architecture & Technology Stack](#architecture--technology-stack)
    - [Frontend Architecture](#frontend-architecture)
    - [Backend Architecture](#backend-architecture)
    - [Production Serverless & In-Memory Pipeline](#production-serverless--in-memory-pipeline)
    - [Database & Authentication Architecture](#database--authentication-architecture)
11. [Storage & Persistence Architecture](#storage--persistence-architecture)
    - [Client-Side IndexedDB Storage](#client-side-indexeddb-storage)
    - [Serverless-Resilient In-Memory Staging](#serverless-resilient-in-memory-staging)
    - [Cloud Firestore Message History](#cloud-firestore-message-history)
    - [Guest Mode Storage](#guest-mode-storage)
12. [Resilient Error UI & Recovery Architecture](#resilient-error-ui--recovery-architecture)
13. [Project Structure & Important Files](#project-structure--important-files)
    - [Directory Tree](#directory-tree)
    - [Important Files & Modules](#important-files--modules)
14. [Environment Variables & Configuration](#environment-variables--configuration)
    - [Configuration Reference Table](#configuration-reference-table)
    - [Configuration Template (`.env.example`)](#configuration-template-envexample)
15. [Prerequisites & Setup Instructions](#prerequisites--setup-instructions)
    - [Prerequisites](#prerequisites)
    - [Installation](#installation)
    - [Running in Development](#running-in-development)
    - [Building for Production](#building-for-production)
    - [Running the Production Server](#running-the-production-server)
    - [Type Checking & Linting](#type-checking--linting)
16. [Deployment Instructions](#deployment-instructions)
17. [Firebase Setup & Security Rules](#firebase-setup--security-rules)
18. [Security Architecture](#security-architecture)
19. [Known Limitations](#known-limitations)
20. [Version History & Changelog](#version-history--changelog)
21. [Future Improvements](#future-improvements)

---

## Project Overview

**Orvix** is an intelligent, multi-model conversational AI web application designed for high-performance text conversation, live latency transparency, touch-optimized responsive navigation, surgical document comprehension, image Optical Character Recognition (OCR), and production-grade serverless reliability. Built as a full-stack Node.js application with a responsive React 19 single-page frontend and an Express proxy backend running Vite in middleware mode, Orvix provides seamless access to leading open and proprietary language models while ensuring zero credential exposure, robust client-side caching, and complete user privacy.

Orvix integrates four selectable AI providers:
- **Google Gemini** (`gemini-3.8-flash` primary, with automatic failover to `gemini-3.1-flash-lite`) via the modern `@google/genai` TypeScript SDK.
- **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via high-speed OpenAI-compatible REST completions.
- **OpenRouter** (`openrouter/free`) routing across high-capacity free community models.
- **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct`) providing serverless inference on Cloudflare's global edge network.

With **version v0.7.0**, Orvix introduces **Live Response-Time Measurement** (real-time elapsed timer badge during inference and exact duration persistence) and a native, conflict-free **Left-Edge Swipe Gesture for Chat History** on mobile and tablet devices, complementing the existing hamburger button.

---

## Project Purpose & Current Status

### Purpose
Orvix was engineered to deliver an accessible, flexible, and privacy-conscious AI workspace:
1. **Live Latency Transparency**: Display live elapsed response-generation time in seconds as the AI streams tokens, followed by an exact final response time badge stored across sessions and exports.
2. **Natural Mobile & Tablet Navigation**: Allow users to swipe right from the left screen edge (within 20–40px) to slide open the chat history sidebar, coexisting seamlessly with the hamburger menu.
3. **Controlled Multi-Part Large Output Handling**: Deliver deep, exhaustive answers safely without risking token truncations, gateway timeouts, or incomplete responses.
4. **Effortless Multimodal Inputs**: Attach images and documents via file picker dialog, pasting copied items directly from the clipboard with `Ctrl + V`, or dragging and dropping files from your desktop.
5. **Multi-Model Flexibility**: Switch models on the fly (Gemini, Groq, OpenRouter, Cloudflare Workers AI) within the same conversation without losing message history or attached file contexts.
6. **Deep Document & Image Text Understanding**: Extract and analyze text from complex multi-page PDFs, Word documents, PowerPoint presentations, spreadsheets, data files, and images (OCR) with precise page/slide/section boundary citations.
7. **Frictionless Onboarding**: Explore the complete application immediately via Guest Mode without requiring API keys, cloud subscriptions, or account creation.
8. **Secure Server-Side Proxying**: Route all AI completions, uploads, and OCR through a protected Express server (`/api/chat`, `/api/upload`), ensuring API keys, file system paths, and raw payloads are never exposed to the client.
9. **Production Serverless Resilience**: Process uploads in-memory on serverless deployments where filesystems are strictly read-only, while preserving disk-backed workflows in local development.
10. **Accessible Multimodal Speech**: Built-in voice dictation with spoken verbal punctuation conversion and Web Speech synthesis read-aloud with playback speed adjustments.
11. **Local-First Reliability**: Original files are cached in browser IndexedDB to survive page reloads and network reconnects even when temporary server files have expired.

### Current Status
- **Current Version**: `v0.7.0` (Semantic Versioning: `MAJOR.MINOR.PATCH`).
- **Build Status**: Verified on Node.js 22 LTS. All TypeScript checks (`npm run lint`), Vite builds (`npm run build`), and test suites pass with zero errors.

---

## Latest Update: v0.7.0 Usability & Interface Update

Version `v0.7.0` is a targeted usability and interface update delivering two core quality-of-life enhancements:

### Live Response-Time Measurement

Orvix now measures and displays the elapsed response generation duration for every assistant reply:

1. **Active Streaming Phase (`LiveResponseTimer`)**:
   - While an AI model is actively streaming tokens, a lightweight, self-contained live badge appears above the message bubble: `Thinking... 1.4s`.
   - Uses high-resolution browser timing (`performance.now()`) with a 100ms refresh interval scoped strictly to the timer component, eliminating unnecessary chat re-renders.
2. **Final Elapsed Duration Badge**:
   - Upon completion (or manual stop), the live timer seamlessly transitions to a static badge: `Response time: 2.3s` (or `Response time: 1m 04s` for longer multi-part tasks).
   - Formatted via `src/utils/formatResponseTime.js`:
     - Under 60 seconds: seconds with one decimal place (e.g. `0.8s`, `2.4s`, `8.7s`).
     - 60 seconds to 59 minutes: minutes and padded seconds (e.g. `1m 08s`, `2m 15s`).
     - 1 hour or more: hours, minutes, and seconds (e.g. `1h 02m 05s`).
3. **Session & Export Persistence**:
   - The final `responseTimeMs` value is stored immutably in Cloud Firestore (`ChatMessage.responseTimeMs`) and `localStorage` for guest mode.
   - Preserved in client-side Markdown and Plain Text conversation exports (`src/utils/exportConversation.js`).

### Left-Edge Swipe Gesture for Chat History

Mobile and tablet users can now quickly view and switch chat threads with an intuitive edge gesture:

1. **Activation Zone & Coordinates**:
   - Swiping right starting within 0–40px from the left edge of the viewport (`EDGE_ZONE_PX = 40`) initiates drawer opening.
   - Active on mobile and tablet viewport widths (`window.innerWidth <= 1024`).
2. **Intent Resolution & Vertical Scroll Preservation**:
   - An initial 8px displacement check (`INTENT_THRESHOLD_PX = 8`) cleanly distinguishes horizontal swipes from vertical chat scrolling.
   - If vertical displacement exceeds horizontal movement (`absY >= absX`) or movement is leftward (`deltaX <= 0`), tracking is immediately released without calling `preventDefault()`, ensuring native vertical scrolling remains 100% smooth and uninterrupted.
3. **Threshold & Snap**:
   - A rightward movement of 40px (`MIN_SWIPE_PX = 40`) or a fast rightward flick (`deltaX >= 25px` with velocity > 0.3 px/ms) opens the sidebar.
4. **Collision-Free Architecture**:
   - Native Touch Events and Pointer Events operate with isolated internal state. Browser `pointercancel` events (dispatched during native scrolling) only reset pointer state and cannot kill active native touch swipes.
   - Interactive elements (`<input>`, `<textarea>`, `<button>`, `[role="dialog"]`) are ignored so typing and button taps are never hijacked.
   - The existing hamburger button, close button, backdrop tap, and Escape key behavior continue to work identically.

---

## Controlled Large-Response Continuation

### Overview & Safe Output Budgeting

Standard conversational queries receive their complete answer in a single assistant message. However, when a user asks for an exhaustive analysis, an end-to-end tutorial, a multi-chapter guide, or a comprehensive breakdown of an attached multi-page document, returning the entire output at once risks gateway timeouts, token truncation, and unreadable walls of text.

To solve this, Orvix features a **Controlled Large-Response Continuation System** managed by `src/services/multiPartResponseService.js`. When `detectLargeResponseIntent()` determines that a request exceeds a safe single-response budget, Orvix divides the response into natural, coherent parts.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        LARGE-RESPONSE FLOW                             │
│                                                                        │
│  User Prompt: "Write a comprehensive 5-part architecture guide..."     │
│        │                                                               │
│        ▼                                                               │
│  detectLargeResponseIntent() identifies exhaustive scope               │
│        │                                                               │
│        ▼                                                               │
│  Assistant responds with Part 1 (foundational architecture)            │
│        │                                                               │
│        ▼ Appends Continuation Notice:                                  │
│  "---                                                                  │
│   This is a large response, so I’ve provided the first part.           │
│   Reply 'Continue' and I’ll send the rest."                            │
│        │                                                               │
│        ├─────────────────────────────┬─────────────────────────────────┤
│        ▼                             ▼                                 ▼
│  User types "Continue"       User clicks quick chip:          User types "Send rest"
│                              [ → Continue response ]                   │
│        │                             │                                 │
│        └─────────────────────────────┼─────────────────────────────────┘
│                                      ▼
│  isContinuationRequest() catches phrase & triggers Part 2              │
│  resolveMultiPartContext() carries forward:                            │
│    - Original prompt & attached documents                              │
│    - Summary of topics already covered in previous parts               │
│    - Explicit instruction to continue seamlessly WITHOUT restarting    │
│        │                                                               │
│        ▼                                                               │
│  Assistant responds with Part 2 (subsequent sections)                  │
└────────────────────────────────────────────────────────────────────────┘
```

### Continuation Notices & User Triggers

When an answer is partitioned, Orvix ends the message with a clear, markdown-formatted continuation notice:
- **Part 1 Notice**:
  > *This is a large response, so I’ve provided the first part. Reply "Continue" and I’ll send the rest.*
- **Subsequent Parts Notice**:
  > *There is still more to cover. Reply "Continue" for the next part.*

The continuation engine recognizes a comprehensive list of continuation phrases (`isContinuationRequest`), including:
- `"continue"`, `"cont"`, `"go on"`, `"carry on"`, `"keep going"`
- `"send the rest"`, `"send rest"`, `"give me the rest"`, `"show the rest"`
- `"next"`, `"next part"`, `"next section"`, `"part 2"`, `"part 3"`
- `"more"`, `"more please"`, `"please continue"`, `"proceed"`
- `"finish the answer"`, `"complete the answer"`, `"finish the response"`

### Interactive Composer Continuation Chip

Users do not even need to type. Whenever the most recent assistant message concludes with a continuation notice (`canContinueLastMessage` in `ChatArea.jsx`), an interactive quick-action chip appears floating above the composer:

```
[ → Continue response ]
```

Clicking this chip immediately issues a `Continue` command, streaming the next segment seamlessly.

### Context, Prompt & Attachment Preservation

Orvix prevents model hallucination and restarting via `resolveMultiPartContext()` and `buildMultiPartPromptAugmentation()`:
1. **Original Prompt Retention**: Inspects conversation history to retrieve the root user prompt that initiated the multi-part sequence.
2. **Attached File & Document Forwarding**: If the original prompt included an attached document or image, its extracted text and metadata are automatically forwarded into the continuation request.
3. **Covered Content Tracking**: A synthesized record of what sections were covered in prior parts is passed to the AI prompt with strict instructions:
   > *"Continue from where the previous part ended. DO NOT restart the response or repeat sections already delivered. Begin immediately with the next section."*

### Multiple Continuations & History Persistence

- Orvix supports chains of multiple continuations (Part 1 → Part 2 → Part 3 → Final Part) until the entire topic is exhaustively completed.
- When the final section has been fully delivered, Orvix omits the continuation notice, signaling completion.
- Each part is stored as an independent, fully rendered assistant message with response time metadata. Both Firestore (for authenticated users) and `localStorage` (for guests) persist every part.

---

## Three Attachment Methods & Multimodal Inputs

Orvix supports **three distinct ways to attach an image or file** to your message. All three methods route through the identical validation and processing pipeline (`processAttachment` in `src/components/chat/ChatArea.jsx`), ensuring consistent behavior across desktop and mobile.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   THREE WAYS TO ATTACH IN ORVIX                        │
│                                                                        │
│   1. Paperclip Button        2. Ctrl + V Paste       3. Drag-and-Drop  │
│      [ 📎 Attach ]             [ Clipboard ]            [ OS Files ]   │
│            │                         │                       │         │
│            ▼                         ▼                       ▼         │
│   Native File Dialog        MIME File Extraction      Drag-Over Banner │
│            │                         │                       │         │
│            └─────────────────────────┼───────────────────────┘         │
│                                      ▼                                 │
│                   ┌──────────────────────────────────────┐             │
│                   │      processAttachment() Pipeline    │             │
│                   ├──────────────────────────────────────┤             │
│                   │ 1. Strictly 1 attachment per message │             │
│                   │ 2. 25MB maximum file size limit      │             │
│                   │ 3. Supported extension & MIME check  │             │
│                   │ 4. Client-side thumbnail generation  │             │
│                   └──────────────────┬───────────────────┘             │
│                                      ▼                                 │
│                   Composer Attachment Chip Preview                     │
│                   [ 📄 document.pdf (2.4 MB)  ✕ ]                     │
└────────────────────────────────────────────────────────────────────────┘
```

### Method 1: File Picker Upload Button
- Located directly in the composer dock as a paperclip button (`composer-attach-btn`).
- Clicking it opens the native operating system file selection dialog.
- Configured with `accept` attributes for all supported image and document MIME types.

### Method 2: Clipboard Paste (`Ctrl + V`)
- Copy an image or supported file to your clipboard and press `Ctrl + V` while the chat input is focused.
- **Intelligent MIME Resolution**: When copying raw image data without a filename (e.g. Snipping Tool), Orvix automatically generates a sensible filename (e.g. `pasted-image.png`).
- **Normal Text Paste Preserved**: Standard text, URLs, and code snippets pass through unhindered directly into the textarea.

### Method 3: Drag-and-Drop Interaction
- Drag any supported image or document from your computer's file explorer directly over the chat area (`.chat-area-container`).
- **Visual Feedback**: The chat area and composer form highlight with an Obsidian-accented dashed border (`.is-drag-over`) and a clear drop indicator banner:
  > **Drop file to attach**
- **Window Drop Protection**: Prevents the browser's default behavior of navigating away or opening raw files when dragged over the window.

### Strict One-Attachment-Per-Message Rule
Orvix strictly enforces **one attachment maximum per message** across all three input methods:
- **Button**: Rejects multi-selection and displays a notice if clicked while a file is already attached.
- **Paste (`Ctrl + V`)**: Rejects duplicate pastes with:
  > *"Only one attachment can be added per message. Remove the current attachment before pasting another file."*
- **Drag-and-Drop**: Rejects duplicate drops with:
  > *"Only one attachment can be added per message. Remove the current attachment before adding another file."*

### Unified Processing Pipeline & 25MB Limit
Every attached file passes through the same validation:
1. **Size Restriction**: Hard limit of **25 MB** per file. Files exceeding this are rejected with:
   > *"File '[filename]' exceeds the maximum allowed size of 25MB."*
2. **Format Whitelist**:
   - **Images**: PNG, JPG, JPEG, WEBP, GIF, BMP, HEIC/HEIF.
   - **Documents**: PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, CSV, TSV, JSON, XML, TXT, MD.
3. **Instant Preview Generation**: Image files immediately generate an in-memory thumbnail preview (`URL.createObjectURL`), while document files render an extension badge pill (`PDF`, `DOCX`, etc.).

### Composer Attachment Preview & Removal
- When an attachment is staged, a preview strip renders above the input field with the file name, formatted size, and an explicit `"One attachment maximum per message"` indicator.
- Clicking the **Remove (✕)** button instantly purges the file, revokes object URLs to prevent memory leaks, and clears file input references.

---

## AI Providers & Selectable Models

### Fully Implemented Providers

| Provider | Model Identifier | Primary / Fallback Role | Max Context Budget | Protocol / Integration |
| :--- | :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-3.8-flash` | Primary Model | 120,000 characters | Official `@google/genai` TypeScript SDK with SSE streaming |
| **Google Gemini (Fallback)** | `gemini-3.1-flash-lite` | Automatic Resilient Fallback | 120,000 characters | Seamless failover on 429/503 quota or rate limit events |
| **Groq** | `llama-3.3-70b-versatile` | Ultra-Fast Primary | 24,000 characters | OpenAI-compatible REST API via Groq LPU inference |
| **Groq (Alternative)** | `openai/gpt-oss-120b` | High-Capacity Model | 24,000 characters | Fast secondary option for complex code generation |
| **OpenRouter** | `openrouter/free` | Free Multi-Model Router | 16,000 characters | OpenRouter completions API routing to free community models |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | Global Edge Inference | 16,000 characters | Cloudflare REST API with Server-Sent Events stream transform |

### Provider Context Capacities
When documents or OCR text are injected into prompts, Orvix applies context bounds tailored to each provider's context window:
- **Gemini**: 120,000 characters (~30,000 tokens)
- **Groq**: 24,000 characters (~6,000 tokens)
- **OpenRouter & Cloudflare**: 16,000 characters (~4,000 tokens)

### AI Provider Routing, Streaming & Fallbacks
1. **Real-Time Streaming**: Responses stream to the browser via Server-Sent Events (SSE) through `POST /api/chat`.
2. **Automatic Provider Failover**: If Gemini `gemini-3.8-flash` encounters a quota error or high demand, the server retries `gemini-3.1-flash-lite` automatically before returning an error.
3. **One-Click Model Switch & Retry**: When a provider quota or rate limit is reached, error banners offer a one-click button to retry the prompt using an alternative active provider (e.g., switch to Groq or Gemini).

### Zero-Key Simulation Mode
If no API keys are provided in `.env`, Orvix runs in **Simulation Mode**:
- Generates realistic, contextual responses without crashing.
- Simulates live response time calculation and large multi-part responses with continuation invitations for testing.
- Allows full exploration of the UI, modes, attachments, OCR inspection, and export features.

---

## Conversational & Text Chat Features

### Multi-Turn Memory & Context Retention
- Maintains full conversation history across multiple turns.
- Intelligently truncates history when approaching provider context limits to prevent submission errors.

### Chat Modes & Persona Directives
Orvix provides 4 specialized chat modes with tailored system instructions:
- **General Assistant**: Balanced, versatile companion for everyday tasks.
- **Coding Specialist**: Concise code blocks, minimal fluff, strict architecture patterns, and syntax highlighting.
- **Writing Coach**: Focuses on tone, structure, vocabulary, and polished prose.
- **Learning Tutor**: Socratic guidance, analogies, step-by-step explanations, and comprehension quizzes.

### Personalization & Response Preferences
User settings permit custom persona overrides:
- **Tone**: Professional, Casual, Academic, Creative, or Concise.
- **Response Length**: Concise, Balanced, or Detailed.
- **Enter to Send**: Configurable between Plain Enter and `Ctrl + Enter`.

### Voice Dictation & Verbal Punctuation Engine
- Uses the Web Speech API with multi-language recognition (9 languages).
- **Spoken Verbal Punctuation**: Automatically converts verbal commands into punctuation:
  - *"comma"* → `,`
  - *"period"* / *"full stop"* → `.`
  - *"question mark"* → `?`
  - *"exclamation mark"* → `!`
  - *"new line"* / *"new paragraph"* → `\n`
- Live soundwave audio frequency visualization during speech.

### Text-to-Speech (Read Aloud)
- Reads assistant messages aloud using browser speech synthesis.
- Controls for Play, Pause, Resume, Stop, and speed rate adjustments (0.75x to 1.5x).

### Conversation Management & Client-Side Export
- Rename and delete conversation threads.
- Pin up to 5 important conversations to the top of the sidebar.
- Export entire threads to **Markdown (`.md`)** or **Plain Text (`.txt`)** with zero server roundtrips, including timestamps and final response times.

---

## Document Understanding & Analysis

### Supported Document Formats
Orvix extracts text from a wide range of documents:
- **PDF Documents (`.pdf`)**: Page-by-page text extraction via `unpdf`.
- **Microsoft Word (`.docx`)**: Heading, list, and table structure preservation via `mammoth`.
- **PowerPoint Presentations (`.pptx`)**: Slide-by-slide extraction including presenter speaker notes via `jszip`.
- **Structured Data**: CSV, TSV, JSON, XML.
- **Plain Text**: TXT, Markdown (`.md`).

### Targeted Questioning (Pages, Ranges, Slides)
Users can ask targeted questions about specific sections of an attached document:
- *"What is discussed on page 3?"*
- *"Summarize pages 2 to 5."*
- *"Explain slide 4."*
Orvix extracts only the relevant pages or slides, validating boundaries to prevent hallucinations.

### Presenter Notes Extraction
For `.pptx` presentations, Orvix extracts speaker notes attached to individual slides, allowing the AI to answer questions about the presenter's speaking points.

### Scanned & Rasterized PDF Diagnostics
If a PDF consists solely of scanned raster images without an embedded text layer, Orvix detects the missing text layer and provides a clear diagnostic notice suggesting OCR extraction.

---

## Image Attachments & Optical Character Recognition (OCR)

### Image Upload & Verification Pipeline
When an image is attached via upload button, `Ctrl + V` clipboard paste, or drag-and-drop:
1. Verified against binary magic numbers (JPEG `\xFF\xD8\xFF`, PNG `\x89PNG`, WebP `RIFF`/`WEBP`, GIF `GIF87a`/`GIF89a`, BMP `BM`, HEIC `ftyp`).
2. Disguised executable files (ELF, PE, Mach-O) are strictly rejected.
3. Processed by the server-side OCR engine.

### Supported Image Formats
- JPEG / JPG
- PNG
- WebP
- GIF
- BMP
- HEIC / HEIF

### Server-Side OCR Extraction Engine
- Powered by `tesseract.js` (^7.0.0) with managed worker queues and a 25-second safety timeout.
- Extracts clean text, confidence metrics (0–100%), word count, character count, and line segmentation.

### Honest No-Readable-Text Handling
If an image contains no readable text (e.g. abstract art, blank canvas, low-contrast photograph), Orvix flags it as `NO_TEXT_DETECTED` and reports:
> **"No readable text detected in this image."**
This prevents hallucinated responses across all AI models.

### Image Thumbnail Cards & User Message Display
- Attached images render as responsive thumbnail cards directly inside user message bubbles.
- Displays image dimensions, file size, and format badge.

### Image Preview Modal & OCR Text Inspection
Clicking an image opens `DocumentPreviewModal.jsx` with a dual-tab viewer:
- **Image Tab**: High-resolution view with zoom and aspect ratio controls.
- **Extracted Text Tab**: Monospace text viewer displaying OCR results, confidence metrics, and a one-click **Copy Text** button.

### OCR vs Native Visual Reasoning Clarification
Orvix extracts readable printed and typographic text via OCR. It does not perform spatial visual reasoning, artistic description, or object segmentation beyond text extraction.

---

## Architecture & Technology Stack

### Frontend Architecture
- **Framework**: React 19 (`react` ^19.0.1, `react-dom` ^19.0.1).
- **Build Tool**: Vite (`vite` ^8.3.0) with `@vitejs/plugin-react` (^6.1.1).
- **Styling**: Tailwind CSS v4 (`tailwindcss` ^4.3.3, `@tailwindcss/vite` ^4.3.3) paired with an Obsidian Dark and Clean Light design system.
- **Icons**: Lucide React (`lucide-react` ^0.546.0).
- **Markdown & Code**: `react-markdown` (^10.1.0) and `remark-gfm` (^4.0.1).
- **Client Cache**: Browser `IndexedDB` (`orvix_attachments_db`) for local blob persistence.

### Backend Architecture
- **Server**: Express (`express` ^4.22.3) in TypeScript (`server.ts`).
- **Development Runtime**: `tsx` (^4.21.0) running `server.ts` with Vite middleware mode on port 3000 (`0.0.0.0`).
- **Production Server**: Serves pre-built assets from `dist/` with SPA routing fallback to `index.html`.
- **Endpoints**:
  - `GET /api/health`: Uptime and system status check.
  - `GET /api/config`: Provider configuration status without leaking keys.
  - `POST /api/chat`: Multi-provider AI router with SSE streaming.
  - `POST /api/upload`: Multipart upload handling, magic number validation, and OCR.
  - `GET /api/upload/config`: Returns upload bounds (25 MB max file size, 1 attachment per message).
  - `GET /api/upload/:id`: Returns attachment metadata and parsing status.
  - `GET /api/upload/:id/extraction`: Returns structured OCR text or document sections.
  - `GET /api/upload/:id/file`: Serves raw file data from memory buffer or disk.
  - `DELETE /api/upload/:id`: Removes staged attachments.

### Production Serverless & In-Memory Pipeline
- Uploads use `multer.memoryStorage()`, avoiding read-only filesystem errors (`EROFS`) on Vercel and AWS Lambda.
- Dual-mode serving: files are served directly from in-memory buffers (`record.buffer`) with optional disk caching when running locally.
- Client-side `AbortController` configured with a 90-second timeout for large files and OCR processing.

### Database & Authentication Architecture
- **Firebase Auth**: Secure Google Sign-In and Email/Password authentication.
- **Cloud Firestore**: Stores chat documents, message threads, and user preferences under `users/{uid}/chats/{chatId}/messages/{messageId}`.
- **Guest Mode**: Allows complete application usage without an account, saving history, response times, and pins in browser `localStorage`.

---

## Storage & Persistence Architecture

### Client-Side IndexedDB Storage
Raw binary files and images are stored locally in the browser's `IndexedDB` (`orvix_attachments_db` via `src/services/attachmentStorageService.js`). This ensures that image previews, thumbnails, and downloads survive page reloads even if temporary server files have expired.

### Serverless-Resilient In-Memory Staging
Incoming files are buffered in memory and indexed by a unique attachment ID (`att-{timestamp}-{hash}`). On platforms like Vercel, this prevents disk write crashes while providing fast access during chat generation.

### Cloud Firestore Message History
For authenticated users, conversations are persisted in Cloud Firestore:
- `users/{uid}`: Profile settings and persona preferences.
- `users/{uid}/chats/{chatId}`: Conversation metadata, mode, pin status, and updated timestamp.
- `users/{uid}/chats/{chatId}/messages/{messageId}`: Message content, sender, timestamp, model used, response time (`responseTimeMs`), and attachment metadata.

### Guest Mode Storage
For unauthenticated users, conversation threads and pins are stored in `localStorage` under `orvix_guest_chats` and `orvix_guest_pins`.

---

## Resilient Error UI & Recovery Architecture

Orvix features a responsive diagnostic error system:
1. **Contextual Error Banners**: Identifies error types (Rate Limit, Quota Exceeded, Service Busy, Auth Error, Network Timeout) with tailored titles.
2. **One-Click Recovery Actions**:
   - **Retry**: Immediately re-executes the request with the same provider.
   - **Switch Provider & Retry**: Switches to an active alternative provider (e.g. Gemini → Groq) and re-executes the prompt.
   - **Restore Prompt**: Restores the failed prompt into the composer textarea for editing.
3. **Responsive Button Wrapping**: Error card action buttons wrap gracefully across mobile and desktop viewports without overflowing.

---

## Project Structure & Important Files

### Directory Tree

```text
├── api/                             # Serverless API route handlers
│   ├── chat.ts                      # Multi-provider AI streaming router
│   ├── config.ts                    # Public configuration status endpoint
│   ├── health.ts                    # Health check endpoint
│   └── upload.ts                    # Multipart file upload & OCR handler
├── public/                          # Static assets, icons & PWA manifest
│   ├── favicon.ico
│   ├── icon-192.png
│   ├── icon-512.png
│   └── manifest.webmanifest
├── src/
│   ├── components/
│   │   ├── auth/                    # Authentication modal & guest switcher
│   │   ├── chat/                    # Chat interface components
│   │   │   ├── AttachmentCard.jsx   # Document attachment chip & card
│   │   │   ├── ChatArea.jsx         # Composer dock, paste & drop handlers
│   │   │   ├── ChatMessage.jsx      # Markdown message rendering, live timer & response badge
│   │   │   ├── CodeBlock.jsx        # Syntax highlighter & copy button
│   │   │   ├── DocumentPreviewModal.jsx # Full-screen image/OCR preview
│   │   │   ├── ExportChatMenu.jsx   # Markdown / Plain Text export
│   │   │   ├── ImageAttachmentCard.jsx  # Inline image message thumbnail
│   │   │   ├── MessageList.jsx      # Virtualized scrollable message list
│   │   │   ├── ModeSelector.jsx     # Conversational mode switcher
│   │   │   ├── ModelSelector.jsx    # AI provider & model selector
│   │   │   ├── PromptSuggestions.jsx# Welcome prompt inspiration chips
│   │   │   └── TypingIndicator.jsx  # Streaming indicator dots
│   │   ├── layout/                  # Navigation header, sidebar & layout
│   │   │   ├── Header.jsx           # Desktop/mobile navigation & hamburger
│   │   │   ├── Layout.jsx           # App shell, responsive drawers & edge swipe gesture
│   │   │   ├── Sidebar.jsx          # Collapsible chat history sidebar
│   │   │   └── SidebarChatItem.jsx  # Chat thread item with pin/rename/delete
│   │   ├── settings/                # User preferences & persona modal
│   │   └── ui/                      # Reusable UI primitives (Button, Logo)
│   ├── config/                      # App configuration, modes & Firebase
│   ├── context/                     # React context (Auth, Settings, Speech)
│   ├── hooks/                       # Custom hooks (PWA install, voice dictation)
│   ├── pages/                       # ChatPage main page component
│   ├── services/                    # Core business logic services
│   │   ├── aiRouter.js              # Client-side AI router & fallback logic
│   │   ├── attachmentStorageService.js # IndexedDB blob storage
│   │   ├── authService.js           # Firebase authentication wrapper
│   │   ├── chatStorageService.js    # Firestore & localStorage chat persistence
│   │   ├── documentContextService.js# Context budgeting & attachment formatting
│   │   ├── documentExtractor.js     # PDF, DOCX, PPTX document parsers
│   │   ├── geminiService.js         # Google Gemini integration
│   │   ├── groqService.js           # Groq REST API integration
│   │   ├── imageOcrService.js       # Tesseract.js OCR engine
│   │   ├── multiPartResponseService.js # Large-response continuation engine
│   │   └── openrouterService.js     # OpenRouter completions API
│   ├── styles/                      # Tailwind CSS v4 & theme definitions
│   └── utils/                       # Export, speech, formatResponseTime & highlighter utilities
├── server.ts                        # Express development & production server
├── vite.config.ts                   # Vite configuration
├── package.json                     # Project dependencies & scripts
├── .env.example                     # Environment configuration template
└── README.md                        # Project documentation
```

### Important Files & Modules
- `src/components/layout/Layout.jsx`: Native touch & pointer edge swipe gesture recognizer, viewport bounds, and drawer layout management.
- `src/components/chat/ChatMessage.jsx`: `LiveResponseTimer` streaming elapsed badge, finalized duration badge, and markdown message rendering.
- `src/utils/formatResponseTime.js`: Human-readable duration formatting utility (seconds, minutes/seconds, hours/minutes).
- `src/services/multiPartResponseService.js`: Intent detection, continuation phrases, context resolution, and multi-part coordination.
- `src/components/chat/ChatArea.jsx`: Unified `processAttachment` pipeline, clipboard paste handler (`handlePaste`), drag-and-drop handlers, drop banner, and continuation chip.
- `src/pages/ChatPage.jsx`: Top-level conversation controller, attachment submission, streaming handler, response-time calculation, and multi-part context forwarding.
- `server.ts` & `api/upload.ts`: In-memory multipart upload handling, magic number validation, and Tesseract OCR engine.
- `src/services/attachmentStorageService.js`: Browser IndexedDB binary blob caching (`orvix_attachments_db`).

---

## Environment Variables & Configuration

### Configuration Reference Table

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Optional | `3000` | Port for Express server |
| `GEMINI_API_KEY` | Optional | None | Google Gemini API key |
| `GROQ_API_KEY` | Optional | None | Groq Cloud API key |
| `OPENROUTER_API_KEY` | Optional | None | OpenRouter API key |
| `CLOUDFLARE_ACCOUNT_ID` | Optional | None | Cloudflare account ID for Workers AI |
| `CLOUDFLARE_API_TOKEN` | Optional | None | Cloudflare API token for Workers AI |
| `VITE_FIREBASE_API_KEY` | Optional | None | Firebase client API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Optional | None | Firebase authentication domain |
| `VITE_FIREBASE_PROJECT_ID` | Optional | None | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET`| Optional | None | Firebase storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Optional | None | Firebase messaging sender ID |
| `VITE_FIREBASE_APP_ID` | Optional | None | Firebase application ID |

### Configuration Template (`.env.example`)

```bash
# Server Configuration
PORT=3000

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

## Prerequisites & Setup Instructions

### Prerequisites
- **Node.js**: Version 18.0.0 or higher (Node.js 22 LTS recommended).
- **npm**: Version 9.0.0 or higher.

### Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/Hannankhan203/Orvix.git
cd Orvix
npm install
```

### Running in Development
Start the unified full-stack development server on port 3000:
```bash
npm run dev
```
Open your browser and navigate to `http://localhost:3000`.

### Building for Production
Compile the client assets with Vite:
```bash
npm run build
```

### Running the Production Server
Start the production Express server:
```bash
npm start
```

### Type Checking & Linting
Run the TypeScript compiler to verify all types and imports:
```bash
npm run lint
```

---

## Deployment Instructions

### Full-Stack Node.js Deployment (Cloud Run, Render, Railway, VPS)
1. Set the required environment variables in your deployment dashboard (`GEMINI_API_KEY`, etc.).
2. Build the application:
   ```bash
   npm run build
   ```
3. Start the server using the configured start script:
   ```bash
   npm start
   ```
   The Express server listens on `0.0.0.0:3000` (or `process.env.PORT`) and serves static files from `dist/` with full API proxy support.

### Serverless Vercel Deployment
Orvix includes `vercel.json` and dedicated entry points under `api/`:
- `api/chat.ts`: Serverless proxy for multi-provider streaming.
- `api/upload.ts`: Serverless in-memory upload and OCR handler.
- Static assets are automatically generated via `npm run build` and served at root.

---

## Firebase Setup & Security Rules

To enable cloud authentication and multi-device history sync, configure Firebase:
1. Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** with Google and Email/Password providers.
3. Enable **Cloud Firestore** and deploy the following security rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /chats/{chatId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;

        match /messages/{messageId} {
          allow read, write: if request.auth != null && request.auth.uid == userId;
        }
      }
    }
  }
}
```

---

## Security Architecture

1. **Zero Credential Exposure**: API keys for Gemini, Groq, OpenRouter, and Cloudflare are never sent to the browser. All AI calls and file uploads route through protected Express endpoints (`/api/chat`, `/api/upload`).
2. **Binary Header & Magic Number Validation**: Uploaded files are inspected for authentic binary signatures, rejecting disguised executable payloads.
3. **Controlled Sanitization**: OCR and document text are stripped of control characters before embedding into AI prompts.
4. **Client-Side Blob Revocation**: Object URLs generated for previews are explicitly revoked upon removal or component unmount to prevent browser memory leaks.

---

## Known Limitations

1. **OCR vs Visual Reasoning**: Orvix extracts readable printed text from images using OCR. It does not perform spatial visual reasoning or object detection beyond its extracted text.
2. **Binary Storage Longevity**:
   - Message metadata and extracted text are permanently saved (in Firestore or `localStorage`).
   - Original binary files are stored in browser **IndexedDB** (`orvix_attachments_db`). On the server, temporary files have a 2-hour retention TTL (`TEMP_FILE_TTL_MS`), while serverless invocations rely on in-memory buffers and client IndexedDB.
   - Opening a conversation on a different device after the temporary server TTL has expired preserves message text and OCR extraction, but the original raw binary file cannot be redownloaded.
3. **HEIC Browser Native Rendering**: Standard web browsers cannot decode HEIC/HEIF images natively in `<img>` tags without client-side wasm transcoders; the UI displays a clean fallback card with direct download and modal inspection.
4. **Scanned PDFs Without Embedded Text**: PDFs containing exclusively rasterized scans without an embedded text layer require image extraction.
5. **Legacy PowerPoint Binary Format (`.ppt`)**: Direct binary text extraction is supported for modern OpenXML `.pptx` presentations; legacy `.ppt` files trigger a conversion recommendation.

---

## Version History & Changelog

### v0.7.0 — Live Response-Time Measurement & Left-Edge Swipe Gesture *(Current Release)*
- **Live Response-Time Measurement**:
  - Implemented high-resolution live elapsed duration timer (`LiveResponseTimer` in `src/components/chat/ChatMessage.jsx`) that updates every 100ms during active AI generation (`Thinking... X.Xs`).
  - Added final response duration badge (`Response time: X.Xs`) displaying the total generation time once streaming finishes or is stopped.
  - Implemented `src/utils/formatResponseTime.js` providing clear formatting across seconds (`2.4s`), minutes/seconds (`1m 08s`), and hours.
  - Added response time persistence to Cloud Firestore and local guest storage (`responseTimeMs`).
  - Integrated response duration badges into Markdown and Plain Text export outputs (`src/utils/exportConversation.js`).
- **Left-Edge Swipe Gesture for Chat History**:
  - Implemented conflict-free left-edge swipe-right gesture in `src/components/layout/Layout.jsx` allowing users to slide open the chat history sidebar on mobile and tablet viewports (`window.innerWidth <= 1024`).
  - Calibrated activation zone within 0–40px from the left screen edge (`EDGE_ZONE_PX = 40`) and a 40px movement threshold (`MIN_SWIPE_PX = 40`) with flick velocity detection.
  - Added intent resolution (`INTENT_THRESHOLD_PX = 8`) to distinguish horizontal swipes from vertical scrolling, ensuring native chat scrolling remains completely smooth and unhindered.
  - Separated Touch and Pointer event pipelines to prevent browser `pointercancel` events from prematurely aborting active touch swipes.
  - Ensured interactive elements (inputs, textareas, buttons, modal dialogs) are bypassed and preserved full compatibility with the existing hamburger button.

### v0.6.0 — Controlled Large-Response Continuation & Multimodal Attachment Inputs
- **Controlled Large-Response Continuation**:
  - Implemented `src/services/multiPartResponseService.js` to detect queries exceeding safe token/character budgets (`detectLargeResponseIntent`).
  - Added continuation notices informing users that additional content remains (Part 1 and subsequent parts).
  - Added flexible continuation intent recognition (`isContinuationRequest`) supporting phrases such as `"Continue"`, `"Send the rest"`, `"Next"`, `"Part 2"`, and `"Proceed"`.
  - Added interactive composer continuation chip (`[ → Continue response ]`) floating above the composer when an incomplete response is detected.
  - Implemented `resolveMultiPartContext()` to carry forward the original prompt, attached documents, and covered sections without restarting the answer.
  - Added full multi-turn persistence for all response parts in both Cloud Firestore and Guest Mode.
- **Three Multimodal Attachment Methods**:
  - **Upload Button**: Paperclip button opening the native OS file picker with supported MIME type filters.
  - **Clipboard Paste (`Ctrl + V`)**: Direct clipboard paste handling (`handlePaste`) for copied images and files with MIME-based filename resolution (`pasted-image.png`). Normal text, URLs, and code snippets pass through unhindered.
  - **Drag-and-Drop Interaction**: Drag-and-drop file attachment from desktop file managers onto the chat area with an Obsidian-accented dashed border (`.is-drag-over`) and a `"Drop file to attach"` visual indicator banner.
  - **Strict One-Attachment Limit**: Enforced across all three attachment methods with explicit, user-friendly rejection notices.
  - **Unified Attachment Pipeline**: Consolidated upload button, paste, and drag-and-drop through `processAttachment()` with 25MB file size validation and instant thumbnail preview generation.

### v0.5.0 — Production Vercel Serverless Upload Architecture & Attachment Resilience
- **Serverless Production Upload Architecture**:
  - Migrated upload buffering to `multer.memoryStorage()`, resolving `EROFS: read-only file system` errors on `/var/task/uploads/temp/` in Vercel serverless environments.
  - Implemented dual-mode serving: files are served directly from in-memory buffers (`record.buffer`) with asynchronous local disk persistence when running locally.
  - Fixed 404 attachment errors on Vercel by adding dynamic subpath rewrite rules in `vercel.json` (`/api/upload/:subpath*` -> `/api/upload?__subpath=:subpath*`) and request URL reconstruction in `api/upload.ts`.
- **Client Upload & Abort Resilience**:
  - Replaced abrupt client cancellations with a robust `AbortController` supporting an extended 90-second upload window for large files and OCR processing.
  - Resolved `Failed to upload attachments: signal is aborted without reason` errors with descriptive user-facing network error reporting.
  - Ensured every upload and chat failure terminates cleanly, preventing the UI from getting permanently stuck on "Thinking...".
- **Enhanced Image OCR & Document Stability**:
  - Validated full JPG, JPEG, and PNG extraction workflows on both local and serverless deployments.
  - Ensured zero-text images consistently report `"No readable text detected in this image."` across all four AI providers without hallucinations.
  - Maintained complete backward compatibility with existing PDF, DOCX, PPTX, and TXT extraction.

### v0.4.0 — Image Attachment & Optical Character Recognition (OCR) Integration
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
