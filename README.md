# OQP-FindPlacement — standalone web app

CV in → matched Melbourne job ads out, with company contacts, as an .xlsx file.
This version runs on your own hosting with your own Anthropic API key, so your
friends can use it with **no Claude account** — just the link and the app password.

## How it is structured

- `src/App.jsx` — the whole user interface (React + Vite).
- `api/claude.js` — a tiny backend function. It holds your Anthropic API key
  privately on the server, checks the app password, and forwards requests to
  the Anthropic API. The key is **never** exposed to the browser.

## One-time setup (about 20 minutes)

### 1. Get an Anthropic API key
1. Go to https://console.anthropic.com and sign up.
2. Add billing (Settings → Billing). You pay per use; see "Costs" below.
3. Create an API key (Settings → API keys) and copy it. Treat it like a bank password.

### 2. Put this project on GitHub
1. Create a free account at https://github.com if you don't have one.
2. Create a new repository (e.g. `oqp-findplacement`) and upload this folder's
   contents (GitHub's web uploader is fine — drag the files in).

### 3. Deploy on Vercel (free)
1. Sign up at https://vercel.com with your GitHub account.
2. Click **Add New → Project** and import your repository.
   Vercel auto-detects Vite; accept the defaults.
3. Before deploying, open **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = your key from step 1
   - `APP_PASSWORD` = any password you choose for your friends
4. Click **Deploy**. In a minute you get a URL like
   `https://oqp-findplacement.vercel.app` — that's the link to share.

Send friends the URL **and** the app password. That's all they need.

## Costs — read this once

- Hosting on Vercel's free tier: **$0** for this scale.
- Anthropic usage: you pay per run. A full run (30 companies, contacts on)
  makes ~25–40 model calls, many with web search, and typically costs on the
  order of a dollar or two; smaller runs cost less. Prices change — check
  https://claude.com/pricing#api for current rates.
- **Set a monthly spend limit** in the Anthropic console (Settings → Limits).
  This is your real safety net: even if the password leaks, spending stops
  at your cap.
- If the password ever leaks, change `APP_PASSWORD` in Vercel and redeploy —
  old users are locked out instantly.

## Running locally (optional, for testing)

    npm install
    npx vercel dev        # runs frontend + the api/ function together

(`npm run dev` alone runs only the frontend — the /api/claude function needs
`vercel dev` or a deployment.)

## Changing things later

Edit `src/App.jsx`, push to GitHub, and Vercel redeploys automatically.
The Anthropic web-search tool must be available on your API account; if a
search call errors with a message about the tool, check the tool settings in
the Anthropic console.
