/**
 * VisioOd Mediator — Cloudflare Worker
 *
 * This worker sits between your static frontend and GitHub Actions.
 * It holds the GITHUB_TOKEN and COMPOSIO_API_KEY as secrets (set via
 * `wrangler secret put`). The frontend never sees any tokens — it just
 * calls this worker's URL.
 *
 * Endpoints:
 *   POST /vision          — trigger the annotation pipeline, returns runId
 *   GET  /status?runId=X  — poll workflow run status
 *   GET  /result?runId=X  — download parsed result (after run completes)
 *   GET  /                — health check
 *
 * Deploy:
 *   cd worker && npm install && npx wrangler deploy
 *   Then set secrets:
 *     npx wrangler secret put GITHUB_TOKEN
 *     npx wrangler secret put COMPOSIO_API_KEY
 *     npx wrangler secret put API_KEY   (shared secret for frontend auth)
 */

const GITHUB_API = "https://api.github.com";
const REPO = "focusIinks/VisioOd";

// --- Simple shared-secret auth (prevents random abuse) ---
function checkAuth(request, env) {
  if (!env.API_KEY) return true; // no auth required if API_KEY not set
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token === env.API_KEY;
}

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "content-type": "application/json",
    "User-Agent": "visiood-mediator",
  };
}

async function triggerWorkflow(env, workflowFile, inputs) {
  const res = await fetch(
    `${GITHUB_API}/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, message: `GitHub dispatch failed (${res.status}): ${text}` };
  }
  // Poll briefly for the run to register
  await new Promise((r) => setTimeout(r, 2000));
  const runsRes = await fetch(`${GITHUB_API}/repos/${REPO}/actions/runs?per_page=1`, {
    headers: ghHeaders(env),
  });
  const runsJson = await runsRes.json();
  const run = runsJson.workflow_runs?.[0];
  if (!run) return { ok: false, message: "Workflow triggered but no run found" };
  return { ok: true, runId: run.id };
}

async function getRunStatus(env, runId) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/actions/runs/${runId}`, {
    headers: ghHeaders(env),
  });
  if (!res.ok) return { ok: false, message: `Failed (${res.status})` };
  const json = await res.json();
  return {
    ok: true,
    status: json.status,
    conclusion: json.conclusion,
    htmlUrl: json.html_url,
    name: json.name,
  };
}

async function getRunResult(env, runId) {
  // List artifacts
  const listRes = await fetch(`${GITHUB_API}/repos/${REPO}/actions/runs/${runId}/artifacts`, {
    headers: ghHeaders(env),
  });
  if (!listRes.ok) return { ok: false, message: `Failed to list artifacts (${listRes.status})` };
  const listJson = await listRes.json();
  const artifact = listJson.artifacts?.[0];
  if (!artifact) return { ok: false, message: "No artifacts found" };

  // Download the zip (GitHub redirects to S3 — fetch follows redirects)
  const dlRes = await fetch(artifact.archive_download_url, { headers: ghHeaders(env), redirect: "follow" });
  if (!dlRes.ok) return { ok: false, message: `Failed to download (${dlRes.status})` };
  const zipBuf = await dlRes.arrayBuffer();

  // Parse the zip to extract result.json
  // Cloudflare Workers support the Compression Streams API for deflate/gzip,
  // but zip parsing needs a tiny manual reader. We use fflate (bundled).
  const files = await unzipResultJson(new Uint8Array(zipBuf));
  if (!files["result.json"]) return { ok: false, message: "result.json not in artifact" };
  const text = new TextDecoder().decode(files["result.json"]);
  try {
    return { ok: true, result: JSON.parse(text) };
  } catch {
    return { ok: true, result: text };
  }
}

// --- Minimal ZIP reader (extracts result.json only) ---
// ZIP format: local file headers + central directory. We scan for "result.json".
async function unzipResultJson(buf) {
  const files = {};
  const view = new DataView(buf.buffer);
  let offset = 0;
  while (offset < buf.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // not a local file header
    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraFieldLength = view.getUint16(offset + 28, true);
    const fileName = new TextDecoder().decode(buf.slice(offset + 30, offset + 30 + fileNameLength));
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const compressedData = buf.slice(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      // Stored (no compression)
      files[fileName] = compressedData;
    } else if (compressionMethod === 8) {
      // Deflate — use DecompressionStream (available in Cloudflare Workers)
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([compressedData]).stream().pipeThrough(ds);
      const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      files[fileName] = decompressed;
    }
    offset = dataStart + compressedSize;
  }
  return files;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*", // static frontend can be anywhere
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }

    // Health check
    if (path === "/" && request.method === "GET") {
      return json({ ok: true, service: "VisioOd Mediator", repo: REPO });
    }

    // All other routes require auth
    if (!checkAuth(request, env)) {
      return json({ ok: false, message: "Unauthorized" }, 401);
    }

    // POST /vision — trigger the pipeline
    if (path === "/vision" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch {
        return json({ ok: false, message: "Invalid JSON" }, 400);
      }
      if (!body.image_base64) {
        return json({ ok: false, message: "image_base64 is required" }, 400);
      }
      const inputs = {
        image_base64: body.image_base64,
        mime_type: body.mime_type || "image/png",
        mode: body.mode || "all",
        clinical_context: body.clinical_context || "",
        image_name: body.image_name || "uploaded.png",
      };
      const result = await triggerWorkflow(env, "vision.yml", inputs);
      return json(result, result.ok ? 200 : 502);
    }

    // GET /status?runId=X
    if (path === "/status" && request.method === "GET") {
      const runId = parseInt(url.searchParams.get("runId") || "", 10);
      if (isNaN(runId)) return json({ ok: false, message: "runId required" }, 400);
      const result = await getRunStatus(env, runId);
      return json(result, result.ok ? 200 : 502);
    }

    // GET /result?runId=X
    if (path === "/result" && request.method === "GET") {
      const runId = parseInt(url.searchParams.get("runId") || "", 10);
      if (isNaN(runId)) return json({ ok: false, message: "runId required" }, 400);
      const result = await getRunResult(env, runId);
      return json(result, result.ok ? 200 : 502);
    }

    return json({ ok: false, message: "Not found" }, 404);
  },
};
