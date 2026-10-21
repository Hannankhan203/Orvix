# Orvix

**Current Version: Orvix v0.1**

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
4. [AI Provider Architecture & Streaming](#ai-provider-architecture--streaming)
   - [Supported AI Providers](#supported-ai-providers)
   - [Server-Side Proxy & SSE Streaming](#server-side-proxy--sse-streaming)
   - [Dynamic System Instructions & Personas](#dynamic-system-instructions--personas)
   - [Zero-Key Simulation & Fallbacks](#zero-key-simulation--fallbacks)
5. [Current Features (v0.1)](#current-features-v01)
6. [Planned / Future Features](#planned--future-features)
7. [Project Structure](#project-structure)
   - [Directory Tree](#directory-tree)
   - [Important Files & Directories](#important-files--directories)
8. [Environment Variables](#environment-variables)
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
13. [Changelog](#changelog)

---

## Project Overview

**Orvix v0.1** is a high-performance, responsive AI chatbot web application built with a modern React 19 single-page frontend, an Obsidian Dark / Clean Light design system styled with Tailwind CSS, and a Node.js Express full-stack backend running Vite in middleware mode.

Orvix provides seamless multi-model intelligence across three AI providers:
- **Google Gemini** (`gemini-3.8-flash` primary with automatic `gemini-3.1-flash-lite` fallback) via the modern `@google/genai` TypeScript SDK.
- **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via Groq's high-speed OpenAI-compatible REST API.
- **OpenRouter** (`openrouter/free`) dynamically routing queries across available high-capacity free community models.

Orvix features full-duplex conversational interaction: users can chat via text or hands-free voice dictation (speech-to-text), listen to AI responses via browser text-to-speech (read aloud), personalize responses (length, tone, beginner-friendly explanations), export conversations to Markdown or Plain Text, and store chat history either in Firebase Cloud Firestore or locally in browser storage through a zero-friction Guest Mode.

---

## Project Purpose & Current Status

### Purpose
The primary purpose of Orvix is to deliver an accessible, multi-model conversational assistant that balances privacy, flexibility, and speed:
1. **Multi-Model Intelligence**: Compare outputs across leading providers (Google Gemini, Groq, OpenRouter) inside the same conversation thread without losing context.
2. **True Zero-Friction Access**: Allow users to explore the application instantly via Guest Mode with simulated AI responses and local storage persistence without requiring API keys or mandatory account registration.
3. **Secure Full-Stack Proxying**: Route sensitive AI completions through a backend Express proxy (`/api/chat`) with Server-Sent Events (SSE) streaming so credentials remain protected on the server.
4. **Accessible Multimodal Speech**: Provide built-in voice input with verbal punctuation formatting and browser-synthesized audio read-aloud with voice and speed controls.
5. **Robust Data Ownership**: Offer complete cloud persistence via Firebase Cloud Firestore alongside instant client-side export to standard `.md` and `.txt` files.

### Current Status
- **Current Release**: `v0.1` (Active initial development release).
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
  - `GET /api/config` (or `/config`): Returns provider configuration booleans without exposing secrets.
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

## AI Provider Architecture & Streaming

Orvix unifies multiple AI providers into a normalized interface managed by `src/services/aiRouter.js` and the backend Express handler in `server.ts`.

```text
                           ┌─────────────────────────┐
                           │      Client Browser     │
                           │   (selectedProvider)    │
                           └────────────┬────────────┘
                                        │ POST /api/chat (SSE stream: true)
                                        ▼
                           ┌─────────────────────────┐
                           │   server.ts (/api/chat) │
                           └──────┬─────┬─────┬──────┘
                    Gemini        │     │     │     OpenRouter
              ┌───────────────────┘     │     └───────────────────┐
              ▼                         ▼                         ▼
       ┌───────────────┐        ┌───────────────┐        ┌──────────────────┐
       │ GoogleGenAI   │        │ Groq REST API │        │ OpenRouter API   │
       │ SDK (v2.4.0)  │        │ (OpenAI-comp) │        │ (Free Gateway)   │
       └───────────────┘        └───────────────┘        └──────────────────┘
```

### Supported AI Providers

| Provider | Default / Configured Model | Primary Transport | SDK / Library |
|---|---|---|---|
| **Google Gemini** | `gemini-3.8-flash` (fallback: `gemini-3.1-flash-lite`) | Server-side SSE Stream | `@google/genai` (^2.4.0) |
| **Groq** | `openai/gpt-oss-120b` / `llama-3.3-70b-versatile` | Server-side SSE Stream | Native Node.js `fetch` |
| **OpenRouter** | `openrouter/free` | Server-side SSE Stream | Native Node.js `fetch` |

### Server-Side Proxy & SSE Streaming
- **Server-Sent Events (SSE)**: The frontend sets `Accept: text/event-stream`. The backend flushes chunked `data: {"type":"chunk","text":"..."}` events in real time.
- **Pre-Stream Validation**: For Google Gemini, the server inspects the first token of `ai.models.generateContentStream` *before* committing HTTP 200 SSE headers. If the model is experiencing temporary high demand (HTTP 503), the server retries with jitter and backoff or seamlessly fails over to `gemini-3.1-flash-lite`.
- **Client Disconnect Handling**: The server tracks client socket closures (`res.on('close')`) to immediately abort upstream streaming requests and avoid wasted quota.
- **Client Fallback**: If the Express backend is completely unreachable, `aiRouter.js` can invoke client-side fetch fallbacks (`geminiService.js`, `groqService.js`, `openrouterService.js`) if client keys are present.

### Dynamic System Instructions & Personas
System instructions are built dynamically based on user context:
- **Personalized Name**: Incorporates the user's preferred username naturally.
- **Response Length**: Injects guidelines for `concise`, `balanced`, or `detailed` responses.
- **Beginner-Friendly Mode**: Prompts the model to provide clear analogies and avoid unnecessary technical jargon.
- **Chat Modes**: Modulates behavior based on the active mode:
  - `General`: Helpful, versatile general conversational companion.
  - `Coding`: Emphasizes software architecture, clean syntax, edge cases, and step-by-step debugging.
  - `Writing`: Prioritizes flow, tone polishing, constructive rewriting, and audience tailoring.
  - `Learning`: Focuses on conceptual mastery, real-world analogies, and comprehension checkpoints.

### Zero-Key Simulation & Fallbacks
When running without API keys configured (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` unset or default):
- Orvix remains 100% interactive.
- `server.ts` produces rich, simulated conversational responses tailored to the prompt, mode, and response preferences.
- When streaming is enabled, the simulated response streams token-by-token via SSE with realistic typing latency.

---

## Current Features (v0.1)

All features below are **fully implemented and functional in Orvix v0.1**:

### Conversational & AI Capabilities
- **Multi-Model Selection**: Switch between Google Gemini, Groq, and OpenRouter at any time via the navigation bar dropdown without clearing chat history.
- **Real-Time Token Streaming**: Real-time response streaming via Server-Sent Events (SSE) with progressive UI rendering.
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

## Planned / Future Features

The following features are **planned for future releases** and are not yet implemented in `v0.1`:

- **Guest-to-Account History Migration** *(Planned)*: Transfer locally cached guest conversations into a new user account upon registration.
- **Multimodal File & Image Uploads** *(Planned)*: Upload images, documents, and code files to multimodal models.
- **Global Message Search** *(Planned)*: Full-text search across all saved conversation titles and message contents in the sidebar.
- **Custom System Instructions Editor** *(Planned)*: Allow users to specify arbitrary custom prompt directives beyond the predefined chat modes.
- **Automated Unit & E2E Test Suite** *(Planned)*: Introduce Vitest and React Testing Library test suites into the build pipeline.

---

## Project Structure

### Directory Tree

```text
Orvix/
├── .env.example                  # Environment variable template with required keys
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
│   │   │   ├── ModelSelector.jsx # AI provider switcher (Gemini, Groq, OpenRouter)
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

- **`server.ts`**: The backend server. Implements `/api/chat` with SSE streaming, invokes `@google/genai` on the server, handles Groq/OpenRouter requests, provides health checks, and mounts Vite middlewares in development.
- **`src/pages/ChatPage.jsx`**: The core coordinator of the application. Manages active conversation IDs, sends prompts, coordinates real-time streaming tokens, synchronizes with Firestore or `localStorage`, and handles error recovery.
- **`src/services/aiRouter.js`**: Standardizes provider requests, sends SSE streams to `/api/chat`, handles client abort signals, and classifies errors into user-friendly messages.
- **`src/services/chatStorageService.js`**: Manages all Cloud Firestore persistence, real-time subscriptions (`onSnapshot`), subcollection writes, and batch deletion.
- **`src/config/chatModes.js`**: Defines the four chat modes (`general`, `coding`, `writing`, `learning`), system instruction extensions, and starter prompts.
- **`src/context/SpeechContext.jsx` & `src/hooks/useVoiceDictation.js`**: Powers the complete voice-in (speech recognition) and voice-out (speech synthesis) multimodal workflows.
- **`firestore.rules`**: Production security rules restricting document access to authenticated owners.

---

## Environment Variables

Environment variables are defined in `.env` in the root directory. Use `.env.example` as a template.

> **Security Note**: Never commit actual API keys or credentials to version control. Variables prefixed with `VITE_` are exposed to the client bundle. AI provider keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`) should be placed on the server to ensure keys are never exposed to the browser.

| Variable Name | Required? | Context | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Optional | Server | Google Gemini API key used by the backend Express proxy (`server.ts`). |
| `GROQ_API_KEY` | Optional | Server | Groq API key used by the backend Express proxy (`server.ts`). |
| `OPENROUTER_API_KEY` | Optional | Server | OpenRouter API key used by the backend Express proxy (`server.ts`). |
| `PORT` | Optional | Server | Server port (defaults to `3000`). |
| `NODE_ENV` | Optional | Server | Runtime environment (`development` or `production`). |
| `VITE_FIREBASE_API_KEY` | Optional | Client | Firebase Web API key for authentication and Firestore sync. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Optional | Client | Firebase Auth domain (e.g., `your-project.firebaseapp.com`). |
| `VITE_FIREBASE_PROJECT_ID` | Optional | Client | Firebase project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET`| Optional | Client | Firebase Cloud Storage bucket URL. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Optional | Client | Firebase Cloud Messaging sender ID. |
| `VITE_FIREBASE_APP_ID` | Optional | Client | Firebase Web application ID. |

### Configuration Template (`.env.example`)

```ini
# Server-Side AI API Keys (Recommended for security)
GEMINI_API_KEY=your_gemini_api_key_here
GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here

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

## Changelog

### v0.1
- **Initial Development Release**:
  - Implemented React 19 SPA frontend with Obsidian Dark and Clean Light themes.
  - Implemented Express backend (`server.ts`) with Vite middleware mode on port 3000.
  - Integrated Google Gemini via `@google/genai` with streaming Server-Sent Events (SSE) and model failover.
  - Integrated Groq and OpenRouter OpenAI-compatible streaming endpoints.
  - Built zero-key simulated response fallback engine for instant prototype testing.
  - Added 4 conversational Chat Modes (`General`, `Coding`, `Writing`, `Learning`) with specialized instructions and starter prompts.
  - Implemented Web Speech Recognition voice dictation with verbal punctuation engine and 9 language options.
  - Implemented Web Speech Synthesis read-aloud with voice selection, rate adjustments, and markdown cleaning.
  - Implemented Cloud Firestore persistence with subcollections, real-time sync, and batch deletions.
  - Implemented Guest / Demo Mode with `localStorage` and `sessionStorage` fallback.
  - Added conversation pinning with a 5-chat limit and inline title editing.
  - Added client-side Markdown (`.md`) and Plain Text (`.txt`) conversation export.
  - Configured Progressive Web App manifest and install hooks.
