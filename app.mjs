/*
=====================================================================
  مذاكرتي - ملف واحد فيه كل حاجة (سيرفر + واجهة + قاعدة البيانات)
=====================================================================

الخطوات:
1) أنشئ مشروع Supabase، وافتح SQL Editor والصق فيه جزء "SQL" اللي تحت وشغّله.
2) في نفس فولدر الملف ده، اعمل ملف اسمه .env وحط فيه:

   PORT=3000
   SUPABASE_URL=
   SUPABASE_SERVICE_KEY=
   ANTHROPIC_API_KEY=
   ADMIN_KEY=اختار-كلمة-سر-قوية
   WHATSAPP_TOKEN=
   WHATSAPP_PHONE_ID=
   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
   GOOGLE_SHEET_ID=

3) نزّل المكتبات (Node 18 أو أحدث):

   npm i express cors multer pdf-parse node-cron dotenv @anthropic-ai/sdk @supabase/supabase-js googleapis

4) شغّل:  node app.mjs
5) افتح المتصفح على:  http://localhost:3000

---------------------------- SQL ----------------------------
create extension if not exists pgcrypto;

create table students (
  id uuid primary key default gen_random_uuid(),
  access_token text not null default encode(gen_random_bytes(16), 'hex'),
  name text not null,
  parent_phone text,
  adhd boolean default false,
  stage text, grade text, curriculum text, language text, subject text,
  created_at timestamptz default now()
);

create table sources (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  title text not null, page int, content text not null,
  stage text, grade text, subject text, school_year text,
  created_at timestamptz default now()
);
create index sources_fts on sources using gin (to_tsvector('simple', content));

create table results (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  topic text, score int, total int,
  source_title text, page_from int, page_to int,
  created_at timestamptz default now()
);

create table curriculum_content (
  id uuid primary key default gen_random_uuid(),
  institution_type text,
  college text, subject text, title text, page int, content text,
  created_at timestamptz default now()
);
create index content_fts on curriculum_content using gin (to_tsvector('simple', content));

create table adhd_profiles (
  student_id uuid primary key references students(id) on delete cascade,
  age int,
  focus_span int default 10,
  break_len int default 3,
  best_time text, interests text, triggers text, sensory text,
  updated_at timestamptz default now()
);

create table adhd_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  topic text, planned_min int, actual_min int,
  chunks_planned int, chunks_done int, interruptions int default 0,
  mood text, created_at timestamptz default now()
);

create or replace function search_sources(sid uuid, q text)
returns setof sources language sql stable as $$
  select * from sources
  where student_id = sid
    and to_tsvector('simple', content) @@ plainto_tsquery('simple', q)
  order by ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', q)) desc
  limit 5;
$$;

create or replace function search_content(q text, col text default null)
returns setof curriculum_content language sql stable as $$
  select * from curriculum_content
  where (col is null or col = '' or college = col)
    and to_tsvector('simple', content) @@ plainto_tsquery('simple', q)
  limit 10;
$$;
-------------------------- نهاية SQL --------------------------
*/

import "dotenv/config";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30e6 } });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

/* ---------- الواجهة: بتتقرأ من نفس الملف (آخر الملف) ---------- */
const SELF = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const grab = (tag) => SELF.split(`@@${tag}_START@@`)[1].split(`@@${tag}_END@@`)[0];
app.get("/", (req, res) => res.type("html").send(grab("HTML")));

/* ---------- أدوات مساعدة ---------- */
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

