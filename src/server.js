import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { config } from "./config.js";
import {
  getUserById,
  getUserByEmail,
  createEmailUser,
  setUserOwner,
  countLoginableOwners,
  localToday,
  listEntries,
  entriesSince,
  deleteEntry,
  listFinance,
  addFinance,
  deleteFinance,
  FINANCE_CATEGORIES,
  listHealth,
  addHealth,
  deleteHealth,
  listGoals,
  applyGoal,
  deleteGoal,
  setGoalCurrent,
  goalLog,
  deleteGoalLog,
  updateGoalLog,
  logMetric,
  upsertMetric,
  listMetricsWithStats,
  metricHistory,
  setMetricDay,
  updateMetricMeta,
  deleteMetric,
  deleteMetricLog,
  listConversations,
  deleteConversation,
  listConditions,
  getCondition,
  closeCondition,
  deleteCondition,
  healthBetween,
  listMeals,
  deleteMeal,
  listHabits,
  addHabit,
  logHabit,
  unlogHabit,
  deleteHabit,
  addTask,
  listTasks,
  completeTask,
  reopenTask,
  deleteTask,
  aiUsageSummary,
  userUsageCost,
  userUsageDetails,
  listProfileFacts,
  upsertProfileFact,
  deleteProfileFact,
  getAdminByUsername,
  getAdminById,
  countAdmins,
  createAdmin,
  touchAdminLogin,
  listUsersWithStats,
  platformStats,
  savePushSubscription,
  deletePushSubscription,
  listNotifications,
  unreadNotificationCount,
  markNotificationsRead,
  addIdea,
  listIdeas,
  setIdeaStatus,
  deleteIdea,
  addThought,
  listThoughts,
  deleteThought,
  addProblem,
  listProblems,
  setProblemStatus,
  deleteProblem,
  entriesBetween,
  addFile,
  listFiles,
  getFile,
  deleteFile,
  updateFinance,
  updateHealth,
  updateEntry,
  updateTaskFields,
  updateMeal,
  updateGoalMeta,
  updateIdeaFields,
  updateProblemFields,
  updateHabitFields,
  getFinanceBudget,
  setFinanceBudget,
  addAskMessage,
  listAskMessages,
  clearAskMessages,
  recentIdenticalConversation,
  addAsset,
  listAssets,
  updateAsset,
  deleteAsset,
  getAssetMarket,
  setAssetMarket,
  createSession,
  getSession,
  deleteSession,
  purgeExpiredSessions,
  rateLimitBump,
  purgeRateLimits,
} from "./db.js";
import { pushEnabled, vapidPublicKey, sendPushToUser, notifyUser } from "./push.js";
import { analyzeEntries, doctorReport, unifiedReport, transcribe, PRICING, chatAboutJournal, classifyImage, textToSpeech, PROVIDERS, aiSettings, saveAiSettings, aiConfigured, aiErrorMessage, refreshAi, chatModel } from "./openai.js";
import OpenAI from "openai";
import { versionStatus, pullUpdate, scheduleRestart } from "./updater.js";
import { buildReportData } from "./report.js";
import { runAgent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// مجلد الواجهة سُمّي web بدل public عن قصد: Vercel بيقدّم أي مجلد اسمه
// public تلقائيًا كملفات ثابتة من غير ما يمر على السيرفر، وده كان هيعطّل
// الـ auth gate على app.js و admin.js.
const publicDir = join(__dirname, "..", "web");
const uploadsDir = join(__dirname, "..", "data", "uploads"); // ملفات المستخدمين المرفوعة

// نحفظ الصوت الخام فور وصوله — لو التفريغ فشل ميضيعش (نقدر نسترجعه من data/uploads/<user>/voice)
function persistAudio(userId, prefix, ext, buf) {
  try {
    const dir = join(uploadsDir, String(userId), "voice");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${prefix}-${Date.now()}.${ext}`);
    writeFileSync(p, buf);
    return p;
  } catch (e) { console.error("persistAudio error:", e); return null; }
}
function cleanupAudio(p) { if (p) { try { unlinkSync(p); } catch {} } }

/* ===================== الجلسات ===================== */

const SESSION_TTL = 30 * 86400 * 1000;
async function newSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  await createSession(token, "user", userId, Date.now() + SESSION_TTL);
  return token;
}

async function sessionUser(req) {
  const token = parseCookies(req).dawenli_session;
  if (!token) return null;
  const s = await getSession(token);
  if (!s || s.kind !== "user") return null;
  if (Date.now() > s.expires_at) {
    await deleteSession(token);
    return null;
  }
  return (await getUserById(s.subject_id));
}

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])
  );
}

/* ===================== جلسات الأدمن (منفصلة تمامًا عن المستخدمين) ===================== */

async function newAdminSession(adminId) {
  const token = crypto.randomBytes(24).toString("hex");
  await createSession(token, "admin", adminId, Date.now() + SESSION_TTL);
  return token;
}
async function sessionAdmin(req) {
  const token = parseCookies(req).dawenli_admin;
  if (!token) return null;
  const s = await getSession(token);
  if (!s || s.kind !== "admin") return null;
  if (Date.now() > s.expires_at) {
    await deleteSession(token);
    return null;
  }
  return (await getAdminById(s.subject_id));
}

/* ===================== كلمات السر (scrypt — من غير مكتبات) ===================== */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      crypto.scryptSync(String(pw), salt, 64)
    );
  } catch {
    return false;
  }
}

/* ===================== السيرفر ===================== */

/* ===================== Async error handling (Express 4 بيلهمل الـ rejections) ===================== */
// Express 4 مش بيمسك الأخطاء اللي جاية من async handler — بتشتغل زي exception عادي
// وبتوقّف العملية كلها. ده كان سبب السيرفر إنه يقع عند أول خطأ في قاعدة البيانات.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ===================== Rate limiting (في الداتابيز — يشتغل على Vercel) ===================== */
// كان Map في الذاكرة: على Vercel كل cold start كان بيصفّر العداد، يعني الحماية
// من تخمين كلمات السر بتختفي تمامًا. دلوقتي العداد متخزّن ومش بيعتمد على instance.
function rateLimit({ bucket, max, windowMs }) {
  return ah(async (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
    const { count, resetAt } = await rateLimitBump(bucket, ip, windowMs);
    if (count > max) {
      const sec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", String(sec));
      return res.status(429).json({ error: `محاولات كتير — استنى ${sec} ثانية وجرّب تاني` });
    }
    next();
  });
}

const loginLimiter = rateLimit({ bucket: "login", max: 8, windowMs: 10 * 60 * 1000 }); // 8 / 10د
const voiceLimiter = rateLimit({ bucket: "voice", max: 40, windowMs: 10 * 60 * 1000 });
const uploadLimiter = rateLimit({ bucket: "upload", max: 30, windowMs: 10 * 60 * 1000 });
const reportLimiter = rateLimit({ bucket: "report", max: 5, windowMs: 15 * 60 * 1000 }); // بلاغات: ٥ كل ربع ساعة
// أنواع مسموح برفعها — صور نقطية + PDF بس. **مرفوض SVG** (ممكن يحمل سكربت = XSS).
const ALLOWED_UPLOAD = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif", "application/pdf",
]);

// باني سياق "اسأل دوّنلي" حسب النطاق المختار — مستخدم في الشات النصي والصوتي.
async function buildAskContext(userId, scope, date, from, to) {
  const journalCtx = (rows) =>
    rows.map((e) => `📅 ${e.entry_date}${e.mood ? ` (${e.mood})` : ""}: ${e.transcript || e.summary || ""}`).join("\n\n");
  switch (scope) {
    case "day": return journalCtx((await entriesBetween(userId, date, date)));
    case "range": return journalCtx((await entriesBetween(userId, from, to)));
    case "finance":
      return (await listFinance(userId, 500)).map((f) => `📅 ${f.entry_date} ${f.direction === "income" ? "دخل" : "صرف"} ${f.amount} ${f.currency || "جنيه"}${f.category ? " · " + f.category : ""}${f.note ? " · " + f.note : ""}`).join("\n");
    case "health":
      return (await listHealth(userId, 500)).map((h) => `📅 ${h.entry_date} [${h.category}] ${h.detail}${h.body_region && h.body_region !== "عام" ? " (" + h.body_region + ")" : ""}`).join("\n");
    case "mental":
      return (await listHealth(userId, 500)).filter((h) => h.category === "نفسية").map((h) => `📅 ${h.entry_date}: ${h.detail}`).join("\n");
    case "goals":
      return (await listGoals(userId)).map((g) => `🎯 ${g.title}: ${g.current}${g.target ? " / " + g.target : ""}${g.unit ? " " + g.unit : ""}`).join("\n");
    case "habits":
      return (await listHabits(userId)).map((h) => `🔁 ${h.title} (${h.kind === "quit" ? "بيبطّلها" : "بيعملها"}) — ستريك ${h.streak}، اتعملت ${h.total} مرة`).join("\n");
    case "tasks":
      return (await listTasks(userId, "0000-01-01", "9999-12-31")).map((t) => `📌 ${t.due_date}${t.due_time ? " " + t.due_time : ""} — ${t.title} [${t.status === "done" ? "اتعملت" : "لسه"}]`).join("\n");
    case "meals":
      return (await listMeals(userId, 500)).map((m) => `🍽️ ${m.entry_date}${m.at_time ? " " + m.at_time : ""}: ${m.items}${m.note ? " · " + m.note : ""}`).join("\n");
    case "ideas":
      return (await listIdeas(userId)).map((i) => `💡 ${i.title}${i.detail ? " — " + i.detail : ""} [${i.status}]`).join("\n");
    case "problems":
      return (await listProblems(userId)).map((p) => `🧩 ${p.title}${p.detail ? " — " + p.detail : ""} [${p.area || "-"}/${p.status}]`).join("\n");
    default:
      return journalCtx((await listEntries(userId, 500)));
  }
}

export async function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Express 4 بيلهمل الـ rejected promises من الـ async handlers: أي error جاي من
  // قاعدة البيانات كان بيطلع exception عادي وبيقتل الـ process كله. بنلف كل
  // الـ handlers أوتوماتيك عشان كل error يروح للـ error middleware في الآخر.
  // (handlers بـ 4 args هي error middleware — بنسيبها زي ما هي)
  for (const m of ["get", "post", "put", "patch", "delete", "all", "use"]) {
    const orig = app[m].bind(app);
    app[m] = (path, ...rest) =>
      orig(
        path,
        ...rest.map((h) => (typeof h === "function" && h.length !== 4 && !h.__ah ? Object.assign(ah(h), { __ah: true }) : h))
      );
  }

  // هيدرات أمان أساسية على كل الردود
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
    next();
  });

  // CORS للـ API — عشان تطبيق الموبايل (Capacitor/أصول native) يقدر ينادي الـ APIs بالكوكيز.
  // أصول معروفة بس (allowlist) — آمن. الويب نفسه same-origin فمش محتاج ده.
  const APP_ORIGINS = new Set([
    "capacitor://localhost", "ionic://localhost",
    "http://localhost", "https://localhost",
    "https://dawenli.com", "https://www.dawenli.com",
  ]);
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && APP_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });

  // JSON صغيرة للـ API العادي؛ الصوت ليه parser منفصل (raw) في endpoint بتاعه
  app.use(express.json({ limit: "64kb" }));

  // على Vercel كل النداءات HTTPS، فالكوكي لازم Secure. على localhost
  // (http) بنسيبها من غير Secure وإلا المتصفح مش هيبعت الكوكي أصلاً.
  const secure = config.isServerless ? "; Secure" : "";

  async function openSession(res, userId, remember) {
    const token = await newSession(userId);
    const maxAge = remember === false ? "" : `; Max-Age=${30 * 86400}`;
    res.setHeader(
      "Set-Cookie",
      `dawenli_session=${token}; HttpOnly; SameSite=Strict; Path=/${maxAge}${secure}`
    );
  }

  // bootstrap: أول أدمن من DASHBOARD_PASSWORD (يوزر: admin) لو مفيش أدمنز
  if ((await countAdmins()) === 0 && config.dashboardPassword) {
    (await createAdmin({ username: "admin", passwordHash: hashPassword(config.dashboardPassword) }));
    console.log("👤 اتعمل أدمن افتراضي: admin (الباسورد = DASHBOARD_PASSWORD) — غيّره بعد أول دخول");
  }

  async function openAdminSession(res, adminId, remember) {
    const token = await newAdminSession(adminId);
    const maxAge = remember === false ? "" : `; Max-Age=${30 * 86400}`;
    res.setHeader("Set-Cookie", `dawenli_admin=${token}; HttpOnly; SameSite=Strict; Path=/${maxAge}${secure}`);
  }

  // دخول المستخدمين: إيميل + باسورد (مفيش أدمن هنا)
  app.post("/api/login", loginLimiter, async (req, res) => {
    const { email, password, remember } = req.body || {};
    let userId = null;
    if (email && password) {
      const user = (await getUserByEmail(email));
      if (user?.password_hash && verifyPassword(password, user.password_hash)) userId = user.id;
    }
    if (!userId) return res.status(401).json({ ok: false, error: "بيانات الدخول غلط" });
    (await openSession(res, userId, remember));
    return res.json({ ok: true });
  });

  /* ===== دخول الأدمن (منفصل) ===== */
  app.post("/api/admin/login", loginLimiter, async (req, res) => {
    const { username, password, remember } = req.body || {};
    const admin = (await getAdminByUsername(username));
    if (!admin || !verifyPassword(password || "", admin.password_hash)) {
      return res.status(401).json({ ok: false, error: "اسم المستخدم أو كلمة السر غلط" });
    }
    (await touchAdminLogin(admin.id));
    (await openAdminSession(res, admin.id, remember));
    return res.json({ ok: true });
  });
  app.post("/api/admin/logout", async (req, res) => {
    const t = parseCookies(req).dawenli_admin;
    if (t) (await deleteSession(t));
    res.setHeader("Set-Cookie", `dawenli_admin=; HttpOnly; Path=/; Max-Age=0${secure}`);
    res.json({ ok: true });
  });

  // حساب جديد بالإيميل
  // التسجيل العام مقفول — الحسابات بتتعمل من لوحة الأدمن بس
  app.post("/api/signup", loginLimiter, (_req, res) => {
    return res.status(403).json({ ok: false, error: "التسجيل مقفول — تواصل مع الأدمن عشان يفتحلك حساب" });
  });

  app.post("/api/logout", async (req, res) => {
    const t = parseCookies(req).dawenli_session;
    if (t) (await deleteSession(t));
    res.setHeader("Set-Cookie", `dawenli_session=; HttpOnly; Path=/; Max-Age=0${secure}`);
    res.json({ ok: true });
  });

  // أصول عامة (مفيهاش بيانات حسّاسة)
  app.get("/style.css", (_req, res) => res.sendFile(join(publicDir, "style.css")));
  app.get("/login.js", (_req, res) => res.sendFile(join(publicDir, "login.js")));
  app.use("/assets", express.static(join(publicDir, "assets")));

  // PWA — الـ manifest و الـ service worker لازم يتقدّموا من الجذر (scope = "/")
  app.get("/manifest.webmanifest", (_req, res) => {
    res.type("application/manifest+json");
    res.sendFile(join(publicDir, "manifest.webmanifest"));
  });
  app.get("/sw.js", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.type("application/javascript");
    res.sendFile(join(publicDir, "sw.js"));
  });

  app.get(["/login", "/login.html"], async (req, res) => {
    if ((await sessionUser(req))) return res.redirect("/");
    res.sendFile(join(publicDir, "login.html"));
  });

  app.get(["/landing", "/landing.html", "/welcome"], async (req, res) => {
    // اللي مسجّل دخول مايشوفش صفحة الهبوط — يروح الداشبورد على طول
    if ((await sessionUser(req))) return res.redirect("/");
    res.sendFile(join(publicDir, "landing.html"));
  });

  // محمي: السكربت والصفحة والبيانات
  app.get("/app.js", async (req, res) =>
    (await sessionUser(req)) ? res.sendFile(join(publicDir, "app.js")) : res.status(401).end()
  );

  app.get("/", async (req, res) => {
    // الزائر الجديد يشوف صفحة الهبوط (وفيها «نزّل التطبيق») أول حاجة؛ المسجّل يدخل الداشبورد.
    if (!(await sessionUser(req))) return res.redirect("/landing");
    res.sendFile(join(publicDir, "index.html"));
  });

  /* ===== صفحات الأدمن ===== */
  app.get(["/admin/login", "/admin-login.html"], async (req, res) => {
    if ((await sessionAdmin(req))) return res.redirect("/admin");
    res.sendFile(join(publicDir, "admin-login.html"));
  });
  app.get("/admin.js", async (req, res) =>
    (await sessionAdmin(req)) ? res.sendFile(join(publicDir, "admin.js")) : res.status(401).end()
  );
  app.get(["/admin", "/admin.html"], async (req, res) => {
    if (!(await sessionAdmin(req))) return res.redirect("/admin/login");
    res.sendFile(join(publicDir, "admin.html"));
  });

  // gate: بيرجّع المستخدم بتاع الجلسة أو بيقفل الطلب
  const gate = async (req, res) => {
    const user = (await sessionUser(req));
    if (!user) {
      res.status(401).json({ error: "غير مصرّح" });
      return null;
    }
    return user;
  };

  // adminGate: للـ endpoints الخاصة بلوحة الأدمن
  const adminGate = async (req, res) => {
    const admin = (await sessionAdmin(req));
    if (!admin) {
      res.status(401).json({ error: "غير مصرّح" });
      return null;
    }
    return admin;
  };
  // ownerGate: الأدمن أو صاحب التطبيق (is_owner) — عشان صاحب التطبيق يظبّط مزود
  // الذكاء والتحديثات من جوّه التطبيق من غير ما يسجّل دخول تاني في لوحة الأدمن.
  // المستخدمين العاديين مايوصلوش (دي إعدادات بتأثر على التطبيق كله).
  const ownerGate = async (req, res) => {
    if ((await sessionAdmin(req))) return { kind: "admin" };
    const user = (await sessionUser(req));
    if (user?.is_owner) return { kind: "owner", user };
    res.status(403).json({ error: "الإعدادات دي لصاحب التطبيق بس" });
    return null;
  };

  /* ===== API الأدمن ===== */
  app.get("/api/admin/me", async (req, res) => {
    const admin = (await adminGate(req, res));
    if (!admin) return;
    res.json({ username: admin.username, lastLogin: admin.last_login });
  });
  app.get("/api/admin/overview", async (req, res) => {
    const admin = (await adminGate(req, res));
    if (!admin) return;
    res.json({
      stats: (await platformStats()),
      users: (await listUsersWithStats()),
      usage: (await aiUsageSummary(30)),
      pricing: PRICING,
    });
  });
  /* ===== تحديثات التطبيق من الجيت ===== */
  app.get("/api/admin/version",  async (req, res) => {
    if (!(await ownerGate(req, res))) return;
    // check=0 → قراءة سريعة من غير ما نضرب على الريبو (للعرض الأولي)
    res.json(await versionStatus({ checkRemote: req.query.check !== "0" }));
  });
  let _updating = false;
  app.post("/api/admin/update",  async (req, res) => {
    if (!(await ownerGate(req, res))) return;
    if (_updating) return res.status(409).json({ ok: false, error: "فيه تحديث شغّال دلوقتي — استنى شوية" });
    _updating = true;
    try {
      const out = await pullUpdate();
      if (out.ok && out.changed) {
        res.json({ ...out, restarting: true, message: "التحديث نزل ✅ — التطبيق بيقوم تاني، استنى ثواني واعمل ريفريش" });
        scheduleRestart(); // بعد ما الرد يوصل
        return;
      }
      res.status(out.ok ? 200 : 500).json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    } finally {
      _updating = false;
    }
  });

  /* ===== إعدادات مزود الذكاء (OpenAI / Gemini / Grok / مخصص) ===== */
  app.get("/api/admin/ai-settings", async (req, res) => {
    if (!(await ownerGate(req, res))) return;
    const s = aiSettings();
    res.json({
      configured: !!s.apiKey,
      source: s.source, // db = من الإعدادات، env = من ملف .env القديم، none = محتاج إعداد
      provider: s.provider,
      model: s.model,
      baseUrl: s.provider === "custom" ? s.baseURL : undefined,
      // المفتاح مايتبعتش كامل أبدًا — آخر ٤ حروف للتأكيد بس
      keyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : null,
      hasVoiceKey: !!s.voiceKey,
      providers: Object.fromEntries(
        Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, defaultModel: p.defaultModel }])
      ),
    });
  });
  app.put("/api/admin/ai-settings", async (req, res) => {
    if (!(await ownerGate(req, res))) return;
    const { provider, api_key, model, base_url, voice_key } = req.body || {};
    if (!PROVIDERS[provider]) return res.status(400).json({ error: "اختار مزود صحيح" });
    const existing = aiSettings();
    if (!api_key && existing.source !== "db") return res.status(400).json({ error: "حط مفتاح الـ API" });
    if (provider === "custom" && !String(base_url || "").startsWith("http"))
      return res.status(400).json({ error: "المزود المخصص محتاج baseURL صحيح (يبدأ بـ https)" });
    saveAiSettings({
      provider,
      apiKey: api_key || undefined,
      model: model || PROVIDERS[provider].defaultModel,
      baseUrl: provider === "custom" ? base_url : undefined,
      voiceKey: voice_key !== undefined ? voice_key : undefined,
    });
    res.json({ ok: true });
  });
  // اختبار حي: بيكلم المزود فعلاً بمفتاح/موديل الفورم (من غير حفظ) أو بالمحفوظ لو الفورم فاضي
  app.post("/api/admin/ai-settings/test",  async (req, res) => {
    if (!(await ownerGate(req, res))) return;
    const { provider, api_key, model, base_url } = req.body || {};
    const saved = aiSettings();
    const p = PROVIDERS[provider || saved.provider] || PROVIDERS.openai;
    const key = api_key || saved.apiKey;
    const baseURL = (provider || saved.provider) === "custom" ? (base_url || saved.baseURL) : p.baseURL;
    const testModel = model || (provider && provider !== saved.provider ? p.defaultModel : saved.model) || p.defaultModel;
    if (!key) return res.status(400).json({ error: "مفيش مفتاح للاختبار" });
    try {
      const tc = new OpenAI({ apiKey: key, ...(baseURL ? { baseURL } : {}), timeout: 20000, maxRetries: 0 });
      const r = await tc.chat.completions.create({
        model: testModel,
        messages: [{ role: "user", content: "رد بكلمة واحدة بس: تمام" }],
        max_tokens: 10,
      });
      res.json({ ok: true, model: testModel, reply: (r.choices?.[0]?.message?.content || "").trim() });
    } catch (err) {
      const friendly = aiErrorMessage(err);
      res.json({ ok: false, model: testModel, error: friendly || String(err?.message || err).slice(0, 300) });
    }
  });

  // إنشاء حساب مستخدم من الأدمن (التسجيل العام مقفول)
  app.post("/api/admin/users", async (req, res) => {
    const admin = (await adminGate(req, res));
    if (!admin) return;
    const { name, email, password } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return res.status(400).json({ error: "اكتب إيميل صحيح" });
    if (!password || String(password).length < 6) return res.status(400).json({ error: "كلمة السر لازم ٦ حروف على الأقل" });
    const user = (await createEmailUser({
      name: String(name || "").trim() || null,
      email: cleanEmail,
      passwordHash: hashPassword(password),
    }));
    if (!user) return res.status(409).json({ error: "الإيميل ده متسجّل قبل كده" });
    res.json({ ok: true, user: { id: user.id, email: cleanEmail, name: user.name } });
  });
  // تحويل ملكية التطبيق لحساب (المالك بيقدر يظبّط الذكاء والتحديثات من جوّه التطبيق)
  app.put("/api/admin/users/:id/owner", async (req, res) => {
    const admin = (await adminGate(req, res));
    if (!admin) return;
    const id = Number(req.params.id);
    const target = (await getUserById(id));
    if (!target) return res.status(404).json({ error: "الحساب مش موجود" });
    const makeOwner = !!(req.body || {}).is_owner;
    if (makeOwner && !target.email) return res.status(400).json({ error: "الحساب ده مالوش إيميل فمينفعش يسجّل دخول" });
    if (!makeOwner && (await countLoginableOwners()) <= 1 && target.is_owner)
      return res.status(400).json({ error: "ده آخر صاحب للتطبيق — عيّن واحد تاني الأول" });
    res.json({ ok: (await setUserOwner(id, makeOwner)) });
  });
  // تفاصيل مستخدم واحد (قراءة فقط للمراقبة)
  app.get("/api/admin/users/:id", async (req, res) => {
    const admin = (await adminGate(req, res));
    if (!admin) return;
    const uid = Number(req.params.id);
    const u = (await getUserById(uid));
    if (!u) return res.status(404).json({ error: "المستخدم مش موجود" });
    res.json({
      user: { id: u.id, name: u.name, email: u.email, last_seen: u.last_seen, created_at: u.created_at, is_owner: !!u.is_owner },
      entries: (await listEntries(uid, 30)),
      finance: (await listFinance(uid, 50)),
      health: (await listHealth(uid, 50)),
      goals: (await listGoals(uid)),
      habits: (await listHabits(uid)),
      tasks: (await listTasks(uid, "0000-01-01", "9999-12-31")),
      profile: (await listProfileFacts(uid)),
    });
  });

  app.get("/api/me", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({
      id: user.id,
      name: user.name,
      isOwner: !!user.is_owner,
      today: (await localToday()),
    });
  });
  // تكلفة المستخدم على الذكاء الاصطناعي — يظهر له في الرئيسية
  app.get("/api/my-usage", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await userUsageCost(user.id)));
  });
  // تفاصيل تكلفة الـ AI للمستخدم نفسه (مقسّمة بالنوع)
  app.get("/api/my-usage/details", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ...userUsageDetails(user.id), pricing: PRICING, usdEgp: (await getAssetMarket())?.rates?.USD || null });
  });

  /* ===== إشعارات PWA (Web Push) ===== */
  // مفتاح VAPID العام — العميل بيستخدمه عشان يعمل subscribe
  app.get("/api/push/key", async (req, res) => {
    if (!(await gate(req, res))) return;
    res.json({ enabled: pushEnabled, key: pushEnabled ? vapidPublicKey : null });
  });
  // تسجيل اشتراك جهاز
  app.post("/api/push/subscribe", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    if (!pushEnabled) return res.status(503).json({ error: "push_disabled" });
    const ok = (await savePushSubscription(user.id, req.body));
    if (!ok) return res.status(400).json({ error: "bad_subscription" });
    res.json({ ok: true });
  });
  // إلغاء اشتراك جهاز
  app.post("/api/push/unsubscribe", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    (await deletePushSubscription(req.body?.endpoint));
    res.json({ ok: true });
  });
  // إشعار تجريبي للمستخدم الحالي (بيتخزّن في الجرس كمان)
  app.post("/api/push/test",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const sent = await notifyUser(user.id, {
      title: "دوّنلي ✍️",
      body: "التنبيهات شغّالة! هفكّرك تدوّن يومك كل يوم.",
      url: "/",
      icon: "🔔",
    });
    res.json({ ok: true, sent });
  });

  /* ===== إشعارات داخل التطبيق (الجرس) ===== */
  app.get("/api/notifications", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({
      items: (await listNotifications(user.id, 30)),
      unread: (await unreadNotificationCount(user.id)),
    });
  });
  app.post("/api/notifications/read", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    (await markNotificationsRead(user.id, req.body?.id || null));
    res.json({ ok: true, unread: (await unreadNotificationCount(user.id)) });
  });

  /* ===== الأقسام ===== */
  app.get("/api/entries", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listEntries(user.id, 500)));
  });
  app.get("/api/finance", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listFinance(user.id, 500)));
  });
  app.get("/api/health", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listHealth(user.id, 500)));
  });
  app.get("/api/goals", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listGoals(user.id)));
  });
  app.get("/api/conversations", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listConversations(user.id, 500)));
  });
  app.get("/api/conditions", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listConditions(user.id)));
  });
  app.get("/api/meals", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listMeals(user.id, 500)));
  });
  app.get("/api/habits", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listHabits(user.id)));
  });

  /* ===== الذاكرة الدائمة (دوّنلي يعرف عنك) ===== */
  app.get("/api/profile", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listProfileFacts(user.id)));
  });
  app.post("/api/profile", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { category, key, value } = req.body || {};
    if (!key || !value) return res.status(400).json({ error: "المفتاح والقيمة مطلوبين" });
    res.json({ ok: true, fact: (await upsertProfileFact({ userId: user.id, category, key, value })) });
  });
  app.delete("/api/profile/:id", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await deleteProfileFact(user.id, Number(req.params.id))) });
  });

  /* ===== المهام والتقويم ===== */
  app.get("/api/tasks", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const from = String(req.query.from || "0000-01-01");
    const to = String(req.query.to || "9999-12-31");
    res.json((await listTasks(user.id, from, to)));
  });
  app.post("/api/tasks", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { title, dueDate, dueTime, note, resources } = req.body || {};
    if (!title) return res.status(400).json({ error: "العنوان مطلوب" });
    // dueDate = "" → مهمة عامة من غير يوم (مسموح)
    res.json({ ok: true, task: (await addTask({ userId: user.id, title, dueDate, dueTime, note, resources })) });
  });
  app.put("/api/tasks/:id/done", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: !!(await completeTask(user.id, { id: Number(req.params.id) })) });
  });
  app.put("/api/tasks/:id/reopen", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await reopenTask(user.id, Number(req.params.id))) });
  });
  app.delete("/api/tasks/:id", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await deleteTask(user.id, Number(req.params.id))) });
  });

  /* ===== الأفكار (دماغك) ===== */
  app.get("/api/ideas", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listIdeas(user.id)));
  });
  app.post("/api/ideas", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { title, detail } = req.body || {};
    if (!title) return res.status(400).json({ error: "اكتب الفكرة" });
    res.json({ ok: true, idea: (await addIdea({ userId: user.id, title, detail })) });
  });
  app.put("/api/ideas/:id/status", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await setIdeaStatus(user.id, Number(req.params.id), String(req.body?.status || ""))) });
  });

  /* ===== المشاكل (قلبك) ===== */
  app.get("/api/problems", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listProblems(user.id)));
  });
  app.post("/api/problems", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { title, detail, area } = req.body || {};
    if (!title) return res.status(400).json({ error: "اكتب المشكلة" });
    res.json({ ok: true, problem: (await addProblem({ userId: user.id, title, detail, area })) });
  });
  app.put("/api/problems/:id/status", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await setProblemStatus(user.id, Number(req.params.id), String(req.body?.status || ""), req.body?.note)) });
  });

  /* ===== اسأل دوّنلي (شات سياقي عن اليوميات — بيحافظ على الـ context) ===== */
  app.post("/api/ask",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { messages, scope, date, from, to, fast } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "اكتب رسالة" });
    // ناخد آخر ٢٠ رسالة بس (user/assistant) للحفاظ على التوكنز — الـ context مستمر
    const clean = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (!clean.length) return res.status(400).json({ error: "اكتب رسالة" });
    const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
    if ((scope === "day" && !dateOk(date)) || (scope === "range" && !(dateOk(from) && dateOk(to))))
      return res.status(400).json({ error: "اختار تاريخ صحيح الأول" });
    const contextText = (await buildAskContext(user.id, scope, date, from, to));
    try {
      const reply = await chatAboutJournal({ messages: clean, contextText, userId: user.id, fast: !!fast });
      // نحفظ الرسالة الجديدة + الرد عشان المحادثة تفضل موجودة بعد الريلود
      const lastUser = [...clean].reverse().find((m) => m.role === "user");
      if (lastUser) (await addAskMessage(user.id, "user", lastUser.content));
      (await addAskMessage(user.id, "assistant", reply));
      res.json({ reply });
    } catch (err) {
      console.error("ask error:", err);
      const friendly = aiErrorMessage(err);
      res.status(friendly ? 503 : 500).json({ error: friendly || "حصل خطأ، جرّب تاني" });
    }
  });
  // تاريخ محادثة اسأل دوّنلي (محفوظ)
  app.get("/api/ask/history", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listAskMessages(user.id, 200)));
  });
  app.delete("/api/ask/history", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    (await clearAskMessages(user.id));
    res.json({ ok: true });
  });

  // اسأل دوّنلي بالصوت: نفرّغ الصوت ونرد ونحفظ المحادثة
  app.post(
    "/api/ask/voice",
    voiceLimiter,
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
     async (req, res) => {
      const user = (await gate(req, res));
      if (!user) return;
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "مفيش صوت" });
      const scope = String(req.query.scope || "all");
      const date = String(req.query.date || "");
      if (scope === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "اختار تاريخ صحيح الأول" });
      const ext = String(req.headers["content-type"] || "").includes("ogg") ? "ogg" : "webm";
      try {
        const transcript = await transcribe(buf, `ask.${ext}`, user.id);
        if (!transcript) return res.status(422).json({ error: "مقدرتش أفهم الصوت، جرّب تاني" });
        const contextText = (await buildAskContext(user.id, scope, date));
        const messages = [...listAskMessages(user.id, 20), { role: "user", content: transcript }];
        const reply = await chatAboutJournal({ messages, contextText, userId: user.id });
        (await addAskMessage(user.id, "user", transcript));
        (await addAskMessage(user.id, "assistant", reply));
        res.json({ transcript, reply });
      } catch (err) {
        console.error("ask voice error:", err);
        res.status(500).json({ error: "حصل خطأ في معالجة الصوت، جرّب تاني" });
      }
    }
  );

  // تحويل رد لصوت (TTS) — للرد الصوتي في الشات
  app.post("/api/tts", voiceLimiter,  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "مفيش نص" });
    try {
      const buf = await textToSpeech(text, user.id);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(buf);
    } catch (err) {
      console.error("tts error:", err);
      res.status(500).json({ error: "فشل تحويل النص لصوت" });
    }
  });

  /* ===== مركز الملفات: رفع (raw) + تصنيف بالرؤية + عرض ===== */
  app.post(
    "/api/files",
    uploadLimiter,
    express.raw({ type: ["image/*", "application/pdf"], limit: "12mb" }),
     async (req, res) => {
      const user = (await gate(req, res));
      if (!user) return;
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!ALLOWED_UPLOAD.has(mime))
        return res.status(415).json({ error: "النوع ده مش مدعوم — ارفع صورة (PNG/JPG/WEBP) أو PDF" });
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "مفيش ملف" });
      let rawName;
      try { rawName = decodeURIComponent(String(req.query.name || "ملف")); }
      catch { rawName = "ملف"; }
      const safeName = rawName.replace(/[^\w.\-؀-ۿ ]/g, "_").slice(0, 120) || "ملف";
      const userDir = join(uploadsDir, String(user.id));
      let fullPath = null;
      try {
        mkdirSync(userDir, { recursive: true });
        fullPath = join(userDir, `${Date.now()}-${safeName}`);
        writeFileSync(fullPath, buf);
        let category = mime === "application/pdf" ? "مستند" : "أخرى";
        let description = "";
        if (mime.startsWith("image/")) {
          try {
            const c = await classifyImage({ base64: buf.toString("base64"), mime, userId: user.id });
            category = c.category;
            description = c.description;
          } catch (e) {
            console.error("classify error:", e);
          }
        }
        const file = (await addFile({ userId: user.id, filename: safeName, mime, size: buf.length, category, description, path: fullPath }));
        res.json({ ok: true, file });
      } catch (err) {
        if (fullPath) { try { unlinkSync(fullPath); } catch {} } // منسيبش ملف يتيم من غير صف
        console.error("file upload error:", err);
        res.status(500).json({ error: "حصل خطأ في رفع الملف" });
      }
    }
  );
  app.get("/api/files", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listFiles(user.id)));
  });
  app.get("/api/files/:id/raw", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const f = (await getFile(user.id, Number(req.params.id)));
    if (!f || !f.path || !f.path.startsWith(uploadsDir)) return res.status(404).end();
    res.setHeader("Content-Type", f.mime || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // sandbox + default-src none: حتى لو اترفع ملف خبيث، مايشتغلش أي سكربت في الأصل.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(f.path);
  });
  app.delete("/api/files/:id", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const f = (await getFile(user.id, Number(req.params.id)));
    if (f?.path) { try { unlinkSync(f.path); } catch {} }
    res.json({ ok: (await deleteFile(user.id, Number(req.params.id))) });
  });

  /* ===== تعديل أي عنصر (مرونة التعديل) — PUT /api/<نوع>/:id ===== */
  const updaters = {
    finance: updateFinance,
    health: updateHealth,
    entries: updateEntry,
    tasks: updateTaskFields,
    meals: updateMeal,
    goals: updateGoalMeta,
    ideas: updateIdeaFields,
    problems: updateProblemFields,
    habits: updateHabitFields,
    metrics: updateMetricMeta,
  };
  for (const [kind, fn] of Object.entries(updaters)) {
    app.put(`/api/${kind}/:id`, async (req, res) => {
      const user = (await gate(req, res));
      if (!user) return;
      res.json({ ok: await fn(user.id, Number(req.params.id), req.body || {}) });
    });
  }

  // الكومبوزر في الداشبورد: "رتّبهالي" — بيشغّل الـ agent على النص
  app.post("/api/log",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "اكتب حاجة الأول" });
    try {
      const { reply, receipts } = await runAgent({ user, text, kind: "dashboard" });
      res.json({ reply, receipts });
    } catch (err) {
      console.error("dashboard log error:", err);
      const friendly = aiErrorMessage(err);
      res.status(friendly ? 503 : 500).json({ error: friendly || "حصل خطأ أثناء المعالجة، جرّب تاني" });
    }
  });

  // تسجيل صوت من الداشبورد: المتصفح بيبعت الصوت (webm/ogg) كـ raw body،
  // بنفرّغه بـ whisper وبنمرره لنفس الـ agent ونرجّع التفريغ + الرد + الإيصالات.
  app.post(
    "/api/voice",
    voiceLimiter,
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
     async (req, res) => {
      const user = (await gate(req, res));
      if (!user) return;
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ error: "مفيش صوت" });
      const ext = (req.headers["content-type"] || "").includes("ogg") ? "ogg" : "webm";
      const audioPath = persistAudio(user.id, "voice", ext, buf); // احفظ فورًا قبل أي معالجة
      try {
        const transcript = await transcribe(buf, `voice.${ext}`, user.id);
        if (!transcript) return res.status(422).json({ error: "مقدرتش أفهم الصوت، جرّب تاني — تسجيلك محفوظ عندنا" });
        // منع تكرار: لو نفس التسجيل اتبعت واتعالج قبل كده بدقايق (ريتراي/دبل-سبمت) ماتعالجهوش تاني
        const dup = (await recentIdenticalConversation(user.id, transcript, 15));
        if (dup) {
          cleanupAudio(audioPath);
          return res.json({ transcript, reply: dup.ai_reply || "التسجيل ده اتسجّل قبل كده ✅", receipts: [], duplicate: true });
        }
        const { reply, receipts } = await runAgent({ user, text: transcript, kind: "voice" });
        cleanupAudio(audioPath); // نجح كله → الخام مبقاش محتاج
        res.json({ transcript, reply, receipts });
      } catch (err) {
        console.error("dashboard voice error:", err, "| الصوت محفوظ في:", audioPath);
        const friendly = aiErrorMessage(err);
        res.status(friendly ? 503 : 500).json({ error: friendly || "حصل خطأ أثناء معالجة الصوت، جرّب تاني — تسجيلك محفوظ عندنا" });
      }
    }
  );

  /* ===== خواطر / عصف ذهني ===== */
  app.get("/api/thoughts", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listThoughts(user.id)));
  });
  app.post("/api/thoughts", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const t = (await addThought(user.id, (req.body || {}).text, "text"));
    if (!t) return res.status(400).json({ error: "اكتب خاطرة الأول" });
    res.json({ ok: true, thought: t });
  });
  app.delete("/api/thoughts/:id", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await deleteThought(user.id, Number(req.params.id))) });
  });
  app.post(
    "/api/thoughts/voice",
    voiceLimiter,
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
     async (req, res) => {
      const user = (await gate(req, res));
      if (!user) return;
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ error: "مفيش صوت" });
      const ext = (req.headers["content-type"] || "").includes("ogg") ? "ogg" : "webm";
      const audioPath = persistAudio(user.id, "thought", ext, buf); // احفظ فورًا قبل أي معالجة
      try {
        const transcript = await transcribe(buf, `thought.${ext}`, user.id);
        if (!transcript) return res.status(422).json({ error: "مقدرتش أفهم الصوت، جرّب تاني — تسجيلك محفوظ عندنا" });
        cleanupAudio(audioPath); // نجح → الخام مبقاش محتاج
        const thought = (await addThought(user.id, transcript, "voice"));
        res.json({ transcript, thought });
      } catch (err) {
        console.error("thought voice error:", err, "| الصوت محفوظ في:", audioPath);
        const friendly = aiErrorMessage(err);
        res.status(friendly ? 503 : 500).json({ error: friendly || "حصل خطأ أثناء معالجة الصوت، جرّب تاني — تسجيلك محفوظ عندنا" });
      }
    }
  );

  /* ===== التحليل والتقارير ===== */
  app.get("/api/analyze",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : 7;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const entries = (await entriesSince(user.id, since));
    if (!entries.length) return res.json({ analysis: "مفيش تدوينات في الفترة دي." });
    try {
      const analysis = await analyzeEntries(entries, user.id);
      res.json({ analysis });
    } catch (err) {
      console.error("analyze error:", err);
      res.status(500).json({ error: "فشل التحليل" });
    }
  });

  // التقرير الشامل الواحد — من كل كلام المستخدم في الفترة
  app.get("/api/report",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
    try {
      const data = (await buildReportData(user.id, days));
      const report = await unifiedReport(data, user.id);
      res.json({ report, data });
    } catch (err) {
      console.error("report error:", err);
      res.status(500).json({ error: "فشل توليد التقرير" });
    }
  });

  // تقرير للدكتور: تلخيص AI + خط زمني للأعراض في فترة المتابعة
  app.get("/api/conditions/:id/report",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const condition = (await getCondition(user.id, Number(req.params.id)));
    if (!condition) return res.status(404).json({ error: "المتابعة مش موجودة" });
    const items = (await healthBetween(user.id, condition.start_date, condition.end_date));
    try {
      const summary = await doctorReport(condition, items, user.id);
      res.json({ condition, summary, timeline: items });
    } catch (err) {
      console.error("doctor report error:", err);
      res.status(500).json({ error: "فشل توليد التقرير" });
    }
  });

  /* ===== الحذف ===== */
  const deleters = {
    entries: deleteEntry,
    finance: deleteFinance,
    health: deleteHealth,
    goals: deleteGoal,
    conversations: deleteConversation,
    conditions: deleteCondition,
    meals: deleteMeal,
    habits: deleteHabit,
    ideas: deleteIdea,
    problems: deleteProblem,
    metrics: deleteMetric,
  };
  for (const [kind, fn] of Object.entries(deleters)) {
    app.delete(`/api/${kind}/:id`, async (req, res) => {
      const user = (await gate(req, res));
      if (!user) return;
      res.json({ ok: fn(user.id, Number(req.params.id)) });
    });
  }

  // إقفال متابعة (خلصت/مش محتاجها)
  app.put("/api/conditions/:id/close", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await closeCondition(user.id, Number(req.params.id))) });
  });

  /* ===== ماليات: إضافة يدوية من الداشبورد ===== */
  app.get("/api/finance-categories", async (req, res) => {
    if (!(await gate(req, res))) return;
    res.json(FINANCE_CATEGORIES);
  });

  /* ===== ميزانية وهدف الشهر ===== */
  app.get("/api/finance-budget", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : (await localToday()).slice(0, 7);
    res.json((await getFinanceBudget(user.id, month)));
  });
  app.put("/api/finance-budget", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { month, budget, goal } = req.body || {};
    const m = /^\d{4}-\d{2}$/.test(String(month || "")) ? month : (await localToday()).slice(0, 7);
    res.json({ ok: true, budget: (await setFinanceBudget(user.id, m, { budget, goal })) });
  });

  /* ===== الأصول (دهب / كاش / أصول تانية) + أسعار حيّة ===== */
  app.get("/api/assets", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ assets: (await listAssets(user.id)), market: (await getAssetMarket()) });
  });
  // أسعار السوق لوحدها (للتحويل في صفحة الفلوس مثلاً)
  app.get("/api/market", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await getAssetMarket()));
  });
  app.post("/api/assets", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const b = req.body || {};
    if (!b.type) return res.status(400).json({ error: "اختار نوع الأصل" });
    res.json({ ok: true, asset: (await addAsset({ userId: user.id, ...b })) });
  });
  // مسارات محددة قبل /:id عشان متتلخبطش مع :id
  app.post("/api/assets/refresh-prices",  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const prev = (await getAssetMarket());
    let rates = {};
    let goldG24Egp = null;
    try {
      const cr = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      const egpPerUsd = cr?.rates?.EGP;
      if (egpPerUsd) {
        rates.EGP = 1;
        rates.USD = egpPerUsd;
        for (const cur of ["EUR", "SAR", "AED", "GBP", "KWD"]) {
          if (cr.rates[cur]) rates[cur] = egpPerUsd / cr.rates[cur]; // جنيه لكل وحدة عملة
        }
      }
    } catch (e) { console.error("rates fetch failed:", e?.message); }
    try {
      const g = await fetch("https://api.gold-api.com/price/XAU", { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      const usdPerOz = g?.price;
      const usdEgp = rates.USD || prev.rates?.USD;
      if (usdPerOz && usdEgp) goldG24Egp = (usdPerOz / 31.1035) * usdEgp; // جرام عيار ٢٤ بالجنيه
    } catch (e) { console.error("gold fetch failed:", e?.message); }
    const market = (await setAssetMarket({
      goldG24Egp: goldG24Egp ?? prev.goldG24Egp,
      rates: Object.keys(rates).length ? { ...prev.rates, ...rates } : prev.rates,
    }));
    res.json(market);
  });
  app.put("/api/assets/market", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const prev = (await getAssetMarket());
    const { goldG24Egp, rates } = req.body || {};
    res.json((await setAssetMarket({
      goldG24Egp: goldG24Egp != null && goldG24Egp !== "" ? Number(goldG24Egp) : prev.goldG24Egp,
      rates: { ...prev.rates, ...(rates || {}) },
    })));
  });
  app.put("/api/assets/:id", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await updateAsset(user.id, Number(req.params.id), req.body || {})) });
  });
  app.delete("/api/assets/:id", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await deleteAsset(user.id, Number(req.params.id))) });
  });
  app.post("/api/finance", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { entryDate, direction, amount, currency, category, note } = req.body || {};
    if (amount == null || amount === "" || isNaN(Number(amount)))
      return res.status(400).json({ error: "المبلغ مطلوب" });
    // التاريخ اختياري: فاضي/مش موجود = النهارده. أي قيمة تانية لازم تكون
    // YYYY-MM-DD حقيقية، ومش أبعد من النهارده (ما نسجّلش عمليات مستقبلية).
    const todayStr = localToday();
    let eDate = todayStr;
    if (entryDate != null && entryDate !== "") {
      const s = String(entryDate);
      // Date.parse بيعدّي 2026-02-31 لـ 2026-03-03 من غير ما يبقى NaN، فبنتحقق
      // إن الرجوع لنفس النص (يعني التاريخ موجود فعلًا مش متسرّب).
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
      if (!parsed || isNaN(parsed) || parsed.toISOString().slice(0, 10) !== s)
        return res.status(400).json({ error: "تاريخ غير صحيح" });
      if (s > todayStr)
        return res.status(400).json({ error: "التاريخ لا يمكن أن يكون في المستقبل" });
      eDate = s;
    }
    const id = (await addFinance({
      userId: user.id,
      entryDate: eDate,
      direction,
      amount,
      currency,
      category,
      note,
    }));
    res.json({ ok: true, id });
  });

  /* ===== صحة: إضافة يدوية ===== */
  app.post("/api/health", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { entryDate, category, detail, bodyRegion } = req.body || {};
    if (!detail) return res.status(400).json({ error: "الوصف مطلوب" });
    const id = (await addHealth({ userId: user.id, entryDate, category, detail, bodyRegion }));
    res.json({ ok: true, id });
  });

  /* ===== عادات: إنشاء/تسجيل/إلغاء تسجيل من الداشبورد ===== */
  app.post("/api/habits", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { title, kind, emoji, note } = req.body || {};
    if (!title) return res.status(400).json({ error: "اسم العادة مطلوب" });
    const habit = (await addHabit({ userId: user.id, title, kind, emoji, note }));
    res.json({ ok: true, habit });
  });
  app.post("/api/habits/:id/log", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { date } = req.body || {};
    res.json({ ok: true, ...logHabit(Number(req.params.id), date) });
  });
  app.delete("/api/habits/:id/log", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const date = req.query.date || (await localToday());
    res.json({ ok: (await unlogHabit(Number(req.params.id), date)) });
  });

  /* ===== أهداف: إنشاء/تعديل يدوي من الداشبورد ===== */
  app.post("/api/goals", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { title, target, unit, note, period, deadline } = req.body || {};
    if (!title) return res.status(400).json({ error: "العنوان مطلوب" });
    const g = (await applyGoal({
      userId: user.id,
      title,
      target: target != null && target !== "" ? Number(target) : null,
      unit: unit || null,
      note: note || null,
      period: period || null,
      deadline: deadline || null,
    }));
    res.json({ ok: true, goal: g });
  });
  app.put("/api/goals/:id/current", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { current } = req.body || {};
    res.json({ ok: (await setGoalCurrent(user.id, Number(req.params.id), Number(current) || 0)) });
  });

  // سجل تقدّم الهدف (إمتى زوّدت كام)
  app.get("/api/goals/:id/log", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await goalLog(user.id, Number(req.params.id))));
  });
  // حذف بند من سجل الهدف (بيطرح الدلتا من رصيد الهدف)
  app.delete("/api/goals/log/:logId", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await deleteGoalLog(user.id, Number(req.params.logId))) });
  });
  // تعديل بند في سجل الهدف (التفاصيل و/أو المبلغ)
  app.put("/api/goals/log/:logId", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { delta, note } = req.body || {};
    res.json({ ok: (await updateGoalLog(user.id, Number(req.params.logId), { delta, note })) });
  });

  /* ===== المتتبِّعات اليومية (أرقام يومية) ===== */
  app.get("/api/metrics", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await listMetricsWithStats(user.id)));
  });
  app.post("/api/metrics", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { title, value, unit, emoji, daily_target, date, note } = req.body || {};
    if (!title) return res.status(400).json({ error: "العنوان مطلوب" });
    // لو مفيش قيمة → ننشئ المتتبِّع بس (من غير ما نسجّل صفر وهمي لليوم)
    const hasValue = value !== "" && value != null;
    const m = hasValue
      ? (await logMetric({ userId: user.id, title, value, unit, emoji, dailyTarget: daily_target, date, note }))
      : (await upsertMetric({ userId: user.id, title, unit, emoji, dailyTarget: daily_target }));
    res.json({ ok: !!m, metric: m });
  });
  // تسجيل/تعديل قيمة يوم معيّن (من الواجهة) — قيمة فاضية = امسح تسجيل اليوم
  app.post("/api/metrics/:id/day", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const { date, value, note } = req.body || {};
    res.json({ ok: (await setMetricDay(user.id, Number(req.params.id), date || null, value, note || null)) });
  });
  app.get("/api/metrics/:id/history", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json((await metricHistory(user.id, Number(req.params.id))));
  });
  app.delete("/api/metrics/log/:logId", async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    res.json({ ok: (await deleteMetricLog(user.id, Number(req.params.logId))) });
  });

  /* ===== بلّغ عن مشكلة → نظام البلاغات في سينتاكس أكاديمي =====
     الإرسال من السيرفر (مش من المتصفح) عشان المفتاح السري مايتعرّضش،
     والموضوع بيتحط «دوّنلي» + نسخة التطبيق تلقائيًا عشان نعرف نصلّح بسرعة. */
  app.post("/api/report", reportLimiter,  async (req, res) => {
    const user = (await gate(req, res));
    if (!user) return;
    const message = String(req.body?.message || "").trim();
    if (message.length < 10) return res.status(400).json({ error: "اكتب المشكلة بتفصيل شوية (١٠ حروف على الأقل)" });
    if (message.length > 4000) return res.status(400).json({ error: "البلاغ طويل أوي — اختصره شوية" });
    if (!config.reportSecret) {
      return res.status(503).json({ error: "الإبلاغ مش متظبط على السيرفر (مفيش REPORT_SECRET) — كلّم الدعم مباشرة" });
    }
    let version = "";
    try { version = (await versionStatus({ checkRemote: false }))?.current?.sha || ""; } catch {}
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(config.reportUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Dawenli-Secret": config.reportSecret },
        body: JSON.stringify({
          message,
          name: user.name || "مستخدم دوّنلي",
          email: user.email || "",
          version,
          // مسار داخلي بس (hash أو path) — مانبعتش نص حر يتحوّل لينك في لوحة البلاغات
          page_url: /^[#/][\w\-/#?=&%.]{0,200}$/.test(String(req.body?.page || "")) ? String(req.body.page) : "/",
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        console.error("report forward failed:", r.status, data);
        return res.status(502).json({ error: "مقدرتش أبعت البلاغ دلوقتي — جرّب تاني بعد شوية" });
      }
      res.json({ ok: true, message: "وصلنا بلاغك ✅ — شكرًا، هنشوفه ونصلّحه" });
    } catch (err) {
      console.error("report error:", err);
      res.status(502).json({ error: "مقدرتش أبعت البلاغ دلوقتي — جرّب تاني بعد شوية" });
    }
  });

  // معالج أخطاء عام — يرجّع JSON نضيف بدل صفحة HTML أو سوكت معلّق (أخطاء body-parser
  // زي الملف الأكبر من الحد، أو أي throw في middleware).
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err?.status || err?.statusCode || 500;
    if (status >= 500) console.error("unhandled route error:", err?.message || err);
    res.status(status).json({ error: status === 413 ? "الملف كبير جدًا (الحد ١٢ ميجا)" : "حصل خطأ في الخادم" });
  });

  return app;
}

// التشغيل المحلي بس. على Vercel بنصدّر الـ app مباشرة من api/index.js
// من غير listen (مفيش process طويل هناك).
export async function startServer() {
  const app = await createApp();
  app.listen(config.port, () =>
    console.log(`📊 الداشبورد شغّال على http://localhost:${config.port}`)
  );
}