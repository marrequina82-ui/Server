// server/src/test-hf.ts
// Test the Hugging Face provider without the app. Run from the server folder:
//   npx tsx src/test-hf.ts meal ./lunch.jpg 350
//   npx tsx src/test-hf.ts label ./label.jpg

import { readFileSync } from "node:fs";

// Load server/.env (needs Node 22.13+). Secrets are read from env, never printed.
process.loadEnvFile(".env");

const { hfLabel, hfMeal, hfModelName } = await import("./hf.js");

async function main() {
  const [mode, path, grams] = process.argv.slice(2);
  if (!mode || !path || (mode !== "meal" && mode !== "label")) {
    console.log("Usage: npx tsx src/test-hf.ts <meal|label> <photo.jpg> [totalGrams]");
    process.exit(1);
  }

  console.log(`Model: ${hfModelName()}`);
  console.log(`Photo: ${path}`);

  const b64 = readFileSync(path).toString("base64");
  const started = Date.now();
  const result = mode === "label" ? await hfLabel(b64) : await hfMeal(b64, grams ? Number(grams) : null, null);

  console.log(JSON.stringify(result, null, 2));
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("Failed:", err.message ?? err);
  process.exit(1);
});
