// Vercel Cron — بيبدّل الحاجة اللي كانت شغالة بـ setInterval.
//
// Vercel Hobby بيسمح بـ cron يومي بس، فالتذكير اللحظي للمهام بقى كل ساعة
// بدل كل دقيقة. الاستعلام نفسه بيلتقط كل مهمة معادها عدّت ولسه ما
// اتبعتتش، فمفيش إشعارات بتضيع لو الـ cron اتأخر شوية.
import { config } from "../src/config.js";
import { schedulerTick } from "../src/scheduler.js";

export default async function handler(req, res) {
  // Vercel بيبعت CRON_SECRET في هيدر Authorization أو Bearer
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!config.cronSecret) {
    return res.status(503).json({ error: "CRON_SECRET مش متظبّط — الـ cron متعطّل" });
  }
  if (token !== config.cronSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const out = await schedulerTick();
    return res.status(200).json({ ok: true, at: new Date().toISOString(), ...out });
  } catch (err) {
    console.error("cron error:", err);
    return res.status(500).json({ error: "cron failed", detail: String(err?.message || err) });
  }
}
