// server/src/gemini.ts
// Gemini provider (AI_PROVIDER=gemini) via the @google/genai SDK.
// Returns the same MealAnalysis / LabelAnalysis shapes as the Claude and Hugging Face providers.
// Config is read from process.env inside each call, never at import time.

import "dotenv/config";
import { GoogleGenAI, Type } from "@google/genai";
import type { LabelAnalysis, MealAnalysis } from "./ai.js";
import { AiError, toLabel, toMeal } from "./hf.js";

const DEFAULT_MODEL = "gemini-3.7-flash";
const DEFAULT_FALLBACK = "gemini-2.5-flash";
// Waits before each retry of an overloaded model (500/503): 1s, then 3s, then 3s.
const RETRY_WAITS_MS = [1000, 3000, 3000];

function config() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new AiError("GEMINI_API_KEY is not set on the server", 500);
  return {
    apiKey,
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
    fallback: process.env.GEMINI_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK,
  };
}

// ---------- JSON schemas, matching the app's MealAnalysis / LabelAnalysis ----------
const mealSchema = {
  type: Type.OBJECT,
  properties: {
    is_food: { type: Type.BOOLEAN, description: "false if the photo does not show food" },
    meal_name: { type: Type.STRING, description: "Short name for the plate, e.g. 'Chicken adobo with rice'" },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          grams: { type: Type.NUMBER },
          kcal: { type: Type.NUMBER },
          protein_g: { type: Type.NUMBER },
          carbs_g: { type: Type.NUMBER },
          fat_g: { type: Type.NUMBER },
        },
        required: ["name", "grams", "kcal", "protein_g", "carbs_g", "fat_g"],
      },
    },
    confidence: { type: Type.STRING, enum: ["low", "medium", "high"] },
    notes: { type: Type.STRING, description: "One short sentence on assumptions" },
  },
  required: ["is_food", "meal_name", "items", "confidence", "notes"],
};

const labelSchema = {
  type: Type.OBJECT,
  properties: {
    is_label: { type: Type.BOOLEAN, description: "false if no readable nutrition label is visible" },
    product_name: { type: Type.STRING },
    serving_desc: { type: Type.STRING, description: "Serving size exactly as printed" },
    serving_g: { type: Type.NUMBER, nullable: true },
    servings_per_container: { type: Type.NUMBER, nullable: true },
    kcal: { type: Type.NUMBER },
    protein_g: { type: Type.NUMBER },
    carbs_g: { type: Type.NUMBER },
    fat_g: { type: Type.NUMBER },
    fiber_g: { type: Type.NUMBER, nullable: true },
    sugar_g: { type: Type.NUMBER, nullable: true },
    sodium_mg: { type: Type.NUMBER, nullable: true },
    notes: { type: Type.STRING },
  },
  required: ["is_label", "product_name", "serving_desc", "kcal", "protein_g", "carbs_g", "fat_g", "notes"],
};

// ---------- Helpers ----------
function cleanBase64(b64: string) {
  // Accept "data:image/jpeg;base64,...." as well as raw base64
  return b64.replace(/^data:image\/\w+;base64,/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pulls the HTTP status and provider message out of an SDK error. */
function describe(err: any): { code: number | string; message: string } {
  const code = err?.status ?? err?.code ?? err?.error?.code ?? "unknown";
  const message = String(err?.message ?? err).slice(0, 300);
  return { code, message };
}

/** One request to one model. Throws the raw SDK error. */
async function callModel(apiKey: string, model: string, imageBase64: string, prompt: string, schema: object): Promise<unknown> {
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { mimeType: "image/jpeg", data: cleanBase64(imageBase64) } },
      { text: prompt },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2,
    },
  });
  const text = res.text;
  if (!text) throw Object.assign(new Error("Empty response from Gemini"), { status: 502 });
  return JSON.parse(text);
}

/**
 * Overloaded models (500/503): retry the same model with waits. 404 (model not found):
 * switch to the fallback at once. 429: stop with the free-limit message. Every failure is logged
 * with the real code and model name.
 */
async function askGemini(imageBase64: string, prompt: string, schema: object): Promise<unknown> {
  const { apiKey, model, fallback } = config();
  const models = [model, fallback].filter((m, i, all) => all.indexOf(m) === i);
  let lastOverload: { code: number | string; message: string } | null = null;

  for (const current of models) {
    for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
      try {
        return await callModel(apiKey, current, imageBase64, prompt, schema);
      } catch (err: any) {
        const { code, message } = describe(err);
        console.error(`[gemini] model=${current} code=${code} attempt=${attempt + 1}: ${message}`);

        if (code === 429 || /RESOURCE_EXHAUSTED/.test(message)) {
          throw new AiError("AI is busy (free limit reached), try again in a minute", 429);
        }
        if (code === 404) {
          lastOverload = { code, message };
          break; // model not found: go straight to the fallback
        }
        if (code === 500 || code === 503) {
          lastOverload = { code, message };
          if (attempt < RETRY_WAITS_MS.length) {
            await sleep(RETRY_WAITS_MS[attempt]);
            continue;
          }
          break; // retries used up: try the fallback model
        }
        // Anything else is a real error. Show it, do not call it "busy".
        throw new AiError(`Gemini error (${code}, model ${current}): ${message}`, 502);
      }
    }
  }

  // Report the real last failure. A 404 is a configuration problem, not a busy service.
  const last = lastOverload ?? { code: "unknown", message: "no details" };
  const busy = last.code === 500 || last.code === 503;
  throw new AiError(
    `Gemini failed after trying ${models.join(" then ")} (last status ${last.code}: ${last.message})`,
    busy ? 503 : 502
  );
}

// ---------- Public functions ----------
export async function geminiMeal(imageBase64: string, totalGrams?: number | null, note?: string | null): Promise<MealAnalysis> {
  const prompt = [
    "You are a nutrition assistant inside a calorie-tracking app used mostly in the Philippines.",
    "Identify every distinct food on this plate. Use Filipino dish names when the food is Filipino (adobo, sinigang, pancit, kanin).",
    totalGrams
      ? `The user weighed the WHOLE plate at ${totalGrams} g. Split that total across the items so item grams add up to about ${totalGrams} g.`
      : "No weight was given. Estimate each item's grams from typical portion sizes.",
    note ? `User note: "${note}".` : "",
    "Estimate kcal and macros for each item as served, including typical cooking oil and sauces.",
    "If the photo is not food, set is_food to false and items to [].",
  ].filter(Boolean).join("\n");
  return toMeal(await askGemini(imageBase64, prompt, mealSchema));
}

export async function geminiLabel(imageBase64: string): Promise<LabelAnalysis> {
  const prompt = [
    "Read the Nutrition Facts label in this photo. Report values for ONE serving exactly as printed.",
    "serving_g is the serving size in grams (or ml for drinks). Convert kJ to kcal by dividing by 4.184 if only kJ is shown.",
    "Use null for optional values you cannot read. Do not guess. If there is no readable label, set is_label to false.",
  ].join("\n");
  return toLabel(await askGemini(imageBase64, prompt, labelSchema));
}
