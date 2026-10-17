# Orvix

<p align="center">
  <strong>An Intelligent, Modern AI Conversation Companion</strong>
</p>

<p align="center">
  <img src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" alt="Orvix AI Banner" width="800" />
</p>

---

## 1. Project Overview

**Orvix** is a high-performance, responsive AI chatbot web application built with a modern React 19 single-page frontend, styled with an Obsidian Dark design system using Tailwind CSS, and backed by a dual-mode Node.js Express server.

Orvix provides seamless multi-model intelligence through three first-class AI providers:
- **Google Gemini** (Gemini 3.1 Flash Lite & Gemini 3.8 Flash) via the modern `@google/genai` TypeScript SDK.
- **Groq** (Llama 3.3 70B Versatile) via Groq's high-speed inference engine.
- **OpenRouter** (Dynamic Free Model Gateway) allowing access to open-weights models without friction.

The application supports complete multi-turn conversation threads, persistent Cloud Firestore storage with subcollections, real-time sync, an instant zero-friction Guest/Demo mode with browser storage fallback, markdown rendering with syntax-highlighted code blocks and one-click copying, inline conversation renaming, batch message deletion, and conversation pinning with a 5-chat limit.

---

## 2. Project Goals and Purpose

The primary goals of Orvix are:
1. **Multi-Model Flexibility**: Allow users to seamlessly switch between Google Gemini, Groq, and OpenRouter within the same application interface, comparing outputs while preserving the ongoing conversation history.
2. **Zero-Friction Access**: Provide a fully functional Guest Mode with mock authentication and local storage persistence so users can immediately test AI capabilities without mandatory registration or API keys.
3. **Secure Full-Stack Architecture**: Route AI generation and secret keys through a server-side Express proxy (`/api/chat`) while maintaining client-side fallbacks for standalone prototypes.
4. **Reliable Persistence**: Leverage Firebase Cloud Firestore to structure user conversations into parent chat documents and child message subcollections, protected by granular security rules.
5. **Modern, Distraction-Free UI**: Offer a clean obsidian dark aesthetic with collapsible navigation, auto-expanding message composer, starter prompt suggestions, and smooth loading states.

---

## 3. Key Features

- **Multi-Provider AI Routing**: Instant dropdown model switching between Google Gemini, Groq, and OpenRouter.
- **Full-Stack Backend Proxy**: Centralized `/api/chat` route protects API keys server-side, with automated graceful fallbacks.
- **Context-Aware Conversations**: Multi-turn history (up to the last 12 messages) is formatted and passed to each AI provider for conversational continuity.
- **Simulated Fallback Mode**: When API keys are not yet configured in the environment, the app generates high-quality simulated responses so the UI can be tested without interruption.
- **Rich Markdown & Code Highlighting**: Formats responses with `react-markdown` and `remark-gfm`, including language labels, copy buttons, responsive tables, blockquotes, and safe link handling.
- **Persistent Cloud Storage**: Organizes conversation metadata in `/users/{userId}/chats/{chatId}` and chronological message history in `/users/{userId}/chats/{chatId}/messages/{messageId}`.
- **Guest / Demo Mode**: Instant access with zero setup; conversations and pinned statuses are preserved across page reloads via `sessionStorage` and `localStorage`.
- **Conversation Pinning (5-Chat Limit)**: Pin up to 5 vital conversations to the top of the sidebar with dedicated visual indicators.
- **Inline Renaming & Deletion**: Rename any thread inline or trigger safe deletion with batch-write subcollection purging.
- **Automatic Smart Titles**: Derives clean, concise 36-character thread titles from the user's initial prompt.
- **Error Recovery & Prompt Restore**: Failed requests display inline error bubbles with one-click **Retry** and **Edit prompt** actions that restore the text to the composer.
- **Responsive Layout**: Collapsible sidebar with mobile overlay backdrop, custom slim scrollbars, and accessible keyboard navigation.

---

## 4. Detailed Explanation of the Three AI Providers

Orvix unifies three distinct AI providers through a standardized interface managed by `src/services/aiRouter.js` and the backend Express endpoint in `server.ts`.

