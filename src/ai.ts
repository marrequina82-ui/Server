import { hfLabel, hfMeal, hfModelName, toLabel } from "./hf.js";
import { geminiLabel, geminiMeal } from "./gemini.js";

export { AiError } from "./hf.js";

// AI_PROVIDER in .env: "claude" (default), "hf" (free Hugging Face models), "gemini" (Google Gemini), or "ollama" (local Qwen).
// Read on each call so changing .env and restarting is all it takes.
function provider(): "claude" | "hf" | "gemini" | "ollama" {
  const p = process.env.AI_PROVIDER?.trim().toLowerCase();
  return p === "hf" || p === "gemini" || p === "ollama" ? p : "claude";
}
export function aiProviderName(): string {
  if (provider() === "hf") return `hf (${hfModelName()})`;
  if (provider() === "gemini") return `gemini (${process.env.GEMINI_MODEL ?? "gemini-3.7-flash"})`;
  if (provider() === "ollama") {
    const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
    return `ollama qwen (${url})`;
  }
  const n8nUrl = process.env.N8N_BASE_URL ?? "http://localhost:5678";
  return `claude via n8n (${n8nUrl})`;
}

type MediaType = "image/jpeg" | "image/png" | "image/webp";

export interface MealItem {
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}
export interface MealAnalysis {
  is_food: boolean;
  meal_name: string;
  items: MealItem[];
  total_grams: number;
  confidence: "low" | "medium" | "high";
  notes: string;
}

export interface LabelAnalysis {
  is_label: boolean;
  product_name: string;
  serving_desc: string;
  serving_g: number | null;
  servings_per_container: number | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  notes: string;
}

type Tool = { name: string };

const MEAL_TOOL: Tool = { name: "report_meal" };
const LABEL_TOOL: Tool = { name: "report_label" };

