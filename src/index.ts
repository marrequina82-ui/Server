import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { computeTargets, type ProfileInput } from "./nutrition.js";
import { AiError, analyzeLabel, analyzeMeal } from "./ai.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-only-change-me";
const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // base64 photos

// ---------- helpers ----------
type AuthedRequest = Request & { userId: number };

function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    (req as AuthedRequest).userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: "Session expired, please sign in again" });
  }
}

const uid = (req: Request) => (req as AuthedRequest).userId;
const sign = (id: number) => jwt.sign({}, JWT_SECRET, { subject: String(id), expiresIn: "30d" });

function parse<T>(schema: z.ZodType<T>, data: unknown, res: Response): T | null {
  const r = schema.safeParse(data);
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return null;
  }
  return r.data;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mealEnum = z.enum(["breakfast", "lunch", "dinner", "snacks"]);
const mediaType = z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg");

// ---------- auth ----------
app.post("/auth/register", (req, res) => {
  const body = parse(z.object({ name: z.string().min(1), email: z.email(), password: z.string().min(8) }), req.body, res);
  if (!body) return;
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(body.email.toLowerCase());
  if (exists) return res.status(409).json({ error: "That email is already registered" });
  const hash = bcrypt.hashSync(body.password, 10);
  const info = db.prepare("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)").run(body.email.toLowerCase(), hash, body.name);
  const id = Number(info.lastInsertRowid);
  res.json({ token: sign(id), user: { id, name: body.name, email: body.email.toLowerCase() } });
});

app.post("/auth/login", (req, res) => {
  const body = parse(z.object({ email: z.email(), password: z.string() }), req.body, res);
  if (!body) return;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(body.email.toLowerCase()) as unknown as
    | { id: number; name: string; email: string; password_hash: string }
    | undefined;
  if (!user || !bcrypt.compareSync(body.password, user.password_hash)) return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(user.id), user: { id: user.id, name: user.name, email: user.email } });
});

// ---------- profile & goals ----------
const profileSchema = z.object({
  sex: z.enum(["female", "male"]),
  birth_year: z.number().int().min(1920).max(new Date().getFullYear() - 13),
  height_cm: z.number().min(100).max(250),
  weight_kg: z.number().min(30).max(300),
  goal_weight_kg: z.number().min(30).max(300),
  activity: z.enum(["sedentary", "light", "moderate", "active", "very_active"]),
  goal: z.enum(["lose", "maintain", "gain"]),
  weekly_rate_kg: z.number().refine((v) => [0, 0.25, 0.5, 0.75].includes(v), "must be 0, 0.25, 0.5 or 0.75"),
});

app.get("/me", auth, (req, res) => {
  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(uid(req));
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(uid(req)) as unknown as ProfileInput | undefined;
  res.json({ user, profile: profile ?? null, targets: profile ? computeTargets(profile) : null });
});

app.put("/profile", auth, (req, res) => {
  const p = parse(profileSchema, req.body, res);
  if (!p) return;
  db.prepare(
    `INSERT INTO profiles (user_id, sex, birth_year, height_cm, weight_kg, goal_weight_kg, activity, goal, weekly_rate_kg, updated_at)
     VALUES (@user_id, @sex, @birth_year, @height_cm, @weight_kg, @goal_weight_kg, @activity, @goal, @weekly_rate_kg, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET sex=@sex, birth_year=@birth_year, height_cm=@height_cm, weight_kg=@weight_kg,
       goal_weight_kg=@goal_weight_kg, activity=@activity, goal=@goal, weekly_rate_kg=@weekly_rate_kg, updated_at=datetime('now')`
  ).run({ user_id: uid(req), ...p });
  res.json({ profile: p, targets: computeTargets(p) });
});

app.post("/weight", auth, (req, res) => {
  const b = parse(z.object({ date: dateStr, weight_kg: z.number().min(30).max(300) }), req.body, res);
  if (!b) return;
  db.prepare("INSERT INTO weight_logs (user_id, date, weight_kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg = excluded.weight_kg").run(uid(req), b.date, b.weight_kg);
  db.prepare("UPDATE profiles SET weight_kg = ?, updated_at = datetime('now') WHERE user_id = ?").run(b.weight_kg, uid(req));
  res.json({ ok: true });
});

app.get("/weight", auth, (req, res) => {
  res.json(db.prepare("SELECT date, weight_kg FROM weight_logs WHERE user_id = ? ORDER BY date DESC LIMIT 90").all(uid(req)));
});

// ---------- foods ----------
app.get("/foods/search", auth, (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json([]);
  const rows = db
    .prepare(
      `SELECT * FROM foods WHERE name LIKE ? AND (created_by IS NULL OR created_by = ?)
       ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, length(name) LIMIT 30`
    )
    .all(`%${q}%`, uid(req), `${q}%`);
  res.json(rows);
});

