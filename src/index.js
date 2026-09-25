import { startServer } from "./server.js";
import { startScheduler } from "./scheduler.js";
import { config } from "./config.js";

console.log("✍️  دوّنلي — بيبدأ...");
startServer();

// على Vercel مفيش process طويل يفضل شغّال، فالمبادرة بتتنادى من الـ cron
// (api/cron.js) بدل الـ setInterval. تشغيلها هنا كانت هتعمل instance
// ميتوحد ويتقفل على طول.
if (!config.isServerless) startScheduler();
else console.log("⏰ وضع serverless — التذكيرات هتيجي من Vercel Cron.");
