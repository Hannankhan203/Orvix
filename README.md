# Orvix

**Current Version: Orvix v0.2**

<p align="center">
  <strong>An Intelligent, Modern AI Conversation Companion</strong>
</p>

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Project Purpose & Current Status](#project-purpose--current-status)
3. [Architecture & Technology Stack](#architecture--technology-stack)
   - [Frontend Architecture](#frontend-architecture)
   - [Backend Architecture](#backend-architecture)
   - [Database & Authentication Architecture](#database--authentication-architecture)
4. [AI Providers & Selectable Models](#ai-providers--selectable-models)
   - [Fully Implemented Providers](#fully-implemented-providers)
   - [In Progress Providers](#in-progress-providers)
   - [Planned Providers](#planned-providers)
   - [AI Provider Routing, Streaming & Fallbacks](#ai-provider-routing-streaming--fallbacks)
   - [Zero-Key Simulation Mode](#zero-key-simulation-mode)
5. [Current Features (v0.2)](#current-features-v02)
6. [Planned & Future Features](#planned--future-features)
7. [Project Structure & Important Files](#project-structure--important-files)
   - [Directory Tree](#directory-tree)
   - [Important Files & Directories](#important-files--directories)
8. [Environment Variables & Configuration](#environment-variables--configuration)
9. [Prerequisites & Setup Instructions](#prerequisites--setup-instructions)
   - [Prerequisites](#prerequisites)
   - [Installation](#installation)
   - [Running in Development](#running-in-development)
   - [Building for Production](#building-for-production)
   - [Running the Production Server](#running-the-production-server)
   - [Type Checking & Linting](#type-checking--linting)
10. [Firebase Setup & Security Rules](#firebase-setup--security-rules)
11. [Deployment Information](#deployment-information)
12. [Current Limitations](#current-limitations)
13. [Version History & Changelog](#version-history--changelog)

---

## Project Overview

**Orvix v0.2** is a high-performance, responsive AI chatbot web application built with a modern React 19 single-page frontend, an Obsidian Dark / Clean Light design system styled with Tailwind CSS, and a Node.js Express full-stack backend running Vite in middleware mode.

Orvix provides seamless multi-model intelligence across four independently selectable AI providers:
- **Google Gemini** (`gemini-3.8-flash` primary with automatic `gemini-3.1-flash-lite` fallback) via the modern `@google/genai` TypeScript SDK.
- **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via Groq's high-speed OpenAI-compatible REST API.
- **OpenRouter** (`openrouter/free`) dynamically routing queries across available high-capacity free community models.
- **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct`) providing high-speed serverless inference on Cloudflare's global edge network via its official REST API.

Orvix features full-duplex conversational interaction: users can chat via text or hands-free voice dictation (speech-to-text), listen to AI responses via browser text-to-speech (read aloud), personalize responses (length, tone, beginner-friendly explanations), export conversations to Markdown or Plain Text, and store chat history either in Firebase Cloud Firestore or locally in browser storage through a zero-friction Guest Mode.

---

## Project Purpose & Current Status

### Purpose
The primary purpose of Orvix is to deliver an accessible, multi-model conversational assistant that balances privacy, flexibility, and speed:
1. **Multi-Model Intelligence**: Compare outputs across leading providers (Google Gemini, Groq, OpenRouter, Cloudflare Workers AI) inside the same conversation thread without losing context.
2. **True Zero-Friction Access**: Allow users to explore the application instantly via Guest Mode with simulated AI responses and local storage persistence without requiring API keys or mandatory account registration.
3. **Secure Full-Stack Proxying**: Route sensitive AI completions through a backend Express proxy (`/api/chat`) with Server-Sent Events (SSE) streaming so credentials remain protected on the server.
4. **Accessible Multimodal Speech**: Provide built-in voice input with verbal punctuation formatting and browser-synthesized audio read-aloud with voice and speed controls.
5. **Robust Data Ownership**: Offer complete cloud persistence via Firebase Cloud Firestore alongside instant client-side export to standard `.md` and `.txt` files.

### Current Status
- **Current Version**: `v0.2` (Minor release adding Cloudflare Workers AI).
- **Core Status**: Fully functional full-stack web application. The frontend, backend proxy, streaming SSE pipeline, authentication, Firestore storage, local fallback storage, speech synthesis, voice dictation, and personalization settings are all implemented and operating on Node.js 22 and port 3000.

---

## Architecture & Technology Stack

### Frontend Architecture
- **Framework**: React 19 (`react` ^19.0.1, `react-dom` ^19.0.1) as a Single Page Application (SPA).
- **Build Tool**: Vite (`vite` ^8.3.0) with `@vitejs/plugin-react` (^6.1.1).
- **Styling & Design System**: Tailwind CSS v4 (`tailwindcss` ^4.3.3, `@tailwindcss/vite` ^4.3.3) paired with an Obsidian Dark and Clean Light CSS custom-property design system (`src/styles/index.css`).
- **Icons**: Lucide React (`lucide-react` ^0.546.0).
- **Motion & Transitions**: Motion (`motion` ^12.23.24) and CSS hardware-accelerated transitions.
- **Markdown & Code Highlighting**: `react-markdown` (^10.1.0) and `remark-gfm` (^4.0.1), featuring custom code block rendering with language detection, line numbers, and one-click clipboard copying.
- **State Management**: React Context architecture:
  - `AuthContext`: Tracks user session, login, signup, logout, and guest identity.
  - `SettingsContext`: Synchronizes user preferences (theme, response length, beginner mode, chat mode, timestamps, enter-to-send) between Firestore and local storage.
  - `SpeechContext`: Controls Web Speech Synthesis playback, voice selection, speech rate, and read-aloud state.

### Backend Architecture
- **Server**: Express (`express` ^4.21.2) written in TypeScript (`server.ts`).
- **Development Execution**: `tsx` (^4.21.0) executes `server.ts` directly, mounting Vite in middleware mode (`appType: 'spa'`) for rapid hot module execution on a single port (3000).
- **Production Execution**: Serves compiled static frontend assets from `dist/` with wildcard SPA routing fallback to `index.html`.
- **API Endpoints**:
  - `GET /api/health` (or `/health`): System uptime and health verification.
  - `GET /api/config` (or `/config`): Returns provider configuration booleans (`geminiConfigured`, `groqConfigured`, `openrouterConfigured`, `cloudflareConfigured`) without exposing secrets.
  - `POST /api/chat` (or `/chat`): Central AI dispatch supporting both Server-Sent Events (SSE) streaming and atomic JSON responses.
- **Vercel Serverless Compatibility**: Lightweight handler wrappers in `api/chat.ts`, `api/config.ts`, and `api/health.ts` enable deployment on Vercel Functions.

### Database & Authentication Architecture
- **Firebase SDK**: Firebase Web SDK (`firebase` ^13.0.0).
- **Authentication**: Firebase Authentication with Email and Password provider. Includes session persistence, automated auth state synchronization, and friendly error normalization.
- **Cloud Database**: Cloud Firestore using a subcollection hierarchy:
  - Top-level user chat document: `/users/{userId}/chats/{chatId}`
  - Nested chronological message subcollection: `/users/{userId}/chats/{chatId}/messages/{messageId}`
- **Security Rules**: `firestore.rules` enforces user isolation (`request.auth.uid == userId`), message content validation (up to 100,000 characters), and title constraints.
- **Local Fallback Storage**: If Firebase is not configured or if the user chooses **Guest Mode**, chat threads, message histories, pinned statuses, and settings persist safely in browser `localStorage` and `sessionStorage`.

---

## AI Providers & Selectable Models

Orvix implements a multi-model architecture where models are selectable via the top navigation dropdown (`ModelSelector.jsx`). Switching models retains the entire ongoing conversation history.

```text
                                  ┌─────────────────────────┐
                                  │      Client Browser     │
                                  │   (selectedProvider)    │
                                  └────────────┬────────────┘
                                               │ POST /api/chat (SSE stream: true)
                                               ▼
                                  ┌─────────────────────────┐
                                  │   server.ts (/api/chat) │
                                  └─┬─────┬───────────┬─────┤
                 Gemini             │     │           │     │  Cloudflare
           ┌────────────────────────┘     │           │     └──────────────────────┐
           ▼                              ▼           ▼                            ▼
    ┌───────────────┐        ┌───────────────┐ ┌──────────────────┐       ┌────────────────────┐
    │ GoogleGenAI   │        │ Groq REST API │ │ OpenRouter API   │       │ Cloudflare Workers │
    │ SDK (v2.4.0)  │        │ (OpenAI-comp) │ │ (Free Gateway)   │       │ AI REST API        │
    └───────────────┘        └───────────────┘ └──────────────────┘       └────────────────────┘
```

### Fully Implemented Providers

| Provider Name | Exact Model ID | Dropdown Label in UI | Streaming Support | Transport / Implementation |
|---|---|---|---|---|
| **Google Gemini** | `gemini-3.8-flash` (fallback: `gemini-3.1-flash-lite`) | `Gemini (Gemini 3.1 Flash Lite)` | Yes (SSE) | Server-side `@google/genai` TypeScript SDK with automatic jitter retries and model failover. |
| **Groq** | `llama-3.3-70b-versatile` / `openai/gpt-oss-120b` | `Groq (Llama 3.3 70B)` | Yes (SSE) | Server-side native `fetch` calling Groq's OpenAI-compatible completions endpoint. |
| **OpenRouter** | `openrouter/free` | `OpenRouter (Llama 3.3 70B (Free))` | Yes (SSE) | Server-side native `fetch` dynamically routing to available high-capacity free community models. |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct` | `Cloudflare Workers AI — Llama 3.1 8B` | Yes (SSE) | Server-side native `fetch` calling Cloudflare Workers AI REST API with streaming and JSON adaptation. |

> **Note on Latest Model Addition**: In release `v0.2`, **exactly one new AI model** was added: `Cloudflare Workers AI — Llama 3.1 8B` (`@cf/meta/llama-3.1-8b-instruct`). No other new models were added.

### In Progress Providers
- *(None currently in progress; all four listed providers are fully integrated).*

### Planned Providers
- **Cerebras Inference** *(Planned)*: Ultra-high speed Llama inference.
- **Mistral AI** *(Planned)*: Native integration with Mistral Large and Codestral models.

---

### AI Provider Routing, Streaming & Fallbacks

- **Server-Sent Events (SSE)**: When the client requests streaming (`stream: true`), the server sends standard SSE chunks (`data: {"type":"chunk","text":"..."}`) and a completion marker (`data: {"type":"done", ...}`).
- **Pre-Stream Demand Check**: For Google Gemini, the server checks the initial token before sending HTTP 200 headers. If Google Gemini returns HTTP 503 high demand, the server retries with exponential backoff or fails over to `gemini-3.1-flash-lite`.
- **Cloudflare Streaming Adapter**: If Cloudflare responds with non-streaming JSON (or if chunked transfer is unavailable), `server.ts` automatically converts the JSON response into compliant SSE events (`start`, `chunk`, `done`), preserving the client streaming contract without failure.
- **Client Disconnection Safeguard**: When the user navigates away or stops generating, `res.on('close')` fires, immediately cancelling upstream fetch streams and saving API quota.
- **Context Retention Across Switching**: Switching between Gemini, Groq, OpenRouter, and Cloudflare Workers AI preserves all prior messages. Up to the last 12 messages are formatted into the active provider's expected schema.

### Zero-Key Simulation Mode
If API keys or credentials (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) are missing or unconfigured:
- The server produces rich, context-aware simulated responses matching the selected Chat Mode and personalization settings.
- When streaming, simulated responses are delivered token-by-token over SSE to test UI rendering, animations, and voice synthesis without friction.

---

## Current Features (v0.2)

All features below are **fully implemented and verified in Orvix v0.2**:

### Conversational & AI Capabilities
- **Multi-Model Selection**: Seamlessly switch between Google Gemini, Groq, OpenRouter, and Cloudflare Workers AI via the top navigation dropdown without clearing chat history.
- **Real-Time Token Streaming**: True Server-Sent Events (SSE) streaming with animated progressive reveal.
- **Multi-Turn Context Memory**: Passes up to the last 12 messages in chronological order to maintain multi-turn context.
- **Context Preservation across Providers**: Switch providers mid-conversation while retaining full context from previous messages.
- **Simulated Demo AI**: Fully responsive in-memory response generator for local testing when API keys are absent.
- **Chat Modes**: Select from 4 modes (`General`, `Coding`, `Writing`, `Learning`) with specialized starter prompts and model instructions.
- **Starter Prompt Suggestions**: Category-tagged starter prompts on the welcome screen to kick off coding, writing, learning, and planning tasks.
- **Message Retry & Edit-Resend**: One-click **Retry** for failed requests, or **Edit prompt** to load previous user text back into the composer.

### Speech & Audio
- **Voice Dictation (Speech-to-Text)**: Speak directly into the message composer via browser Web Speech Recognition. Includes live recording indicator, audio wave animation, and pause/resume.
- **Verbal Punctuation Engine**: Automatically converts spoken verbal cues ("comma", "period", "question mark", "new line") into typography, with phonetic tech corrections (e.g. "Orvix", "JavaScript", "API").
- **Multilingual Dictation**: Supports 9 spoken language options (English US/UK/PK, Urdu, Spanish, French, German, Arabic, Hindi).
- **Text-to-Speech (Read Aloud)**: Click the speaker icon on any assistant message to read it aloud using Web Speech Synthesis.
- **Speech Controls**: Pause, resume, stop, adjust playback speed (0.75x to 2.0x), and select system voices in Settings. Strips raw markdown/code blocks for a natural audio reading experience.

### Persistence & Conversation Management
- **Cloud Firestore Storage**: Automatically syncs chats and messages for authenticated users with real-time updates (`onSnapshot`).
- **Subcollection Message Architecture**: Messages are stored in subcollections to eliminate 1MB single-document limits.
- **Atomic Batch Deletion**: Safely purges message subcollections in batches before removing the parent chat document.
- **Guest / Demo Mode**: Instant access with no credentials needed. Conversations and pinned states persist across browser refreshes via `localStorage` and `sessionStorage`.
- **Conversation Pinning (5-Chat Limit)**: Pin up to 5 priority chats to the top of the sidebar with visual pin icons and constraint notifications.
- **Inline Renaming**: Rename any conversation directly from the sidebar item with `Enter` (save) or `Escape` (cancel).
- **Auto-Generated Titles**: Automatically derives concise titles from the user's initial prompt.

### UI, Personalization & Export
- **Obsidian Dark & Clean Light Themes**: Instant theme switching (`Dark`, `Light`, `System`) with zero-flash early initialization.
- **Personalization Settings**: Modal to configure theme, response length (`Concise`, `Balanced`, `Detailed`), beginner-friendly explanation toggle, default chat mode, Enter-to-send toggle, and timestamps.
- **Client-Side Export**: Export the active conversation to **Markdown (`.md`)** or **Plain Text (`.txt`)** directly in the browser with sanitized filenames.
- **Responsive Layout**: Collapsible sidebar navigation, mobile drawer overlay, auto-resizing composer textarea, and custom scrollbars.
- **PWA Ready**: Web App Manifest (`manifest.webmanifest`), home screen icons, theme color, and install prompt integration.

---

## Planned & Future Features

The following features are **planned for future releases** and are not implemented in `v0.2`:

- **Guest-to-Account History Migration** *(Planned)*: Transfer locally cached guest conversations into a new user account upon registration.
- **Multimodal File & Image Uploads** *(Planned)*: Upload images, documents, and code files to multimodal models.
- **Global Message Search** *(Planned)*: Full-text search across all saved conversation titles and message contents in the sidebar.
- **Custom System Instructions Editor** *(Planned)*: Allow users to specify arbitrary custom prompt directives beyond the predefined chat modes.
- **Automated Unit & E2E Test Suite** *(Planned)*: Introduce Vitest and React Testing Library test suites into the build pipeline.

---

## Project Structure & Important Files

### Directory Tree

```text
Orvix/
├── .env.example                  # Environment variable reference template
├── .gitignore                    # Git ignore specifications
├── README.md                     # Comprehensive project documentation
├── api/                          # Serverless entry points for Vercel deployment
│   ├── chat.ts                   # /api/chat handler wrapper
│   ├── config.ts                 # /api/config handler wrapper
│   └── health.ts                 # /api/health handler wrapper
├── firebase-blueprint.json       # Blueprint database schema definition
├── firestore.rules               # Production Firestore database security rules
├── index.html                    # SPA HTML entry point with theme bootstrap
├── metadata.json                 # AI Studio applet capabilities and metadata
├── package.json                  # NPM dependencies, scripts, and package metadata
├── public/                       # Static public assets, icons, and PWA manifest
│   ├── apple-touch-icon.png      # iOS home screen icon
│   ├── favicon.ico               # Browser favicon
│   ├── favicon.svg               # SVG vector favicon
│   ├── icon-192.png              # 192x192 PWA manifest icon
│   ├── icon-512.png              # 512x512 PWA manifest icon
│   └── manifest.webmanifest      # Progressive Web App manifest
├── server.ts                     # Express server, Vite middleware & AI proxy
├── src/                          # React 19 client application source code
│   ├── App.jsx                   # Root application container & auth router
│   ├── index.css                 # Global CSS entry loading Tailwind and styles
│   ├── main.jsx                  # Application entry point mounting to DOM
│   ├── components/               # Modular UI components
│   │   ├── auth/
│   │   │   └── AuthScreen.jsx    # Email/password authentication & guest mode launcher
│   │   ├── chat/
│   │   │   ├── ChatArea.jsx      # Message viewport and message composer dock
│   │   │   ├── ChatMessage.jsx   # Message bubble, markdown, code copy & speech button
│   │   │   ├── CodeBlock.jsx     # Syntax-highlighted code block with copy action
│   │   │   ├── ExportChatMenu.jsx# Export dropdown for Markdown and Plain Text
│   │   │   ├── MessageList.jsx   # Virtualized message list with auto-scroll pinning
│   │   │   ├── ModeSelector.jsx  # Chat mode switcher (General, Coding, Writing, Learning)
│   │   │   ├── ModelSelector.jsx # AI provider switcher (Gemini, Groq, OpenRouter, Cloudflare)
│   │   │   ├── PromptSuggestions.jsx # Welcome screen starter prompt cards
│   │   │   ├── TypingIndicator.jsx   # Pulsing three-dot thinking indicator
│   │   │   └── WelcomeScreen.jsx     # Empty conversation welcome state
│   │   ├── layout/
│   │   │   ├── Header.jsx        # Navigation bar, model selector, title & actions
│   │   │   ├── Layout.jsx        # Responsive shell managing sidebar and backdrop
│   │   │   ├── Sidebar.jsx       # Conversations drawer, pinned list & user profile
│   │   │   └── SidebarChatItem.jsx # Chat item with pin, inline rename & delete
│   │   ├── settings/
│   │   │   └── SettingsModal.jsx # Personalization settings dialog
│   │   └── ui/
│   │       ├── Button.jsx        # Reusable button primitive with variants
│   │       └── OrvixLogo.jsx     # Orvix branding logo component
│   ├── config/                   # Static configuration and constants
│   │   ├── appConfig.js          # App metadata, defaults, and starter prompt templates
│   │   ├── chatModes.js          # Chat mode definitions, icons, and instructions
│   │   ├── firebaseConfig.js     # Firebase SDK initialization and validation
│   │   └── sampleData.js         # Offline mock conversation demonstration data
│   ├── context/                  # React Context state providers
│   │   ├── AuthContext.jsx       # Authentication state, login, signup, and guest mode
│   │   ├── SettingsContext.jsx   # Theme, response preferences, and composer settings
│   │   └── SpeechContext.jsx     # Web Speech synthesis, voices, and read-aloud state
│   ├── hooks/                    # Reusable React hooks
│   │   ├── usePWAInstall.js      # PWA install prompt handler
│   │   └── useVoiceDictation.js  # Web Speech recognition and verbal punctuation hook
│   ├── pages/
│   │   └── ChatPage.jsx          # Primary chat screen orchestrating state & storage
│   ├── services/                 # Business logic and external API integrations
│   │   ├── aiRouter.js           # Central AI dispatch, streaming, and error parsing
│   │   ├── authService.js        # Firebase Auth wrapper with error normalization
│   │   ├── chatStorageService.js # Firestore CRUD, batch deletion, and pinning logic
│   │   ├── geminiService.js      # Google Gemini client fallback integration
│   │   ├── groqService.js        # Groq client fallback integration
│   │   ├── index.js              # Service module index
│   │   ├── mockChatService.js    # Local simulated response generator
│   │   ├── openrouterService.js  # OpenRouter client fallback integration
│   │   ├── userProfileService.js # Firestore user profile read/write
│   │   └── userSettingsService.js# User settings persistence in Firestore & localStorage
│   ├── styles/
│   │   └── index.css             # Comprehensive Obsidian & Light theme design system
│   └── utils/                    # Helper utilities
│       ├── exportConversation.js # Markdown and Plain Text file generation & download
│       ├── speechTextCleaner.js  # Cleans markdown for natural voice synthesis
│       └── syntaxHighlighter.js  # Keyword syntax highlighter for code blocks
├── tsconfig.json                 # TypeScript compiler configuration
├── vercel.json                   # Vercel deployment configuration
└── vite.config.ts                # Vite bundler, plugin, and dev server configuration
```

### Important Files & Directories

- **`server.ts`**: The backend server. Implements `/api/chat` with SSE streaming, invokes `@google/genai` on the server, handles Groq, OpenRouter, and Cloudflare Workers AI requests, provides health checks, and mounts Vite middlewares in development.
- **`src/pages/ChatPage.jsx`**: The core coordinator of the application. Manages active conversation IDs, sends prompts, coordinates real-time streaming tokens, synchronizes with Firestore or `localStorage`, and handles error recovery.
- **`src/services/aiRouter.js`**: Standardizes provider requests, sends SSE streams to `/api/chat`, handles client abort signals, and classifies errors into user-friendly messages.
- **`src/components/chat/ModelSelector.jsx`**: Model dropdown enabling users to switch between Google Gemini, Groq, OpenRouter, and Cloudflare Workers AI.
- **`src/services/chatStorageService.js`**: Manages all Cloud Firestore persistence, real-time subscriptions (`onSnapshot`), subcollection writes, and batch deletion.
- **`src/config/chatModes.js`**: Defines the four chat modes (`general`, `coding`, `writing`, `learning`), system instruction extensions, and starter prompts.
- **`src/context/SpeechContext.jsx` & `src/hooks/useVoiceDictation.js`**: Powers the complete voice-in (speech recognition) and voice-out (speech synthesis) multimodal workflows.
- **`firestore.rules`**: Production security rules restricting document access to authenticated owners.

---

## Environment Variables & Configuration

Environment variables are defined in `.env` in the root directory. Use `.env.example` as a template.

> **Security Note**: Never commit actual API keys or credentials to version control. Variables prefixed with `VITE_` are exposed to the client bundle. AI provider keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) belong exclusively in the server-side environment to protect secrets.

| Variable Name | Required? | Environment Scope | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Optional | Server-side | Google Gemini API key used by the backend Express proxy (`server.ts`). |
| `GROQ_API_KEY` | Optional | Server-side | Groq API key used by the backend Express proxy (`server.ts`). |
| `OPENROUTER_API_KEY` | Optional | Server-side | OpenRouter API key used by the backend Express proxy (`server.ts`). |
| `CLOUDFLARE_ACCOUNT_ID` | Optional | Server-side | Cloudflare Account ID for Workers AI REST API requests. |
| `CLOUDFLARE_API_TOKEN` | Optional | Server-side | Cloudflare API Token with Workers AI read/execute permissions. |
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
- **Web Browser**: Modern browser with Web Speech API and JavaScript enabled (Chrome, Edge, Safari, Firefox).

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Hannankhan203/Orvix.git
   cd Orvix
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
- Mounts Vite in middleware mode for hot client reloads while serving live `/api/chat` endpoints.
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

*Note: If Firebase credentials are not provided, Orvix automatically activates Guest Mode with local storage persistence.*

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
- `api/chat.ts` routes requests to the Express server handler.
- `api/health.ts` and `api/config.ts` provide serverless endpoints.
- Vite build output is configured to `dist/`.

---

## Current Limitations

- **Guest-to-Account Migration**: Conversations created in Guest Mode reside in local browser storage; registering an account does not currently migrate guest chats into Firestore.
- **Client-Side Pin Limit Enforcement**: The 5-pinned-chat constraint is enforced in client application state and Firestore query logic, but not in database security rules due to Firestore rule constraints on aggregate counts.
- **Speech Synthesis Browser Variance**: Voices available for Read Aloud depend on the host operating system and browser synthesizer capabilities.

---

## Version History & Changelog

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
