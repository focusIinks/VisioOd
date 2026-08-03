/**
 * ComposioMcpClient — standalone MCP client for Composio's MCP gateway.
 *
 * Used by VisioOd API workers (GitHub Actions) to talk directly to the
 * Composio MCP server via the Streamable HTTP transport with
 * `x-consumer-api-key` header authentication.
 *
 * No framework dependencies — runs on plain Node.js / Bun.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";
export const COMPOSIO_AUTH_HEADER = "x-consumer-api-key";

export class ComposioMcpClient {
  constructor(apiKey, serverUrl = COMPOSIO_MCP_URL) {
    if (!apiKey) throw new Error("Composio API key is required");
    this.apiKey = apiKey;
    this.serverUrl = serverUrl;
    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    this.transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), {
      requestInit: {
        headers: {
          [COMPOSIO_AUTH_HEADER]: this.apiKey,
          Accept: "application/json, text/event-stream",
        },
      },
    });
    this.client = new Client(
      { name: "visiood-api", version: "1.0.0" },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools() {
    await this.connect();
    const res = await this.client.listTools();
    return (res.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name, args) {
    await this.connect();
    const res = await this.client.callTool({ name, arguments: args });
    const content = res.content || [];
    const textParts = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        textParts.push(`[image: ${block.mimeType || "unknown"}]`);
      } else if (block.type === "resource") {
        const r = block.resource;
        if (typeof r.text === "string") textParts.push(r.text);
      }
    }
    return {
      name,
      arguments: args,
      text: textParts.join("\n") || "(empty result)",
      raw: res,
      isError: Boolean(res.isError),
    };
  }

  async close() {
    if (!this.connected) return;
    try { await this.transport.close(); } catch {}
    this.connected = false;
  }
}

/** Extract image URLs (s3url) from a Gemini tool result.
 *  MCP returns content as text blocks containing JSON strings, so we parse
 *  any JSON-looking strings and walk the structured raw too. */
export function extractImageUrls(val) {
  const urls = [];
  const seen = new Set();
  const add = (u) => {
    if (/^https?:\/\//.test(u) && !seen.has(u)) { seen.add(u); urls.push(u); }
  };
  const visit = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v) && (v.includes("cloudflarestorage") || v.includes("s3") || v.includes("r2."))) add(v);
      const t = v.trim();
      if (t.startsWith("{") || t.startsWith("[")) { try { visit(JSON.parse(t)); } catch {} }
      return;
    }
    if (typeof v !== "object") return;
    const o = v;
    if (typeof o.s3url === "string") add(o.s3url);
    if (typeof o.url === "string") add(o.url);
    for (const x of Object.values(o)) {
      if (Array.isArray(x)) x.forEach(visit);
      else if (typeof x === "object") visit(x);
      else if (typeof x === "string") visit(x);
    }
  };
  visit(val);
  return urls;
}

/** Extract clinical text from a deeply-nested Gemini diagnosis result.
 *
 *  When GEMINI_GENERATE_IMAGE is asked to return text (diagnosis), Composio
 *  marks it as an error ("No image data was found... Model's text response
 *  (truncated): <actual report>"). We dig through the nested JSON to find
 *  the actual clinical report text.
 */
export function extractText(raw) {
  const found = [];
  const visit = (val, depth = 0) => {
    if (!val || depth > 12) return;
    if (typeof val === "string") {
      const t = val.trim();
      // If it's JSON, parse and recurse
      if (t.startsWith("{") || t.startsWith("[")) { try { visit(JSON.parse(t), depth + 1); return; } catch {} }
      // Extract the clinical report from "Model's text response (truncated): ..."
      const marker = "Model's text response (truncated): ";
      const markerIdx = t.indexOf(marker);
      if (markerIdx !== -1) {
        const report = t.slice(markerIdx + marker.length).trim();
        if (report.length > 30) found.push(report);
      }
      // Also match direct clinical text
      if (t.length > 80 && /^(image quality|anatomical|notable|differential|recommended|disclaimer|clinical|report|findings|assessment|structures|based on)/im.test(t)) found.push(t);
      return;
    }
    if (typeof val !== "object") return;
    const o = val;
    if (Array.isArray(o.content)) {
      for (const c of o.content) {
        if (c && c.type === "text" && typeof c.text === "string") visit(c.text, depth + 1);
      }
    }
    if (typeof o.message === "string" && o.message.length > 80) visit(o.message, depth + 1);
    if (typeof o.text === "string" && o.text.length > 50) visit(o.text, depth + 1);
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach((i) => visit(i, depth + 1));
      else if (typeof v === "object") visit(v, depth + 1);
    }
  };
  visit(raw);
  if (found.length > 0) { found.sort((a, b) => b.length - a.length); return found[0]; }
  try { return typeof raw === "object" ? JSON.stringify(raw, null, 2).slice(0, 5000) : String(raw ?? ""); } catch { return String(raw ?? ""); }
}
