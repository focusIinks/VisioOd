# 👁️ VisioOd API

**AI-Powered Ophthalmic Annotation & Differential Diagnosis API**

A serverless API that runs entirely on GitHub Actions. Each endpoint is a workflow worker that talks to the [Composio MCP](https://mcp.composio.dev) server to validate, annotate, and diagnose ocular images using Google's Gemini Nano Banana model.

## How It Works

```
Your Frontend  →  GitHub Actions API (trigger workflow)  →  VisioOd Worker  →  Composio MCP  →  Gemini Nano Banana  →  Result Artifact
```

- **No server to maintain** — runs on GitHub Actions
- **Separable frontend** — your existing app calls this API via the GitHub REST API
- **Extensible** — add new endpoints by dropping in a workflow + worker script

## Setup

### 1. Add the Composio API key as a repository secret

Go to **Settings → Secrets and variables → Actions → New repository secret**:
- Name: `COMPOSIO_API_KEY`
- Value: your Composio API key (e.g., `ck_yVuv7G4i6PxmqI5xNVA_`)

### 2. Enable GitHub Pages (for the API docs)

Go to **Settings → Pages → Source: GitHub Actions**. The docs workflow will deploy automatically on push to `main`.

## API Endpoints

### `POST /vision` — Ophthalmic Annotation Pipeline

```bash
curl -X POST \
  -H "Authorization: token ghp_YOUR_GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/focusIinks/VisioOd/actions/workflows/vision.yml/dispatches \
  -d '{
    "ref": "main",
    "inputs": {
      "image_base64": "'"$(base64 -w0 eye.jpg)"'",
      "mime_type": "image/jpeg",
      "mode": "all",
      "clinical_context": "45yo male, 3-day redness OD",
      "image_name": "eye_photo.jpg"
    }
  }'
```

**Inputs:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `image_base64` | string | Yes | Base64-encoded image (no `data:` prefix) |
| `mime_type` | string | No | `image/png` (default), `image/jpeg`, `image/webp` |
| `mode` | string | No | `all` (default), `validate`, `annotate`, `diagnose` |
| `clinical_context` | string | No | Patient history, symptoms, prior findings |
| `image_name` | string | No | Filename for reference |

**Pipeline steps** (mode: `all`):
1. **Validate** — checks if the image is ocular. Stops if not.
2. **Annotate** — overlays clinical findings (red/yellow/green markers) on the original image
3. **Diagnose** — generates a structured text report with differential diagnoses

### `POST /tools` — List Composio MCP Tools

```bash
curl -X POST \
  -H "Authorization: token ghp_YOUR_GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/focusIinks/VisioOd/actions/workflows/tools.yml/dispatches \
  -d '{"ref": "main", "inputs": {}}'
```

### `GET /runs/{run_id}` — Check Status & Get Result

```bash
# Get run status
curl -s -H "Authorization: token ghp_YOUR_TOKEN" \
  https://api.github.com/repos/focusIinks/VisioOd/actions/runs/{RUN_ID}

# List artifacts (download the result)
curl -s -H "Authorization: token ghp_YOUR_TOKEN" \
  https://api.github.com/repos/focusIinks/VisioOd/actions/runs/{RUN_ID}/artifacts
```

## Result Format

The vision pipeline writes a `result.json` artifact:

```json
{
  "mode": "all",
  "imageName": "eye_photo.jpg",
  "startedAt": "2026-08-02T14:00:00Z",
  "completedAt": "2026-08-02T14:01:30Z",
  "success": true,
  "steps": {
    "validation": {
      "isOcular": true,
      "message": "Ocular image confirmed."
    },
    "annotation": {
      "imageUrl": "https://temp...r2.cloudflarestorage.com/.../generated_image.jpg"
    },
    "diagnosis": {
      "text": "1) Image quality assessment..."
    }
  }
}
```

## Project Structure

```
VisioOd/
├── .github/workflows/
│   ├── vision.yml      # /vision endpoint worker
│   ├── tools.yml       # /tools endpoint worker
│   └── docs.yml        # deploys API docs to GitHub Pages
├── src/
│   ├── mcp-client.js   # Composio MCP client (standalone)
│   ├── vision.js       # Vision pipeline worker
│   ├── tools.js        # Tools lister worker
│   └── prompts.js      # Clinical system prompts
├── docs/
│   └── index.html      # API documentation website
├── package.json
└── README.md
```

## Adding New Endpoints

1. Create `src/your-endpoint.js` — use `ComposioMcpClient` to call MCP tools
2. Create `.github/workflows/your-endpoint.yml` — triggers on `workflow_dispatch`, runs the script, uploads result
3. Document it in `docs/index.html` and this README

## Tech Stack

- **Runtime**: GitHub Actions (ubuntu-latest) + Bun
- **MCP Client**: `@modelcontextprotocol/sdk` (StreamableHTTP transport)
- **AI**: Composio MCP → Gemini Nano Banana Pro (`gemini-3-pro-image-preview`)
- **Docs**: GitHub Pages

## License

MIT
