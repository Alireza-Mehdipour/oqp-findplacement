/**
 * Backend proxy for OQP-FindPlacement.
 * Holds the Anthropic API key privately (as an environment variable on the
 * server) and forwards the app's requests to the Anthropic Messages API.
 * The browser never sees the key — it only sends the shared app password.
 */

const ALLOWED_MODEL = "claude-sonnet-4-6"; // the only model this proxy will call
const MAX_TOKENS_CAP = 4000;               // hard ceiling per request

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "POST only" } });
  }

  // --- password gate ---
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: { message: "Server is missing the APP_PASSWORD environment variable" } });
  }
  const given = req.headers["x-app-password"] || "";
  if (given !== expected) {
    return res.status(401).json({ error: { message: "Wrong app password" } });
  }

  // --- API key check ---
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: "Server is missing the ANTHROPIC_API_KEY environment variable" } });
  }

  // --- clamp the request so a modified client can't run up costs ---
  const body = req.body || {};
  body.model = ALLOWED_MODEL;
  body.max_tokens = Math.min(Number(body.max_tokens) || 2000, MAX_TOKENS_CAP);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: { message: "Upstream request failed: " + e.message } });
  }
}