async function chat(system, messages, max = 1000) {
  const r = await claude.messages.create({ model: MODEL, max_tokens: max, system, messages });
  return r.content.map((c) => c.text || "").join("");
}
const one = (system, user, max) => chat(system, [{ role: "user", content: user }], max);

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.search(/[\[{]/);
  return JSON.parse(start > 0 ? clean.slice(start) : clean);
}

const tutorPrompt = (s) =>
  `أنت مدرّس لطالب في ${s.stage} صف ${s.grade}، منهج ${s.curriculum}، مادة ${s.subject}. ` +
  `اشرح بلغة ${s.language} وبمستوى مناسب لعمره.`;

/* ---------- حماية: كل مسارات الطالب تحتاج x-token ---------- */
async function guard(req, res, next) {
  try {
    const { data } = await db.from("students").select("*").eq("id", req.params.id).single();
    if (!data || data.access_token !== req.get("x-token"))
      return res.status(401).json({ error: "unauthorized" });
    req.student = data;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
app.use("/students/:id", guard);

/* ---------- الطلاب ---------- */
app.post("/students", wrap(async (req, res) => {
  const { name, parent_phone, adhd, stage, grade, curriculum, language, subject } = req.body;
  const { data, error } = await db.from("students")
    .insert({ name, parent_phone, adhd: !!adhd, stage, grade, curriculum, language, subject })
    .select().single();
  if (error) throw error;
  res.json({ id: data.id, token: data.access_token });
}));

app.get("/students/:id", wrap(async (req, res) => {
  const { access_token, ...safe } = req.student;
  res.json(safe);
}));

app.patch("/students/:id", wrap(async (req, res) => {
  const allowed = ["name", "parent_phone", "adhd", "stage", "grade", "curriculum", "language", "subject"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { data, error } = await db.from("students").update(patch).eq("id", req.params.id).select().single();
  if (error) throw error;
  const { access_token, ...safe } = data;
  res.json(safe);
}));

/* ---------- المصادر: PDF أو نص، يتقسم صفحات ---------- */
app.post("/students/:id/sources", upload.single("file"), wrap(async (req, res) => {
  const s = req.student;
  const { title, school_year } = req.body;
  let pages;
  if (req.file) {
    const parsed = await pdf(req.file.buffer, {
      pagerender: async (p) => {
        const tc = await p.getTextContent();
        return tc.items.map((i) => i.str).join(" ") + "\f";
      },
    });
    pages = parsed.text.split("\f").map((t) => t.trim());
  } else {
    pages = [req.body.text || ""];
  }
  const rows = pages
    .map((content, i) => ({
      student_id: s.id, title, page: i + 1, content,
      stage: s.stage, grade: s.grade, subject: s.subject, school_year,
    }))
    .filter((r) => r.content);
  if (!rows.length) throw new Error("no text found");
  const { error } = await db.from("sources").insert(rows);
  if (error) throw error;
  res.json({ pages_saved: rows.length });
}));

app.get("/students/:id/search", wrap(async (req, res) => {
  const { data, error } = await db.rpc("search_sources", { sid: req.params.id, q: req.query.q || "" });
  if (error) throw error;
  res.json(data.map((r) => ({
    title: r.title, page: r.page, grade: r.grade,
    school_year: r.school_year, snippet: r.content.slice(0, 300),
  })));
}));

/* ---------- شرح ---------- */
app.post("/students/:id/ask", wrap(async (req, res) => {
  const s = req.student;
  const q = req.body.question;
  const { data: hits } = await db.rpc("search_sources", { sid: s.id, q });
  const ctx = (hits || []).map((h) => `[${h.title} ص${h.page}] ${h.content}`).join("\n");
  const system = tutorPrompt(s) +
    (ctx ? "\nاعتمد على مصادر الطالب دي واذكر اسم الكتاب والصفحة:\n" + ctx : "");
  const answer = await one(system, q);
  res.json({ answer, sources: (hits || []).map((h) => ({ title: h.title, page: h.page })) });
}));

/* ---------- اختبار ---------- */
app.post("/students/:id/quiz", wrap(async (req, res) => {
  const s = req.student;
  const { topic } = req.body;
  const { data: hits } = await db.rpc("search_sources", { sid: s.id, q: topic });
  const src = hits?.[0];
  const text = await one(
    tutorPrompt(s) + '\nرجّع JSON فقط بدون أي نص: [{"q":"","options":["","","",""],"answer":0}]',
    `5 أسئلة اختيار من متعدد عن: ${topic}` + (src ? `\nمن المصدر: ${src.content}` : ""),
    1500
  );
  res.json({ items: parseJSON(text), source: src ? { title: src.title, page: src.page } : null });
}));

app.post("/students/:id/results", wrap(async (req, res) => {
  const { topic, score, total, source_title, page_from, page_to } = req.body;
  const { data, error } = await db.from("results")
    .insert({ student_id: req.params.id, topic, score, total, source_title, page_from, page_to })
    .select().single();
  if (error) throw error;
  res.json(data);
}));

/* ---------- محتوى الكليات (إدخال الأدمن) ---------- */
const adminOnly = (req, res, next) =>
  req.get("x-admin-key") === process.env.ADMIN_KEY ? next() : res.status(401).json({ error: "admin only" });

app.post("/content", adminOnly, wrap(async (req, res) => {
  const { institution_type, college, subject, title, page, content } = req.body;
  const { data, error } = await db.from("curriculum_content")
    .insert({ institution_type, college, subject, title, page, content }).select().single();
  if (error) throw error;
  res.json(data);
}));

app.get("/content", wrap(async (req, res) => {
  const { data, error } = await db.rpc("search_content", { q: req.query.q || "", col: req.query.college || null });
  if (error) throw error;
  res.json(data);
}));

/* =====================================================
   قسم ADHD: نظام منفصل + ذكاء اصطناعي مخصص
   ===================================================== */
const adhdPrompt = (s, p) =>
`أنت مدرّب مذاكرة متخصص لطلاب عندهم ADHD. الطالب: ${s.name}، ${s.stage} صف ${s.grade}، مادة ${s.subject}، لغة الشرح ${s.language}.
مدة تركيزه الحالية ${p.focus_span} دقيقة، واستراحته ${p.break_len} دقيقة. اهتماماته: ${p.interests || "غير محددة"}. أفضل وقت للمذاكرة: ${p.best_time || "غير محدد"}. أشياء بتشتته: ${p.triggers || "غير محددة"}.
قواعد التعامل:
- جمل قصيرة جدًا وكلمات بسيطة. خطوة واحدة بس في كل رد.
- ابدأ بأصغر خطوة ممكنة (أقل من دقيقتين) عشان تكسر حاجز البداية.
- سؤال واحد بس في الرد.
- امدح المجهود والاستمرار، مش النتيجة. ما تلومش ولا تقارن بغيره أبدًا.
- استخدم اهتماماته في الأمثلة عشان تشد انتباهه.
- لو قال إنه اتشتت أو زهق: طبّع الموضوع وقوله يرجع لأول سطر وقف عنده بدون عقاب، أو اقترح استراحة حركة قصيرة.
- متشخّصش ومتدّيش نصايح طبية. لو الطالب مضغوط أو محبط جدًا، اقترح يتكلم مع ولي أمره أو أخصائي.`;

const defaultProfile = { focus_span: 10, break_len: 3 };
async function getProfile(id) {
  const { data } = await db.from("adhd_profiles").select("*").eq("student_id", id).maybeSingle();
  return data || { student_id: id, ...defaultProfile };
}

app.get("/students/:id/adhd", wrap(async (req, res) => res.json(await getProfile(req.params.id))));

app.put("/students/:id/adhd", wrap(async (req, res) => {
  const { age, focus_span, break_len, best_time, interests, triggers, sensory } = req.body;
  const row = {
    student_id: req.params.id, age, best_time, interests, triggers, sensory,
    focus_span: Math.min(45, Math.max(3, +focus_span || 10)),
    break_len: Math.min(15, Math.max(1, +break_len || 3)),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db.from("adhd_profiles").upsert(row).select().single();
  if (error) throw error;
  await db.from("students").update({ adhd: true }).eq("id", req.params.id);
  res.json(data);
}));

app.post("/students/:id/adhd/plan", wrap(async (req, res) => {
  const s = req.student;
  const p = await getProfile(s.id);
  const { topic, total_min } = req.body;
  const n = Math.max(1, Math.floor((+total_min || 30) / (p.focus_span + p.break_len)));
  let chunks;
  try {
    const text = await one(
      adhdPrompt(s, p) +
      `\nرجّع JSON فقط بدون أي نص: [{"title":"","task":""}] وبالظبط ${n} عنصر. كل عنصر مهمة صغيرة واضحة تتخلص في ${p.focus_span} دقيقة، وأولها أسهل واحدة.`,
      `الموضوع: ${topic}`, 1200
    );
    chunks = parseJSON(text).slice(0, n);
  } catch {
    chunks = Array.from({ length: n }, (_, i) => ({ title: `الجزء ${i + 1}`, task: `ذاكر ${topic} لمدة ${p.focus_span} دقيقة` }));
  }
  res.json({ chunks: chunks.map((c) => ({ ...c, minutes: p.focus_span })), break_len: p.break_len, span: p.focus_span });
}));

app.post("/students/:id/adhd/coach", wrap(async (req, res) => {
  const p = await getProfile(req.student.id);
  const msgs = (req.body.messages || []).slice(-10)
    .filter((m) => ["user", "assistant"].includes(m.role) && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw new Error("last message must be from user");
  res.json({ reply: await chat(adhdPrompt(req.student, p), msgs, 600) });
}));

app.post("/students/:id/adhd/session", wrap(async (req, res) => {
  const { topic, planned_min, actual_min, chunks_planned, chunks_done, interruptions, mood } = req.body;
  const { error } = await db.from("adhd_sessions").insert({
    student_id: req.params.id, topic, planned_min, actual_min,
    chunks_planned, chunks_done, interruptions, mood,
  });
  if (error) throw error;
  const p = await getProfile(req.params.id);
  const rate = chunks_planned ? chunks_done / chunks_planned : 0;
  let span = p.focus_span;
  if (rate >= 0.9 && (interruptions || 0) <= 2) span = Math.min(25, span + 2);
  else if (rate < 0.5 || (interruptions || 0) >= 5) span = Math.max(5, span - 2);
  if (span !== p.focus_span)
    await db.from("adhd_profiles").upsert({ ...p, student_id: req.params.id, focus_span: span, updated_at: new Date().toISOString() });
  res.json({ old_span: p.focus_span, new_span: span });
}));

app.get("/students/:id/adhd/stats", wrap(async (req, res) => {
  const { data } = await db.from("adhd_sessions").select("*").eq("student_id", req.params.id)
    .order("created_at", { ascending: false }).limit(30);
  res.json(data || []);
}));

/* =====================================================
   التقارير: واتساب + Google Sheets
   ===================================================== */
async function buildReport(s, days) {
  const from = new Date(Date.now() - days * 864e5).toISOString();
  const { data } = await db.from("results").select("*").eq("student_id", s.id).gte("created_at", from);
  const lines = (data || []).map((r) => {
    const weak = r.score / r.total < 0.6;
    let note = "";
    if (weak && r.source_title) {
      note = r.page_from && r.page_to && r.page_to !== r.page_from
        ? ` - يراجع ${r.source_title} من صفحة ${r.page_from} إلى ${r.page_to}`
        : ` - يراجع ${r.source_title}${r.page_from ? " صفحة " + r.page_from : ""}`;
    }
    return `• ${r.topic}: ${r.score}/${r.total}${note}`;
  });
  let text = `تقرير ${s.name} - ${s.subject}\n` + (lines.join("\n") || "لا توجد اختبارات في الفترة دي");

  if (s.adhd) {
    const { data: ses } = await db.from("adhd_sessions").select("*").eq("student_id", s.id).gte("created_at", from);
    if (ses?.length) {
      const mins = ses.reduce((a, x) => a + (x.actual_min || 0), 0);
      const rate = Math.round((ses.reduce((a, x) => a + (x.chunks_done || 0), 0) /
        Math.max(1, ses.reduce((a, x) => a + (x.chunks_planned || 0), 0))) * 100);
      text += `\n\nجلسات التركيز: ${ses.length} جلسة، ${mins} دقيقة، نسبة إنجاز الأجزاء ${rate}%`;
    }
  }
  return { rows: data || [], text };
}

async function sendWhatsApp(phone, body) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body } }),
  });
  if (!r.ok) throw new Error("whatsapp: " + (await r.text()));
}

