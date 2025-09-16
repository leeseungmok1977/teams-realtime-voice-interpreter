# Teams Realtime Voice Interpreter (GPT Realtime API)
**Goal:** Microsoft Teams meeting side panel app that performs *voice → voice* live interpretation (no text UI).  
Stack: **Teams Tab (meeting side panel)** + **WebRTC ↔ OpenAI Realtime** + **Node/Express** (ephemeral session).

## Quick Start
1) **Server**
   ```bash
   cd server
   cp .env.example .env   # fill OPENAI_API_KEY
   npm i
   npm run dev            # http://localhost:3000
   ```
2) **Client (served statically by server in this template)**
   - Open http://localhost:3000 to test in a normal browser first.
3) **Teams**
   - Update `teams-app/manifest.json` (AAD App ID, URLs) and sideload into Teams (Developer Portal).
   - Use the meeting side panel to run the app.

> This template is minimal and focused on **audio-only interpreting**.
