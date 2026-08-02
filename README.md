# 👁️ VisioOd API

**AI-Powered Ophthalmic Annotation & Differential Diagnosis**

A 3-tier architecture where **Frontend A** (your app) sends an encrypted token + image to **Frontend B** (mediator), which decrypts the token and triggers **Frontend C** (GitHub Action) that calls Composio MCP (Gemini Nano Banana).

## Architecture (A → B → C)

```
┌─────────────┐        ┌─────────────────┐        ┌──────────────────┐
│ Frontend A  │        │   Frontend B    │        │   Frontend C     │
│ (your app)  │        │  (mediator)     │        │ (GitHub Action)  │
│             │        │                 │        │                  │
│ - User UI   │ postMsg │ - Decrypts key │  API   │ - Calls Composio │
│ - Encrypts  │ ──────▶ │ - Has GitHub   │ ─────▶ │   MCP (Gemini)   │
│   Composio  │        │   PAT (hidden)  │        │ - Runs pipeline  │
│   key       │        │ - Triggers C    │        │ - Returns result │
│             │        │ - Polls result  │        │                  │
└─────────────┘        └─────────────────┘        └──────────────────┘
      │                         │                         │
      │         result          │  artifact download      │
      ◀─────────────────────────◀─────────────────────────│
```

### What each part holds

| Component | Has | Exposed to user? |
|-----------|-----|------------------|
| **Frontend A** | Shared passphrase + encrypted Composio key | ✅ Public (static site) |
| **Frontend B** | GitHub PAT (obfuscated) + shared passphrase | ✅ Public (static site) |
| **Frontend C** | Decrypted Composio key (passed as input, in-memory only) | ❌ Runs on GitHub Actions |

**The real Composio key is encrypted in A, decrypted in B, passed to C as a workflow input.** The GitHub PAT lives only in B. Neither token appears in plaintext in network traffic between A and B.

## Quick Start

### 1. Deploy Frontend B (mediator)

Push `frontend-b/index.html` to GitHub Pages (or any static host). It's already in this repo at `frontend-b/`.

If using GitHub Pages, enable it in **Settings → Pages → Source: main branch / root**. Your URL will be:
```
https://focusIinks.github.io/VisioOd/frontend-b/
```

### 2. Deploy Frontend A (your app)

`frontend-a/index.html` is a complete example. To use it:

1. Open `frontend-a/index.html` in your browser
2. Open the browser console and generate the encrypted token:
   ```js
   await window.encryptToken("ck_yVuv7G4i6PxmqI5xNVA_")
   ```
3. Copy the output and paste it into the `ENCRYPTED_TOKEN` constant in `frontend-a/index.html`
4. Update the `mediatorFrame` `src` to point to your Frontend B URL
5. Deploy to any static host

### 3. Use it

Open Frontend A → upload ocular image → click **Analyze**. The flow:

1. **A** encrypts the Composio key (AES-GCM with shared passphrase)
2. **A** sends `{ encrypted_token, image_base64, ... }` to **B** via `postMessage` (hidden iframe)
3. **B** decrypts the token using the shared passphrase
4. **B** triggers the GitHub Action (**C**) via the GitHub API (using the embedded PAT)
5. **C** receives the decrypted Composio key as a workflow input, calls Composio MCP → Gemini
6. **C** uploads the result as an artifact
7. **B** polls for completion, downloads the artifact, extracts `result.json`
8. **B** sends the result back to **A** via `postMessage`
9. **A** displays the annotated image + diagnosis

## Project Structure

```
VisioOd/
├── frontend-a/           # Frontend A — your app (static HTML)
│   └── index.html        # Encrypts token, sends to B via postMessage
├── frontend-b/           # Frontend B — mediator (static HTML)
│   └── index.html        # Decrypts token, calls GitHub API, returns result
├── .github/workflows/
│   └── vision.yml        # Frontend C — GitHub Action (calls Composio MCP)
├── src/                  # Worker scripts (run inside GitHub Actions)
│   ├── mcp-client.js     # Composio MCP client
│   ├── vision.js         # Annotation pipeline
│   └── prompts.js        # Clinical prompts
└── README.md
```

## Security Notes

- **Shared passphrase** (`visiood-2026-ophthalmic-annotation`) — used for AES-GCM encryption. Must be the same in A and B. Change it to your own.
- **GitHub PAT** — embedded in Frontend B (base64-obfuscated). Anyone can decode it, so use a **fine-grained PAT** with only `actions:write` on the VisioOd repo.
- **Composio key** — encrypted in A, decrypted in B, passed to C. Never appears in plaintext between A and B.
- **No server** — everything runs in the browser (A and B) and GitHub Actions (C).

## Customizing

- **Change the passphrase**: Update `SHARED_PASSPHRASE` in both `frontend-a/index.html` and `frontend-b/index.html`
- **Change the GitHub PAT**: Update the `GITHUB_PAT` line in `frontend-b/index.html` (base64-encode your new PAT)
- **Change the repo**: Update `GITHUB_REPO` in `frontend-b/index.html`
- **Add endpoints**: Add new workflows in `.github/workflows/` and handle them in `frontend-b/index.html`

## License

MIT