```
                    ┌─────────────────────────┐
                    │      Client Browser     │
                    │   (selectedProvider)    │
                    └────────────┬────────────┘
                                 │ POST /api/chat
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

### A. Google Gemini
- **Service Handler**: `server.ts` (backend) / `src/services/geminiService.js` (client fallback).
- **SDK**: `@google/genai` (v2.4.0).
- **Configured Models**:
  - Primary: `gemini-3.1-flash-lite` (fast, efficient default).
  - Secondary / Fallback: `gemini-3.8-flash` (used if primary encounters 503 high traffic or 404).
- **Environment Variable**: `GEMINI_API_KEY` (server-side) or `VITE_GEMINI_API_KEY` (client).
- **Request Format**: Formats messages as `{ role: 'user' | 'model', parts: [{ text }] }`. System instruction specifies Orvix's conversational persona.
- **Fallback Behavior**: If no API key is provided, generates an in-memory simulated answer marked as `gemini-3.1-flash-lite (demo)`.

### B. Groq
- **Service Handler**: `server.ts` (backend) / `src/services/groqService.js` (client fallback).
- **API Endpoint**: `https://api.groq.com/openai/v1/chat/completions`.
- **Configured Model**: `llama-3.3-70b-versatile` (backend) / `openai/gpt-oss-120b` (client fallback).
- **Environment Variable**: `GROQ_API_KEY` (server-side) or `VITE_GROQ_API_KEY` (client).
- **Request Format**: Standard OpenAI-compatible format with `system`, `user`, and `assistant` messages, temperature set to 0.7.
- **Fallback Behavior**: If unconfigured, outputs demo responses with `modelUsed: 'Llama 3.3 70B (demo)'`.

