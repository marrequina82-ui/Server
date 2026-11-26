// Discord sign-in (Firebase has no Discord provider). The app runs the OAuth authorization-code + PKCE
// flow and sends us the code; we exchange it with the client secret and read the verified identity.

export interface DiscordIdentity {
  id: string;
  email: string | null; // only set when Discord says it is verified
  name: string;
}

export class OAuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function json(res: Response, what: string) {
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new OAuthError(`${what} failed: ${data.error_description ?? data.error ?? res.status}`, 401);
  return data;
}

export async function verifyDiscord(b: { code: string; code_verifier: string; redirect_uri: string; client_id: string }): Promise<DiscordIdentity> {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const secret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !secret) throw new OAuthError("Discord sign-in isn't set up on the server", 501);
  if (b.client_id !== clientId) throw new OAuthError("Unknown Discord client", 401);

  const form = new URLSearchParams({ grant_type: "authorization_code", code: b.code, code_verifier: b.code_verifier, redirect_uri: b.redirect_uri, client_id: clientId, client_secret: secret });
  const tok = await json(await fetch("https://discord.com/api/oauth2/token", { method: "POST", body: form }), "Discord sign-in");
  const u = await json(await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tok.access_token}` } }), "Discord profile");
  return { id: String(u.id), email: u.verified && u.email ? String(u.email).toLowerCase() : null, name: u.global_name || u.username || "Discord user" };
}
