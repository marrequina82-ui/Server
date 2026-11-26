import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SEED_FOODS } from "./seedFoods.js";

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "fittonesugo.db");
// Node's built-in SQLite (Node 22.13+): no native compile step, works on Windows without Visual Studio.
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

/** Run fn inside a transaction; rolls back if it throws. */
export function transaction(fn: () => void) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sex TEXT NOT NULL,              -- 'female' | 'male'
  birth_year INTEGER NOT NULL,
  height_cm REAL NOT NULL,
  weight_kg REAL NOT NULL,
  goal_weight_kg REAL NOT NULL,
  activity TEXT NOT NULL,         -- sedentary | light | moderate | active | very_active
  goal TEXT NOT NULL,             -- lose | maintain | gain
  weekly_rate_kg REAL NOT NULL,   -- 0, 0.25, 0.5, 0.75
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  serving_desc TEXT NOT NULL,     -- e.g. '1 cup (158 g)'
  serving_g REAL NOT NULL,
  kcal REAL NOT NULL,             -- per serving
  protein_g REAL NOT NULL,
  carbs_g REAL NOT NULL,
  fat_g REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',  -- seed | label | user
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);

CREATE TABLE IF NOT EXISTS diary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,             -- YYYY-MM-DD (user's local date)
  meal TEXT NOT NULL,             -- breakfast | lunch | dinner | snacks
  name TEXT NOT NULL,
  amount_desc TEXT NOT NULL,      -- e.g. '150 g' or '1.5 servings'
  kcal REAL NOT NULL,
  protein_g REAL NOT NULL,
  carbs_g REAL NOT NULL,
  fat_g REAL NOT NULL,
  source TEXT NOT NULL,           -- search | ai_photo | label | quick
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary_entries(user_id, date);

CREATE TABLE IF NOT EXISTS weight_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  UNIQUE(user_id, date)
);
`);

const userCols = db.prepare("PRAGMA table_info(users)").all() as unknown as { name: string }[];
if (!userCols.some((c) => c.name === "avatar")) {
  // "preset:<id>" for a built-in avatar, or a small "data:image/jpeg;base64,..." photo.
  db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
}
if (!userCols.some((c) => c.name === "firebase_uid")) {
  // Set once the account signs in through Firebase. NULL = old password account not moved yet.
  db.exec("ALTER TABLE users ADD COLUMN firebase_uid TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)");

const profileCols = db.prepare("PRAGMA table_info(profiles)").all() as unknown as { name: string }[];
if (!profileCols.some((c) => c.name === "macro_style")) {
  db.exec("ALTER TABLE profiles ADD COLUMN macro_style TEXT NOT NULL DEFAULT 'balanced'");
}

const count = (db.prepare("SELECT COUNT(*) AS n FROM foods WHERE source = 'seed'").get() as unknown as { n: number }).n;
if (count === 0) {
  const insert = db.prepare(
    "INSERT INTO foods (name, serving_desc, serving_g, kcal, protein_g, carbs_g, fat_g, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'seed')"
  );
  transaction(() => {
    for (const f of SEED_FOODS) insert.run(f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
  });
}
