import React, { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import {
  Upload, FileText, Search, Users, Download, CheckCircle2, AlertCircle,
  Loader2, MapPin, Briefcase, Building2, Clock, Link2, Phone, XCircle
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  OQP-FindPlacement — robust pipeline build                          */
/*  CV in → Melbourne job ads out, with company contacts, as .xlsx     */
/* ------------------------------------------------------------------ */

const STAGES = [
  { id: "extract", label: "Extract CV data", icon: FileText },
  { id: "search", label: "Search platforms", icon: Search },
  { id: "match", label: "Match & rank", icon: CheckCircle2 },
  { id: "contacts", label: "Find contacts", icon: Users },
];

const COLUMNS = [
  "Job Title", "Company Name", "Industry Sector", "Aligned Key Skills",
  "Relevant People Contacts", "Website URL", "Company Phone Number", "Office Location",
];

// Placement tool: senior-level roles are never appropriate results.
const SENIOR_RE = /\b(senior|snr|sr\.?|lead|principal|head\s+of|chief|director|executive)\b/i;

const CHAT_BRIEF = `You are the refinement assistant inside OQP-FindPlacement, an app that matches a CV to placement-appropriate job advertisements in Melbourne, Australia (junior to mid level — never senior/lead/principal). The user chats with you to add details that make the job search more accurate and practical — for example "only search jobs in local councils", "prefer part-time", "focus on the health sector", "exclude recruitment agencies".

Your job: hold a short, helpful conversation, and maintain a running list of search directives — concise imperative phrases that the search pipeline will follow (e.g. "Only local council employers"). Directives must only concern finding, filtering, or scoring jobs; politely decline anything unrelated (you cannot change the app's output format, columns, or behaviour beyond the search).

Every reply must be ONLY a JSON object, no markdown: {"reply":"your short conversational answer","directives":["the COMPLETE updated list from the whole conversation"]}`;

/* ---------------------------- API layer ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Set from the password field in the UI. Sent to OUR backend only —
// the Anthropic API key never exists in this frontend.
let APP_PASSWORD = "";

// Single request with retry on transient failures (429 rate limit, 5xx).
async function apiRequest(body) {
  let lastErr = "API unavailable";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Password": APP_PASSWORD },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = "Network error — check your connection";
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    lastErr = data?.error?.message || `API error ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      await sleep(2500 * (attempt + 1)); // transient — back off and retry
      continue;
    }
    throw new Error(lastErr); // non-retryable (e.g. 400)
  }
  throw new Error(lastErr);
}

// Full model turn. Handles web-search pauses (stop_reason: "pause_turn"),
// which must be continued by resending the partial assistant content.
async function callClaude(messages, { useSearch = false } = {}) {
  let convo = [...messages];
  for (let turn = 0; turn < 8; turn++) {
    const body = { model: "claude-sonnet-4-6", max_tokens: 2000, messages: convo };
    if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    const data = await apiRequest(body);
    if (data.stop_reason === "pause_turn") {
      convo = [...convo, { role: "assistant", content: data.content }];
      continue;
    }
    return (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  throw new Error("Search turn did not complete");
}

function parseJSON(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch (_) {}
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch (_) {} }
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  throw new Error("Response was not valid JSON");
}

// Two-phase research: (1) search-enabled call reports findings as free text —
// no JSON demanded, so the model can search and cite naturally;
// (2) a clean, search-free call converts the notes into strict JSON.
async function researchToJSON(searchPrompt, jsonSpec) {
  const notes = await callClaude(
    [{ role: "user", content: searchPrompt }],
    { useSearch: true }
  );
  if (!notes) return [];
  try { // in case the model returned JSON directly anyway
    const direct = parseJSON(notes);
    if (Array.isArray(direct)) return direct;
  } catch (_) {}
  const converted = await callClaude([{
    role: "user",
    content: `Convert the research notes below into JSON. Return ONLY valid JSON — no markdown fences, no commentary. Include only items actually present in the notes. If the notes contain no usable items, return [].

Required JSON shape:
${jsonSpec}

Research notes:
${notes.slice(0, 7000)}`,
  }]);
  return parseJSON(converted);
}

// Search-free structured call with one self-repair retry.
async function structuredCall(prompt) {
  const first = await callClaude([{ role: "user", content: prompt }]);
  try { return parseJSON(first); } catch (_) {}
  const retry = await callClaude([{
    role: "user",
    content: `The following was meant to be valid JSON but is malformed or incomplete. Output the corrected, complete JSON ONLY — no commentary:\n\n${first.slice(0, 6000)}`,
  }]);
  return parseJSON(retry);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

/* ------------------------------ App ------------------------------ */

export default function OQPFindPlacement() {
  const [cvText, setCvText] = useState("");
  const [fileName, setFileName] = useState(null);
  const [pdfData, setPdfData] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [doneStages, setDoneStages] = useState([]);
  const [log, setLog] = useState([]);
  const [profile, setProfile] = useState(null);
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [threshold, setThreshold] = useState(40);      // 0 = no minimum
  const [targetCount, setTargetCount] = useState(30);  // companies to deliver
  const [findContacts, setFindContacts] = useState(true);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [directives, setDirectives] = useState([]);
  const [appPass, setAppPass] = useState("");
  const chatRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const logRef = useRef(null);
  const cancelRef = useRef(false);

  const pushLog = useCallback((msg, kind = "info") => {
    setLog((l) => [...l, { t: new Date().toLocaleTimeString(), msg, kind }]);
    setTimeout(() => logRef.current?.scrollTo({ top: 99999, behavior: "smooth" }), 50);
  }, []);

  const checkCancel = () => {
    if (cancelRef.current) throw new Error("__cancelled__");
  };

  /* ------------------------- file handling ------------------------- */

  async function handleFile(file) {
    setError(null);
    setFileName(file.name);
    setPdfData(null);
    const ext = file.name.split(".").pop().toLowerCase();
    try {
      if (ext === "pdf") {
        const b64 = await fileToBase64(file);
        setPdfData(b64);
        setCvText("");
        pushLog(`Loaded PDF "${file.name}" — text will be read during extraction.`);
      } else if (ext === "docx") {
        const buf = await file.arrayBuffer();
        const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
        setCvText(value);
        pushLog(`Loaded "${file.name}" (${value.length.toLocaleString()} characters).`);
      } else {
        const text = await file.text();
        setCvText(text);
        pushLog(`Loaded "${file.name}" (${text.length.toLocaleString()} characters).`);
      }
    } catch (e) {
      setError(`Could not read ${file.name}: ${e.message}`);
      setFileName(null);
    }
  }

  /* ------------------------- chat refinement ------------------------- */

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || chatBusy) return;
    const newHistory = [...chatHistory, { role: "user", content: msg }];
    setChatHistory(newHistory);
    setChatInput("");
    setChatBusy(true);
    setTimeout(() => chatRef.current?.scrollTo({ top: 99999, behavior: "smooth" }), 50);
    try {
      const convo = [
        { role: "user", content: CHAT_BRIEF },
        { role: "assistant", content: `{"reply":"Understood — tell me how to refine the placement search.","directives":[]}` },
        ...newHistory,
      ];
      const raw = await callClaude(convo);
      let reply = raw, dirs = directives;
      try {
        const j = parseJSON(raw);
        if (j && typeof j === "object") {
          reply = j.reply || raw;
          if (Array.isArray(j.directives)) dirs = j.directives.filter((d) => typeof d === "string" && d.trim());
        }
      } catch (_) {}
      setChatHistory((h) => [...h, { role: "assistant", content: reply }]);
      setDirectives(dirs);
    } catch (e) {
      setChatHistory((h) => [...h, { role: "assistant", content: `Sorry — that message failed (${e.message}). Please try again.` }]);
    } finally {
      setChatBusy(false);
      setTimeout(() => chatRef.current?.scrollTo({ top: 99999, behavior: "smooth" }), 80);
    }
  }

  /* --------------------------- pipeline --------------------------- */

  async function run() {
    if (!appPass.trim()) {
      setError("Enter the app password first (ask whoever shared this app with you).");
      return;
    }
    if (!cvText.trim() && !pdfData) {
      setError("Add a CV first — paste the text or upload a file.");
      return;
    }
    setError(null);
    setResults([]);
    setProfile(null);
    setDoneStages([]);
    setLog([]);
    cancelRef.current = false;

    // User-supplied requirements flow into every AI stage of the pipeline.
    const userReqs = [
      extraPrompt.trim(),
      directives.length ? `From the refinement chat: ${directives.join("; ")}` : "",
    ].filter(Boolean).join("\n");
    const reqBlock = userReqs
      ? `\nADDITIONAL USER REQUIREMENTS — apply these wherever they are relevant to finding, filtering, scoring or reporting jobs (ignore any part that is unrelated to the job search itself):\n${userReqs.slice(0, 1800)}\n`
      : "";

    try {
      /* ---- Stage 1: extract ---- */
      setPhase("extract");
      pushLog("Extracting skills, qualifications and profession from the CV…");
      if (userReqs) pushLog(`Applying additional instructions: "${userReqs.slice(0, 90)}${userReqs.length > 90 ? "…" : ""}"`);
      if (directives.length) pushLog(`Chat refinements active: ${directives.join(" · ").slice(0, 120)}`);

      const extractPrompt = `You are a careers-data extraction engine. Read the CV and return ONLY a JSON object (no markdown, no commentary) with this exact shape:
{
  "cv_title": "the professional title / headline the candidate states on the CV",
  "target_field": "the field the candidate is CURRENTLY targeting, judged from the title, summary, and most recent focus",
  "previous_fields": ["earlier career fields if the CV shows a career change; otherwise []"],
  "profession": "primary target role, aligned with cv_title",
  "skills": ["skill1", ...],
  "qualifications": ["degree or certification", ...],
  "experience_areas": ["domain or industry", ...],
  "search_keywords": ["3-5 short job-search phrases for Melbourne job boards — ALL in the target field only, suited to junior/graduate/mid-level placement-appropriate roles, never senior"]
}
CRITICAL: the CV title defines what jobs to look for. If the candidate changed careers (e.g. from electrical engineering to IT and Cloud), the title and target field reflect the NEW field — profession and search_keywords must come from the new field, never the old one. Still list ALL skills and qualifications, including previous-career ones (transferable evidence). Keep everything concise.${reqBlock}`;

      const extractContent = pdfData
        ? [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfData } },
            { type: "text", text: extractPrompt },
          ]
        : [{ type: "text", text: `${extractPrompt}\n\nCV:\n${cvText.slice(0, 30000)}` }];

      let prof;
      try {
        prof = parseJSON(await callClaude([{ role: "user", content: extractContent }]));
      } catch (_) {
        pushLog("Extraction response needed a repair pass — retrying…", "warn");
        prof = await structuredCall(
          pdfData ? extractPrompt + "\n\n(Use the PDF provided earlier — if unavailable, say so.)"
                  : `${extractPrompt}\n\nCV:\n${cvText.slice(0, 30000)}`
        );
      }
      checkCancel();
      setProfile(prof);
      setDoneStages(["extract"]);
      pushLog(`Profile: ${prof.cv_title || prof.profession} — ${(prof.skills || []).length} skills, ${(prof.qualifications || []).length} qualifications.`, "ok");

      /* ---- Stage 2: search ---- */
      setPhase("search");
      pushLog(`Target: ${targetCount} companies — prioritising small/medium businesses and the newest ads.`);
      const platformSets = [
        "SEEK (seek.com.au), sorted by most recent",
        "SEEK (seek.com.au), small and medium employers rather than corporates or agencies",
        "Indeed Australia (au.indeed.com), recent listings",
        "Jora and CareerOne, recent listings",
        "EthicalJobs, LinkedIn jobs, and startup job boards",
        "small Melbourne companies' own career pages",
      ];
      const careerChangeNote = (prof.previous_fields || []).length
        ? ` The candidate changed careers FROM ${prof.previous_fields.join(" and ")} — do NOT report jobs in ${prof.previous_fields.join(" or ")}.`
        : "";
      const jobJsonSpec = `[{"job_title":"","company":"","industry":"","location":"suburb, Melbourne VIC","url":"","requirements":"one line","company_size":"small|medium|large|unknown","date_posted":"as shown in the ad","days_since_posted":30}]`;

      let allJobs = [];
      const passes = targetCount <= 10 ? 3 : targetCount <= 25 ? 5 : 6;
      for (let i = 0; i < passes; i++) {
        checkCancel();
        pushLog(`Deep-search pass ${i + 1}/${passes}: ${platformSets[i]}…`);
        const searchPrompt = `Search the web for CURRENT published job advertisements in Melbourne, Australia on ${platformSets[i]} for this candidate:
CV title / target role: ${prof.cv_title || prof.profession}
Target field: ${prof.target_field || prof.profession}
Suggested queries: ${(prof.search_keywords || []).join("; ")}

Search ONLY for positions relevant to the CV title and target field.${careerChangeNote}${reqBlock}
This is a PLACEMENT tool: NEVER report Senior, Lead, Principal, Head-of, Director or Chief level positions — only junior, graduate, entry, or mid-level roles.
Prioritise (1) small and medium-size companies (under ~200 staff) over large corporates and recruitment agencies, and (2) the most recently posted ads — include recency terms like "this week" in some queries.

Run several searches, then report up to 6 real jobs you actually found, as concise notes. For each: job title, company, industry, suburb, URL, one-line requirements, company size (small/medium/large/unknown), when it was posted, and estimated days since posted (30 if unknown). If you find nothing, say "NO JOBS FOUND".`;
        try {
          const found = await researchToJSON(searchPrompt, jobJsonSpec);
          if (Array.isArray(found) && found.length > 0) {
            allJobs = allJobs.concat(found);
            pushLog(`Found ${found.length} listing(s).`, "ok");
          } else {
            pushLog(`Pass ${i + 1}: search completed, no listings matched.`, "warn");
          }
        } catch (e) {
          if (e.message === "__cancelled__") throw e;
          pushLog(`Pass ${i + 1} failed: ${e.message}`, "warn");
        }
      }
      const seen = new Set();
      allJobs = allJobs.filter((j) => {
        const k = `${(j.company || "").toLowerCase().trim()}|${(j.job_title || "").toLowerCase().trim()}`;
        if (seen.has(k) || !j.job_title) return false;
        seen.add(k);
        return true;
      });
      // Hard seniority filter — belt and braces on top of the search instruction.
      const beforeSenior = allJobs.length;
      allJobs = allJobs.filter((j) => !SENIOR_RE.test(j.job_title || ""));
      if (beforeSenior > allJobs.length) {
        pushLog(`Removed ${beforeSenior - allJobs.length} senior/lead/principal-level ad(s) — not placement-appropriate.`);
      }
      if (allJobs.length === 0) throw new Error("No job advertisements were found across any platform. Check the extracted profile above — if the title or keywords look wrong, adjust the CV wording and run again.");
      setDoneStages(["extract", "search"]);
      pushLog(`${allJobs.length} unique advertisements collected.`, "ok");

      /* ---- Stage 3: match & rank ---- */
      setPhase("match");
      pushLog(threshold > 0
        ? `Comparing advertisements against the CV data (${threshold}% minimum)…`
        : "Comparing advertisements against the CV data (no minimum — ranking only)…");
      const candidateData = JSON.stringify({
        cv_title: prof.cv_title, target_field: prof.target_field,
        previous_fields: prof.previous_fields || [],
        skills: prof.skills, qualifications: prof.qualifications,
        experience_areas: prof.experience_areas,
      });

      // Compact scoring: the model returns only {i, p, s} per job;
      // full job objects are merged back locally. Fits large batches
      // in the response budget without truncation.
      let scored = [];
      const matchBatch = 8;
      for (let off = 0; off < allJobs.length; off += matchBatch) {
        checkCancel();
        const chunk = allJobs.slice(off, off + matchBatch);
        pushLog(`Scoring ads ${off + 1}–${Math.min(off + matchBatch, allJobs.length)} of ${allJobs.length}…`);
        const numbered = chunk.map((j, k) =>
          `${k + 1}. ${j.job_title} at ${j.company} — ${j.industry || "?"} — requires: ${j.requirements || "?"}`
        ).join("\n");
        const matchPrompt = `Candidate:
${candidateData}

Jobs:
${numbered}

For each job, estimate what percentage of the candidate's combined data items (skills + qualifications + profession + experience areas) align with the job's requirements. RULES: (1) a job in one of the previous_fields scores under 20 regardless of skill overlap — jobs must fit the cv_title/target_field; (2) previous-career skills DO count when a target-field job asks for them (transferable evidence); (3) a job that clearly violates the additional user requirements below scores under 20; (4) Senior/Lead/Principal/Head-of level roles score under 20 — this tool finds placement-appropriate positions. Be realistic, not generous.${reqBlock}

Return ONLY a JSON array, no markdown: [{"i":1,"p":55,"s":["aligned skill","aligned skill"]}]
where i = job number above, p = alignment percent, s = up to 6 aligned key skills.`;
        try {
          const part = await structuredCall(matchPrompt);
          (Array.isArray(part) ? part : []).forEach((m) => {
            const job = chunk[(m.i || 0) - 1];
            if (job) scored.push({ ...job, alignment_percent: m.p || 0, aligned_skills: m.s || [] });
          });
        } catch (e) {
          if (e.message === "__cancelled__") throw e;
          pushLog(`One scoring batch failed (${e.message}) — skipped.`, "warn");
        }
      }
      scored = threshold > 0 ? scored.filter((j) => (j.alignment_percent || 0) >= threshold) : scored;
      if (scored.length === 0) throw new Error(`No jobs reached the ${threshold}% alignment threshold. Lower the minimum with the slider, or run again.`);
      const sizeBonus = (s) => (/small/i.test(s || "") ? 16 : /med/i.test(s || "") ? 10 : /unknown/i.test(s || "") ? 4 : 0);
      const recencyPenalty = (d) => Math.min(Number(d) || 30, 60) * 0.4;
      const priority = (j) => (j.alignment_percent || 0) + sizeBonus(j.company_size) - recencyPenalty(j.days_since_posted);
      scored.sort((a, b) => priority(b) - priority(a));
      scored = scored.slice(0, targetCount);
      if (scored.length < targetCount) pushLog(`${scored.length} companies qualified this run — ${threshold > 0 ? "lower the minimum or " : ""}run again to widen the sweep.`, "warn");
      setDoneStages(["extract", "search", "match"]);
      pushLog(`${scored.length} job(s) qualified and ranked.`, "ok");

      /* ---- Stage 4: contacts (optional) ---- */
      let withContacts = scored;
      if (findContacts) {
        setPhase("contacts");
        withContacts = [];
        const contactSpec = `[{"company":"","relevant_contacts":"Name — role — email, or 'Not publicly listed' (a general HR/careers email is fine)","website":"","phone":"","office_location":"address or suburb, Melbourne VIC"}]`;
        const batchSize = 4;
        for (let i = 0; i < scored.length; i += batchSize) {
          checkCancel();
          const batch = scored.slice(i, i + batchSize);
          pushLog(`Contacts ${i + 1}–${Math.min(i + batchSize, scored.length)} of ${scored.length}: ${batch.map((b) => b.company).join(", ")}…`);
          const contactPrompt = `Search the web for PUBLICLY LISTED contact details for these Melbourne companies, so a university placement office can reach out about student/graduate placement:
${batch.map((b) => `- ${b.company} (advertised: ${b.job_title})`).join("\n")}

For each company report as concise notes: a relevant publicly named contact (HR / talent / recruitment) with their publicly listed email if available, the main phone number, official website, and Melbourne office address. ONLY report details that are publicly published — never guess or invent emails or numbers; say "not publicly listed" for anything you cannot find.`;
          try {
            const contacts = await researchToJSON(contactPrompt, contactSpec);
            batch.forEach((job) => {
              const c = (Array.isArray(contacts) ? contacts : []).find((x) => {
                const a = (x.company || "").toLowerCase(), b = (job.company || "").toLowerCase();
                return a && b && (a.includes(b.slice(0, 8)) || b.includes(a.slice(0, 8)));
              }) || {};
              withContacts.push({ ...job, ...c, company: job.company });
            });
          } catch (e) {
            if (e.message === "__cancelled__") throw e;
            batch.forEach((job) => withContacts.push({ ...job }));
            pushLog(`Contact search failed for this batch (${e.message}) — rows kept without contacts.`, "warn");
          }
          setResults([...withContacts]); // stream partial results to the table
        }
      } else {
        pushLog("Contact search skipped (toggle is off).");
      }

      setResults(withContacts);
      setDoneStages(findContacts ? ["extract", "search", "match", "contacts"] : ["extract", "search", "match"]);
      setPhase("done");
      pushLog(`Done — ${withContacts.length} placement lead(s) ready. Download the Excel file below.`, "ok");
    } catch (e) {
      if (e.message === "__cancelled__") {
        setPhase("idle");
        pushLog("Run stopped. Partial results (if any) are shown below.", "warn");
        return;
      }
      setPhase("error");
      setError(e.message);
      pushLog(e.message, "err");
    }
  }

  function stopRun() {
    cancelRef.current = true;
    pushLog("Stopping after the current step…", "warn");
  }

  /* ---------------------------- export ---------------------------- */

  function downloadXlsx() {
    const rows = results.map((r) => ({
      "Job Title": r.job_title || "",
      "Company Name": r.company || "",
      "Industry Sector": r.industry || "",
      "Aligned Key Skills": (r.aligned_skills || []).join(", "),
      "Relevant People Contacts": r.relevant_contacts || "Not publicly listed",
      "Website URL": r.website || r.url || "",
      "Company Phone Number": r.phone || "Not publicly listed",
      "Office Location": r.office_location || r.location || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });
    ws["!cols"] = [28, 24, 20, 40, 44, 34, 20, 30].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Placement Leads");
    XLSX.writeFile(wb, "OQP-FindPlacement-Melbourne.xlsx");
  }

  const running = ["extract", "search", "match", "contacts"].includes(phase);
  const sizeClass = (s) => (/small/i.test(s || "") ? "sz-sm" : /med/i.test(s || "") ? "sz-md" : "sz-lg");

  /* ----------------------------- render ----------------------------- */

  return (
    <div className="oqp">
      <style>{CSS}</style>

      <header className="oqp-header">
        <div className="oqp-shell oqp-header-in">
          <div className="oqp-brand">
            <div className="oqp-mark" aria-hidden="true"><Briefcase size={17} /></div>
            <h1>OQP<span>·</span>FindPlacement</h1>
          </div>
          <p className="oqp-tag"><MapPin size={13} /> Melbourne, VIC · CV → matched job ads → contacts → .xlsx</p>
        </div>
      </header>

      <main className="oqp-shell oqp-main">

        {/* ---- Input panel ---- */}
        <section className="panel">
          <div className="panel-head">
            <span className="step-no">1</span>
            <div>
              <h2>Candidate CV</h2>
              <p>Paste the CV text, or upload a .pdf, .docx or plain-text file.</p>
            </div>
          </div>

          <div
            className={`dropzone ${dragOver ? "drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false);
              if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
            }}
          >
            <textarea
              value={cvText}
              onChange={(e) => { setCvText(e.target.value); setPdfData(null); setFileName(null); }}
              placeholder="Paste the CV text here — or drop a file anywhere in this box…"
              disabled={running}
              aria-label="CV text"
            />
            <div className="dropzone-bar">
              <input
                ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.rtf,.text" hidden
                onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])}
              />
              <button className="btn ghost" onClick={() => fileRef.current.click()} disabled={running}>
                <Upload size={15} /> Upload file
              </button>
              {fileName && <span className="filechip"><FileText size={13} /> {fileName}</span>}
            </div>
          </div>

          <div className="settings">
            <div className="setting">
              <div className="setting-top">
                <label htmlFor="align">Minimum skill alignment</label>
                <output className={threshold === 0 ? "off" : ""}>
                  {threshold === 0 ? "Off — include all" : `≥ ${threshold}%`}
                </output>
              </div>
              <input
                id="align" type="range" min={0} max={90} step={5} value={threshold}
                disabled={running} onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
            <div className="setting">
              <div className="setting-top">
                <label htmlFor="count">Companies to deliver</label>
                <output>up to {targetCount}</output>
              </div>
              <input
                id="count" type="range" min={5} max={50} step={5} value={targetCount}
                disabled={running} onChange={(e) => setTargetCount(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="extra">
            <label htmlFor="extra">Additional instructions for the AI <span>(optional)</span></label>
            <textarea
              id="extra" value={extraPrompt} disabled={running}
              onChange={(e) => setExtraPrompt(e.target.value)}
              placeholder="Anything else the search should consider — e.g. part-time or 3 days a week only · prefer fintech and health-tech companies · exclude recruitment agencies · must be reachable by public transport from the CBD · graduate-friendly roles…"
            />
          </div>

          <label className="checkrow">
            <input
              type="checkbox" checked={findContacts} disabled={running}
              onChange={(e) => setFindContacts(e.target.checked)}
            />
            Search for company contact details (slower — roughly doubles the run time)
          </label>

          <div className="actions">
            {error && <p className="error" role="alert"><AlertCircle size={15} /> {error}</p>}
            <input
              className="passfield" type="password" value={appPass} disabled={running}
              onChange={(e) => { APP_PASSWORD = e.target.value; setAppPass(e.target.value); }}
              placeholder="App password" aria-label="App password"
              autoComplete="current-password"
            />
            {running && (
              <button className="btn ghost" onClick={stopRun}>
                <XCircle size={15} /> Stop
              </button>
            )}
            <button className="btn primary run" onClick={run} disabled={running}>
              {running ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
              {running ? "Running…" : phase === "done" || phase === "error" ? "Run again" : "Find placements"}
            </button>
          </div>
        </section>

        {/* ---- Chat refinement panel ---- */}
        <section className="panel">
          <div className="panel-head slim">
            <span className="step-no">2</span>
            <div>
              <h2>Refine with the assistant</h2>
              <p>Optional — chat to make the search more accurate, e.g. "only search jobs in local councils" or "prefer part-time roles in health-tech".</p>
            </div>
          </div>

          {directives.length > 0 && (
            <div className="directives">
              <strong>Active refinements:</strong>
              {directives.map((d, i) => <span key={i} className="chip dchip">{d}</span>)}
              <button className="dclear" onClick={() => setDirectives([])} disabled={running || chatBusy}>clear</button>
            </div>
          )}

          {chatHistory.length > 0 && (
            <div className="chatbox" ref={chatRef}>
              {chatHistory.map((m, i) => (
                <div key={i} className={`bubble ${m.role === "user" ? "me" : "ai"}`}>{m.content}</div>
              ))}
              {chatBusy && <div className="bubble ai thinking"><Loader2 size={13} className="spin" /> thinking…</div>}
            </div>
          )}

          <div className="chatrow">
            <input
              type="text" value={chatInput} disabled={chatBusy || running}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
              placeholder='Type a refinement… e.g. "only local council jobs"'
              aria-label="Chat with the assistant"
            />
            <button className="btn primary" onClick={sendChat} disabled={chatBusy || running || !chatInput.trim()}>
              {chatBusy ? <Loader2 size={15} className="spin" /> : "Send"}
            </button>
          </div>
        </section>

        {/* ---- Pipeline stepper ---- */}
        <section className="stepper" aria-label="Pipeline progress">
          {STAGES.map((s, i) => {
            const active = phase === s.id;
            const done = doneStages.includes(s.id);
            const skipped = s.id === "contacts" && !findContacts;
            const Icon = s.icon;
            return (
              <div key={s.id} className={`stage ${done ? "done" : ""} ${active ? "active" : ""} ${skipped ? "skipped" : ""}`}>
                <div className="stage-icon">
                  {active ? <Loader2 size={15} className="spin" /> : done ? <CheckCircle2 size={15} /> : <Icon size={15} />}
                </div>
                <div className="stage-txt">
                  <span>Stage {i + 1}</span>
                  <strong>{skipped ? "Contacts (off)" : s.label}</strong>
                </div>
              </div>
            );
          })}
        </section>

        {/* ---- Extracted profile ---- */}
        {profile && (
          <section className="panel">
            <div className="panel-head slim">
              <span className="step-no ok">✓</span>
              <div>
                <h2>{profile.cv_title || profile.profession}</h2>
                <p>
                  Target field: <strong className="euc">{profile.target_field || profile.profession}</strong>
                  {(profile.previous_fields || []).length > 0 &&
                    <> · previously {profile.previous_fields.join(", ")} (transferable skills only)</>}
                </p>
              </div>
            </div>
            <div className="chips">
              {[...(profile.skills || []), ...(profile.qualifications || [])].map((s, i) => (
                <span key={i} className="chip">{s}</span>
              ))}
            </div>
          </section>
        )}

        {/* ---- Activity log ---- */}
        {log.length > 0 && (
          <section ref={logRef} className="log" aria-label="Activity log" aria-live="polite">
            {log.map((l, i) => (
              <div key={i} className={`log-line ${l.kind}`}>
                <span className="log-t">{l.t}</span>
                <span>{l.msg}</span>
              </div>
            ))}
          </section>
        )}

        {/* ---- Results ---- */}
        {results.length > 0 && (
          <section className="panel results">
            <div className="results-head">
              <div>
                <h2>Placement leads</h2>
                <p>
                  {results.length} of {targetCount} target · SME &amp; newest first
                  {threshold > 0 ? ` · ≥ ${threshold}% aligned` : " · no minimum"}
                </p>
              </div>
              <button className="btn primary" onClick={downloadXlsx}>
                <Download size={15} /> Download .xlsx
              </button>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>%</th><th>Size</th><th>Posted</th>
                    {COLUMNS.map((c) => <th key={c}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td className="pct">{r.alignment_percent}%</td>
                      <td><span className={`badge ${sizeClass(r.company_size)}`}>{r.company_size || "?"}</span></td>
                      <td className="posted">{r.date_posted || "—"}</td>
                      <td className="title">{r.job_title}</td>
                      <td>{r.company}</td>
                      <td>{r.industry}</td>
                      <td>{(r.aligned_skills || []).join(", ")}</td>
                      <td>{r.relevant_contacts || "Not publicly listed"}</td>
                      <td className="url">
                        {(r.website || r.url)
                          ? <a href={r.website || r.url} target="_blank" rel="noreferrer">{r.website || r.url}</a>
                          : ""}
                      </td>
                      <td>{r.phone || "Not publicly listed"}</td>
                      <td>{r.office_location || r.location}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="cards">
              {results.map((r, i) => (
                <article key={i} className="card">
                  <div className="card-top">
                    <span className="pct">{r.alignment_percent}%</span>
                    <span className={`badge ${sizeClass(r.company_size)}`}>{r.company_size || "?"}</span>
                    <span className="posted"><Clock size={12} /> {r.date_posted || "—"}</span>
                  </div>
                  <h3>{r.job_title}</h3>
                  <p className="card-co"><Building2 size={13} /> {r.company}{r.industry ? ` · ${r.industry}` : ""}</p>
                  {(r.aligned_skills || []).length > 0 &&
                    <p className="card-row"><strong>Aligned skills:</strong> {(r.aligned_skills || []).join(", ")}</p>}
                  <p className="card-row"><strong>Contacts:</strong> {r.relevant_contacts || "Not publicly listed"}</p>
                  <p className="card-row"><Phone size={12} /> {r.phone || "Not publicly listed"}</p>
                  <p className="card-row"><MapPin size={12} /> {r.office_location || r.location || "—"}</p>
                  {(r.website || r.url) &&
                    <p className="card-row"><Link2 size={12} /> <a href={r.website || r.url} target="_blank" rel="noreferrer">{r.website || r.url}</a></p>}
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="oqp-foot">
        <p>Contact details are limited to publicly published information. Verify leads before outreach.</p>
      </footer>
    </div>
  );
}

/* ------------------------------ styles ------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap');

.oqp {
  --ink: #101820; --paper: #F6F8F5; --panel: #FFFFFF; --line: #E1E6E0;
  --euc: #1F6F54; --euc-dark: #175C45; --euc-soft: #E7F2EC;
  --amber: #B4690E; --red: #B3261E; --grey: #5B655F;
  --radius: 12px;
  --shadow: 0 1px 2px rgba(16,24,32,.05), 0 4px 14px rgba(16,24,32,.05);
  min-height: 100vh; background: var(--paper); color: var(--ink);
  font-family: 'Inter', system-ui, sans-serif; font-size: 15px; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.oqp * { box-sizing: border-box; }
.oqp-shell { max-width: 1120px; margin: 0 auto; padding: 0 20px; }

.oqp-header { background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; }
.oqp-header-in { display: flex; align-items: center; gap: 16px; padding-top: 14px; padding-bottom: 14px; flex-wrap: wrap; }
.oqp-brand { display: flex; align-items: center; gap: 10px; }
.oqp-mark { width: 34px; height: 34px; border-radius: 9px; background: var(--euc); color: #fff; display: grid; place-items: center; flex-shrink: 0; }
.oqp-brand h1 { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 19px; letter-spacing: -0.02em; margin: 0; }
.oqp-brand h1 span { color: var(--euc); }
.oqp-tag { margin: 0; display: flex; align-items: center; gap: 5px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: var(--grey); }
.oqp-main { padding-top: 24px; padding-bottom: 56px; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 22px; margin-bottom: 22px; }
.panel-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 16px; }
.panel-head.slim { margin-bottom: 12px; }
.panel-head h2 { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 16px; margin: 0 0 2px; }
.panel-head p { margin: 0; font-size: 13px; color: var(--grey); }
.step-no { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; background: var(--ink); color: #fff; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; display: grid; place-items: center; margin-top: 2px; }
.step-no.ok { background: var(--euc); }
.euc { color: var(--euc); }

.dropzone { border: 1.5px dashed var(--line); border-radius: 10px; background: var(--paper); transition: border-color .15s, background .15s; }
.dropzone.drag { border-color: var(--euc); background: var(--euc-soft); }
.dropzone textarea { display: block; width: 100%; min-height: 150px; resize: vertical; border: 0; background: transparent; outline: none; padding: 14px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; line-height: 1.55; color: var(--ink); }
.dropzone-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-top: 1px dashed var(--line); }
.filechip { display: inline-flex; align-items: center; gap: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--euc); background: var(--euc-soft); border-radius: 99px; padding: 5px 12px; }

.settings { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 28px; margin-top: 18px; }
.setting-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.setting label { font-size: 13px; font-weight: 600; }
.setting output { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; font-weight: 500; color: var(--euc); }
.setting output.off { color: var(--amber); }
.setting input[type=range] { width: 100%; accent-color: var(--euc); cursor: pointer; height: 22px; }
.setting input[type=range]:disabled { cursor: default; opacity: .5; }

.checkrow { display: flex; align-items: center; gap: 9px; margin-top: 14px; font-size: 13px; color: var(--grey); cursor: pointer; }
.checkrow input { accent-color: var(--euc); width: 16px; height: 16px; cursor: pointer; }

.extra { margin-top: 18px; }
.extra label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.extra label span { font-weight: 400; color: var(--grey); }
.extra textarea { display: block; width: 100%; min-height: 64px; resize: vertical; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); outline: none; padding: 11px 13px; font-family: 'Inter', sans-serif; font-size: 13px; line-height: 1.5; color: var(--ink); transition: border-color .15s; }
.extra textarea:focus { border-color: var(--euc); }
.extra textarea:disabled { opacity: .55; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-family: 'Archivo', sans-serif; font-weight: 600; font-size: 14px; border-radius: 9px; padding: 11px 20px; cursor: pointer; border: 1px solid transparent; transition: background .15s, border-color .15s, transform .05s; }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: 2px solid var(--euc); outline-offset: 2px; }
.btn.primary { background: var(--euc); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--euc-dark); }
.btn.primary:disabled { background: #8FB5A5; cursor: wait; }
.btn.ghost { background: #fff; color: var(--ink); border-color: var(--line); }
.btn.ghost:hover:not(:disabled) { border-color: var(--euc); color: var(--euc); }
.actions { display: flex; align-items: center; gap: 14px; margin-top: 18px; flex-wrap: wrap; }
.actions .run { margin-left: auto; min-width: 190px; }
.passfield { border: 1px solid var(--line); border-radius: 9px; padding: 10px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; background: var(--paper); outline: none; width: 170px; transition: border-color .15s; }
.passfield:focus { border-color: var(--euc); }
.passfield:disabled { opacity: .55; }
.error { display: flex; align-items: flex-start; gap: 7px; margin: 0; color: var(--red); font-size: 13px; max-width: 60ch; }
.error svg { flex-shrink: 0; margin-top: 2px; }

.stepper { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 22px; }
.stage { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 14px; transition: border-color .3s, background .3s; }
.stage.active { border-color: var(--ink); }
.stage.done { border-color: var(--euc); background: var(--euc-soft); }
.stage.skipped { opacity: .45; }
.stage-icon { color: var(--grey); display: grid; place-items: center; }
.stage.done .stage-icon { color: var(--euc); }
.stage.active .stage-icon { color: var(--ink); }
.stage-txt { display: flex; flex-direction: column; line-height: 1.25; }
.stage-txt span { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--grey); }
.stage-txt strong { font-size: 12.5px; font-weight: 600; }
.stage.done .stage-txt strong { color: var(--euc); }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; border: 1px solid var(--line); border-radius: 99px; padding: 4px 11px; background: var(--paper); }

.directives { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 14px; font-size: 12.5px; color: var(--grey); }
.dchip { background: var(--euc-soft); border-color: var(--euc); color: var(--euc); }
.dclear { border: 0; background: none; color: var(--grey); font-size: 11.5px; text-decoration: underline; cursor: pointer; font-family: inherit; }
.dclear:hover:not(:disabled) { color: var(--red); }

.chatbox { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 2px 12px; }
.bubble { max-width: 85%; padding: 9px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; }
.bubble.me { align-self: flex-end; background: var(--euc); color: #fff; border-bottom-right-radius: 4px; }
.bubble.ai { align-self: flex-start; background: var(--paper); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
.bubble.thinking { display: inline-flex; align-items: center; gap: 7px; color: var(--grey); }

.chatrow { display: flex; gap: 10px; }
.chatrow input { flex: 1; border: 1px solid var(--line); border-radius: 9px; padding: 11px 14px; font-family: 'Inter', sans-serif; font-size: 13.5px; background: var(--paper); outline: none; transition: border-color .15s; min-width: 0; }
.chatrow input:focus { border-color: var(--euc); }
.chatrow input:disabled { opacity: .55; }
.chatrow .btn { padding: 11px 22px; }

.log { background: var(--ink); border-radius: var(--radius); padding: 14px 18px; margin-bottom: 22px; max-height: 190px; overflow-y: auto; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.8; }
.log-line { display: flex; gap: 10px; color: #B8C4BD; }
.log-line.ok { color: #7FD8AE; }
.log-line.warn { color: #E8B25E; }
.log-line.err { color: #F08A80; }
.log-t { opacity: .45; flex-shrink: 0; }

.results { padding: 0; overflow: hidden; }
.results-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 18px 22px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.results-head h2 { font-family: 'Archivo', sans-serif; font-size: 16px; font-weight: 700; margin: 0; }
.results-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--grey); }

.table-wrap { overflow-x: auto; }
.results table { border-collapse: collapse; width: 100%; font-size: 12.5px; min-width: 1150px; }
.results th { position: sticky; top: 0; text-align: left; padding: 10px 12px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--grey); background: #F1F4F0; white-space: nowrap; }
.results td { padding: 10px 12px; vertical-align: top; line-height: 1.45; border-top: 1px solid var(--line); }
.results tbody tr:hover { background: #FAFCF9; }
.results .pct { font-family: 'IBM Plex Mono', monospace; color: var(--euc); font-weight: 600; }
.results .title { font-weight: 600; }
.results .posted { white-space: nowrap; font-size: 12px; }
.results .url { max-width: 190px; word-break: break-all; }
.results a { color: var(--euc); }

.badge { display: inline-block; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; border-radius: 5px; padding: 2px 7px; }
.badge.sz-sm { background: var(--euc-soft); color: var(--euc); }
.badge.sz-md { background: #EAF0FA; color: #2B5AA6; }
.badge.sz-lg { background: #EFEFEC; color: var(--grey); }

.cards { display: none; }

.oqp-foot { border-top: 1px solid var(--line); padding: 18px 20px 30px; }
.oqp-foot p { max-width: 1120px; margin: 0 auto; font-size: 12px; color: var(--grey); text-align: center; }

.spin { animation: oqp-spin 1s linear infinite; }
@keyframes oqp-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
  .stage, .dropzone, .btn { transition: none; }
}

@media (max-width: 720px) {
  .oqp { font-size: 14.5px; }
  .oqp-shell { padding: 0 14px; }
  .oqp-header-in { gap: 4px; padding-top: 12px; padding-bottom: 12px; }
  .oqp-tag { width: 100%; }
  .panel { padding: 16px; }
  .settings { grid-template-columns: 1fr; gap: 16px; }
  .actions { flex-direction: column; align-items: stretch; }
  .actions .run { margin-left: 0; width: 100%; }
  .actions .btn { width: 100%; }
  .passfield { width: 100%; }
  .dropzone-bar .btn { width: 100%; }
  .stepper { grid-template-columns: 1fr 1fr; }
  .results-head { padding: 16px; }
  .results-head .btn { width: 100%; }
  .table-wrap { display: none; }
  .cards { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: var(--paper); }
  .card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .card-top .pct { font-family: 'IBM Plex Mono', monospace; color: var(--euc); font-weight: 600; font-size: 14px; }
  .card-top .posted { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--grey); }
  .card h3 { font-family: 'Archivo', sans-serif; font-size: 15px; font-weight: 700; margin: 0 0 3px; }
  .card-co { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--grey); margin: 0 0 8px; }
  .card-row { display: flex; align-items: flex-start; gap: 6px; font-size: 12.5px; margin: 4px 0; word-break: break-word; }
  .card-row svg { flex-shrink: 0; margin-top: 3px; color: var(--grey); }
  .card-row a { color: var(--euc); }
}
`;