### C. OpenRouter
- **Service Handler**: `server.ts` (backend) / `src/services/openrouterService.js` (client fallback).
- **API Endpoint**: `https://openrouter.ai/api/v1/chat/completions`.
- **Configured Model**: `openrouter/free` (OpenRouter's free router that dynamically routes queries across available high-capacity free community models).
- **Environment Variable**: `OPENROUTER_API_KEY` (server-side) or `VITE_OPENROUTER_API_KEY` (client).
- **Request Headers**: Passes `Authorization: Bearer <KEY>`, `X-Title: Orvix`, and `HTTP-Referer`.
- **Fallback Behavior**: If unconfigured, outputs demo responses with `modelUsed: 'openrouter/free (demo)'`.

### Context & Provider Switching Behavior
- All providers receive the last **12 conversation messages** formatted into their respective message schemas.
- Switching between providers does **not** erase, truncate, or reset existing conversation history. The next message sent will forward the prior thread messages regardless of which model created them.

---

## 5. Complete Technology Stack

### Core Runtime & Frameworks
| Dependency | Version | Role in Application |
|---|---|---|
| `react` | `^19.0.1` | Core UI component framework (React 19). |
| `react-dom` | `^19.0.1` | React DOM rendering for web browsers. |
| `express` | `^4.21.2` | Node.js backend server handling `/api/chat` proxy routes and static file serving. |
| `vite` | `^8.3.0` | Development server and production build bundler. |
| `tsx` | `^4.21.0` | TypeScript execution engine used to run `server.ts` directly in development. |
| `typescript` | `^7.0.2` | Type-checking and interface definitions. |

### AI Integration & SDKs
| Dependency | Version | Role in Application |
|---|---|---|
| `@google/genai` | `^2.4.0` | Official Google Gen AI TypeScript SDK for Gemini 3.1 Flash Lite and 3.8 Flash. |
| Native `fetch` | Built-in | Used for HTTP requests to Groq and OpenRouter OpenAI-compatible endpoints. |

### Database & Authentication
| Dependency | Version | Role in Application |
|---|---|---|
| `firebase` | `^13.0.0` | Client SDK providing Firebase Authentication (Email/Password) and Cloud Firestore persistence. |

### Styling, Icons & UI Utilities
| Dependency | Version | Role in Application |
|---|---|---|
| `tailwindcss` | `^4.3.3` | Utility-first CSS framework (v4). |
| `@tailwindcss/vite` | `^4.3.3` | Vite plugin for Tailwind CSS v4 compilation. |
| `lucide-react` | `^0.546.0` | Modern, consistent icon pack (Bot, User, Sparkles, Pin, Trash, Pencil, etc.). |
| `motion` | `^12.23.24` | Animation and motion primitives for smooth transitions. |
| `react-markdown` | `^10.1.0` | Markdown parser for rendering assistant output safely. |
| `remark-gfm` | `^4.0.1` | GitHub Flavored Markdown plugin (tables, autolinks, strikethrough, task lists). |
| `dotenv` | `^17.2.3` | Loads environment variables from `.env` into `process.env`. |

---

## 6. Application Architecture

```
┌────────────────────────────────────────────────────────┐
│                   React 19 Frontend                    │
│                                                        │
│   App.jsx                                              │
│     ├── AuthProvider (AuthContext.jsx)                 │
│     │     ├── AuthScreen.jsx (Sign in / Create acct)   │
│     │     └── ChatPage.jsx                             │
│     │           ├── Layout.jsx                         │
│     │           │     ├── Sidebar.jsx                  │
│     │           │     └── Header.jsx (ModelSelector)   │
│     │           └── ChatArea.jsx                       │
│     │                 ├── WelcomeScreen.jsx            │
│     │                 ├── MessageList.jsx              │
│     │                 │     └── ChatMessage.jsx        │
│     │                 └── Composer Dock                │
└───────────────────────────┬────────────────────────────┘
                            │
               HTTP Requests to /api/chat
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Express Backend                       │
│                                                        │
│   server.ts                                            │
│     ├── GET  /api/health                               │
│     ├── GET  /api/config                               │
│     ├── POST /api/chat                                 │
│     │     ├── Gemini Provider (@google/genai SDK)      │
│     │     ├── Groq Provider (OpenAI REST)              │
│     │     └── OpenRouter Provider (OpenAI REST)        │
│     └── Middleware                                     │
│           ├── Dev: Vite middleware mode (`npm run dev`)│
│           └── Prod: Express static serving ('dist/')   │
└───────────────────────────┬────────────────────────────┘
                            │
              Direct Client SDK Operations
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Google Firebase                       │
│     ├── Firebase Auth (Email/Password & Sessions)      │
│     └── Cloud Firestore                                │
│           ├── /users/{userId}/chats/{chatId}           │
│           └── .../messages/{messageId}                 │
└────────────────────────────────────────────────────────┘
```

1. **Development Mode**: `npm run dev` executes `tsx server.ts`. Express mounts Vite in middleware mode on port 3000, serving React hot-reloaded while listening on `/api/*` endpoints.
2. **Production Mode**: `npm run build` compiles client assets to `dist/`. `node server.ts` serves static assets from `dist/` with SPA fallback routing.
3. **Resilience Strategy**: If the Express backend proxy is unreachable, the client-side router (`aiRouter.js`) automatically falls back to browser-side API calls.

---

## 7. Project Directory Structure

```
.
├── .env.example                  # Environment variable reference template
├── .gitignore                    # Git ignore specifications
├── README.md                     # Complete project documentation
├── firebase-blueprint.json       # Blueprint schema definitions for Firestore
├── firestore.rules               # Cloud Firestore database security rules
├── index.html                    # Single-page HTML entry point
├── metadata.json                 # AI Studio applet metadata & capabilities
├── package.json                  # NPM dependencies, scripts, and package metadata
├── server.ts                     # Express server & /api/chat AI proxy implementation
├── tsconfig.json                 # TypeScript compiler configuration
├── vite.config.ts                # Vite bundler, alias, and dev server configuration
└── src/
    ├── App.jsx                   # Root application component & auth gatekeeper
    ├── index.css                 # Global CSS entry importing Tailwind & Obsidian styles
    ├── main.jsx                  # React DOM bootstrap entry point
    ├── components/
    │   ├── auth/
    │   │   └── AuthScreen.jsx    # Email/password authentication & guest mode launcher
    │   ├── chat/
    │   │   ├── ChatArea.jsx      # Scrollable message viewport & bottom composer dock
    │   │   ├── ChatMessage.jsx   # Message bubble rendering, Markdown, and code copy
    │   │   ├── MessageList.jsx   # Message collection container with auto-scroll pinning
    │   │   ├── ModelSelector.jsx # Header dropdown for Gemini, Groq, and OpenRouter
    │   │   ├── PromptSuggestions.jsx # Welcome screen starter prompt cards
    │   │   ├── TypingIndicator.jsx   # Thinking animation indicator
    │   │   └── WelcomeScreen.jsx     # Zero-state empty conversation screen
    │   ├── layout/
    │   │   ├── Header.jsx        # Navigation bar, thread title, model selector & logout
    │   │   ├── Layout.jsx        # Responsive shell managing sidebar collapse & backdrop
    │   │   ├── Sidebar.jsx       # Conversations list, pinned section & user profile
    │   │   └── SidebarChatItem.jsx # Chat item with pin, inline rename, and delete actions
    │   └── ui/
    │       └── Button.jsx        # Reusable styled button component
    ├── config/
    │   ├── appConfig.js          # App branding, constants, and starter prompt templates
    │   ├── firebaseConfig.js     # Firebase SDK initialization & config verification
    │   └── sampleData.js         # Visual demonstration mock conversation data
    ├── context/
    │   └── AuthContext.jsx       # Authentication state, login/signup/logout & guest mode
    ├── pages/
    │   └── ChatPage.jsx          # Main conversational coordinator & state orchestrator
    ├── services/
    │   ├── aiRouter.js           # Central dispatch routing prompts to the active AI provider
    │   ├── authService.js        # Dedicated Firebase Auth helper with error normalization
    │   ├── chatStorageService.js # Cloud Firestore CRUD operations, pinning, & batch delete
    │   ├── geminiService.js      # Google Gemini client fallback integration
    │   ├── groqService.js        # Groq client fallback integration
    │   ├── index.js              # Service module registry
    │   ├── mockChatService.js    # Local simulated response generator
    │   └── openrouterService.js  # OpenRouter client fallback integration
    └── styles/
        └── index.css             # Comprehensive Obsidian theme design system
```

---

## 8. Source Files and Their Responsibilities

### Root Configuration
- **`server.ts`**: Express application creating `/api/chat`, `/api/health`, and `/api/config`. Handles server-side calls to Gemini, Groq, and OpenRouter. In dev, mounts Vite middlewares; in production, serves static assets from `dist/`.
- **`vite.config.ts`**: Configures React plugin, Tailwind CSS v4, path alias (`@/*`), environment variable defines, and the dev server on `0.0.0.0:3000`.
- **`package.json`**: Defines scripts (`dev`, `build`, `start`, `preview`, `lint`), dependencies, and package metadata.
- **`firestore.rules`**: Production Firestore rules requiring authentication, checking resource ownership (`request.auth.uid == userId`), and validating data structure schemas and string bounds.

### React Application Entry & Shell
- **`src/main.jsx`**: Initializes the React 19 root into `#root`.
- **`src/App.jsx`**: Top-level gatekeeper. Renders a loading splash during initial auth checks, directs unauthenticated visitors to `AuthScreen`, and displays `ChatPage` for active users.
- **`src/context/AuthContext.jsx`**: Manages auth lifecycle (`currentUser`, `login`, `signup`, `logout`, `continueAsGuest`). Supports dual-key session storage compatibility.
- **`src/pages/ChatPage.jsx`**: Core state orchestrator. Subscribes to Firestore user chats, coordinates message dispatch, handles race conditions across rapid chat switching, persists messages, and manages pinning.

### UI Components
- **`src/components/layout/Layout.jsx`**: Manages the responsive layout container, collapsible sidebar, and mobile backdrop overlay.
- **`src/components/layout/Header.jsx`**: Top bar with sidebar toggle button, thread title breadcrumb, `ModelSelector` dropdown, "New Chat" button, user email, and logout.
- **`src/components/layout/Sidebar.jsx`**: Displays conversations divided into "Pinned (X/5)" and "Recent" sections, plus "New Chat" button and session status footer.
- **`src/components/layout/SidebarChatItem.jsx`**: Interactive chat row with inline renaming (input with Enter/Esc triggers), delete confirmation prompt, and pin toggle button.
- **`src/components/chat/ChatArea.jsx`**: Manages the main chat stream, zero-state `WelcomeScreen`, and the fixed bottom composer dock with auto-resizing textarea.
- **`src/components/chat/ChatMessage.jsx`**: Individual message bubble rendering user or assistant messages. Includes rich Markdown parsing, syntax-highlighted code with copy buttons, error bubbles with retry/edit actions, and model badges.
- **`src/components/chat/ModelSelector.jsx`**: Clean dropdown component allowing users to switch AI providers.
- **`src/components/chat/PromptSuggestions.jsx`**: Renders 4 starter prompt cards on the welcome screen.
- **`src/components/chat/TypingIndicator.jsx`**: Three-dot pulsing loading state when waiting for an AI response.
- **`src/components/ui/Button.jsx`**: Standardized button component with variants (`primary`, `secondary`, `ghost`, `outline`) and sizes.

### Service Modules
- **`src/services/aiRouter.js`**: Normalizes and dispatches prompts to `/api/chat` (or fallback client services). Exposes provider list and configuration checks.
- **`src/services/chatStorageService.js`**: Encapsulates all Firestore queries (`createChatDocument`, `saveChatMessage`, `renameConversation`, `deleteConversation`, `toggleChatPinned`, `subscribeToUserChats`, `loadConversationMessages`).
- **`src/services/geminiService.js`**: Client-side Gemini integration with automatic fallback from `gemini-3.1-flash-lite` to `gemini-3.8-flash`.
- **`src/services/groqService.js`**: Client-side Groq OpenAI-compatible fetch client.
- **`src/services/openrouterService.js`**: Client-side OpenRouter fetch client using `openrouter/free`.
- **`src/services/authService.js`**: Wraps Firebase Auth calls and translates technical error codes into readable text.

---

## 9. Prerequisites

Before installing and running Orvix, ensure you have:
- **Node.js**: Version 20.x or 22.x LTS (Node.js 22 is recommended).
- **npm**: Version 10.x or higher (included with Node.js).
- Modern web browser with JavaScript enabled (Chrome, Safari, Firefox, Edge).
- *(Optional)* A Google Cloud or Firebase project for cloud persistence.
- *(Optional)* API keys for Google Gemini, Groq, or OpenRouter.

---

## 10. Installation Instructions

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Hannankhan203/text.git orvix
   cd orvix
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file based on the provided template:
   ```bash
   cp .env.example .env
   ```

---

## 11. Local Development Setup

To start the local development server:

```bash
npm run dev
```

The server will start on `http://localhost:3000` (or `http://0.0.0.0:3000`).

- The development server runs `tsx server.ts`.
- Express runs the API endpoints on `/api/*` and mounts Vite in middleware mode for instant frontend updates.
- If no API keys or Firebase variables are supplied, Orvix automatically boots in **Guest / Demo Mode** with simulated AI responses.

---

## 12. Environment Variables

The table below lists all supported environment variables.

| Variable Name | Required? | Location | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Optional | Server | Google Gemini API key used by the backend Express proxy. |
| `GROQ_API_KEY` | Optional | Server | Groq API key used by the backend Express proxy. |
| `OPENROUTER_API_KEY` | Optional | Server | OpenRouter API key used by the backend Express proxy. |
| `VITE_GEMINI_API_KEY` | Optional | Client/Build | Gemini API key for client-side direct fallback requests. |
| `VITE_GROQ_API_KEY` | Optional | Client/Build | Groq API key for client-side direct fallback requests. |
| `VITE_OPENROUTER_API_KEY` | Optional | Client/Build | OpenRouter API key for client-side direct fallback requests. |
| `VITE_FIREBASE_API_KEY` | Optional | Client/Build | Firebase Web API key. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Optional | Client/Build | Firebase Auth Domain (e.g., `project-id.firebaseapp.com`). |
| `VITE_FIREBASE_PROJECT_ID` | Optional | Client/Build | Firebase Project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET`| Optional | Client/Build | Firebase Cloud Storage Bucket name. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Optional | Client/Build | Firebase Cloud Messaging sender ID. |
| `VITE_FIREBASE_APP_ID` | Optional | Client/Build | Firebase Web Application ID. |
| `PORT` | Optional | Server | Server port (defaults to `3000`). |

> **IMPORTANT SECURITY NOTE**: Any variable prefixed with `VITE_` is baked into client-side JavaScript bundles by Vite during build time. For production deployments, configure API keys on the server (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`) so secrets remain strictly on the backend.

