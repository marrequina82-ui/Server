// server/src/hf.ts
// Free vision models through Hugging Face Inference Providers (OpenAI-style chat API).
// Returns the same shapes as the Claude functions in ai.ts.
// Reads HF_TOKEN and HF_MODEL inside each call, so .env values are always current.

import type { LabelAnalysis, MealAnalysis, MealItem } from "./ai.js";

const ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
const DEFAULT_MODEL = "google/gemma-4-31B-it:novita";
const TIMEOUT_MS = 90_000;

/** Error with an HTTP status the Express routes return to the app. */
export class AiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function readConfig() {
  const token = process.env.HF_TOKEN;
  if (!token) throw new AiError("HF_TOKEN is not set on the server", 500);
  return { token, model: process.env.HF_MODEL?.trim() || DEFAULT_MODEL };
}

/** Calls the chat endpoint and returns the assistant's text. Maps provider errors to AiError. */
async function chat(imageBase64: string, prompt: string): Promise<string> {
  const { token, model } = readConfig();
  const body = {
    model,
    max_tokens: 1500,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AiError(`Could not reach Hugging Face: ${(err as Error).message}`, 502);
  }

  if (!res.ok) {
    const raw = await res.text();
    if (res.status === 402) throw new AiError("Free Hugging Face credits are used up for this month", 402);
    if (res.status === 429 || res.status === 503) throw new AiError("AI is busy, try again in a minute", res.status);
    // Show the provider's own message, but never echo the token.
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
      const m = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
      if (m) detail = m;
    } catch { /* not JSON, keep raw text */ }
    detail = detail.split(token).join("[redacted]").slice(0, 400);
    throw new AiError(`Hugging Face error (${res.status}, model ${model}): ${detail}`, 502);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new AiError("Hugging Face returned an empty answer", 502);
  return text;
}

/** Pulls the first JSON object out of a reply, even if it has ``` fences or extra text. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new SyntaxError("no JSON object found");
  return JSON.parse(body.slice(start, end + 1));
}

// ---------- coercion helpers (open models are inconsistent with types) ----------
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- prompts ----------
const MEAL_SHAPE = `{"is_food": true, "meal_name": "string", "items": [{"name": "string", "grams": 0, "kcal": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}], "confidence": "low|medium|high", "notes": "one short sentence"}`;
const LABEL_SHAPE = `{"is_label": true, "product_name": "string", "serving_desc": "string", "serving_g": 0, "servings_per_container": 0, "kcal": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "fiber_g": 0, "sugar_g": 0, "sodium_mg": 0, "notes": "string"}`;

function mealPrompt(totalGrams: number | null, note: string | null): string {
  const weight = totalGrams
    ? `The user says the WHOLE plate weighs ${totalGrams} g. Split that total across the items so the item grams add up to about ${totalGrams} g.`
    : "No weight was given. Estimate each item's grams from typical Filipino portion sizes.";
  return [
    "You are a nutrition assistant for a calorie-tracking app used by Filipino users.",
    "Identify each distinct food on the plate. Use Filipino dish names where they apply, for example adobo, sinigang, pancit, kanin (rice), itlog (egg), ginisang gulay.",
    weight,
    note ? `User note: "${note}".` : "",
    "Estimate calories and macros (protein, carbs, fat in grams) for each item as served, including typical cooking oil and sauces. Use whole numbers for grams and kcal, one decimal for macros.",
    `Reply with ONLY a JSON object, no other text, in exactly this shape: ${MEAL_SHAPE}`,
    "If the photo does not show food, set is_food to false and items to [].",
  ].filter(Boolean).join("\n");
}

const LABEL_PROMPT = [
  "Read the Nutrition Facts label in this photo. Report the values for ONE serving as printed.",
  "If only per-100 g values are printed, use serving_desc \"100 g\" and serving_g 100.",
  "Use null for values you cannot read. Do not guess. Convert kJ to kcal if only kJ is shown.",
  `Reply with ONLY a JSON object, no other text, in exactly this shape: ${LABEL_SHAPE}`,
  "If there is no readable label, set is_label to false.",
].join("\n");

// ---------- normalisers ----------
export function toMeal(raw: any): MealAnalysis {
  const items: MealItem[] = (Array.isArray(raw?.items) ? raw.items : [])
    .map((i: any) => ({
      name: str(i?.name, "Food"),
      grams: round(num(i?.grams)),
      kcal: round(num(i?.kcal)),
      protein_g: round(num(i?.protein_g), 1),
      carbs_g: round(num(i?.carbs_g), 1),
      fat_g: round(num(i?.fat_g), 1),
    }))
    .filter((i: MealItem) => i.grams > 0 || i.kcal > 0);
  const confidence = ["low", "medium", "high"].includes(raw?.confidence) ? raw.confidence : "medium";
  return {
    is_food: typeof raw?.is_food === "boolean" ? raw.is_food : items.length > 0,
    meal_name: str(raw?.meal_name, "Meal"),
    items,
    total_grams: round(items.reduce((s, i) => s + i.grams, 0)),
    confidence,
    notes: str(raw?.notes, ""),
  };
}

export function toLabel(raw: any): LabelAnalysis {
  return {
    is_label: typeof raw?.is_label === "boolean" ? raw.is_label : true,
    product_name: str(raw?.product_name, "Packaged food"),
    serving_desc: str(raw?.serving_desc, "1 serving"),
    serving_g: numOrNull(raw?.serving_g),
    servings_per_container: numOrNull(raw?.servings_per_container),
    kcal: round(num(raw?.kcal)),
    protein_g: round(num(raw?.protein_g), 1),
    carbs_g: round(num(raw?.carbs_g), 1),
    fat_g: round(num(raw?.fat_g), 1),
    fiber_g: numOrNull(raw?.fiber_g),
    sugar_g: numOrNull(raw?.sugar_g),
    sodium_mg: numOrNull(raw?.sodium_mg),
    notes: str(raw?.notes, ""),
  };
}

/** Asks, parses and normalises. Retries once with a stricter instruction if the JSON is bad. */
async function askJson<T>(imageBase64: string, prompt: string, normalise: (raw: any) => T): Promise<T> {
  let lastText = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await chat(imageBase64, attempt === 1 ? prompt : `${prompt}\nYour previous reply was not valid JSON. Output only the JSON object.`);
    lastText = text;
    try {
      return normalise(extractJson(text));
    } catch {
      // try again
    }
  }
  console.error("[hf] unreadable reply:", lastText.slice(0, 300));
  throw new AiError("The AI returned an answer the app couldn't read. Please try the photo again.", 502);
}

export async function hfMeal(imageBase64: string, totalGrams?: number | null, note?: string | null): Promise<MealAnalysis> {
  return askJson(imageBase64, mealPrompt(totalGrams ?? null, note ?? null), toMeal);
}

export async function hfLabel(imageBase64: string): Promise<LabelAnalysis> {
  return askJson(imageBase64, LABEL_PROMPT, toLabel);
}

/** The model in use, for logs and tests. Never includes the token. */
export function hfModelName(): string {
  return process.env.HF_MODEL?.trim() || DEFAULT_MODEL;
}
