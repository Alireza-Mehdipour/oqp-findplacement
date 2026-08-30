# OQP-FindPlacement

**CV in → matched Melbourne job advertisements out, with company contacts, as an Excel file.**

A web app that reads a candidate's CV, searches current job advertisements across Australian
job platforms, scores each advertisement against the CV, and produces a spreadsheet of
placement leads including publicly listed company contact details.

Built for university placement outreach in Melbourne, Australia, but the search region and
criteria are easy to adapt.

---

## What it does

1. **Reads a CV** — pasted text, or an uploaded `.pdf`, `.docx` or plain-text file. It extracts
   skills, qualifications, the candidate's stated title and their target field.
2. **Searches job platforms** — multiple passes across SEEK, Indeed, Jora, CareerOne,
   EthicalJobs, publicly listed LinkedIn jobs, startup boards and companies' own career pages.
3. **Matches and ranks** — scores each advertisement against the CV data, with a configurable
   minimum alignment threshold.
4. **Finds contacts** — searches for publicly published HR / recruitment contacts, phone
   numbers, websites and office addresses for each matched company.
5. **Exports to Excel** — one row per lead with eight columns: Job Title, Company Name,
   Industry Sector, Aligned Key Skills, Relevant People Contacts, Website URL, Company Phone
   Number, Office Location.

## Design decisions worth knowing

- **Title-driven matching.** The CV's stated title defines the target field. For career
  changers (e.g. electrical engineering → cloud/IT), jobs in the *previous* field are scored
  down heavily, while skills from that previous career still count as transferable evidence
  toward target-field roles.
- **Placement-appropriate only.** Senior, Lead, Principal, Head-of, Director and Chief level
  roles are filtered out at three points: the search instruction, a hard title filter, and the
  scoring stage.
- **SME and recency priority.** Ranking is a composite of alignment percentage, a bonus for
  small and medium employers, and a penalty that grows with the age of the advertisement.
- **Chat refinement.** A built-in assistant turns plain-language instructions
  ("only local council jobs", "part-time roles only") into active directives applied across
  every stage of the next run.
- **Two-phase research.** Search-enabled calls report findings as free text; a second,
  search-free call converts those notes to strict JSON. This is far more reliable than asking
  a single search call to return JSON directly.

## Architecture

```
src/App.jsx      React frontend — the entire UI and pipeline logic
api/claude.js    Serverless function — holds the API key server-side,
                 checks the app password, forwards requests to Anthropic
```

The Anthropic API key is **never** exposed to the browser. The frontend calls `/api/claude`;
only the serverless function holds the key and talks to `api.anthropic.com`.

## Deploy your own

You need an Anthropic API key and a free Vercel account.

1. **Fork or clone this repository.**
2. **Get an API key** at [console.anthropic.com](https://console.anthropic.com), add billing,
   and **set a monthly spend limit** (see Costs below).
3. **Import the repository into [Vercel](https://vercel.com)** (Add New → Project). Vercel
   auto-detects Vite; keep the default build settings.
4. **Add two environment variables** before deploying (see `.env.example`):
   - `ANTHROPIC_API_KEY` — your key
   - `APP_PASSWORD` — a password you invent, required to run a search
5. **Deploy.** Vercel gives you a URL. Share it, plus the password, with your users.

### Local development

```bash
npm install
npx vercel dev     # runs the frontend and the /api function together
```

`npm run dev` alone runs only the frontend; the API function needs `vercel dev`.

## Costs — read before deploying

Every run makes multiple AI calls, many of them using the web search tool, which is billed
in addition to token usage. **A full run (30 companies with contact lookup) can cost several
dollars.** In testing, roughly 8–12 full runs consumed about US$22.

Recommendations:
- Set a **monthly spend limit** in the Anthropic console before sharing the link.
- Start users on small runs: 10 companies, contact lookup off.
- Change `APP_PASSWORD` and redeploy if the password spreads further than intended.

## Privacy

- **No database, no storage.** CV content is processed in memory for the duration of a run
  and is gone when the page is closed. The serverless function does not log or persist it.
- **Transit is encrypted** (HTTPS) from the browser to the function to the Anthropic API.
- **CV content is not sent to job boards or search engines.** Searches use derived, non-identifying
  terms such as the target role and skills, never the candidate's name or contact details.
- **The Excel file is generated in the user's browser** and downloads directly to their device.
- Anthropic does not use API data to train its models by default — see
  [privacy.anthropic.com](https://privacy.anthropic.com).

If you modify `api/claude.js`, do not add request-body logging: that would undo the first point.

## Limitations

- Coverage is limited to what web search can reach. SEEK, Indeed, Jora, CareerOne and company
  career pages index well; LinkedIn walls off most listings from external tools, so its
  contribution is small.
- Contact details are limited to publicly published information. Direct personal emails for
  hiring managers are often not public, so results frequently give a general HR or careers
  address. **Verify before outreach.**
- Alignment percentages are model estimates from advertisement text. Treat borderline matches
  as leads to verify, not confirmed fits.
- Job boards change daily; two runs on different days will return different results.

## Contributing

Issues and pull requests are welcome. Useful directions: additional job platforms, other
cities or countries, cost reduction, and smarter deduplication across search passes.

## License

MIT — see [LICENSE](LICENSE).

Built by [Alireza Mehdipour](https://github.com/Alireza-Mehdipour).