---

## 13. Safe `.env` Configuration Example

```ini
# ==============================================================================
# Orvix Environment Configuration
# Use real keys in your private environment. NEVER commit real secrets to Git.
# ==============================================================================

# Server-Side AI API Keys (Recommended for security)
GEMINI_API_KEY=AIzaSyExampleKeyForGeminiOnly
GROQ_API_KEY=gsk_ExampleKeyForGroqInference
OPENROUTER_API_KEY=sk-or-v1-ExampleOpenRouterKey

# Optional Client-Side Direct AI Keys (Used only if backend is bypassed)
VITE_GEMINI_API_KEY=
VITE_GROQ_API_KEY=
VITE_OPENROUTER_API_KEY=

# Firebase Client Configuration (Required for cloud authentication and database sync)
VITE_FIREBASE_API_KEY=AIzaSyExampleFirebaseWebApiKey
VITE_FIREBASE_AUTH_DOMAIN=orvix-app.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=orvix-app
VITE_FIREBASE_STORAGE_BUCKET=orvix-app.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef1234567890

# Server Runtime
PORT=3000
NODE_ENV=development
```

---

## 14. Firebase Project Setup

To enable user registration and persistent cloud storage across devices:

1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Add Project**.
2. Name your project (e.g., `orvix-ai`).
3. Under **Project Settings** > **General**, click **Add app** (select Web `</>`).
4. Register your web app and copy the `firebaseConfig` properties into your `.env` file under the matching `VITE_FIREBASE_*` variables.
5. In the left navigation, click **Authentication** > **Get Started**, then enable **Email/Password** provider.
6. In the left navigation, click **Firestore Database** > **Create Database** (choose a region close to your users).
7. Deploy the provided `firestore.rules` (see section 16).

