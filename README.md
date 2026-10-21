# Orvix

**Version: v0.3**

<p align="center">
  <strong>An Intelligent, Multi-Model AI Conversation Companion & Full-Stack Chat Application</strong>
</p>

---

## Table of Contents

- [1. Overview & Purpose](#1-overview--purpose)
- [2. Current Project Status](#2-current-project-status)
- [3. Current Implemented Features](#3-current-implemented-features)
- [4. AI Providers & Selectable Models](#4-ai-providers--selectable-models)
- [5. Frontend Architecture & Technologies](#5-frontend-architecture--technologies)
- [6. Backend Architecture & Technologies](#6-backend-architecture--technologies)
- [7. AI Provider Routing, Streaming & Fallback Behavior](#7-ai-provider-routing-streaming--fallback-behavior)
- [8. Firebase Integration & Authentication](#8-firebase-integration--authentication)
- [9. Chat Functionality & Conversation History](#9-chat-functionality--conversation-history)
- [10. Project Structure & Important Files](#10-project-structure--important-files)
- [11. Prerequisites & Installation Instructions](#11-prerequisites--installation-instructions)
- [12. Environment Variables & Configuration](#12-environment-variables--configuration)
- [13. Development & Build Commands](#13-development--build-commands)
- [14. Deployment Instructions](#14-deployment-instructions)
- [15. Current Limitations](#15-current-limitations)
- [16. Planned & Future Features](#16-planned--future-features)
- [17. Version History & Changelog](#17-version-history--changelog)
- [18. License](#18-license)

---

## 1. Overview & Purpose

**Orvix v0.3** is a production-grade, full-stack AI chatbot web application featuring an Obsidian Dark and Crisp Light design system, built on React 19, Tailwind CSS v4, and a secure Express backend proxy.

### Primary Purpose
Orvix provides a unified interface across leading artificial intelligence models. Rather than locking users into a single model or provider, Orvix allows users to switch between providers mid-conversation while preserving full dialogue history, enabling direct comparison of reasoning, coding, writing, and analytical capabilities.

### Core Principles
1. **Multi-Model Sovereignty**: Users select from five top-tier AI providers without losing conversation context or thread continuity.
2. **Server-Side Security**: All model API credentials (Gemini, Groq, OpenRouter, Hugging Face, Cloudflare) remain exclusively on the server, shielded from client bundles and browser network inspectors.
3. **Zero-Setup Accessibility**: An instant Guest Exploration mode provides immediate offline local persistence and mode-aware simulated responses if API keys are not supplied.
4. **Structured Persistence**: Cloud Firestore subcollections guarantee strict user isolation, atomic message deletions, and granular security rules.
5. **Universal Accessibility**: Native Web Speech voice dictation, text-to-speech audio synthesis, responsive mobile layouts, and complete PWA installability.

---

## 2. Current Project Status

- **Current Version**: `v0.3`
- **Application State**: Fully operational full-stack application with five integrated AI providers, Server-Sent Events (SSE) streaming, Cloud Firestore persistence, multi-mode reasoning, and guest exploration.
- **Runtime Environment**: Node.js 22 LTS, Vite 8, React 19, Express 4.
- **Build Status**: Verified and compiling cleanly (`npm run build`, `npm run lint`).

---

## 3. Current Implemented Features

### Conversational Experience
- **Five-Provider Model Selector**: Switch seamlessly between Google Gemini, Groq, OpenRouter, Hugging Face, and Cloudflare Workers AI at any time.
- **Server-Sent Events (SSE) Streaming**: Token-by-token progressive rendering with an animated typing indicator, dynamic word chunking, and instant **Stop Generating** control.
- **Context-Aware Multi-Turn History**: Automatically formats and passes the last 12 messages to the selected provider for coherent conversations.
- **Simulated Response Fallback**: When API keys are not provided in the environment, the backend automatically generates rich, mode-specific simulated responses for offline testing and demo sessions.
- **Smart Conversation Titles**: Automatically derives concise 36-character titles from the user's opening prompt.
- **Message Action Bar**:
  - One-click copy for complete responses or individual syntax-highlighted code blocks.
  - **Edit & Resend**: In-place editing of previous user prompts with automatic thread regeneration.
  - **Regenerate Response**: Request an alternative response from the assistant.
  - **Inline Error Recovery**: Error banners with one-click **Retry** and one-click provider fallback buttons.

### Chat Modes
- **General Assistant**: Balanced, versatile companion for everyday queries, planning, and brainstorming.
- **Coding Mode**: Software architecture, debugging, clean code blocks with syntax highlighting, and edge-case callouts.
- **Writing Mode**: Drafting, editing, tone adjustment, and prose enhancement.
- **Learning Mode**: Step-by-step conceptual breakdowns, analogies, and comprehension checks.

### Speech & Accessibility
- **Voice Dictation (Speech-to-Text)**: Microphone input powered by the Web Speech API with interim transcript preview, recording timer, pause/resume, and punctuation sanitation.
- **Text-to-Speech (Read Aloud)**: In-browser speech synthesis for assistant responses with adjustable playback speed (0.75x to 2.0x), system voice selection, and pause/resume controls.

### Conversation Management
- **Conversation Pinning (5-Chat Limit)**: Pin up to 5 priority conversations to a dedicated top section in the sidebar with gold badge indicators and limit enforcement.
- **Inline Renaming**: Double-click or click the edit icon to rename threads inline (Enter to save, Esc to cancel).
- **Atomic Deletion**: Purges conversation message subcollections in atomic batches (up to 400 messages per chunk) before removing the parent chat record.
- **Multi-Format Export**: Export any active conversation to **Markdown (`.md`)**, **JSON (`.json`)**, or **Plain Text (`.txt`)**.

### User Personalization & Settings
- **Theme Support**: Obsidian Dark (default), Crisp Light, or System match with zero-flash reload script.
- **Response Length Preference**: Choose between *Concise*, *Balanced*, or *Detailed* outputs injected into model system instructions.
- **Beginner-Friendly Mode**: Injects guidance asking models to use accessible analogies and avoid unexplained jargon.
- **PWA Installation**: Installable Progressive Web App with Web App Manifest, maskable app icons, and in-app install prompt.

---

## 4. AI Providers & Selectable Models

Orvix features five fully implemented AI inference providers selectable via the navigation header dropdown:

| Provider | Display Label | Model ID / Identifier | Protocol | Default Scope |
|---|---|---|---|---|
| **Google Gemini** | `Gemini (Gemini 3.1 Flash Lite)` | `gemini-3.8-flash` (primary)<br>`gemini-3.1-flash-lite` (fallback) | `@google/genai` TypeScript SDK (v2.4.0) | Server-side (`GEMINI_API_KEY`) |
| **Groq** | `Groq (Llama 3.3 70B)` | `openai/gpt-oss-120b` | OpenAI-compatible SSE REST API | Server-side (`GROQ_API_KEY`) |
| **OpenRouter** | `OpenRouter (Llama 3.3 70B (Free))` | `openrouter/free` | OpenAI-compatible SSE REST API | Server-side (`OPENROUTER_API_KEY`) |
| **Hugging Face** | `Hugging Face — Llama 3.3 70B Instruct` | `meta-llama/Llama-3.3-70B-Instruct` | Hugging Face Router REST API | Server-side (`HUGGINGFACE_API_KEY`) |
| **Cloudflare Workers AI** | `Cloudflare Workers AI — Llama 3.1 8B` | `@cf/meta/llama-3.1-8b-instruct` | Cloudflare Workers AI REST API | Server-side (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) |

### Provider Details & Implementations

1. **Google Gemini**:
   - Integrates with Google's modern `@google/genai` TypeScript SDK.
   - Executes multi-tier retries with exponential backoff and jitter. Attempts primary generation on `gemini-3.8-flash` before gracefully falling back to `gemini-3.1-flash-lite`.
   - Delayed SSE header initiation guarantees HTTP 503 high-demand errors are caught before sending 200 stream headers.

2. **Groq**:
   - Communicates with Groq's high-speed inference endpoint (`https://api.groq.com/openai/v1/chat/completions`).
   - Supports genuine Server-Sent Events token streaming and multi-turn message formatting.

3. **OpenRouter**:
   - Interacts with OpenRouter's multi-model gateway (`https://openrouter.ai/api/v1/chat/completions`).
   - Dynamically accesses community-available open-weights models under `openrouter/free`.

4. **Hugging Face Inference Providers**:
   - Routes through Hugging Face's OpenAI-compatible router endpoint (`https://router.huggingface.co/v1/chat/completions`).
   - Uses `meta-llama/Llama-3.3-70B-Instruct` for deep reasoning, writing, and coding tasks.

5. **Cloudflare Workers AI**:
   - Calls Cloudflare's official REST API endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`.
   - Handles Cloudflare's native Server-Sent Events stream format (`data: {"response":"..."}` and `data: [DONE]`).
   - Implements server-side adaptation: if a non-streaming response is received, it is seamlessly transformed into standard Orvix SSE events without client interruption.
   - Error classification specifically distinguishes Cloudflare 401/403 authorization failures, 404 account/model errors, 429 rate limits, and 5xx server issues.

---

## 5. Frontend Architecture & Technologies

The frontend is constructed as a React 19 Single Page Application (SPA) bundled with Vite 8.

```text
src/
├── App.jsx                     # Root application component & auth router
├── main.jsx                    # React 19 DOM bootstrap
├── index.css                   # Global Tailwind CSS v4 & custom variables
├── components/
│   ├── auth/AuthScreen.jsx     # Firebase auth & guest mode login screen
│   ├── chat/                   # Conversational workspace components
│   │   ├── ChatArea.jsx        # Main chat scroll container & composer dock
│   │   ├── ChatMessage.jsx     # Markdown renderer, code blocks, retry actions
│   │   ├── CodeBlock.jsx       # Syntax highlighter with copy action
│   │   ├── ExportChatMenu.jsx  # Markdown, JSON, Text download dropdown
│   │   ├── MessageList.jsx     # Rendered list with scroll anchoring
│   │   ├── ModeSelector.jsx    # General / Coding / Writing / Learning switcher
│   │   ├── ModelSelector.jsx   # AI provider selector (5 providers)
│   │   ├── PromptSuggestions.jsx # Context-sensitive starter prompts
│   │   ├── TypingIndicator.jsx # Animated thinking pill
│   │   └── WelcomeScreen.jsx   # Empty-state hero and mode selection
│   ├── layout/                 # App frame and responsive navigation
│   │   ├── Header.jsx          # Top navigation bar, mode/model selectors, user menu
│   │   ├── Layout.jsx          # Responsive shell managing sidebar collapse
│   │   ├── Sidebar.jsx         # Pinned/recent chats list and user footer
│   │   └── SidebarChatItem.jsx # Individual thread item with rename/delete
│   ├── settings/SettingsModal.jsx # Personalization & preference dialog
│   └── ui/                     # Primitives (Button, OrvixLogo)
├── context/
│   ├── AuthContext.jsx         # Firebase Auth & guest identity state
│   ├── SettingsContext.jsx     # Theme, response length, voice preferences
│   └── SpeechContext.jsx       # Web Speech TTS synthesis engine
├── hooks/
│   ├── usePWAInstall.js        # PWA beforeinstallprompt handler
│   └── useVoiceDictation.js    # Web Speech STT dictation hook
├── services/                   # Client-side API dispatchers
│   ├── aiRouter.js             # Central multi-provider client dispatcher
│   ├── cloudflareService.js    # Cloudflare Workers AI client helper
│   ├── geminiService.js        # Gemini client helper
│   ├── groqService.js          # Groq client helper
│   ├── huggingfaceService.js   # Hugging Face client helper
│   └── openrouterService.js    # OpenRouter client helper
└── utils/                      # Text cleaners, syntax highlighters, exporters
```

### Key Frontend Technologies
- **React 19**: Component lifecycle, concurrent rendering, and hooks (`useRef`, `useState`, `useEffect`, `useCallback`, `useMemo`).
- **Tailwind CSS v4 (`@tailwindcss/vite`)**: Next-generation utility-first styling with `@import "tailwindcss";` and CSS variable theming.
- **Lucide React**: Clean vector icon suite for all navigation, message actions, and controls.
- **React Markdown & Remark GFM**: Safe markdown rendering supporting tables, fenced code blocks, and formatted lists.
- **Web Speech API**: In-browser speech recognition (`webkitSpeechRecognition`) and speech synthesis (`speechSynthesis`).

---

## 6. Backend Architecture & Technologies

The backend is built with Node.js and Express in `server.ts`, functioning both as an API server and as Vite's development middleware host.

```text
server.ts
├── Express HTTP Server (Port 3000, 0.0.0.0)
│   ├── CORS & JSON Body Parser (10MB limit)
│   ├── Route: GET  /api/health   → Uptime, status check
│   ├── Route: GET  /api/config   → Safe provider availability check (no keys leaked)
│   └── Route: POST /api/chat     → Central multi-provider dispatch with SSE
│         ├── Provider 1: Google Gemini (@google/genai SDK v2.4.0)
│         ├── Provider 2: Groq (OpenAI-compatible fetch)
│         ├── Provider 3: OpenRouter (OpenAI-compatible fetch)
│         ├── Provider 4: Hugging Face (Router fetch)
│         ├── Provider 5: Cloudflare Workers AI (Cloudflare REST API fetch)
│         └── Fallback:   Mode-aware demo simulated response
└── Environment Modes
    ├── Development: Express mounts Vite middlewares (appType: 'spa')
    └── Production:  Express serves static dist/ with index.html fallback
```

### Backend Responsibilities
- **Credential Protection**: All API keys and tokens (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) remain exclusively on the server.
- **Client Disconnection Management**: Tracks client disconnections (`res.on('close')`) to cancel upstream fetch readers and backoff timers immediately.
- **Error Sanitization**: `sanitizeErrorLog` redacts API keys, bearer tokens, and credentials from all server logs and client-facing error payloads.
- **Diagnostic Logging**: `logAIDiagnostic` records provider, model, attempt number, phase (pre-stream, mid-stream, non-streaming), and sanitized upstream errors.

---

## 7. AI Provider Routing, Streaming & Fallback Behavior

### Client-to-Server Flow
1. User enters a prompt in `ChatArea.jsx`.
2. `ChatPage.jsx` creates message records and invokes `streamAIMessage` from `src/services/aiRouter.js`.
3. `aiRouter.js` initiates an HTTP POST to `/api/chat` with `{ provider, mode, prompt, history, username, preferences, stream: true }`.
4. `server.ts` validates the request, normalizes history turns, injects mode and user preferences into system instructions, and connects to the target provider.
5. Upstream stream chunks are parsed into unified Server-Sent Events (`data: {"type":"chunk","text":"..."}`).
6. The client reader renders tokens smoothly, gradually revealing text to match natural reading speed.

### Fallback & Recovery Architecture
- **Missing API Keys**: Automatically returns mode-aware simulated responses so the application functions in demo environments without manual setup.
- **Pre-Stream Failure**: If an upstream connection fails before stream initialization (e.g. 503 High Demand or 429 Quota Exceeded), the server returns a clean JSON error with a suggested provider list.
- **Inline Switching**: Message error banners offer one-click buttons to retry immediately with any alternative configured provider (e.g., "Try with Cloudflare Workers AI", "Try with Groq").
- **Partial Stream Preservation**: If an error occurs mid-stream, partial tokens already rendered remain preserved, flagged with an interruption notice rather than discarding generated content.

---

## 8. Firebase Integration & Authentication

### Authentication
- **Engine**: Firebase Authentication (v13.0.0 SDK) via email and password (`createUserWithEmailAndPassword`, `signInWithEmailAndPassword`, `signOut`).
- **Observer**: `onAuthStateChanged` restores authenticated user state upon page reload.
- **Error Sanitization**: `formatAuthError` maps Firebase errors (such as `auth/email-already-in-use` or `auth/invalid-credential`) into user-friendly messages without exposing internal codes.

### Cloud Firestore Schema
Conversations are stored hierarchically:

```text
/users/{userId}/chats/{chatId}
  ├── id: string
  ├── title: string
  ├── userId: string
  ├── mode: "general" | "coding" | "writing" | "learning"
  ├── isPinned: boolean
  ├── pinnedAt: number | null
  ├── createdAt: timestamp
  ├── updatedAt: timestamp
  └── /messages/{messageId}
        ├── id: string
        ├── sender: "user" | "assistant"
        ├── content: string
        ├── provider: string
        ├── modelUsed: string | null
        ├── createdAt: timestamp
        └── clientTimestamp: string
```

### Security Rules (`firestore.rules`)
- Access is strictly restricted to the authenticated document owner (`request.auth.uid == userId`).
- Disallows listing or writing across foreign user directories.
- Validates title lengths (1 to 120 characters) and message content lengths (1 to 100,000 characters).
- Enforces message roles to `user` or `assistant`.

### Guest Exploration Mode
When Firebase credentials are not provided or a user selects **Continue as Guest**:
- An anonymous session ID (`guest-xxxxxxx`) is established in `sessionStorage`.
- Conversations and message histories are saved to `localStorage` under `orvix_guest_chats`.
- Pinned chat IDs are stored in `localStorage` under `orvix_guest_pins`.
- Guest settings are stored in `localStorage` under `orvix_guest_settings`.
- Guest data persists across reloads and functions completely offline.

---

## 9. Chat Functionality & Conversation History

- **Multi-Turn Context**: Preserves previous context up to 12 turns, maintaining conversational coherence across all five providers.
- **Chat Pinning**: Pin up to 5 vital conversations to a dedicated top tier in the sidebar. Attempting to pin a 6th conversation alerts the user to unpin an existing one first.
- **Inline Title Editing**: Double-click or click the edit icon on any sidebar thread to rename it. Pressing Enter saves; pressing Escape cancels.
- **Atomic Batch Deletion**: Safely purges subcollection message documents in batches before deleting the parent conversation document, preventing orphaned database records.
- **Conversation Switching**: Switching threads smoothly updates the active viewport while ensuring ongoing background responses finish saving to their origin thread.

---

## 10. Project Structure & Important Files

```text
Orvix/
├── .env.example                  # Environment variable reference template
├── .gitignore                    # Git ignored directories and files
├── README.md                     # Comprehensive project documentation
├── api/                          # Serverless function handlers
│   ├── chat.ts                   # /api/chat route proxy adapter
│   ├── config.ts                 # /api/config route proxy adapter
│   └── health.ts                 # /api/health route proxy adapter
├── firebase-blueprint.json       # Schema definition for Firestore collections
├── firestore.rules               # Cloud Firestore security rules
├── index.html                    # SPA HTML entry point with inline theme script
├── metadata.json                 # AI Studio applet capabilities and metadata
├── package.json                  # NPM packages, dependencies, and project scripts
├── public/                       # Static public assets (icons, manifest)
│   ├── apple-touch-icon.png
│   ├── favicon.ico
│   ├── favicon.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   └── manifest.webmanifest      # Progressive Web App manifest
├── server.ts                     # Full-stack Express server & multi-provider proxy
├── src/                          # Frontend source code
│   ├── App.jsx                   # Root application component & auth router
│   ├── main.jsx                  # React DOM bootstrap
│   ├── index.css                 # Global CSS entry importing Tailwind & Obsidian styles
│   ├── components/               # React UI components (auth, chat, layout, settings, ui)
│   ├── config/                   # Configuration constants (appConfig, chatModes, firebaseConfig)
│   ├── context/                  # React Context providers (Auth, Settings, Speech)
│   ├── hooks/                    # Custom hooks (usePWAInstall, useVoiceDictation)
│   ├── pages/                    # ChatPage primary workspace view
│   ├── services/                 # AI router, provider services, Firestore service
│   ├── styles/                   # Design system CSS variables and layout rules
│   └── utils/                    # Exporters, text cleaners, syntax highlighter
├── tsconfig.json                 # TypeScript compiler configuration
├── vercel.json                   # Vercel deployment routes and build settings
└── vite.config.ts                # Vite build and development configuration
```

---

## 11. Prerequisites & Installation Instructions

### Prerequisites
- **Node.js**: Version `22.x` LTS recommended (compatible with `20.x`+).
- **npm**: Version `10.x` or higher.
- A modern web browser supporting ES2022 and Server-Sent Events.

### Installation Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Hannankhan203/Orvix.git
   cd Orvix
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```
   Add any available API keys to `.env`. If no keys are provided, the application will boot in **Demo / Guest Mode** using built-in simulated responses.

4. **Start the development server**:
   ```bash
   npm run dev
   ```

5. **Open the application**:
   Navigate to [http://localhost:3000](http://localhost:3000) (or `http://0.0.0.0:3000`) in your browser.

---

## 12. Environment Variables & Configuration

Configure these variables in your root `.env` file (or your hosting platform's environment settings):

| Variable | Scope | Required? | Description |
|---|---|---|---|
| `PORT` | Server | Optional | Port for the Express server (defaults to `3000`). |
| `GEMINI_API_KEY` | Server | Optional | Google Gemini API key. Configured server-side for `@google/genai`. |
| `GROQ_API_KEY` | Server | Optional | Groq API key for high-speed inference. |
| `OPENROUTER_API_KEY` | Server | Optional | OpenRouter API key for dynamic open-weights models. |
| `HUGGINGFACE_API_KEY`| Server | Optional | Hugging Face access token for Hugging Face Inference Providers. |
| `CLOUDFLARE_ACCOUNT_ID` | Server | Optional | Cloudflare Account ID for Workers AI inference. |
| `CLOUDFLARE_API_TOKEN` | Server | Optional | Cloudflare API Token with Workers AI Read permissions. |
| `VITE_FIREBASE_API_KEY` | Client | Optional | Firebase Web API key for authentication and Firestore. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Client | Optional | Firebase Auth Domain (e.g. `your-app.firebaseapp.com`). |
| `VITE_FIREBASE_PROJECT_ID` | Client | Optional | Firebase Project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET`| Client | Optional | Firebase Cloud Storage Bucket name. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID`| Client | Optional | Firebase Messaging Sender ID. |
| `VITE_FIREBASE_APP_ID` | Client | Optional | Firebase Web Application ID. |

### Safe `.env` Template

```env
# Server Configuration
PORT=3000

# Server-Side AI API Keys (Kept secure on backend)
GEMINI_API_KEY=your_gemini_api_key_here
GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
HUGGINGFACE_API_KEY=your_huggingface_api_key_here
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id_here
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token_here

# Firebase Client Configuration (Optional - for Cloud Persistence & Auth)
VITE_FIREBASE_API_KEY=your_firebase_api_key_here
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id
```

> **Security Note**: Never commit actual API keys or credentials to version control. AI keys are read exclusively by `server.ts` and are never exposed to browser bundles.

---

## 13. Development & Build Commands

All commands are executed using `npm`:

| Command | Action | Description |
|---|---|---|
| `npm run dev` | `tsx server.ts` | Starts the Express server with Vite dev middleware on port 3000. |
| `npm run build` | `vite build` | Compiles client assets and outputs production bundles to `dist/`. |
| `npm start` | `node server.ts` | Runs the production server, serving compiled assets from `dist/`. |
| `npm run preview` | `vite preview` | Previews the compiled production build locally. |
| `npm run lint` | `tsc --noEmit` | Runs the TypeScript compiler to validate type safety across the project. |
| `npm run clean` | `rm -rf dist server.js` | Removes compiled artifacts and build outputs. |

---

## 14. Deployment Instructions

### Production Node.js Deployment
1. Set `NODE_ENV=production` and configure port and API keys in your environment.
2. Build the production bundle:
   ```bash
   npm run build
   ```
3. Launch the server:
   ```bash
   npm start
   ```
   The Express server listens on `0.0.0.0:3000`, serves the `/api/*` endpoints, and serves compiled client files from `dist/` with single-page fallback.

### Containerized Deployment (Docker / Google Cloud Run)
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["npm", "start"]
```

---

## 15. Current Limitations

- **Guest to Cloud Account Migration**: Conversations created in Guest Mode reside in browser `localStorage`. Logging in or registering later does not automatically import local guest threads into Cloud Firestore.
- **Database Pin Limit Enforcement**: The 5-pinned-chat constraint is validated in frontend state and Firestore service queries, but cannot be strictly enforced at the database security rule level due to Firestore rule aggregation limits.
- **Web Speech Browser Compatibility**: Voice dictation (Speech-to-Text) and Text-to-Speech audio depend on browser support for `SpeechRecognition` and `SpeechSynthesis` (optimal on Chromium-based browsers and Safari).
- **Automated Test Coverage**: The project currently uses `tsc --noEmit` for static type verification; automated unit test suites (e.g., Vitest or Jest) are not yet integrated.

---

## 16. Planned & Future Features

The following capabilities are planned for upcoming releases:

- [ ] **Account Linking & Migration**: One-click import tool to transfer guest conversations into an authenticated Cloud Firestore account upon registration.
- [ ] **Multimodal File & Image Uploads**: Image, PDF, and text document attachments supported by multimodal models.
- [ ] **Full-Text Conversation Search**: Instant search bar in the sidebar to search across titles and message bodies.
- [ ] **Automated Test Suite**: Unit and integration test coverage with Vitest and React Testing Library.
- [ ] **Custom System Prompts**: User-defined custom instructions and personality presets in the settings modal.
- [ ] **Web Search Grounding**: Real-time Google Search grounding support for the Gemini provider.

---

## 17. Version History & Changelog

### Changelog

#### v0.3 — Cloudflare Workers AI Integration
- **Added Cloudflare Workers AI Provider**: Integrated Cloudflare Workers AI as an independent, selectable AI inference provider.
- **Model Support**: Added `@cf/meta/llama-3.1-8b-instruct` running on Cloudflare's serverless GPU infrastructure.
- **Distinct Model Option**: Added the selector option labelled **`Cloudflare Workers AI — Llama 3.1 8B`** across desktop and mobile headers.
- **Official REST API**: Connected to `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct` using bearer token authentication.
- **SSE Streaming & Fallback**: Implemented native Server-Sent Events (SSE) streaming support (`data: {"response":"..."}`) and server-side adaptation for non-streaming response payloads.
- **Server-Side Security**: Configured `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` server-side variables, keeping all credentials protected from browser bundles.
- **Error Normalization & Diagnostics**: Classified Cloudflare-specific error codes (401/403 unauthorized, 404 account/model not found, 429 rate limit, 5xx server issues) with automatic fallback options.
- **Updated Configuration**: Documented Cloudflare environment variables in `.env.example` and added `cloudflareConfigured` check to `/api/config`.

#### v0.2 — Hugging Face Inference Providers Integration
- **Added Hugging Face Provider**: Integrated Hugging Face Inference Providers as an independently selectable AI provider.
- **Model Support**: Added model support for `meta-llama/Llama-3.3-70B-Instruct`.
- **Selector Option**: Added the selector option labelled **`Hugging Face — Llama 3.3 70B Instruct`**.
- **Router Endpoint**: Connected to Hugging Face's OpenAI-compatible router endpoint (`https://router.huggingface.co/v1/chat/completions`).
- **Server Proxy Dispatch**: Routed requests through `server.ts` to protect `HUGGINGFACE_API_KEY` / `HF_TOKEN`.
- **Streaming & Recovery**: Enabled SSE token streaming and added Hugging Face to inline error retry and switch-provider actions.

#### v0.1 — Initial Development Version
- **Initial Release of Orvix**:
  - Full-stack React 19 single-page application with Obsidian Dark aesthetic and Tailwind CSS v4.
  - Multi-provider AI routing between Google Gemini (`@google/genai` v2.4.0), Groq, and OpenRouter.
  - Full Server-Sent Events (SSE) streaming with token-by-token rendering and stop generating controls.
  - Four specialized Chat Modes: General, Coding, Writing, and Learning.
  - Cloud Firestore persistence with subcollection data structuring and security rules.
  - Zero-setup Guest / Demo mode with local storage persistence and mode-aware simulated responses.
  - Conversation pinning (with 5-chat limit), inline renaming, and atomic batch deletion.
  - Web Speech voice dictation (STT) and text-to-speech audio playback (TTS).
  - Conversation export to Markdown, JSON, and Plain Text.
  - User customization options for themes (Dark/Light/System), response length, and beginner-friendly mode.
  - Progressive Web App (PWA) configuration with manifest and install prompt.

---

## 18. License

This project is maintained for personal and collaborative use. All rights reserved. Refer to the repository owner for licensing and distribution details.