const foodSchema = z.object({
  name: z.string().min(1),
  serving_desc: z.string().min(1),
  serving_g: z.number().positive(),
  kcal: z.number().min(0),
  protein_g: z.number().min(0),
  carbs_g: z.number().min(0),
  fat_g: z.number().min(0),
  source: z.enum(["label", "user"]).default("user"),
});

app.post("/foods", auth, (req, res) => {
  const f = parse(foodSchema, req.body, res);
  if (!f) return;
  const info = db
    .prepare("INSERT INTO foods (name, serving_desc, serving_g, kcal, protein_g, carbs_g, fat_g, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(f.name, f.serving_desc, f.serving_g, f.kcal, f.protein_g, f.carbs_g, f.fat_g, f.source, uid(req));
  res.json({ id: Number(info.lastInsertRowid), ...f });
});

// ---------- diary ----------
const entrySchema = z.object({
  date: dateStr,
  meal: mealEnum,
  name: z.string().min(1),
  amount_desc: z.string().min(1),
  kcal: z.number().min(0),
  protein_g: z.number().min(0),
  carbs_g: z.number().min(0),
  fat_g: z.number().min(0),
  source: z.enum(["search", "ai_photo", "label", "quick"]),
});

app.get("/diary", auth, (req, res) => {
  const date = parse(dateStr, req.query.date, res);
  if (!date) return;
  const entries = db.prepare("SELECT * FROM diary_entries WHERE user_id = ? AND date = ? ORDER BY id").all(uid(req), date);
  res.json(entries);
});

app.post("/diary", auth, (req, res) => {
  const body = parse(z.union([entrySchema, z.array(entrySchema).min(1).max(30)]), req.body, res);
  if (!body) return;
  const list = Array.isArray(body) ? body : [body];
  const insert = db.prepare(
    `INSERT INTO diary_entries (user_id, date, meal, name, amount_desc, kcal, protein_g, carbs_g, fat_g, source)
     VALUES (@user_id, @date, @meal, @name, @amount_desc, @kcal, @protein_g, @carbs_g, @fat_g, @source)`
  );
  transaction(() => list.forEach((e) => insert.run({ user_id: uid(req), ...e })));
  res.json({ ok: true, added: list.length });
});

app.delete("/diary/:id", auth, (req, res) => {
  const info = db.prepare("DELETE FROM diary_entries WHERE id = ? AND user_id = ?").run(Number(req.params.id), uid(req));
  res.json({ ok: info.changes > 0 });
});

app.get("/diary/summary", auth, (req, res) => {
  const b = parse(z.object({ from: dateStr, to: dateStr }), req.query, res);
  if (!b) return;
  res.json(
    db
      .prepare(
        `SELECT date, ROUND(SUM(kcal)) AS kcal, ROUND(SUM(protein_g),1) AS protein_g, ROUND(SUM(carbs_g),1) AS carbs_g, ROUND(SUM(fat_g),1) AS fat_g
         FROM diary_entries WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`
      )
      .all(uid(req), b.from, b.to)
  );
});

// ---------- AI ----------
const aiLimiter = new Map<number, number[]>(); // simple per-user rate limit: 20 AI calls / 10 min
function allowAi(userId: number) {
  const now = Date.now();
  const recent = (aiLimiter.get(userId) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 20) return false;
  recent.push(now);
  aiLimiter.set(userId, recent);
  return true;
}

function aiError(e: unknown, res: Response, next: NextFunction) {
  console.error("AI error:", e);
  if (e instanceof AiError) return res.status(e.status).json({ error: e.message });
  if (e instanceof Anthropic.APIError) {
    const msg = e.status === 401 ? "AI key is missing or invalid on the server" : "The AI service is busy or unavailable — please try again";
    return res.status(502).json({ error: msg });
  }
  next(e);
}

app.post("/ai/meal", auth, async (req, res, next) => {
  const b = parse(
    z.object({
      image_base64: z.string().min(100),
      media_type: mediaType,
      total_grams: z.number().positive().max(5000).nullable().default(null),
      note: z.string().max(300).nullable().default(null),
    }),
    req.body,
    res
  );
  if (!b) return;
  if (!allowAi(uid(req))) return res.status(429).json({ error: "Too many scans — try again in a few minutes" });
  try {
    res.json(await analyzeMeal(b.image_base64, b.media_type, b.total_grams, b.note));
  } catch (e) {
    aiError(e, res, next);
  }
});

app.post("/ai/label", auth, async (req, res, next) => {
  const b = parse(z.object({ image_base64: z.string().min(100), media_type: mediaType }), req.body, res);
  if (!b) return;
  if (!allowAi(uid(req))) return res.status(429).json({ error: "Too many scans — try again in a few minutes" });
  try {
    res.json(await analyzeLabel(b.image_base64, b.media_type));
  } catch (e) {
    aiError(e, res, next);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`FittonesuGo API listening on http://0.0.0.0:${PORT}`));
