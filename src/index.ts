import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import bcrypt from "bcryptjs";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { computeTargets, type ProfileInput } from "./nutrition.js";
import { AiError, analyzeLabel, analyzeMeal } from "./ai.js";
import { adminAuth } from "./firebase.js";
import { OAuthError, verifyDiscord } from "./oauth.js";

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // base64 photos

// ---------- helpers ----------
type AuthedRequest = Request & { fb: DecodedIdToken; userId: number };

/** Verifies the Firebase ID token in the Authorization header. Does not touch the local users table. */
async function firebaseAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    (req as AuthedRequest).fb = await adminAuth().verifyIdToken(token);
    next();
  } catch (e) {
    if (e instanceof Error && /FIREBASE_SERVICE_ACCOUNT/.test(e.message)) return res.status(500).json({ error: e.message });
    res.status(401).json({ error: "Session expired, please sign in again" });
  }
}

/** Local user for this Firebase account: linked by uid, else by verified email, else created. */
function localUserFor(fb: DecodedIdToken): number {
  const linked = db.prepare("SELECT id FROM users WHERE firebase_uid = ?").get(fb.uid) as unknown as { id: number } | undefined;
  if (linked) return linked.id;
  const email = fb.email?.toLowerCase();
  if (email && fb.email_verified) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ? AND firebase_uid IS NULL").get(email) as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE users SET firebase_uid = ? WHERE id = ?").run(fb.uid, existing.id);
      return existing.id;
    }
  }
  // An unverified email may belong to an old account; keep it unique by not reusing it.
  const taken = email && db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  const storedEmail = email && !taken ? email : `${fb.uid}@users.fittonesugo.local`;
  const name = (fb.name as string | undefined) || email?.split("@")[0] || "FittonesuGo user";
  return Number(db.prepare("INSERT INTO users (email, password_hash, name, firebase_uid) VALUES (?, '', ?, ?)").run(storedEmail, name, fb.uid).lastInsertRowid);
}

function auth(req: Request, res: Response, next: NextFunction) {
  firebaseAuth(req, res, () => {
    const r = req as AuthedRequest;
    r.userId = localUserFor(r.fb);
    next();
  });
}

const uid = (req: Request) => (req as AuthedRequest).userId;

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

// ---------- auth (Firebase) ----------
const legacyBody = z.object({ email: z.email(), password: z.string().min(1) });

function legacyUser(email: string, password: string) {
  const u = db.prepare("SELECT id, password_hash FROM users WHERE email = ? AND firebase_uid IS NULL").get(email.toLowerCase()) as unknown as
    | { id: number; password_hash: string }
    | undefined;
  return u && u.password_hash && bcrypt.compareSync(password, u.password_hash) ? u.id : null;
}

// Old (pre-Firebase) accounts: the app asks whether email + password match one before moving it to Firebase.
app.post("/auth/legacy/check", (req, res) => {
  const b = parse(legacyBody, req.body, res);
  if (!b) return;
  res.json({ ok: legacyUser(b.email, b.password) !== null });
});

// Called right after the app created the Firebase account for an old user: links it to their existing data.
app.post("/auth/legacy/link", firebaseAuth, (req, res) => {
  const b = parse(legacyBody, req.body, res);
  if (!b) return;
  const fb = (req as AuthedRequest).fb;
  if (fb.email?.toLowerCase() !== b.email.toLowerCase()) return res.status(403).json({ error: "Email doesn't match this session" });
  const id = legacyUser(b.email, b.password);
  if (id === null) return res.status(401).json({ error: "Wrong email or password" });
  db.prepare("UPDATE users SET firebase_uid = ?, password_hash = '' WHERE id = ?").run(fb.uid, id);
  res.json({ ok: true });
});