async function callWithImage<T>(tool: { name: string }, imageBase64: string, mediaType: MediaType, prompt: string): Promise<T> {
  if (provider() === "ollama") {
    return callOllama<T>(imageBase64, mediaType, prompt);
  }

  const n8nUrl = process.env.N8N_BASE_URL ?? "http://localhost:5678";
  const webhookPath = tool.name === "report_meal" ? "fittonesugo-meal" : "fittonesugo-label";
  const url = `${n8nUrl}/webhook/${webhookPath}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: imageBase64,
        media_type: mediaType,
        prompt,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`n8n error (HTTP ${response.status}): ${text || "unknown error"}`);
    }

    const data = await response.json();
    return data as T;
  } catch (e) {
    if (e instanceof TypeError && e.message.includes("fetch")) {
      throw new Error(`Cannot reach n8n at ${url}. Is n8n running? Start with: npx n8n`);
    }
    throw e;
  }
}

async function callOllama<T>(imageBase64: string, mediaType: MediaType, prompt: string): Promise<T> {
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llava";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000); // 3 minutes for Llava

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `${prompt}

RESPOND WITH ONLY valid JSON in this exact format, no other text:
{"is_food":true,"meal_name":"dish name","items":[{"name":"item","grams":100,"kcal":200,"protein_g":10,"carbs_g":30,"fat_g":5}],"total_grams":100,"confidence":"high","notes":"assumptions"}

Change only the values, keep the field names exactly as shown.`,
        images: [imageBase64],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error (HTTP ${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const responseText = (data.response || "").trim();

    // Parse JSON from Qwen's response
    try {
      // Find JSON: match from first { to the last }
      const firstBrace = responseText.indexOf("{");
      const lastBrace = responseText.lastIndexOf("}");

      if (firstBrace === -1 || lastBrace === -1) {
        throw new Error("No JSON braces found in response");
      }

      let jsonStr = responseText.substring(firstBrace, lastBrace + 1);

      // Clean up Qwen's JSON formatting issues:
      // Remove spaces around underscores in field names
      jsonStr = jsonStr.replace(/"([a-z]+)_ ([a-z_]+)":/g, '"$1_$2":');

      // Remove extra closing braces
      jsonStr = jsonStr.replace(/\}\}+$/, "}");

      return JSON.parse(jsonStr) as T;
    } catch (e) {
      throw new Error(`Failed to parse Qwen response as JSON: ${(e as Error).message}\nResponse: ${responseText.substring(0, 300)}`);
    }
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(`Cannot reach Ollama at ${ollamaUrl}. Is it running? Start with: ollama serve`);
    }
    throw e;
  }
}

/** If the user gave a total weight, rescale the items so their grams match it exactly. Shared by both providers. */
function applyTotalGrams(out: MealAnalysis, totalGrams: number | null): MealAnalysis {
  if (!totalGrams || !out.items.length) return out;
  const sum = out.items.reduce((s, i) => s + i.grams, 0);
  if (sum > 0 && Math.abs(sum - totalGrams) > 1) {
    const k = totalGrams / sum;
    out.items = out.items.map((i) => ({
      ...i,
      grams: Math.round(i.grams * k),
      kcal: Math.round(i.kcal * k),
      protein_g: round1(i.protein_g * k),
      carbs_g: round1(i.carbs_g * k),
      fat_g: round1(i.fat_g * k),
    }));
  }
  out.total_grams = totalGrams;
  return out;
}

export async function analyzeMeal(imageBase64: string, mediaType: MediaType, totalGrams: number | null, note: string | null): Promise<MealAnalysis> {
  if (provider() === "hf") {
    // Hugging Face path. The image is sent as JPEG (the app resizes photos to JPEG).
    const out = await hfMeal(imageBase64, totalGrams, note);
    return applyTotalGrams(out, totalGrams);
  }
  if (provider() === "gemini") {
    return applyTotalGrams(await geminiMeal(imageBase64, totalGrams, note), totalGrams);
  }
  if (provider() === "ollama") {
    // Ollama path - uses callWithImage which calls local Qwen model
    const weightLine = totalGrams
      ? `The user weighed/estimated the WHOLE plate at ${totalGrams} g. Split this total across the items so item grams add up to ${totalGrams} g, then compute calories and macros from those grams.`
      : "The user did not give a weight. Estimate each item's grams from typical portion sizes and visual cues.";
    const noteLine = note ? `User note about the meal: "${note}".` : "";
    const prompt = [
      "You are a nutrition assistant inside a calorie-tracking app used mostly in the Philippines.",
      "Identify every distinct food in this photo (recognize Filipino dishes by name when relevant, e.g. adobo, sinigang, pancit).",
      weightLine,
      noteLine,
      "Use standard nutrition references for cooked foods as served, including typical cooking oil and sauces. Round kcal to whole numbers and macros to one decimal.",
    ].filter(Boolean).join("\n");
    const out = await callWithImage<MealAnalysis>(MEAL_TOOL, imageBase64, mediaType, prompt);
    return applyTotalGrams(out, totalGrams);
  }

  const weightLine = totalGrams
    ? `The user weighed/estimated the WHOLE plate at ${totalGrams} g. Split this total across the items so item grams add up to ${totalGrams} g, then compute calories and macros from those grams.`
    : "The user did not give a weight. Estimate each item's grams from typical portion sizes and visual cues.";
  const noteLine = note ? `User note about the meal: "${note}".` : "";
  const prompt = [
    "You are a nutrition assistant inside a calorie-tracking app used mostly in the Philippines.",
    "Identify every distinct food in this photo (recognize Filipino dishes by name when relevant, e.g. adobo, sinigang, pancit).",
    weightLine,
    noteLine,
    "Use standard nutrition references for cooked foods as served, including typical cooking oil and sauces. Round kcal to whole numbers and macros to one decimal.",
  ].filter(Boolean).join("\n");
  const out = await callWithImage<MealAnalysis>(MEAL_TOOL, imageBase64, mediaType, prompt);
  return applyTotalGrams(out, totalGrams);
}

export async function analyzeLabel(imageBase64: string, mediaType: MediaType): Promise<LabelAnalysis> {
  if (provider() === "hf") return hfLabel(imageBase64);
  if (provider() === "gemini") return geminiLabel(imageBase64);

  const prompt =
    "Read the Nutrition Facts / Nutrition Information label in this photo. Report only calories, protein, carbs and fat for ONE serving as printed. " +
    "If the label only shows per-100 g values, report per 100 g and set serving_desc to '100 g' and serving_g to 100. Do not guess values that are not visible; use null for optional fields you cannot read.";
  return toLabel(await callWithImage<unknown>(LABEL_TOOL, imageBase64, mediaType, prompt));
}


const round1 = (n: number) => Math.round(n * 10) / 10;
