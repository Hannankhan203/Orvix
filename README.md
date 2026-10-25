# Orvix

![Version](https://img.shields.io/badge/version-0.2.1-2563eb)
![React](https://img.shields.io/badge/React-19.0-61dafb)
![Vite](https://img.shields.io/badge/Vite-8.3-646cff)
![TypeScript](https://img.shields.io/badge/Server-Express%20%2B%20TS-3178c6)

**Current Version: v0.2.1**

**Orvix** is a full-stack, multi-model AI conversational workspace built with React 19, Vite, Tailwind CSS v4, and an Express + TypeScript backend proxy. It supports cloud AI streaming (Google Gemini, Groq, OpenRouter, Cloudflare Workers AI), local server inference (Ollama), and **on-device WebGPU inference (Browser AI via WebLLM)** with Progressive Web App (PWA) offline app-shell caching, client- and server-side document extraction, dual-format clipboard copying, voice dictation, and four specialized chat modes.

---

## Table of Contents

1. [Key Features](#1-key-features)
2. [Release History & What's New](#2-release-history--whats-new)
   - [v0.2.1 (Empty New Chat UI Refinement)](#v021-october-25-2026--empty-new-chat-ui-refinement-release)
   - [v0.2.0 (Mobile UI/UX Refinement)](#v020-october-25-2026--mobile-uiux-refinement-release)
   - [v0.1.0 (Desktop UI/UX & Performance)](#v010--desktop-uiux-accessibility-and-performance-release)
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
- **Four Specialized Chat Modes**: Dedicated **General Assistant**, **Coding**, **Writing**, and **Learning** modes selected from the persistent header dropdown, featuring tailored system instructions, educational callout detection, editorial prose layouts, and VS Code-style code blocks with locked line numbering.
- **Dual-Format Clipboard Copying**: Copies assistant responses simultaneously as styled `text/html` (for Google Docs, Word, Slack, and email) and structured `text/plain` record layouts (`• Header: Value`) so Markdown tables remain readable in plain-text messaging apps such as WhatsApp and Telegram.
- **Multimodal Attachments & Server OCR**: Attach one file per message (up to 25 MB) via file picker, clipboard paste (`Ctrl+V` / `Cmd+V`), or drag-and-drop. Supports PDFs, Word (`.docx`), PowerPoint (`.pptx` with speaker notes), CSV/TSV, JSON, XML, TXT/Markdown, and images (with server-side `tesseract.js` OCR and binary header verification).
- **Cross-Platform Voice Dictation & Read-Aloud**: Combines live browser speech recognition (interim snapshot replacement without word duplication) with optional server-side Whisper Large v3 Turbo refinement, 9 language locales, and Web Speech API text-to-speech playback (`Play`, `Pause`, `Resume`, `Stop`).
- **Flexible Persistence & Zero-Key Simulation Mode**: Supports Firebase Authentication + Cloud Firestore sync for signed-in users, `localStorage` + `IndexedDB` persistence for Guest Mode, and an automatic Simulated Mode when cloud API keys are not configured.

---

## 2. Release History & What's New

### v0.2.1 (October 25, 2026) — Empty New Chat UI Refinement Release

Version **0.2.1** delivers a focused UI/UX refinement to the **empty new-chat state**, removing redundant inline controls and elevating the Orvix logo and personalized greeting into an intentional, visually balanced hero centerpiece across all screen sizes (small mobile up to large desktop displays and PWA):

#### Complete Removal of Redundant Empty-State Controls
- **Full Removal of Mode Selection Statement & Buttons**: Completely removed the redundant "Select Chat Mode" statement and the four inline mode buttons that previously rendered in the empty chat response panel across all devices and breakpoints.
- **Removal of Starter Prompts**: Eliminated all empty-state starter/example prompts across all four chat modes, creating a clean, distraction-free canvas upon opening a new chat.
- **Real Code & Style Clean-Up**: Removed obsolete rendering markup, dead state, unused handlers, and obsolete CSS grid styles (`.welcome-modes-statement`, `.welcome-modes-grid`, `.welcome-mode-btn`, `.welcome-prompts-grid`, `.welcome-prompt-card`) rather than hiding them via CSS (`display: none`, media queries, or hidden classes).
- **Header Selection Preserved**: Preserved the authoritative **Chat Mode dropdown** (`ModeSelector.jsx`) and **AI Model dropdown** (`ModelSelector.jsx`) in the header navigation bar as the unified controls for mode and model selection, eliminating control duplication while keeping all underlying mode functionality fully intact.

#### Responsive Empty-State Hero Centerpiece
- **Preserved Core Identity & Personalization**: Kept the authentic Orvix logo asset and dynamic personalized greeting ("*What can I help you with, [username]?*"), gracefully falling back to "friend" when unauthenticated or unnamed.
- **7-Tier Fluid Responsive Scaling**: Engineered progressive sizing for the logo mark, radial aura, and greeting typography across seven viewport tiers using CSS `clamp()`:
  - **Small Mobile (`320px`–`359px`)**: 40px–44px logo, `1.25rem` heading font, compact 10px element gap.
  - **Standard Mobile (`360px`–`430px`)**: 46px–50px logo, `1.4rem`–`1.5rem` heading font.
  - **Large Mobile & Small Tablet (`431px`–`767px`)**: 54px–58px logo, `1.6rem`–`1.8rem` heading font.
  - **Tablet (`768px`–`1023px`)**: 62px–68px logo, `1.9rem`–`2.1rem` heading font.
  - **Laptop (`1024px`–`1439px`)**: 74px–80px logo, `2.3rem`–`2.6rem` heading font.
  - **Desktop (`1440px`–`1919px`)**: 84px–90px logo, `2.75rem`–`3.1rem` heading font.
  - **Large Desktop (`1920px+`)**: 96px–100px logo, `3.2rem`–`3.4rem` heading font.
- **Subtle Ambient Radial Glow**: Added a soft, non-intrusive ambient radial aura behind the logo mark (`.welcome-hero-glow`, scaling smoothly from `280px` to `520px` diameter) providing visual depth and focal anchorage without interfering with contrast or readability.
- **Optical Vertical Centering & Composer Balance**: Adjusted the hero layout with responsive optical negative margins (`-1.5rem` on tablet/laptop, `-2.5rem` on desktop) ensuring the hero group floats naturally at the true optical center of the chat viewport above the composer dock, without crowding or clipping when the sidebar toggles open or closed.
- **Strict Verification & Quality Assurance**: 0 TypeScript compilation errors (`tsc --noEmit`), pristine production build output (`vite build`), and 100% offline reliability test suite pass (`10/10` tests passing).

---

### v0.2.0 (October 25, 2026) — Mobile UI/UX Refinement Release

Version **0.2.0** delivers a comprehensive **Mobile UI/UX Refinement** across smartphone, tablet, and touch-screen environments, improving viewport responsiveness, touch interaction ergonomics, navigation ergonomics, input handling, and conversation readability while preserving full desktop functionality:

#### Responsive Viewports & Virtual Keyboard Adaptation
- **Dynamic Viewport Height Management**: Bound the CSS custom property `--app-viewport-height` to `window.visualViewport` via an optimized `requestAnimationFrame` listener in `Layout.jsx`, dynamically adapting to virtual keyboard appearance, browser address bar collapsing, and orientation changes without container overflow or double-scrollbars.
- **Virtual Keyboard Detection (`is-keyboard-open`)**: When mobile software keyboards open (detected via focus on editable inputs and height deltas >68px/115px), `<html>` receives the `.is-keyboard-open` class, reducing composer dock padding to 6px and hiding the non-essential disclaimer footnote to maximize visible conversation space.
- **Granular Responsive Breakpoints**:
  - **Tablet (`768px`–`1023px`)**: Scales sidebar width to 248px, tightens header margins (padding `0 12px`, gaps `6px`–`8px`), and hides non-essential labels when the sidebar is open to prevent element clipping.
  - **Mobile (`< 768px`)**: Seamlessly converts desktop single-row header into a purpose-built 2-tier mobile navigation bar, transforms sidebar into an off-canvas drawer with backdrop blur, and optimizes touch targets.
  - **Compact Phones (`<= 480px`)**: Dedicates Tier 2 of the mobile header exclusively to the AI model and mode selectors, hiding ancillary elements to prevent overlapping controls.
  - **Small Mobile Screens (`320px`–`374px`)**: Scales welcome headings (`1.3rem`), subheadings (`0.825rem`), prompt cards, and composer padding (`8px`) so UI controls fit gracefully without horizontal overflow.
  - **Mobile Landscape Orientation (`max-height: 500px` and `max-width: 900px`)**: Compacts header bars (42px top / 34px sub) and reduces vertical composer dock padding for short viewports.
- **Safe Area Insets**: Integrated `env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`, and `env(safe-area-inset-left)` into the mobile header, composer dock, and navigation drawer for native notch and home-indicator alignment on modern iOS and Android devices.

#### Mobile Navigation, Drawers & Touch Gestures
- **Purpose-Built 2-Tier Mobile Header**:
  - **Tier 1 (Main Action Bar)**: Accessible hamburger drawer toggle (`20px`), Orvix brand mark with active conversation subtitle, compact export conversation menu, compact "+ New" chat button, and user profile avatar trigger.
  - **Tier 2 (Context Bar)**: AI model/provider selector and chat mode popover positioned directly above the message stream for fast, one-handed switching.
- **Touch & Swipe Drawer Gestures**:
  - Swipe right from anywhere within the main chat area to open the sidebar navigation drawer.
  - Swipe left on the open sidebar or backdrop to dismiss the drawer.
  - **Intelligent Target Exclusion (`isExcludedSwipeTarget`)**: Rejects swipes initiated in the extreme left edge (<16px) to avoid interfering with native iOS system back gestures, and suppresses gestures initiated inside headers, composer dock, form inputs, buttons, dialogs, code blocks, and scrollable tables.
- **Drawer Backdrop & Scroll Locking**: Dimmed, blurred backdrop (`rgba(0, 0, 0, 0.68)`, `backdrop-filter: blur(4px)`) locks background body scrolling (`overflow: hidden`) when the mobile drawer is open, preventing disorienting background scroll jumps while browsing chat history.
- **Touch-Friendly Hit Targets & Actions**: Sidebar conversation actions (`Pin`, `Rename`, `Delete`) and confirmation bars (`Delete?` → `Delete` / `Cancel`) are permanently visible inline without requiring mouse hover, with touch targets sized at 32px–38px and `touch-action: manipulation` for instant touch response.

#### Chat Interface & Message Layout Refinements
- **Asymmetric Message Layout**:
  - **Assistant Messages**: Styled as a clean, full-width reading column (`width: 100%`) with a compact 22x22px avatar pinned at top-left, 30px indented sender label/badge row, and 1.65 line-height for comfortable reading on narrow mobile displays.
  - **User Messages**: Formatted as right-aligned bubbles (`max-width: 90%` on mobile, `94%` on small phones) with the redundant desktop avatar gutter removed to maximize usable message width.
- **Touch-Persistent Action Bars**: Message action buttons (`Copy`, `Read Aloud`, `Alternative Provider`, `Regenerate`, `Edit`) remain permanently visible (`opacity: 1`) on mobile and touch devices rather than depending on hover states, with touch targets >=34px.
- **Safe Overflow & Word-Break Handling**: Applied `word-break: break-word`, `overflow-wrap: anywhere`, and `-webkit-line-clamp` on active conversation titles, attachment chips, and model badges to prevent horizontal blowout or clipped text.
- **Responsive Markdown Elements**: Bulleted and numbered lists feature proportional left indentation (`1.35rem` / `1.5rem`), blockquotes use compact padding (`0.65rem 0.95rem`), and tables render in an isolated horizontal scroll wrapper (`.table-responsive-wrapper`) with sticky first columns and min-width boundaries (`88px`–`240px`).

#### Composer, Input Area & Attachment Handling
- **Dock Padding & Keyboard-Aware Sizing**: Fixed bottom composer dock with responsive padding (`padding: 0 10px max(8px, env(safe-area-inset-bottom)) 10px`), collapsing to 6px when the virtual keyboard is active.
- **Multiline Auto-Resize & Layout Expansion (`.composer-form.is-expanded`)**: Textarea smoothly auto-expands from 38px up to 144px (120px when keyboard is active). When entering multiline text, the textarea expands to 100% full width above the actions (`order: -1`), wrapping action buttons (Attach, Mode, Dictate, Send) neatly on a dedicated bottom control row.
- **iOS Safari Auto-Zoom Prevention**: Enforces `font-size: 16px !important` across `.composer-textarea`, `.user-edit-textarea`, `.form-input`, `.sidebar-search-input`, and `.chat-rename-input`, preventing iOS Safari from forcing an unwanted viewport zoom on input focus.
- **Mobile Attachment Staging**: Single-attachment staging chips display formatted sizes, truncated break-word filenames, and touch-friendly 32px removal/preview buttons.
- **Clipboard & Drag Attachment**: Supports direct clipboard paste (`Ctrl+V` / `Cmd+V`) and touch/drag attachment handling on mobile.

#### Voice Dictation & Recording Interface Refinements
- **Dedicated Mobile Dictation Strip (`.composer-listening-bar`)**:
  - Live audio waveform and recording status indicator with clear transcript preview.
  - Language selector dropdown sized for mobile screens (`width: min(228px, calc(100vw - 24px))`, touch items 38px).
- **Correctly Sized Action Controls**: Sized to touch-friendly 36px heights (`32px` on <=360px phones) with permanent visible text labels (`display: inline !important; white-space: nowrap;`), active tap feedback (`transform: scale(0.96)`), and accessible colors:
  - **Pause**: Amber subtle pill with `<Pause size={12} />` and labeled "Pause" text.
  - **Resume**: Blue subtle pill with `<Play size={12} />` and labeled "Resume" text.
  - **Done**: Primary blue button with `<Check size={13} strokeWidth={2.5} />` and labeled "Done" text.
  - **Cancel**: Neutral button with labeled "Cancel" text for discarding recording sessions.
- **Duplicate Control Suppression**: When voice dictation is active on mobile, the composer's duplicate microphone button is hidden (`.chat-composer-dock.is-recording-active .composer-mic-btn { display: none !important; }`), ensuring zero redundant or competing buttons.

#### Modals, Dialogs & Dropdowns
- **DocumentPreviewModal Mobile Layout**: Full-screen adaptation with max-height 94dvh, 8px viewport margins, single-line truncated title with 38x38px close button, and a dedicated mobile secondary toolbar housing Image / Extracted OCR text tabs, Copy, and Download actions.
- **ModeSelector Dropdown**: Mobile-optimized dropdown popover with arrow-key and touch-friendly item targets (`min-height: 40px`).
- **ExportChatMenu**: Compact trigger button (`compact` prop) displaying icon-only on mobile headers to prevent crowding, opening an accessible dropdown for Markdown and Plain Text downloads.
- **Personalization Settings & Auth Screen**: AuthCard adjusted with responsive padding (`24px 18px` on mobile, `20px 14px` on <=374px phones), accessible touch tabs, and form input font-size normalization.

---

### v0.1.0 — Desktop UI/UX, Accessibility, and Performance Release

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
├── package.json                  # Project metadata (v0.2.1), scripts & dependencies
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
