import Anthropic from "@anthropic-ai/sdk";
import { hfLabel, hfMeal, hfModelName } from "./hf.js";
import { geminiLabel, geminiMeal } from "./gemini.js";

export { AiError } from "./hf.js";

// AI_PROVIDER in .env: "claude" (default), "hf" (free Hugging Face models) or "gemini" (Google Gemini).
// Read on each call so changing .env and restarting is all it takes.
function provider(): "claude" | "hf" | "gemini" {
  const p = process.env.AI_PROVIDER?.trim().toLowerCase();
  return p === "hf" || p === "gemini" ? p : "claude";
}
export function aiProviderName(): string {
  if (provider() === "hf") return `hf (${hfModelName()})`;
  if (provider() === "gemini") return `gemini (${process.env.GEMINI_MODEL ?? "gemini-3.7-flash"})`;
  return `claude (${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"})`;
}

// Created on first Claude call, so an HF-only setup doesn't need an Anthropic key.
let client: Anthropic | null = null;
function claude(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}
const MODEL = () => process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

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
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  notes: string;
}

const num = { type: "number" } as const;

const MEAL_TOOL: Anthropic.Tool = {
  name: "report_meal",
  description: "Report the foods identified in the meal photo with grams, calories and macros for each.",
  input_schema: {
    type: "object",
    properties: {
      is_food: { type: "boolean", description: "false if the photo does not show food" },
      meal_name: { type: "string", description: "Short name for the whole plate, e.g. 'Chicken adobo with rice'" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            grams: num,
            kcal: num,
            protein_g: num,
            carbs_g: num,
            fat_g: num,
          },
          required: ["name", "grams", "kcal", "protein_g", "carbs_g", "fat_g"],
        },
      },
      total_grams: num,
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      notes: { type: "string", description: "One short sentence on assumptions (cooking oil, sauce, hidden ingredients)." },
    },
    required: ["is_food", "meal_name", "items", "total_grams", "confidence", "notes"],
  },
};

const LABEL_TOOL: Anthropic.Tool = {
  name: "report_label",
  description: "Report the values printed on the Nutrition Facts label, per ONE serving.",
  input_schema: {
    type: "object",
    properties: {
      is_label: { type: "boolean", description: "false if no readable nutrition label is visible" },
      product_name: { type: "string", description: "Product name if visible, otherwise a short guess or 'Packaged food'" },
      serving_desc: { type: "string", description: "Serving size exactly as printed, e.g. '1 cup (240 mL)'" },
      serving_g: { type: ["number", "null"], description: "Serving size in grams (or mL for drinks) if printed" },
      servings_per_container: { type: ["number", "null"] },
      kcal: num,
      protein_g: num,
      carbs_g: num,
      fat_g: num,
      fiber_g: { type: ["number", "null"] },
      sugar_g: { type: ["number", "null"] },
      sodium_mg: { type: ["number", "null"] },
      notes: { type: "string", description: "Mention anything unreadable or estimated. Convert kJ to kcal if only kJ is shown." },
    },
    required: ["is_label", "product_name", "serving_desc", "serving_g", "servings_per_container", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "notes"],
  },
};

async function callWithImage<T>(tool: Anthropic.Tool, imageBase64: string, mediaType: MediaType, prompt: string): Promise<T> {
  const res = await claude().messages.create({
    model: MODEL(),
    max_tokens: 1500,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("AI did not return structured output");
  return block.input as T;
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
    "Read the Nutrition Facts / Nutrition Information label in this photo. Report values for ONE serving as printed. " +
    "If the label only shows per-100 g values, report per 100 g and set serving_desc to '100 g' and serving_g to 100. Do not guess values that are not visible; use null for optional fields you cannot read.";
  return callWithImage<LabelAnalysis>(LABEL_TOOL, imageBase64, mediaType, prompt);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
