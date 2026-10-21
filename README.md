# Orvix

**Version: v0.1**

<p align="center">
  <strong>An Intelligent, Multi-Model AI Conversation Companion & Full-Stack Chat Application</strong>
</p>

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Purpose & Goals](#2-purpose--goals)
- [3. Current Project Status](#3-current-project-status)
- [4. Implemented Features](#4-implemented-features)
- [5. Architecture & Tech Stack](#5-architecture--tech-stack)
  - [Frontend Architecture](#frontend-architecture)
  - [Backend Architecture](#backend-architecture)
  - [AI Provider & Routing Architecture](#ai-provider--routing-architecture)
  - [Streaming & Server-Sent Events (SSE)](#streaming--server-sent-events-sse)
- [6. Firebase & Data Persistence](#6-firebase--data-persistence)
  - [Authentication](#authentication)
  - [Cloud Firestore Schema & Security Rules](#cloud-firestore-schema--security-rules)
  - [Guest / Demo Mode Persistence](#guest--demo-mode-persistence)
- [7. Chat Modes, Voice & Customization](#7-chat-modes-voice--customization)
- [8. Project Structure](#8-project-structure)
- [9. Important Files & Responsibilities](#9-important-files--responsibilities)
- [10. Environment Variables & Configuration](#10-environment-variables--configuration)
- [11. Getting Started & Local Setup](#11-getting-started--local-setup)
- [12. Available Scripts & Commands](#12-available-scripts--commands)
- [13. Deployment](#13-deployment)
- [14. Current Limitations](#14-current-limitations)
- [15. Planned / Future Features](#15-planned--future-features)
- [16. Changelog](#16-changelog)
- [17. License](#17-license)

---

## 1. Overview

**Orvix v0.1** is a high-performance, full-stack AI chatbot application crafted with a responsive React 19 single-page interface, an Obsidian Dark design system built on Tailwind CSS v4, and an integrated Node.js Express backend proxy.

Orvix provides unified access to three first-class AI inference providers:
1. **Google Gemini** (`gemini-3.8-flash` & `gemini-3.1-flash-lite`) via the modern `@google/genai` TypeScript SDK.
2. **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`) via Groq's low-latency OpenAI-compatible API.
3. **OpenRouter** (`openrouter/free`) for dynamic routing across free community open-weights models.

In addition to multi-model AI routing, Orvix v0.1 delivers true token-by-token Server-Sent Events (SSE) streaming, specialized conversation modes, real-time Cloud Firestore synchronization, zero-setup guest exploration, Web Speech voice dictation and text-to-speech, multi-format chat export, and PWA installability.

---

## 2. Purpose & Goals

The primary objectives of the Orvix project are:

1. **Multi-Model Flexibility**: Allow users to seamlessly switch AI providers midway through conversations without losing thread history, allowing direct comparison of model outputs.
2. **Secure Full-Stack Design**: Route all model inference and authentication credentials through a backend Express proxy (`/api/chat`), shielding API keys from client bundles.
3. **Zero-Friction Onboarding**: Provide an immediate Guest Mode with local storage persistence and simulated fallback responses so anyone can test the interface instantly without mandatory registration or API keys.
4. **Structured Persistence**: Organize user conversations cleanly in Google Cloud Firestore using subcollections to guarantee scalability, atomic message deletions, and granular security rules.
5. **Polished Accessibility**: Provide voice dictation, speech synthesis audio playback, comprehensive keyboard shortcuts, light/dark themes, and export utilities in a clean obsidian aesthetic.

---

## 3. Current Project Status

- **Current Version**: `v0.1`
- **Application State**: Functional MVP with complete frontend, backend proxy, AI provider router, Firestore database layer, and client fallback flows.
- **Runtime Environment**: Node.js 22 LTS, Vite 8, React 19, Express 4.

---

## 4. Implemented Features

### Conversational Experience
- **Multi-Model Selection**: Switch between Google Gemini, Groq, and OpenRouter at any time via a dedicated top navigation dropdown.
- **Server-Sent Events (SSE) Streaming**: Token-by-token progressive text rendering with typing indicator, dynamic word chunking, and instant **Stop Generating** control.
- **Context-Aware History**: Automatically formats and passes the last 12 messages to the selected provider for coherent multi-turn dialogue.
- **Simulated Response Fallback**: When API keys are not supplied in the environment, the backend automatically generates rich simulated responses tailored to prompt and active mode, ensuring full offline/demo capability.
- **Prompt Suggestions**: Four starter prompt cards on the welcome screen dynamically tailored to the active chat mode.
- **Smart Conversation Titles**: Derives clean, concise 36-character titles automatically from the user's initial prompt.
- **Message Actions**:
  - One-click copy for entire messages or individual syntax-highlighted code blocks.
  - **Edit & Resend**: Edit earlier user prompts directly in the composer.
  - **Regenerate**: Request a fresh response from the assistant.
  - **Error Recovery**: Inline error banners with one-click **Retry** and suggested alternate providers.

### Chat Modes
- **General Assistant**: Versatile companion for everyday queries, planning, and brainstorming.
- **Coding Mode**: Software architecture, debugging, clean code blocks with syntax highlighting, and edge-case callouts.
- **Writing Mode**: Drafting, editing, tone adjustment, and prose enhancement.
- **Learning Mode**: Step-by-step conceptual breakdowns, analogies, and comprehension checks.

### Speech & Accessibility
- **Voice Dictation (Speech-to-Text)**: Microphone input powered by the Web Speech API with interim transcript preview, recording timer, pause/resume, and punctuation auto-cleaning.
- **Text-to-Speech (Read Aloud)**: In-browser speech synthesis for assistant responses with adjustable playback speed (0.75x to 1.5x) and system voice selection.

### Conversation Management
- **Conversation Pinning (5-Chat Limit)**: Pin up to 5 priority conversations to a dedicated top section in the sidebar with gold badge indicators and limit enforcement.
- **Inline Renaming**: Double-click or click the edit icon to rename threads inline (Enter to save, Esc to cancel).
- **Atomic Deletion**: Purges conversation subcollections in atomic batches (up to 400 messages per chunk) before removing the parent chat record.
- **Export Conversations**: Export any active conversation to **Markdown (`.md`)**, **JSON (`.json`)**, or **Plain Text (`.txt`)**.

### User Personalization & Settings
- **Theme Support**: Obsidian Dark (default), Crisp Light, or System match. Immediate inline script prevents light/dark mode flash on reload.
- **Response Length Preference**: Choose between *Concise*, *Balanced*, or *Detailed* outputs injected into model system instructions.
- **Beginner-Friendly Mode**: Injects guidance asking models to use accessible analogies and avoid unexplained jargon.
- **PWA Installation**: Installable Progressive Web App with Web App Manifest, maskable app icons, and in-app install prompt.

---

## 5. Architecture & Tech Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        React 19 Client SPA                             │
│                                                                        │
│   App.jsx                                                              │
│     ├── AuthContext (Firebase Auth & Guest Mode)                       │
│     ├── SettingsContext (Themes, Preferences, Voice Options)           │
│     ├── SpeechContext (Web Speech Synthesis / TTS)                     │
│     └── ChatPage.jsx                                                   │
│           ├── Layout (Collapsible Sidebar, Navigation Header)          │
│           └── ChatArea (MessageList, ChatMessage, Composer Dock)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                       HTTP POST /api/chat (SSE Stream)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      Express Backend (server.ts)                       │
│                                                                        │
│   Endpoints:                                                           │
│     • GET  /api/health     → Health check and server uptime            │
│     • GET  /api/config     → Safe provider configuration status        │
│     • POST /api/chat       → Centralized AI router with SSE streaming  │
│                                                                        │
│   Providers:                                                           │
│     ├── Google Gemini      → @google/genai SDK (v2.4.0)                │
│     ├── Groq API           → Fetch client (OpenAI-compatible)          │
│     ├── OpenRouter API     → Fetch client (Free Model Gateway)         │
│     └── Demo Generator     → In-memory mode-aware fallback generator   │
│                                                                        │
│   Vite Dev Middleware (Development) / Express Static dist/ (Production)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                        Client SDK Cloud Operations
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Google Firebase (Client)                        │
│   • Firebase Authentication (Email/Password & Session Management)      │
│   • Cloud Firestore Database (/users/{userId}/chats/{chatId}/...)      │
└────────────────────────────────────────────────────────────────────────┘
```

### Complete Technology Stack

| Category | Technology | Version | Purpose |
|---|---|---|---|
| **Frontend Framework** | React | `^19.0.1` | Core UI library with concurrent rendering and hooks |
| **Frontend DOM** | React DOM | `^19.0.1` | DOM renderer for web browsers |
| **Build & Bundler** | Vite | `^8.3.0` | Development server and production asset bundler |
| **Backend Runtime** | Node.js / Express | `^4.21.2` | REST API routes, AI streaming proxy, and static serving |
| **TypeScript Execution**| tsx | `^4.21.0` | Direct TypeScript execution for `server.ts` |
| **Type Checking** | TypeScript | `^7.0.2` | Static type checking and verification |
| **Styling** | Tailwind CSS | `^4.3.3` | Utility-first CSS styling system (v4) |
| **Tailwind Vite Plugin**| @tailwindcss/vite | `^4.3.3` | Vite compilation integration for Tailwind v4 |
| **Icons** | Lucide React | `^0.546.0` | Consistent iconography across UI controls |
| **Animations** | Motion | `^12.23.24` | Animation and transition primitives |
| **Markdown Parser** | React Markdown | `^10.1.0` | Safe rendering of markdown text in assistant bubbles |
| **GFM Support** | Remark GFM | `^4.0.1` | Tables, task lists, and autolinks in markdown |
| **Google Gemini SDK** | @google/genai | `^2.4.0` | Official Google Gen AI TypeScript SDK |
| **Database & Auth** | Firebase | `^13.0.0` | Cloud Firestore persistence and Email/Password auth |
| **Environment** | dotenv | `^17.2.3` | Environment variable loader from `.env` |

---

## 6. Firebase & Data Persistence

### Authentication
- **Provider**: Firebase Authentication via email and password (`createUserWithEmailAndPassword`, `signInWithEmailAndPassword`, `signOut`).
- **Session Observer**: `onAuthStateChanged` restores authenticated user state upon page reload.
- **Error Formatting**: `formatAuthError` maps Firebase errors (such as `auth/email-already-in-use` or `auth/invalid-credential`) into clean, user-friendly messages while removing raw tokens.

### Cloud Firestore Schema & Security Rules
Conversations are stored hierarchically:

```text
/users/{userId}/chats/{chatId}
  ├── id: string
  ├── title: string
  ├── userId: string
  ├── isPinned: boolean
  ├── createdAt: timestamp
  ├── updatedAt: timestamp
  └── /messages/{messageId}
        ├── id: string
        ├── sender: "user" | "assistant"
        ├── content: string
        ├── modelUsed: string | null
        ├── createdAt: timestamp
        └── clientTimestamp: string
```

- **Firestore Rules (`firestore.rules`)**:
  - Restricts access strictly to the authenticated document owner (`request.auth.uid == userId`).
  - Denies direct read/write to `/users/{userId}` parent documents.
  - Validates title lengths (1 to 120 characters) and message content lengths (1 to 100,000 characters).
  - Constrains sender roles to `user` or `assistant`.
- **5-Chat Pinning Constraint**: Enforced at the application and service layer (`chatStorageService.js` and `ChatPage.jsx`) due to Firestore rule aggregation limitations.

### Guest / Demo Mode Persistence
When Firebase credentials are not provided or a user clicks **Continue as Guest**:
- An anonymous session identity (`guest-xxxxxxx`) is created in `sessionStorage`.
- Conversations and message histories are saved to `localStorage` under `orvix_guest_chats`.
- Pinned chat IDs are stored in `localStorage` under `orvix_guest_pins`.
- Guest settings are stored in `localStorage` under `orvix_guest_settings`.
- Guest data persists across browser reloads and works completely offline.

---

## 7. Chat Modes, Voice & Customization

### Chat Modes Summary

| Mode | Short Name | Target Use Case | Mode Instruction Focus |
|---|---|---|---|
| `general` | General | Everyday Q&A, brainstorming | Balanced, helpful conversational assistant |
| `coding` | Coding | Debugging, architecture, algorithms | Clean code blocks, syntax tags, edge cases |
| `writing` | Writing | Drafting, tone adjustments, essays | Clarity, flow, structure, and polished prose |
| `learning` | Learning | Conceptual breakdowns, analogies | Step-by-step logic, intuitive comparisons |

### Voice & Speech Features
- **Speech-to-Text (Dictation)**: Uses browser `webkitSpeechRecognition` / `SpeechRecognition`. Includes speech timer, pause/resume, and punctuation sanitation via `src/utils/speechTextCleaner.js`.
- **Text-to-Speech (Audio)**: Uses browser `window.speechSynthesis`. Assistant bubbles include audio play/stop controls, speech rate adjustment, and voice selector in settings.

### Chat Export Formats
- **Markdown (`.md`)**: Preserves full conversation headers, timestamps, model tags, and formatted code blocks.
- **JSON (`.json`)**: Exports structured thread metadata and message array for programmatic backup.
- **Plain Text (`.txt`)**: Clean text transcript suitable for sharing or plain note storage.

---

## 8. Project Structure

```text
Orvix/
├── .env.example                  # Template for required and optional environment variables
├── .gitignore                    # Git ignored files and directories
├── README.md                     # Main project documentation (Orvix v0.1)
├── api/                          # Serverless function adapters (Express app proxy)
│   ├── chat.ts                   # /api/chat route handler adapter
│   ├── config.ts                 # /api/config route handler adapter
│   └── health.ts                 # /api/health route handler adapter
├── firebase-blueprint.json       # Schema definition for Firestore collections
├── firestore.rules               # Cloud Firestore security rules
├── index.html                    # Single-page application HTML entry
├── metadata.json                 # AI Studio applet capabilities and metadata
├── package.json                  # NPM packages, dependencies, and project scripts
├── public/                       # Static public assets (icons, manifest)
│   ├── apple-touch-icon.png
│   ├── favicon.ico
│   ├── favicon.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   └── manifest.webmanifest      # Progressive Web App manifest
├── server.ts                     # Full-stack Express server & AI streaming proxy
├── src/                          # Frontend source code
│   ├── App.jsx                   # Root application component & auth router
│   ├── main.jsx                  # React DOM initialization
│   ├── index.css                 # Global CSS entry importing Tailwind & Obsidian styles
│   ├── components/               # React UI components
│   │   ├── auth/
│   │   │   └── AuthScreen.jsx    # Email/password authentication & guest mode launcher
│   │   ├── chat/
│   │   │   ├── ChatArea.jsx      # Scrollable message viewport & message composer
│   │   │   ├── ChatMessage.jsx   # Message bubble, markdown, code copy & retry actions
│   │   │   ├── CodeBlock.jsx     # Syntax-highlighted code block with language tags
│   │   │   ├── ExportChatMenu.jsx# Export dropdown (Markdown, JSON, Plain Text)
│   │   │   ├── MessageList.jsx   # Virtualized message list with auto-scroll pinning
│   │   │   ├── ModeSelector.jsx  # Chat mode switcher (General, Coding, Writing, Learning)
│   │   │   ├── ModelSelector.jsx # AI provider switcher (Gemini, Groq, OpenRouter)
│   │   │   ├── PromptSuggestions.jsx # Starter prompt suggestion cards
│   │   │   ├── TypingIndicator.jsx   # Pulsing thinking/typing indicator
│   │   │   └── WelcomeScreen.jsx # Empty-state starter screen
│   │   ├── layout/
│   │   │   ├── Header.jsx        # Navigation bar, thread title, controls & user menu
│   │   │   ├── Layout.jsx        # Responsive shell managing sidebar collapse & drawer
│   │   │   ├── Sidebar.jsx       # Pinned & recent conversations, new chat, user footer
│   │   │   └── SidebarChatItem.jsx # Conversation row with pin, rename, delete actions
│   │   ├── settings/
│   │   │   └── SettingsModal.jsx # Preferences dialog (theme, response length, voice)
│   │   └── ui/
│   │       ├── Button.jsx        # Reusable button primitive with variants
│   │       └── OrvixLogo.jsx     # Vector brand logo component
│   ├── config/                   # Static configuration files
│   │   ├── appConfig.js          # Branding strings, defaults, and starter prompts
│   │   ├── chatModes.js          # Mode definitions, icons, prompts, and system prompts
│   │   ├── firebaseConfig.js     # Firebase SDK initialization & verification
│   │   └── sampleData.js         # Fallback demonstration conversation data
│   ├── context/                  # React context state providers
│   │   ├── AuthContext.jsx       # Authentication state, login, signup, guest mode
│   │   ├── SettingsContext.jsx   # Theme, model preferences, and user settings
│   │   └── SpeechContext.jsx     # Web Speech synthesis (TTS) state & playback
│   ├── hooks/                    # Custom React hooks
│   │   ├── usePWAInstall.js      # PWA beforeinstallprompt handler & install state
│   │   └── useVoiceDictation.js  # Web Speech recognition (STT) hook
│   ├── pages/                    # High-level page views
│   │   └── ChatPage.jsx          # Primary chat view orchestrating thread state & AI calls
│   ├── services/                 # Service & communication layer
│   │   ├── aiRouter.js           # Multi-provider client dispatcher & SSE reader
│   │   ├── authService.js        # Firebase Auth wrapper & error sanitizer
│   │   ├── chatStorageService.js # Firestore CRUD operations & batch deletions
│   │   ├── geminiService.js      # Gemini client fallback service
│   │   ├── groqService.js        # Groq client fallback service
│   │   ├── index.js              # Service module index
│   │   ├── mockChatService.js    # Simulated fallback response generator
│   │   ├── openrouterService.js  # OpenRouter client fallback service
│   │   ├── userProfileService.js # Firestore user profile persistence
│   │   └── userSettingsService.js# User preferences storage (Firestore & local)
│   ├── styles/                   # Design system styles
│   │   └── index.css             # Obsidian design system CSS variables and classes
│   └── utils/                    # Utility helper functions
│       ├── exportConversation.js # Exporters for .md, .json, and .txt formats
│       ├── speechTextCleaner.js  # Punctuation & spacing cleaner for voice input
│       └── syntaxHighlighter.js  # Code syntax highlighting token engine
├── tsconfig.json                 # TypeScript compiler configuration
├── vercel.json                   # Vercel deployment routes and build settings
└── vite.config.ts                # Vite build and development configuration
```

---

## 9. Important Files & Responsibilities

- **`server.ts`**: The central backend server. Sets up Express, mounts Vite in middleware mode during development, serves static assets in production, and provides the `/api/chat` streaming endpoint with provider-specific error handling and backoff retries.
- **`src/services/aiRouter.js`**: The frontend AI dispatch router. Coordinates calls to `/api/chat`, parses Server-Sent Events (SSE) data chunks, and triggers client callbacks for progressive rendering.
- **`src/pages/ChatPage.jsx`**: Coordinates active conversation state, message submission, streaming updates, Firestore synchronization, thread switching, and pinning limits.
- **`src/components/chat/ChatArea.jsx`**: Manages the message viewport, auto-scroll locking, markdown rendering, edit/resend flows, and the message composer dock with voice dictation.
- **`src/context/AuthContext.jsx`**: Provides authentication status across the app, supporting both Firebase registered users and zero-setup guest accounts.
- **`src/config/chatModes.js`**: Defines the four core conversational modes (General, Coding, Writing, Learning) along with their respective system instructions and starter prompts.
- **`src/services/chatStorageService.js`**: Manages all Cloud Firestore database queries, real-time `onSnapshot` subscriptions, batch deletion of message subcollections, and conversation renaming.

---

## 10. Environment Variables & Configuration

Create a `.env` file in the root directory by copying `.env.example`:

```bash
cp .env.example .env
```

### Environment Variable Reference

| Variable | Scope | Required? | Description |
|---|---|---|---|
| `PORT` | Server | Optional | Port for the Express server (defaults to `3000`). |
| `GEMINI_API_KEY` | Server | Optional | Google Gemini API key. Configured server-side for `@google/genai`. |
| `GROQ_API_KEY` | Server | Optional | Groq API key for high-speed inference. |
| `OPENROUTER_API_KEY` | Server | Optional | OpenRouter API key for dynamic open-weights models. |
| `VITE_FIREBASE_API_KEY` | Client | Optional | Firebase Web API key for authentication and Firestore. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Client | Optional | Firebase Auth Domain (e.g. `your-app.firebaseapp.com`). |
| `VITE_FIREBASE_PROJECT_ID` | Client | Optional | Firebase Project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET`| Client | Optional | Firebase Cloud Storage Bucket name. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID`| Client | Optional | Firebase Messaging Sender ID. |
| `VITE_FIREBASE_APP_ID` | Client | Optional | Firebase Web Application ID. |

### Safe `.env` Example

```env
# Server Configuration
PORT=3000

# Server-Side AI API Keys (Kept secure on backend)
GEMINI_API_KEY=your_gemini_api_key_here
GROQ_API_KEY=your_groq_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Firebase Client Configuration (Optional - for Cloud Persistence & Auth)
VITE_FIREBASE_API_KEY=your_firebase_api_key_here
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id
```

> **Security Note**: Never commit actual API keys or credentials to version control. AI keys placed under `GEMINI_API_KEY`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` are read exclusively by `server.ts` and are never exposed to client bundles.

---

## 11. Getting Started & Local Setup

### Prerequisites
- **Node.js**: Version `22.x` LTS recommended (compatible with `20.x`+).
- **npm**: Version `10.x` or higher.
- Modern web browser (Chrome, Edge, Firefox, or Safari).

### Step-by-Step Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Hannankhan203/Orvix.git
   cd Orvix
   ```

2. **Install project dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```
   Add any available API keys to `.env`. If no keys are provided, the app will run seamlessly in **Demo / Guest Mode** using high-quality simulated responses.

4. **Start the development server**:
   ```bash
   npm run dev
   ```

5. **Open the application**:
   Open [http://localhost:3000](http://localhost:3000) (or `http://0.0.0.0:3000`) in your browser.

---

## 12. Available Scripts & Commands

All commands are executed from the project root using `npm`:

| Command | Action | Description |
|---|---|---|
| `npm run dev` | `tsx server.ts` | Starts the Express server with Vite dev middleware on port 3000. |
| `npm run build` | `vite build` | Compiles client assets and outputs production bundles to `dist/`. |
| `npm start` | `node server.ts` | Runs the production server, serving compiled assets from `dist/`. |
| `npm run preview` | `vite preview` | Previews the compiled production build locally. |
| `npm run lint` | `tsc --noEmit` | Runs the TypeScript compiler to validate type safety across the project. |
| `npm run clean` | `rm -rf dist server.js` | Removes compiled artifacts and build outputs. |

---

## 13. Deployment

### Production Deployment (Node.js)
1. Ensure `NODE_ENV=production` is set in your environment.
2. Build the production bundle:
   ```bash
   npm run build
   ```
3. Start the production server:
   ```bash
   npm start
   ```
   The Express server listens on `0.0.0.0:3000`, exposes `/api/*` routes, and serves the frontend single-page application from `dist/` with HTML5 client-side routing fallback.

### Containerized Deployment (Docker / Cloud Run)
Orvix can be packaged and deployed in a container:

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

## 14. Current Limitations

- **Guest to Cloud Account Migration**: Conversations created in Guest Mode reside exclusively in browser `localStorage`. Signing up for an account later does not automatically import local guest threads to Cloud Firestore.
- **Database Pin Limit Enforcement**: The 5-pinned-chat constraint is validated in frontend state and Firestore service queries, but cannot be strictly enforced at the database security rule level due to Firestore rule aggregation limits.
- **Web Speech Browser Compatibility**: Voice dictation (Speech-to-Text) and Text-to-Speech audio depend on browser support for `SpeechRecognition` and `SpeechSynthesis`.
- **Automated Test Coverage**: The project currently uses `tsc --noEmit` for static validation; automated unit test suites (e.g., Vitest or Jest) are not yet integrated.

---

## 15. Planned / Future Features

The following capabilities are planned for upcoming releases:

- [ ] **Account Linking & Migration**: One-click import tool to transfer guest conversations into an authenticated Cloud Firestore account upon registration.
- [ ] **Multimodal File & Image Uploads**: Image, PDF, and text document attachments supported by Gemini multimodal models.
- [ ] **Full-Text Conversation Search**: Instant search bar in the sidebar to search across titles and message bodies.
- [ ] **Automated Test Suite**: Unit and integration test coverage with Vitest and React Testing Library.
- [ ] **Custom System Prompts**: User-defined custom instructions and personality presets in the settings modal.
- [ ] **Web Search Grounding**: Real-time Google Search grounding support for the Gemini provider.

---

## 16. Changelog

### v0.1
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

## 17. License

This project is maintained for personal and collaborative use. All rights reserved. Refer to the repository owner for licensing and distribution details.
