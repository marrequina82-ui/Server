// server/src/test-gemini.ts
// Test the Gemini provider without the app. Run from the server folder:
//   npx tsx src/test-gemini.ts meal ./lunch.jpg 350
//   npx tsx src/test-gemini.ts label ./label.jpg

import { readFileSync } from "node:fs";

// Load server/.env before the provider is imported. Secrets are never printed.
process.loadEnvFile(".env");

const { geminiLabel, geminiMeal } = await import("./gemini.js");

async function main() {
  const [mode, path, grams] = process.argv.slice(2);
  if (!mode || !path || (mode !== "meal" && mode !== "label")) {
    console.log("Usage: npx tsx src/test-gemini.ts <meal|label> <photo.jpg> [totalGrams]");
    process.exit(1);
  }

  console.log(`Model: ${process.env.GEMINI_MODEL?.trim() || "gemini-3.7-flash"} (fallback: ${process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-2.5-flash"})`);
  console.log(`Photo: ${path}`);

  const b64 = readFileSync(path).toString("base64");
  const started = Date.now();
  const result = mode === "label" ? await geminiLabel(b64) : await geminiMeal(b64, grams ? Number(grams) : null, null);

  console.log(JSON.stringify(result, null, 2));
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("Failed:", err.message ?? err);
  process.exit(1);
});