async function appendToSheet(s, rows) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID || !rows.length) return;
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: rows.map((r) => [s.name, s.subject, r.topic, r.score, r.total, r.source_title || "", r.page_from ?? "", r.page_to ?? ""]),
    },
  });
}

app.post("/students/:id/report", wrap(async (req, res) => {
  const s = req.student;
  const { text, rows } = await buildReport(s, req.body.days || 7);
  let sent = false;
  if (s.parent_phone) { await sendWhatsApp(s.parent_phone, text); sent = true; }
  await appendToSheet(s, rows);
  res.json({ sent, text });
}));

// كل جمعة 6 مساءً لكل الطلاب اللي ليهم رقم ولي أمر
cron.schedule("0 18 * * 5", async () => {
  const { data } = await db.from("students").select("*").not("parent_phone", "is", null);
  for (const s of data || []) {
    try {
      const { text, rows } = await buildReport(s, 7);
      await sendWhatsApp(s.parent_phone, text);
      await appendToSheet(s, rows);
    } catch (e) { console.error(s.id, e.message); }
  }
});

app.listen(process.env.PORT || 3000, () => console.log("server up: http://localhost:" + (process.env.PORT || 3000)));

/*@@HTML_START@@
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مذاكرتي</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
<style>
:root{--bg:#f2f7f5;--ink:#10343d;--teal:#0f6b6b;--sun:#f2b134;--coral:#e4572e;--card:#fff;--line:#cfe0dc}
@media(prefers-color-scheme:dark){:root{--bg:#0d1f22;--ink:#e6f1ef;--card:#14302f;--line:#255250}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Cairo,system-ui,sans-serif;line-height:1.7}
main{max-width:720px;margin:auto;padding:16px}
h1{font-size:2rem;font-weight:900;margin:.2em 0}h2{font-size:1.2rem;margin:.6em 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.opts{display:flex;flex-wrap:wrap;gap:8px}
button,input,textarea,select{font:inherit;color:inherit}
.opt,.btn{border:2px solid var(--teal);background:transparent;border-radius:10px;padding:8px 14px;cursor:pointer}
.opt:hover,.opt.on{background:var(--teal);color:#fff}
.btn{background:var(--sun);border-color:var(--sun);color:#10343d;font-weight:700}
input,textarea,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:transparent;margin:4px 0}
input[type=checkbox]{width:auto}
nav{display:flex;gap:6px;overflow-x:auto;position:sticky;top:0;background:var(--bg);padding:8px 0}
nav button{white-space:nowrap}
.hit{border-inline-start:4px solid var(--coral);padding-inline-start:10px;margin:8px 0}
.muted{opacity:.7;font-size:.9rem}
.big{font-size:3rem;font-weight:900;text-align:center;margin:.2em 0}
.msg{padding:8px 12px;border-radius:10px;margin:6px 0;background:var(--line)}
.msg.me{background:var(--sun);color:#10343d}
:focus-visible{outline:3px solid var(--sun)}
</style>
</head>
<body>
<main id="app"></main>
<script>
// ===== إعدادات =====
const API = "";

const STAGES = {
  "كي جي": ["KG1", "KG2"],
  "ابتدائي": ["1", "2", "3", "4", "5", "6"],
  "إعدادي": ["1", "2", "3"],
  "ثانوي": ["1", "2", "3"],
  "جامعي": ["1", "2", "3", "4", "5"]
};
const CURRICULA = {
  "كي جي": ["حكومي", "لغات", "دولي"],
  "ابتدائي": ["حكومي", "لغات", "فرنساوي", "أمريكي", "IB", "IGCSE"],
  "إعدادي": ["حكومي", "لغات", "فرنساوي", "أمريكي", "IB", "IGCSE"],
  "ثانوي": ["ثانوية عامة", "بكالوريا", "فرنساوي", "أمريكي (Diploma)", "IB", "IGCSE"],
  "جامعي": ["جامعة حكومية", "جامعة أهلية", "جامعة خاصة"]
};
const LANGS = ["العربية", "English", "Français", "Deutsch"];
const SUBJECTS = {
  "جامعي": ["طب", "هندسة", "صيدلة", "تجارة", "حقوق", "علوم", "آداب", "حاسبات ومعلومات", "تربية"],
  "_": ["رياضيات", "علوم", "لغة عربية", "English", "دراسات", "فيزياء", "كيمياء", "أحياء", "تاريخ", "جغرافيا"]
};
const WIZ = [
  ["stage", "اختار المرحلة", () => Object.keys(STAGES)],
  ["grade", "اختار الصف", () => STAGES[S.p.stage]],
  ["curr", "نوع التعليم", () => CURRICULA[S.p.stage]],
  ["lang", "لغة الدراسة", () => LANGS],
  ["subject", "اختار المادة / الكلية", () => SUBJECTS[S.p.stage] || SUBJECTS._]
];

// ===== الحالة =====
let S = JSON.parse(localStorage.getItem("st") || "null") || { step: 0, p: {}, tab: "ask" };
const save = () => { try { localStorage.setItem("st", JSON.stringify(S)); } catch (e) {} };
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, method = "GET", body, extra = {}) {
  const h = { "x-token": S.token || "", ...extra };
  const isForm = body instanceof FormData;
  if (body && !isForm) h["Content-Type"] = "application/json";
  const r = await fetch(API + path, { method, headers: h, body: isForm ? body : body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "خطأ");
  return d;
}

// ===== الشاشات الرئيسية =====
function render() {
  clearInterval(tick);
  const a = $("#app");

  if (S.step < WIZ.length) {
    const [k, t, f] = WIZ[S.step];
    a.innerHTML = `<h1>مذاكرتي</h1><div class="card"><h2>${t}</h2><div class="opts">${f().map((o) => `<button class="opt" data-k="${k}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>${S.step ? '<p><button class="opt" id="back">رجوع</button></p>' : ""}</div>`;
    a.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { S.p[b.dataset.k] = b.dataset.v; S.step++; save(); render(); });
    const bk = $("#back"); if (bk) bk.onclick = () => { S.step--; save(); render(); };
    return;
  }

  if (!S.id) {
    a.innerHTML = `<h1>مذاكرتي</h1><div class="card"><h2>بيانات الطالب</h2>
      <input id="nm" placeholder="اسم الطالب">
      <input id="ph" placeholder="رقم واتساب ولي الأمر (مثال 201001234567)">
      <label><input type="checkbox" id="ad"> الطالب عنده ADHD (تفعيل قسم التركيز الخاص)</label>
      <p><button class="btn" id="reg">ابدأ</button></p><p class="muted" id="err"></p></div>`;
    $("#reg").onclick = async () => {
      try {
        const d = await api("/students", "POST", {
          name: $("#nm").value, parent_phone: $("#ph").value, adhd: $("#ad").checked,
          stage: S.p.stage, grade: S.p.grade, curriculum: S.p.curr, language: S.p.lang, subject: S.p.subject
        });
        S.id = d.id; S.token = d.token; S.adhd = $("#ad").checked; S.tab = "ask"; save(); render();
      } catch (e) { $("#err").textContent = e.message; }
    };
    return;
  }

  const p = S.p;
  const tabs = { ask: "اسأل", lib: "مكتبتي", quiz: "اختبار", ...(S.adhd ? { adhd: "تركيز ADHD" } : {}), rep: "التقرير", col: "محتوى الكليات" };
  a.innerHTML = `<h1>مذاكرتي</h1><p class="muted">${esc(p.stage)} - ${esc(p.grade)} · ${esc(p.curr)} · ${esc(p.lang)} · ${esc(p.subject)} <button class="opt" id="out">خروج</button></p>
    <nav>${Object.entries(tabs).map(([k, v]) => `<button class="opt ${S.tab == k ? "on" : ""}" data-t="${k}">${v}</button>`).join("")}</nav><div id="view"></div>`;
  a.querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { S.tab = b.dataset.t; save(); render(); });
  $("#out").onclick = () => { S = { step: 0, p: {}, tab: "ask" }; save(); render(); };
  ({ ask: vAsk, lib: vLib, quiz: vQuiz, adhd: vAdhd, rep: vRep, col: vCol })[S.tab]();
}

// ===== اسأل =====
function vAsk() {
  $("#view").innerHTML = `<div class="card"><textarea id="q" rows="3" placeholder="اسأل أو اطلب شرح..."></textarea><button class="btn" id="go">اشرح</button><div id="out"></div></div>`;
  $("#go").onclick = async () => {
    const q = $("#q").value.trim(); if (!q) return;
    $("#out").innerHTML = "<p class='muted'>جاري الشرح...</p>";
    try {
      const d = await api(`/students/${S.id}/ask`, "POST", { question: q });
      $("#out").innerHTML = `<p>${esc(d.answer).replace(/\n/g, "<br>")}</p>` +
        d.sources.map((h) => `<div class="hit"><b>${esc(h.title)}</b> - صفحة ${esc(h.page)}</div>`).join("");
    } catch (e) { $("#out").innerHTML = `<p>${esc(e.message)}</p>`; }
  };
}

// ===== المكتبة =====
function vLib() {
  $("#view").innerHTML = `<div class="card"><h2>أضف مصدر</h2>
    <input id="t" placeholder="اسم الكتاب/الملف"><input id="yr" placeholder="السنة الدراسية (مثال 2026)">
    <input type="file" id="f" accept="application/pdf">
    <textarea id="tx" rows="3" placeholder="أو الصق نص الصفحة"></textarea>
    <button class="btn" id="add">حفظ</button><p class="muted" id="st"></p></div>
    <div class="card"><h2>ابحث في كل مصادرك</h2><input id="sq" placeholder="كلمة أو معلومة"><div id="res"></div></div>`;
  $("#add").onclick = async () => {
    const fd = new FormData();
    fd.append("title", $("#t").value); fd.append("school_year", $("#yr").value); fd.append("text", $("#tx").value);
    if ($("#f").files[0]) fd.append("file", $("#f").files[0]);
    $("#st").textContent = "جاري الحفظ...";
    try { const d = await api(`/students/${S.id}/sources`, "POST", fd); $("#st").textContent = `تم حفظ ${d.pages_saved} صفحة`; }
    catch (e) { $("#st").textContent = e.message; }
  };
  let timer;
  $("#sq").oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const d = await api(`/students/${S.id}/search?q=${encodeURIComponent(e.target.value)}`);
        $("#res").innerHTML = d.map((h) => `<div class="hit"><b>${esc(h.title)}</b> - صفحة ${esc(h.page)} (${esc(h.grade)} ${esc(h.school_year)})<br>${esc(h.snippet)}</div>`).join("") || "<p class='muted'>مفيش نتائج</p>";
      } catch (er) { $("#res").textContent = er.message; }
    }, 400);
  };
}

// ===== اختبار =====
let quiz = null;
function vQuiz() {
  $("#view").innerHTML = `<div class="card"><input id="tp" placeholder="موضوع الاختبار"><button class="btn" id="mk">ابدأ اختبار (5 أسئلة)</button><div id="qz"></div></div>`;
  $("#mk").onclick = async () => {
    const tp = $("#tp").value || S.p.subject;
    $("#qz").innerHTML = "<p class='muted'>بجهز الأسئلة...</p>";
    try { const d = await api(`/students/${S.id}/quiz`, "POST", { topic: tp }); quiz = { tp, src: d.source, items: d.items, a: [] }; drawQ(); }
    catch (e) { $("#qz").innerHTML = `<p>${esc(e.message)}</p>`; }
  };
}
function drawQ() {
  $("#qz").innerHTML = quiz.items.map((it, i) => `<h2>${i + 1}. ${esc(it.q)}</h2><div class="opts">${it.options.map((o, j) => `<button class="opt ${quiz.a[i] === j ? "on" : ""}" data-i="${i}" data-j="${j}">${esc(o)}</button>`).join("")}</div>`).join("") + `<p><button class="btn" id="fin">إنهاء</button></p>`;
  document.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => { quiz.a[+b.dataset.i] = +b.dataset.j; drawQ(); });
  $("#fin").onclick = async () => {
    const ok = quiz.items.filter((it, i) => quiz.a[i] === it.answer).length;
    try {
      await api(`/students/${S.id}/results`, "POST", {
        topic: quiz.tp, score: ok, total: quiz.items.length,
        source_title: quiz.src?.title || null, page_from: quiz.src?.page || null, page_to: quiz.src?.page || null
      });
    } catch (e) {}
    $("#qz").innerHTML = `<h2>نتيجتك ${ok}/${quiz.items.length}</h2>`;
  };
}

// ===== قسم ADHD =====
let plan = null, ci = 0, tick = null, sess = {}, hist = [];

async function vAdhd() {
  let pr = {};
  try { pr = await api(`/students/${S.id}/adhd`); } catch (e) {}
  $("#view").innerHTML = `
  <div class="card"><h2>ملف التركيز</h2>
    <input id="ag" type="number" placeholder="السن" value="${esc(pr.age || "")}">
    <label>مدة التركيز (دقيقة)</label><input id="sp" type="number" value="${esc(pr.focus_span || 10)}">
    <label>مدة الاستراحة (دقيقة)</label><input id="br" type="number" value="${esc(pr.break_len || 3)}">
    <input id="bt" placeholder="أفضل وقت للمذاكرة" value="${esc(pr.best_time || "")}">
    <input id="it" placeholder="اهتماماته (كورة، ألعاب، رسم...)" value="${esc(pr.interests || "")}">
    <input id="tr" placeholder="إيه اللي بيشتته؟" value="${esc(pr.triggers || "")}">
    <input id="se" placeholder="حساسية للصوت/الإضاءة (اختياري)" value="${esc(pr.sensory || "")}">
    <button class="btn" id="sv">حفظ</button> <span class="muted" id="ps"></span>
    <p class="muted">مدة التركيز بتتعدل تلقائيًا حسب أداءه في الجلسات.</p></div>
  <div class="card"><h2>خطة مذاكرة</h2>
    <input id="pt" placeholder="هتذاكر إيه؟"><input id="pm" type="number" value="40" placeholder="الوقت الكلي بالدقايق">
    <button class="btn" id="pg">اعمل الخطة وابدأ</button><p class="muted" id="pe"></p></div>
  <div id="run"></div>
  <div class="card"><h2>المدرب</h2><div id="chat"></div>
    <textarea id="cm" rows="2" placeholder="قوله حاسس بإيه أو محتاج إيه..."></textarea><button class="btn" id="cs">ابعت</button></div>`;

  $("#sv").onclick = async () => {
    try {
      await api(`/students/${S.id}/adhd`, "PUT", {
        age: +$("#ag").value || null, focus_span: +$("#sp").value, break_len: +$("#br").value,
        best_time: $("#bt").value, interests: $("#it").value, triggers: $("#tr").value, sensory: $("#se").value
      });
      $("#ps").textContent = "تم الحفظ";
    } catch (e) { $("#ps").textContent = e.message; }
  };

  $("#pg").onclick = async () => {
    const topic = $("#pt").value.trim(); if (!topic) return;
    $("#pe").textContent = "بجهز الخطة...";
    try {
      const total = +$("#pm").value || 30;
      plan = await api(`/students/${S.id}/adhd/plan`, "POST", { topic, total_min: total });
      sess = { topic, planned: total, n: plan.chunks.length, done: 0, intr: 0, start: Date.now() };
      ci = 0; $("#pe").textContent = ""; runChunk();
    } catch (e) { $("#pe").textContent = e.message; }
  };

  $("#cs").onclick = async () => {
    const m = $("#cm").value.trim(); if (!m) return;
    hist.push({ role: "user", content: m }); $("#cm").value = ""; drawChat();
    try { const d = await api(`/students/${S.id}/adhd/coach`, "POST", { messages: hist }); hist.push({ role: "assistant", content: d.reply }); }
    catch (e) { hist.push({ role: "assistant", content: e.message }); }
    drawChat();
  };
  drawChat();
}
function drawChat() {
  const c = $("#chat"); if (!c) return;
  c.innerHTML = hist.map((m) => `<div class="msg ${m.role === "user" ? "me" : ""}">${esc(m.content).replace(/\n/g, "<br>")}</div>`).join("");
}
function countdown(sec, onEnd) {
  clearInterval(tick); let t = sec;
  const draw = () => { const el = $("#tm"); if (el) el.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  draw();
  tick = setInterval(() => { t--; draw(); if (t <= 0) { clearInterval(tick); onEnd(); } }, 1000);
}
function runChunk() {
  if (ci >= plan.chunks.length) return finish();
  const c = plan.chunks[ci];
  $("#run").innerHTML = `<div class="card"><h2>الجزء ${ci + 1} من ${plan.chunks.length}: ${esc(c.title)}</h2><p>${esc(c.task)}</p><div class="big" id="tm"></div>
    <button class="btn" id="dn">خلصت</button> <button class="opt" id="ds">اتشتت</button><p class="muted" id="ms"></p></div>`;
  $("#dn").onclick = () => { sess.done++; ci++; startBreak(); };
  $("#ds").onclick = () => { sess.intr++; $("#ms").textContent = "عادي جدًا. ارجع لأول سطر وقفت عنده وكمّل."; };
  countdown(c.minutes * 60, () => { ci++; startBreak(); });
}
function startBreak() {
  if (ci >= plan.chunks.length) return finish();
  $("#run").innerHTML = `<div class="card"><h2>استراحة</h2><p>قوم اتحرك، اشرب مياه، وبعدين نكمّل.</p><div class="big" id="tm"></div><button class="opt" id="sk">كمّل دلوقتي</button></div>`;
  $("#sk").onclick = () => { clearInterval(tick); runChunk(); };
  countdown(plan.break_len * 60, runChunk);
}
function finish() {
  clearInterval(tick);
  $("#run").innerHTML = `<div class="card"><h2>خلصت الجلسة، برافو على مجهودك</h2><p>حاسس بإيه؟</p>
    <div class="opts">${["😀", "🙂", "😕", "😣"].map((m) => `<button class="opt" data-m="${m}">${m}</button>`).join("")}</div><p class="muted" id="fs"></p></div>`;
  document.querySelectorAll("[data-m]").forEach((b) => b.onclick = async () => {
    try {
      const d = await api(`/students/${S.id}/adhd/session`, "POST", {
        topic: sess.topic, planned_min: sess.planned, actual_min: Math.round((Date.now() - sess.start) / 60000),
        chunks_planned: sess.n, chunks_done: sess.done, interruptions: sess.intr, mood: b.dataset.m
      });
      $("#fs").textContent = d.new_span !== d.old_span ? `مدة التركيز اتعدلت من ${d.old_span} إلى ${d.new_span} دقيقة` : "تم تسجيل الجلسة";
    } catch (e) { $("#fs").textContent = e.message; }
  });
}

// ===== التقرير =====
function vRep() {
  $("#view").innerHTML = `<div class="card"><h2>تقرير دوري</h2><div class="opts"><button class="opt" data-d="7">أسبوعي</button><button class="opt" data-d="30">شهري</button></div>
    <pre id="rp" style="white-space:pre-wrap"></pre><p class="muted">الإرسال على واتساب وGoogle Sheets بيتم من السيرفر، وبيتبعت أسبوعيًا تلقائي كل جمعة.</p></div>`;
  document.querySelectorAll("[data-d]").forEach((b) => b.onclick = async () => {
    $("#rp").textContent = "جاري الإرسال...";
    try { const d = await api(`/students/${S.id}/report`, "POST", { days: +b.dataset.d }); $("#rp").textContent = (d.sent ? "تم الإرسال لولي الأمر\n\n" : "") + d.text; }
    catch (e) { $("#rp").textContent = e.message; }
  });
}

// ===== محتوى الكليات =====
function vCol() {
  $("#view").innerHTML = `<div class="card"><h2>إدخال محتوى (للأدمن)</h2>
    <input id="ak" type="password" placeholder="مفتاح الأدمن">
    <select id="ty"><option>حكومية</option><option>أهلية</option><option>خاصة</option></select>
    <input id="cl" placeholder="الكلية"><input id="sb" placeholder="المادة"><input id="ti" placeholder="عنوان / اسم الكتاب"><input id="pg" type="number" placeholder="رقم الصفحة">
    <textarea id="ct" rows="4" placeholder="المحتوى"></textarea><button class="btn" id="ad">حفظ</button><p class="muted" id="as"></p></div>
    <div class="card"><h2>بحث في المحتوى</h2><input id="qs" placeholder="كلمة"><input id="qc" placeholder="الكلية (اختياري)"><button class="opt" id="qb">بحث</button><div id="qr"></div></div>`;
  $("#ad").onclick = async () => {
    try {
      await api("/content", "POST", { institution_type: $("#ty").value, college: $("#cl").value, subject: $("#sb").value, title: $("#ti").value, page: +$("#pg").value || null, content: $("#ct").value }, { "x-admin-key": $("#ak").value });
      $("#as").textContent = "تم الحفظ";
    } catch (e) { $("#as").textContent = e.message; }
  };
  $("#qb").onclick = async () => {
    try {
      const d = await api(`/content?q=${encodeURIComponent($("#qs").value)}&college=${encodeURIComponent($("#qc").value)}`);
      $("#qr").innerHTML = d.map((r) => `<div class="hit"><b>${esc(r.title)}</b> - ${esc(r.college)} (${esc(r.institution_type)}) صفحة ${esc(r.page)}<br>${esc(r.content.slice(0, 250))}</div>`).join("") || "<p class='muted'>مفيش نتائج</p>";
    } catch (e) { $("#qr").textContent = e.message; }
  };
}

render();
</script>
</body>
</html>
@@HTML_END@@*/