---

## 15. Firebase Authentication Configuration

Orvix implements Email and Password authentication via `firebase/auth`:
- **Registration**: Calls `signupWithEmail(email, password)` which invokes `createUserWithEmailAndPassword`.
- **Sign In**: Calls `loginWithEmail(email, password)` which invokes `signInWithEmailAndPassword`.
- **Sign Out**: Calls `logout()` which invokes `signOut` and clears guest session keys.
- **State Listener**: Subscribes to `onAuthStateChanged` to restore sessions automatically on refresh.
- **Error Formatting**: `formatAuthError` maps Firebase codes (e.g., `auth/email-already-in-use`, `auth/wrong-password`) to clean error messages while stripping any raw API tokens.

---

## 16. Firestore Configuration and Security Considerations

### Document Structure
```
/users/{userId}
  └── /chats/{chatId}
        ├── id: string
        ├── title: string
        ├── userId: string
        ├── createdAt: timestamp
        ├── updatedAt: timestamp
        ├── isPinned: boolean (optional)
        ├── pinnedAt: timestamp (optional)
        └── /messages/{messageId}
              ├── id: string
              ├── sender: "user" | "assistant"
              ├── content: string
              ├── modelUsed: string | null
              ├── createdAt: timestamp
              └── clientTimestamp: string
```