// Discord isn't a Firebase provider: verify it here and hand back a Firebase custom token.
app.post("/auth/discord", async (req, res, next) => {
  const b = parse(z.object({ code: z.string().min(1), code_verifier: z.string().min(43), redirect_uri: z.string().min(1), client_id: z.string().min(1) }), req.body, res);
  if (!b) return;
  try {
    const who = await verifyDiscord(b);
    const firebaseUid = `discord:${who.id}`;
    const a = adminAuth();
    try {
      await a.getUser(firebaseUid);
    } catch {
      const emailFree = who.email ? await a.getUserByEmail(who.email).then(() => false, () => true) : false;
      await a.createUser({ uid: firebaseUid, displayName: who.name, ...(who.email && emailFree ? { email: who.email, emailVerified: true } : {}) });
    }
    res.json({ firebase_token: await a.createCustomToken(firebaseUid) });
  } catch (e) {
    if (e instanceof OAuthError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
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
  macro_style: z.enum(["balanced", "high_protein", "low_carb"]).default("balanced"),
});

app.get("/me", auth, (req, res) => {
  const user = db.prepare("SELECT id, name, email, avatar FROM users WHERE id = ?").get(uid(req));
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(uid(req)) as unknown as ProfileInput | undefined;
  res.json({ user, profile: profile ?? null, targets: profile ? computeTargets(profile) : null });
});

app.put("/profile", auth, (req, res) => {
  const p = parse(profileSchema, req.body, res);
  if (!p) return;
  db.prepare(
    `INSERT INTO profiles (user_id, sex, birth_year, height_cm, weight_kg, goal_weight_kg, activity, goal, weekly_rate_kg, macro_style, updated_at)
     VALUES (@user_id, @sex, @birth_year, @height_cm, @weight_kg, @goal_weight_kg, @activity, @goal, @weekly_rate_kg, @macro_style, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET sex=@sex, birth_year=@birth_year, height_cm=@height_cm, weight_kg=@weight_kg,
       goal_weight_kg=@goal_weight_kg, activity=@activity, goal=@goal, weekly_rate_kg=@weekly_rate_kg, macro_style=@macro_style, updated_at=datetime('now')`
  ).run({ user_id: uid(req), ...p });
  res.json({ profile: p, targets: computeTargets(p) });
});

const avatarSchema = z.object({
  avatar: z
    .string()
    .max(400_000, "photo is too large")
    .regex(/^(preset:[a-z0-9_-]{1,32}|data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+)$/, "must be a preset or a JPEG/PNG photo")
    .nullable(),
});

app.put("/me/avatar", auth, (req, res) => {
  const b = parse(avatarSchema, req.body, res);
  if (!b) return;
  db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(b.avatar, uid(req));
  res.json({ avatar: b.avatar });
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

// ---------- privacy ----------
app.get("/export", auth, (req, res) => {
  const id = uid(req);
  res.json({
    exported_at: new Date().toISOString(),
    user: db.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(id),
    profile: db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(id) ?? null,
    diary: db.prepare("SELECT date, meal, name, amount_desc, kcal, protein_g, carbs_g, fat_g, source, created_at FROM diary_entries WHERE user_id = ? ORDER BY date, id").all(id),
    weights: db.prepare("SELECT date, weight_kg FROM weight_logs WHERE user_id = ? ORDER BY date").all(id),
    saved_foods: db.prepare("SELECT name, serving_desc, serving_g, kcal, protein_g, carbs_g, fat_g, source FROM foods WHERE created_by = ?").all(id),
  });
});

app.delete("/diary", auth, (req, res) => {
  const info = db.prepare("DELETE FROM diary_entries WHERE user_id = ?").run(uid(req));
  res.json({ ok: true, deleted: Number(info.changes) });
});

app.post("/account/delete", auth, async (req, res, next) => {
  const b = parse(z.object({ confirm: z.literal("DELETE") }), req.body, res);
  if (!b) return;
  const fb = (req as AuthedRequest).fb;
  // Password accounts re-enter their password in the app first, which refreshes auth_time.
  if (fb.firebase.sign_in_provider === "password" && Date.now() / 1000 - fb.auth_time > 300) {
    return res.status(401).json({ error: "Please enter your password again to confirm" });
  }
  try {
    transaction(() => {
      // Saved foods would otherwise become visible to everyone once created_by is cleared.
      db.prepare("DELETE FROM foods WHERE created_by = ?").run(uid(req));
      db.prepare("DELETE FROM users WHERE id = ?").run(uid(req));
    });
    await adminAuth().deleteUser(fb.uid);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
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
