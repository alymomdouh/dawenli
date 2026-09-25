// المبادرة — بتشتغل من غير أي اعتماد خارجي (مفيش تيليجرام).
// القناة الوحيدة للتنبيه هي notifyUser: بيتخزّن في الجرس داخل التطبيق + push للموبايل (PWA).
//   ١) تذكير بالمهام في معادها (لحظي).
//   ٢) check-in يومي — الـ agent بيسأل كل مستخدم نشط عن اللي ناقص في عوالمه.
//   ٣) تأمّل أسبوعي على آخر ٧ أيام.
import { config } from "./config.js";
import { analyzeEntries } from "./openai.js";
import { composeCheckin } from "./agent.js";
import { entriesSince, dueTaskReminders, markTaskReminded, activeUsers, activeUsersWithoutEntry, getSetting, setSetting } from "./db.js";
import { notifyUser } from "./push.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// حماية من التنفيذ المتكرر. محفوظة في الداتابيز مش في الذاكرة، لأن على Vercel
// كل نداء للـ cron بيطلع عملية جديدة والـ Map كان هينسى كل حاجة.
async function oncePerDay(key, date) {
  const k = `cron:${key}:${date}`;
  if (await getSetting(k)) return false;
  await setSetting(k, String(Date.now()));
  return true;
}

/**
 * دورة واحدة من المبادرة. متأكدة إنها آمنة للتكرار (idempotent)، فتقدر
 * تتنادى من الـ cron على Vercel أو من الـ setInterval على السيرفر العادي.
 */
export async function schedulerTick({ quiet = false } = {}) {
  const c = cairoParts();
  const log = (...a) => { if (!quiet) console.log(...a); };
  const out = { reminders: 0, checkin: 0, journal: 0, weekly: 0 };

  // تذكير المهام: بنجيب كل مهام النهاردة اللي معادها عدّت ولسه ما ات-remindedتش.
  // الاستعلام نفسه فيه due_time <= الآن، فبيعمل catch-up لو الـ cron اتأخر.
  try {
    for (const t of (await dueTaskReminders(c.date, c.hhmm))) {
      await markTaskReminded(t.id);
      await notifyUser(t.user_id, {
        title: "⏰ تذكير بمهمة",
        body: `${t.title}${t.due_time ? " — الساعة " + t.due_time : ""}${t.note ? "\n📝 " + t.note : ""}`.trim(),
        url: "/",
        icon: "⏰",
      }).catch(() => {});
      out.reminders++;
    }
  } catch (err) {
    console.error("task reminder error:", err);
  }

  // الـ check-in اليومي — بيسأل كل مستخدم نشط (آخر ظهور خلال ١٤ يوم) عن الناقص في عوالمه.
  // بنبعت للنشطين بس عشان منهدرش نداءات OpenAI على حسابات نايمة، وبستاجر بسيط بين الرسايل.
  if (c.hour >= config.checkinHour && (await oncePerDay("checkin", c.date))) {
    const targets = (await activeUsers(14));
    log(`🌙 check-in اليومي — ${targets.length} مستخدم نشط`);
    for (const user of targets) {
      try {
        const msg = await composeCheckin(user);
        await notifyUser(user.id, {
          title: "🌙 متابعة يومك",
          body: msg,
          url: "/",
          icon: "🌙",
        }).catch(() => {});
        out.checkin++;
      } catch (err) {
        console.error(`checkin error (user ${user.id}):`, err);
      }
      await sleep(500); // ستاجر لطيف
    }
  }

  // تذكير اليوميات الساعة 10م — لكل مستخدم نشط مسجّلش أي يومية النهاردة بس.
  if (c.hour >= config.journalReminderHour && (await oncePerDay("journal", c.date))) {
    const targets = (await activeUsersWithoutEntry(c.date, 14));
    log(`✍️ تذكير اليوميات — ${targets.length} مستخدم مسجّلش النهاردة`);
    for (const user of targets) {
      await notifyUser(user.id, {
        title: "✍️ لا تنسَ تدوين يومك",
        body: "مرّ اليوم ولم تدوّن شيئًا بعد — كيف مرّ يومك؟ 🌙",
        url: "/",
        icon: "✍️",
      }).catch(() => {});
      out.journal++;
      await sleep(400);
    }
  }

  // التأمّل الأسبوعي
  if (c.weekday === config.weeklyDay && c.hour >= config.weeklyHour && (await oncePerDay("weekly", c.date))) {
    for (const user of (await activeUsers(30))) {
      await sendWeeklyReflection(user);
      out.weekly++;
      await sleep(500);
    }
  }

  return out;
}

// التشغيل المستمر — للتطوير/local فقط.
// على Vercel مفيش process طويل، فالتذكير بييجي من الـ cron بدل ده.
export async function startScheduler() {
  setInterval(() => {
    schedulerTick({ quiet: true }).catch((err) => console.error("scheduler error:", err));
  }, 30 * 1000);

  console.log(
    `⏰ المبادرة شغّالة — check-in يومي ${config.checkinHour}:00، تذكير اليوميات ${config.journalReminderHour}:00، تأمّل أسبوعي يوم ${config.weeklyDay} الساعة ${config.weeklyHour}:00، وتذكير مهام لحظي (${config.timezone})`
  );
}

async function sendWeeklyReflection(user) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const entries = (await entriesSince(user.id, since));
  if (!entries.length) return; // مفيش تدوين الأسبوع ده — مفيش داعي نزعّجه
  try {
    const analysis = await analyzeEntries(entries, user.id);
    await notifyUser(user.id, {
      title: "🪞 تأمّل الأسبوع",
      body: analysis,
      url: "/",
      icon: "🪞",
    }).catch(() => {});
  } catch (err) {
    console.error("weekly reflection error:", err);
  }
}

// أجزاء الوقت بتوقيت القاهرة بدون مكتبات
function cairoParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    hhmm: `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}`,
    weekday: wd,
  };
}
