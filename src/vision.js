/**
 * Vision pipeline worker — the core of the /vision endpoint.
 *
 * Runs a 3-step pipeline via Composio MCP:
 *   1. Validate  — is the image ocular?
 *   2. Annotate  — overlay clinical findings on the original image
 *   3. Diagnose  — structured text report with differential diagnoses
 *
 * Usage (in a GitHub Actions worker):
 *   COMPOSIO_API_KEY=ck_... node src/vision.js \
 *     --image-url https://gist.githubusercontent.com/.../raw/image.png \
 *     --mime-type image/png \
 *     --mode all \
 *     --clinical-context "..." \
 *     --output result.json
 *
 * Backward compatible: --image-base64 <base64> still works for callers that
 * pass the image inline (e.g. local tests).
 */

import { ComposioMcpClient, extractImageUrls, extractText } from "./mcp-client.js";
import {
  GEMINI_MODEL,
  VALIDATION_SYSTEM,
  VALIDATION_PROMPT,
  ANNOTATION_SYSTEM,
  annotationPrompt,
  DIAGNOSIS_SYSTEM,
  DIAGNOSIS_PROMPT,
  STYLE_INSTRUCTION,
} from "./prompts.js";
import { writeFileSync } from "node:fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, "");
    if (args[i + 1] && !args[i + 1].startsWith("--")) {
      opts[k] = args[++i];
    } else {
      opts[k] = true;
    }
  }
  return opts;
}

async function callGemini(apiKey, geminiArgs) {
  const mcp = new ComposioMcpClient(apiKey);
  try {
    await mcp.connect();
    const result = await mcp.callTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GEMINI_GENERATE_IMAGE", arguments: geminiArgs }],
      sync_response_to_workbench: false,
    });
    const imageUrls = extractImageUrls(result.raw ?? result.text);
    return {
      ok: !result.isError,
      isError: result.isError,
      text: result.text,
      raw: result.raw,
      error: result.isError ? result.text.slice(0, 500) : undefined,
      imageUrls,
    };
  } catch (err) {
    return { ok: false, isError: true, text: "", raw: null, error: err.message, imageUrls: [] };
  } finally {
    await mcp.close();
  }
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.COMPOSIO_API_KEY || opts["composio-api-key"];
  const mode = opts["mode"] || "all"; // validate | annotate | diagnose | all
  const clinicalContext = typeof opts["clinical-context"] === "string" ? opts["clinical-context"] : "";
  const outputFile = opts["output"] || "result.json";

  if (!apiKey) {
    console.error("ERROR: COMPOSIO_API_KEY env var or --composio-api-key is required");
    process.exit(1);
  }
  if (!opts["image-url"] && !opts["image-base64"]) {
    console.error("ERROR: either --image-url or --image-base64 is required");
    process.exit(1);
  }

  // Resolve the image bytes: either download from a URL, or use a base64 string
  // passed inline (backward compatible).
  let imageBase64;
  let mimeType = opts["mime-type"] || "image/png";

  if (opts["image-url"]) {
    console.log(`Downloading image from URL: ${opts["image-url"]}`);
    const imgRes = await fetch(opts["image-url"]);
    if (!imgRes.ok) {
      console.error(`ERROR: image download failed: HTTP ${imgRes.status} ${imgRes.statusText}`);
      process.exit(1);
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    imageBase64 = buf.toString("base64");
    mimeType = opts["mime-type"] || imgRes.headers.get("content-type") || "image/png";
    console.log(`  → downloaded ${buf.length} bytes (${mimeType})`);
  } else {
    imageBase64 = opts["image-base64"];
  }

  const result = {
    mode,
    imageName: opts["name"] || "uploaded.png",
    mimeType,
    clinicalContext: clinicalContext || undefined,
    startedAt: new Date().toISOString(),
    steps: {},
  };

  const imageInput = { base64: imageBase64, mimeType };

  // ---- Step 1: Validation ----
  if (mode === "all" || mode === "validate") {
    console.log("Step 1: Validating image (is it ocular?)...");
    const v = await callGemini(apiKey, {
      prompt: VALIDATION_PROMPT,
      model: GEMINI_MODEL,
      system_instruction: VALIDATION_SYSTEM,
      image_size: "1K",
      aspect_ratio: "1:1",
      images: [imageInput],
    });
    const isOcular = v.ok && v.imageUrls.length > 0 && !v.isError;
    result.steps.validation = {
      isOcular,
      message: isOcular ? "Ocular image confirmed." : v.error || "Not an ocular image.",
      imageUrl: v.imageUrls[0],
    };
    console.log(`  → ${isOcular ? "Ocular ✓" : "Not ocular ✗"}`);

    if (!isOcular && mode === "all") {
      result.completedAt = new Date().toISOString();
      result.success = false;
      result.reason = "non-ocular";
      writeFileSync(outputFile, JSON.stringify(result, null, 2));
      console.log(`Result written to ${outputFile} (non-ocular, pipeline stopped)`);
      return;
    }
  }

  // ---- Step 2: Annotation ----
  if (mode === "all" || mode === "annotate") {
    console.log("Step 2: Annotating clinical findings...");
    const a = await callGemini(apiKey, {
      prompt: `${annotationPrompt(clinicalContext)}\n\n${STYLE_INSTRUCTION}`,
      model: GEMINI_MODEL,
      system_instruction: ANNOTATION_SYSTEM,
      image_size: "2K",
      aspect_ratio: "1:1",
      images: [imageInput],
    });
    result.steps.annotation = {
      imageUrl: a.imageUrls[0],
      error: a.error,
    };
    console.log(`  → ${a.imageUrls[0] ? "Annotated ✓" : "Failed ✗"}`);
  }

  // ---- Step 3: Diagnosis ----
  if (mode === "all" || mode === "diagnose") {
    console.log("Step 3: Generating differential diagnosis...");
    const d = await callGemini(apiKey, {
      prompt: `${DIAGNOSIS_PROMPT}${clinicalContext ? `\n\nClinical context: ${clinicalContext}` : ""}`,
      model: GEMINI_MODEL,
      system_instruction: DIAGNOSIS_SYSTEM,
      image_size: "1K",
      aspect_ratio: "1:1",
      images: [imageInput],
    });
    const diagnosisText = extractText(d.raw ?? d.text);
    result.steps.diagnosis = {
      text: diagnosisText,
      error: d.error,
    };
    console.log(`  → ${diagnosisText ? "Report ✓" : "Failed ✗"}`);
  }

  result.completedAt = new Date().toISOString();
  result.success = true;

  writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(`\nResult written to ${outputFile}`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