### Security Rules Audit
The repository includes `firestore.rules` enforcing strict ownership:
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthenticated() { return request.auth != null; }
    function isOwner(userId) { return isAuthenticated() && request.auth.uid == userId; }

    match /users/{userId} {
      allow read, write: if false; // Deny direct user document access

      match /chats/{chatId} {
        allow read, delete: if isOwner(userId);
        allow create, update: if isOwner(userId)
          && request.resource.data.userId == userId
          && request.resource.data.title.size() > 0
          && request.resource.data.title.size() <= 120;

        match /messages/{messageId} {
          allow read, delete: if isOwner(userId);
          allow create, update: if isOwner(userId)
            && request.resource.data.sender in ['user', 'assistant']
            && request.resource.data.content.size() > 0
            && request.resource.data.content.size() <= 100000;
        }
      }
    }
  }
}
```

> **Security Rule Constraint Note**: While the rules enforce that `isPinned` must be a boolean, Firestore security rules do not support aggregate count queries. As a result, the **5-pinned-chat limit is enforced at the application/service layer**, not by Firestore security rules directly.

---

## 17. Gemini API Configuration

1. Obtain a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Set `GEMINI_API_KEY=your_key` in `.env`.
3. In `server.ts`, the server initializes `@google/genai`:
   ```typescript
   const ai = new GoogleGenAI({ apiKey });
   ```
4. The system requests `gemini-3.1-flash-lite` with a fallback to `gemini-3.8-flash` in case of high traffic (HTTP 503).

---

## 18. Groq API Configuration

1. Obtain an API key from the [Groq Console](https://console.groq.com/keys).
2. Set `GROQ_API_KEY=your_key` in `.env`.
3. Groq uses standard OpenAI-compatible endpoints with ultra-fast latency.
4. Configured model: `llama-3.3-70b-versatile` with temperature 0.7.

---

## 19. OpenRouter API Configuration

1. Obtain an API key from [OpenRouter](https://openrouter.ai/keys).
2. Set `OPENROUTER_API_KEY=your_key` in `.env`.
3. Configured model: `openrouter/free`. OpenRouter dynamically routes queries to available free community models without requiring paid credits.

---

## 20. Chat History and Data-Persistence Behavior

1. **New Chat Creation**: Clicking "New Chat" resets the viewport immediately in memory. A document is only created in Firestore when the user actually submits their first prompt.
2. **Subcollection Writes**: Messages are saved as individual documents in `messages` subcollections. This prevents documents from exceeding Firestore's 1MB single-document size limit.
3. **Atomic Batch Deletion**: When a user deletes a conversation, `deleteConversation` queries all messages in the subcollection, chunks deletions into batches of 400 (well within Firestore's 500-write batch limit), commits the message batch, and then deletes the parent chat document.
4. **Real-time Synchronization**: `subscribeToUserChats` uses `onSnapshot` to automatically reflect new conversations, renames, and pins across tabs in real-time.

---

## 21. Guest-Mode Behavior

Orvix features an immediate **Continue as Guest (Demo Mode)** workflow:
- **No Credentials Needed**: Users can explore the app immediately without Firebase configuration or account creation.
- **Session Identity**: Creates an anonymous user profile `{ uid: 'guest-xxxxxxx', email: 'guest@orvix.ai', displayName: 'Guest Explorer', isAnonymous: true }` saved in `sessionStorage`.
- **Local Persistence**: Guest conversations and messages are persisted in browser `localStorage` (`orvix_guest_chats`). Pinned chat IDs are stored in `localStorage` (`orvix_guest_pins`).
- **Page Refresh Resilience**: Guest sessions and messages survive page refreshes and browser tab navigation.
- **Scope & Limitations**: Guest data is strictly client-local. It does not synchronize across different devices or browsers, and there is currently no automated account migration to convert guest history into an authenticated account upon signing up.

---

## 22. Pinned Chats and the Five-Chat Limit

- **Pinning Action**: Users can click the Pin icon on any chat item in the sidebar.
- **Dedicated UI Group**: Pinned conversations are elevated into a dedicated **Pinned (X/5)** section at the top of the sidebar.
- **Five-Chat Constraint**:
  - Validated in the frontend (`ChatPage.jsx`): If 5 chats are already pinned, attempting to pin a 6th chat immediately triggers a warning banner: *"You can pin up to 5 chats. Unpin a chat before pinning another."*
  - Validated in the Firestore service layer (`chatStorageService.js`): Checks active pinned count via query before executing the document update.
  - In Guest Mode, the 5-chat limit is equally enforced in local state and `localStorage`.

---

## 23. Available NPM Scripts

| Command | Script Definition | What It Does |
|---|---|---|
| `npm run dev` | `tsx server.ts` | Starts the Express server with Vite in middleware mode on port 3000. |
| `npm run build` | `vite build` | Compiles and bundles production frontend assets into the `dist/` directory. |
| `npm start` | `node server.ts` | Starts the production server, serving compiled assets from `dist/`. |
| `npm run preview`| `vite preview` | Previews the production build locally via Vite. |
| `npm run clean` | `rm -rf dist server.js` | Cleans the build directory. |
| `npm run lint` | `tsc --noEmit` | Runs the TypeScript compiler in dry-run mode to validate type safety. |

---

## 24. How to Run the Development Server

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev
```

