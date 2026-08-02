/**
 * Tools lister — the /tools endpoint worker.
 * Lists all available Composio MCP tools for the given API key.
 *
 * Usage:
 *   COMPOSIO_API_KEY=ck_... node src/tools.js --output tools.json
 */

import { ComposioMcpClient } from "./mcp-client.js";
import { writeFileSync } from "node:fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, "");
    if (args[i + 1] && !args[i + 1].startsWith("--")) opts[k] = args[++i];
    else opts[k] = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.COMPOSIO_API_KEY || opts["composio-api-key"];
  const outputFile = opts["output"] || "tools.json";

  if (!apiKey) {
    console.error("ERROR: COMPOSIO_API_KEY env var or --composio-api-key is required");
    process.exit(1);
  }

  console.log("Listing Composio MCP tools...");
  const mcp = new ComposioMcpClient(apiKey);
  try {
    const tools = await mcp.listTools();
    const result = {
      ok: true,
      count: tools.length,
      tools,
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.log(`Found ${tools.length} tools. Written to ${outputFile}`);
  } catch (err) {
    const result = { ok: false, error: err.message, fetchedAt: new Date().toISOString() };
    writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  } finally {
    await mcp.close();
  }
}

main();
