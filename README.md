# Radio Play: AI Co-Authoring & Performance Web App

A modernized, lightweight rewrite of the `writing-tool` co-authoring application built using **Vite + React** on the frontend and an **ES Module Node.js server** on the backend.

It eliminates the old `p5.js`, `p5.dom`, and `p5.speech` dependencies, replacing them with native Web APIs and modern React state-driven components. 

Following a clean, minimalist design principle, it features a **monochrome, high-contrast user interface** (no glassmorphism or unnecessary colors) supporting both **Light** and **Dark** themes.

---

## Architecture

```
Browser (Vite + React Frontend)            Node.js (ES Module Backend)
───────────────────────────────            ───────────────────────────
src/App.jsx                                server.js
src/App.css            ←─ socket.io ──►   · serves static files (dist/)
src/utils/stringMatch.js                  · syncs script between clients
                                          · proxies LLM prompts → Ollama

                                           Ollama (Local LLM)
                                           · http://localhost:11434
                                           · model: gemma4:e2b (default)
```

Speech tracking runs **entirely in the browser**:
- **Web Speech API**: handles transcription of microphone input.
- **Myers Approximate String Matching**: performs fuzzy text searching locally (`src/utils/stringMatch.js`) from the current cursor position.
- **Sequential Forward Cursor**: maintains track of progress through the script without jumping backwards.

---

## Prerequisites

1. **Node.js** (v18+)
2. **Ollama** (locally installed and running: `ollama serve`)
3. Pull the default model:
   ```bash
   ollama pull gemma4:e2b
   ```

---

## Setup

1. **Install dependencies**:
   ```bash
   cd dynamic-script
   npm install
   ```

2. **Configure the LLM** (Optional):
   Create/modify the `.env` file in the root of the `dynamic-script` folder:
   ```env
   # Ollama endpoint
   OLLAMA_URL=http://localhost:11434/v1

   # Model name — must be pulled with `ollama pull <name>` first
   OLLAMA_MODEL=gemma4:e2b
   ```

---

## How to Run the Program

### Option A: Development Mode (Parallel Servers)
Recommended when editing the React application code. Provides Hot Module Replacement (HMR).

1. **Start the Backend Server** (Terminal Tab 1):
   ```bash
   npm run server
   ```
   *This starts the Socket.io and Ollama proxy server on port `8080`.*

2. **Start the Vite Frontend** (Terminal Tab 2):
   ```bash
   npm run dev
   ```
   *This starts the Vite dev server on port `5173`. WebSocket traffic is automatically proxied to `localhost:8080`.*

3. Open **`http://localhost:5173`** in your browser (Chrome/Safari have the best Web Speech support).

### Option B: Production Mode (Single Port)
Compiles React code into optimized assets and runs everything under a single port.

1. **Build the Frontend Bundle**:
   ```bash
   npm run build
   ```

2. **Start the Server**:
   ```bash
   npm start
   ```
   *This serves the frontend static build and handles Socket.io connections under port `8080`.*

3. Open **`http://localhost:8080`** in your browser.

---

## User Interaction Guide

- **Selection**: Click once on any block to select it.
- **Inline Editing**: Click once on a text paragraph or a generative completion to edit its text directly inline. Focus out (`onBlur`) to save and broadcast changes.
- **Prompt Panel**: Click once on an AI Generatable block (in gray/dotted) to load its prompt into the Prompt Panel at the right, where it can be edited.
- **LLM Generation**: Double-click an AI Generatable block or click **Generate** in the Prompt Panel to run an LLM completion.
- **Shift + Click**: Click a generative block while holding Shift to toggle between its prompt text and its completion text inline.
- **Track Voice**: Toggle the voice tracker button to start speech recognition. As you speak, the matching block in the script will be highlighted and scrolled into view.
- **Broadcast**: Toggle the Broadcast switch to sync script edits and completions to other connected client interfaces in real time.
- **Script Management**: Use the Import/Export buttons to upload JSON scripts or download the current script version.
