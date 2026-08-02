# 👁️ VisioOd API

**AI-Powered Ophthalmic Annotation & Differential Diagnosis API**

A serverless API architecture where a **static frontend** calls a **Cloudflare Worker mediator**, which securely triggers **GitHub Actions workers** that talk to **Composio MCP** (Gemini Nano Banana) to validate, annotate, and diagnose ocular images.

## Architecture

```
Static Frontend (GitHub Pages)
    │  POST /vision { image_base64, mode, ... }
    │  (no tokens — just the mediator URL)
    ▼
Cloudflare Worker (Mediator)
    │  holds GITHUB_TOKEN + COMPOSIO_API_KEY as secrets
    │  triggers workflow_dispatch
    ▼
GitHub Actions (VisioOd repo)
    │  runs vision.js worker
    │  calls Composio MCP → Gemini Nano Banana
    │  uploads result.json artifact
    ▼
Cloudflare Worker downloads artifact → returns result to frontend
```

**No tokens are ever exposed to the browser.** The frontend only knows the mediator URL.

## Quick Start

### 1. Deploy the Mediator (Cloudflare Worker)

```bash
cd worker
npm install

# Set secrets (one-time)
npx wrangler secret put GITHUB_TOKEN        # your GitHub PAT (repo+workflow scope)
npx wrangler secret put COMPOSIO_API_KEY    # your Composio key (ck_...)
npx wrangler secret put API_KEY             # optional: shared secret for frontend auth

# Deploy
npx wrangler deploy
```

You'll get a URL like: `https://visiood-mediator.your-subdomain.workers.dev`

### 2. Deploy the Static Frontend (GitHub Pages)

The frontend is in `frontend/index.html`. To deploy:

1. Edit `frontend/index.html` — set `MEDIATOR_URL` to your worker URL (and `API_KEY` if you set one)
2. Push to the `docs/` folder (or enable GitHub Pages on the repo)
3. Your frontend is live at `https://focusIinks.github.io/VisioOd/`

### 3. Use It

Open the frontend URL, upload an ocular image, click **Analyze Image**. The pipeline:
1. **Validate** — checks if the image is ocular
2. **Annotate** — overlays clinical findings (red/yellow/green markers)
3. **Diagnose** — generates a structured differential diagnosis report

## API Reference (Mediator Endpoints)

### `POST /vision` — Trigger Annotation Pipeline

```bash
curl -X POST https://visiood-mediator.YOUR-SUBDOMAIN.workers.dev/vision \
  -H "content-type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "image_base64": "...",
    "mime_type": "image/png",
    "mode": "all",
    "clinical_context": "45yo male, redness OD",
    "image_name": "eye.jpg"
  }'
```

**Response:** `{ "ok": true, "runId": 12345678 }`

### `GET /status?runId=X` — Poll Run Status

```bash
curl "https://visiood-mediator.YOUR-SUBDOMAIN.workers.dev/status?runId=12345678" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:** `{ "ok": true, "status": "completed", "conclusion": "success" }`

### `GET /result?runId=X` — Get Result

```bash
curl "https://visiood-mediator.YOUR-SUBDOMAIN.workers.dev/result?runId=12345678" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**
```json
{
  "ok": true,
  "result": {
    "success": true,
    "steps": {
      "validation": { "isOcular": true, "message": "Ocular image confirmed." },
      "annotation": { "imageUrl": "https://temp...r2.cloudflarestorage.com/..." },
      "diagnosis": { "text": "1) Image quality assessment..." }
    }
  }
}
```

## Project Structure

```
VisioOd/
├── worker/                # Cloudflare Worker (mediator)
│   ├── index.js           # Worker code (handles /vision, /status, /result)
│   ├── wrangler.toml      # Cloudflare config
│   └── package.json
├── frontend/              # Static frontend (GitHub Pages)
│   └── index.html         # Pure HTML/JS — no build step
├── .github/workflows/
│   ├── vision.yml         # /vision GitHub Actions worker
│   ├── tools.yml          # /tools GitHub Actions worker
│   └── docs.yml           # Deploys docs to GitHub Pages
├── src/                   # Worker scripts (run inside GitHub Actions)
│   ├── mcp-client.js      # Composio MCP client
│   ├── vision.js          # Annotation pipeline
│   ├── tools.js           # Tools lister
│   └── prompts.js         # Clinical prompts
├── docs/                  # API documentation website
└── README.md
```

## Security Model

| Component | Has Access To | Exposed to Browser? |
|-----------|--------------|---------------------|
| Static Frontend | Mediator URL only | ✅ (safe) |
| Cloudflare Worker | GITHUB_TOKEN, COMPOSIO_API_KEY | ❌ (secrets) |
| GitHub Actions | COMPOSIO_API_KEY (repo secret) | ❌ (secrets) |
| Composio MCP | Your Composio account | ❌ (server-side only) |

**The frontend never sees any token.** It only calls the mediator URL. The mediator uses its server-side secrets to trigger GitHub Actions and download results.

## Adding New Endpoints

1. Add a worker script in `src/` (e.g., `src/screening.js`)
2. Add a workflow in `.github/workflows/` (e.g., `screening.yml`)
3. Add a route in `worker/index.js` (e.g., `POST /screening`)
4. Document it in `docs/index.html`

## License

MIT