Visit `http://localhost:3000` in your browser.

---

## 25. How to Build the Production Version

```bash
# Compile client assets into dist/
npm run build
```

The output bundle will be generated in `dist/`.

---

## 26. How to Preview the Production Build

```bash
# Run Vite preview server
npm run preview
```

---

## 27. Testing Instructions

- **Static Type Validation**:
  ```bash
  npm run lint
  ```
  This command executes `tsc --noEmit` to verify type safety across the entire application without emitting output files.
- **Unit / End-to-End Tests**:
  There are currently no automated unit test frameworks (such as Jest or Vitest) configured in `package.json`. Testing is performed via static type checking and manual integration verification.

---

## 28. Deployment Instructions

### Production Deployment with Node.js
1. Set `NODE_ENV=production` in your deployment environment.
2. Build the client application:
   ```bash
   npm run build
   ```
3. Start the application:
   ```bash
   npm start
   ```
   In production, `server.ts` statically serves files from `dist/` and routes all non-API paths to `dist/index.html`.

### Docker / Cloud Run Hosting
Orvix can be deployed to containerized platforms like Google Cloud Run:
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
ENV PORT=3000
CMD ["npm", "start"]
```

---

## 29. Troubleshooting Common Setup and Runtime Errors

### 1. `Firebase is not configured` Banner
- **Cause**: Environment variables `VITE_FIREBASE_*` are missing or contain placeholder values.
- **Solution**: Either click **Continue as Guest (Demo Mode)** to use Orvix locally without Firebase, or provide valid project credentials in `.env`.

### 2. `Invalid or unauthorized Gemini API key`
- **Cause**: The `GEMINI_API_KEY` provided is expired, invalid, or lacks Generative Language API access.
- **Solution**: Generate a fresh key at [Google AI Studio](https://aistudio.google.com/app/apikey) and restart the server.

### 3. `Groq rate limit or quota exceeded` (HTTP 429)
- **Cause**: You exceeded the free tier RPM (requests per minute) or TPM limit on Groq.
- **Solution**: Wait a few moments, or switch to Gemini or OpenRouter via the header dropdown.

### 4. `OpenRouter request failed (402/429)`
- **Cause**: Credit exhaustion or temporary rate limits on OpenRouter.
- **Solution**: Orvix uses `openrouter/free` by default; ensure your key is valid and has free-tier routing permissions enabled.

### 5. `You can pin up to 5 chats. Unpin a chat before pinning another.`
- **Cause**: You attempted to pin a 6th conversation.
- **Solution**: Unpin one of your currently pinned chats by clicking its gold pin icon before pinning a new one.

---

## 30. Security Considerations

1. **Client-Side API Key Exposure Warning**: Any environment variable prefixed with `VITE_` is visible in client-side bundles. Always prefer setting server-side variables (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`) so secrets remain exclusively on the Node.js backend.
2. **Secret Redaction**: Error handlers in `authService.js` and `geminiService.js` run regex masking over error messages to prevent Google API keys or bearer tokens from appearing in UI alerts.
3. **Safe Markdown Rendering**: `ChatMessage.jsx` explicitly inspects markdown links to block `javascript:` URI schemes and adds `rel="noopener noreferrer"` to external links.
4. **Firestore Rules Lockdown**: All Firestore document accesses require authenticated ownership (`request.auth.uid == userId`). Direct access to `/users/{userId}` is locked down.

