import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// FIREBASE_SERVICE_ACCOUNT in .env: path to the service-account JSON downloaded from
// Firebase console → Project settings → Service accounts → Generate new private key.
function app() {
  const existing = getApps()[0];
  if (existing) return existing;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!path) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set on the server");
  return initializeApp({ credential: cert(JSON.parse(readFileSync(path, "utf8"))) });
}

export const adminAuth = () => getAuth(app());