---

## 31. Known Limitations and Incomplete Features

- **No Guest-to-Account Migration**: If a user creates chats in Guest Mode and later signs up with an email account, the guest conversations are not automatically transferred to their new account.
- **Client-Side Pin Limit**: The 5-pinned-chat constraint is validated in frontend state and client-side Firestore queries, but not at the database rule level due to Firestore rule constraints.
- **No Automated Test Runner**: The project currently relies on `tsc --noEmit` for validation; no Jest or Vitest test suites are currently included.
- **No Multi-Device Sync for Guests**: Guest chats exist only in the local browser's `localStorage`.

---

## 32. Future Improvements (Suggestions)

- [ ] **Account Linking**: Provide a 1-click migration prompt allowing guest users to import local conversations when signing up.
- [ ] **Streaming Responses (SSE)**: Implement Server-Sent Events on `/api/chat` for token-by-token streaming responses.
- [ ] **File / Image Uploads**: Add multimodal support for uploading PDFs and images to Gemini.
- [ ] **Search Filter**: Add an instant search bar in the sidebar to search conversation titles and message contents.
- [ ] **Automated Test Suite**: Introduce Vitest and React Testing Library for end-to-end component testing.

---

## 33. Contribution Guidelines

Contributions to Orvix are welcome:
1. Fork the repository and create a feature branch (`git checkout -b feature/amazing-feature`).
2. Run `npm run lint` to verify that there are no type errors.
3. Commit your changes with clear, descriptive commit messages.
4. Push your branch and open a Pull Request.

---

## 34. License Information

No explicit software license file (`LICENSE`) is present in this repository. All rights are reserved by the original author. For licensing inquiries, please contact the repository owner.
