import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  SECRET_KEY: z.string().min(32, "SECRET_KEY must be at least 32 characters — run: bun run generate-key"),
  WA1_NUMBER: z.string().optional().default(""),
  WA2_NUMBER: z.string().optional().default(""),
  DISPLAY_NAME_1: z.string().optional(),
  DISPLAY_NAME_2: z.string().optional(),
  // When true, nothing is sent to WhatsApp: the queue, delays and logs run as normal
  DRY_RUN: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // In production the app replaces each account's profile picture with logo.jpg
  // and sets its display name. Set to "false" to leave the profiles untouched.
  SETUP_PROFILE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Defaults used by the dashboard / invite API when not sent in the request
  INVITE_GROUP_ID: z.string().regex(/^[0-9-]+@g\.us$/).optional(),
  INVITE_LINK: z.string().regex(/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/).optional(),
  // Warm-up conversation between Client 1 and Client 2 before sending.
  // A session runs first thing after start and again whenever nothing was
  // sent for WARMUP_IDLE_MINUTES. WARMUP_SESSION_MAX=0 disables it.
  WARMUP_SESSION_MIN: z.coerce.number().int().min(0).default(2),
  WARMUP_SESSION_MAX: z.coerce.number().int().min(0).default(2),
  WARMUP_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
  WARMUP_GAP_MIN_MS: z.coerce.number().int().min(0).default(3000),
  WARMUP_GAP_MAX_MS: z.coerce.number().int().min(0).default(8000),
  // Hold the queue (send nothing) until both clients are connected
  WARMUP_REQUIRED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Restart a WhatsApp browser that has waited this long for a QR scan
  QR_RECYCLE_MS: z.coerce.number().int().min(10_000).default(240_000),
  // Timezone used for the {salam} greeting (pagi/siang/sore/malam)
  TIMEZONE: z.string().default("Asia/Jakarta"),
  // Delivery pacing (defaults = original anti-ban timing)
  WARMUP_EVERY: z.coerce.number().int().min(1).default(1),
  SEND_DELAY_MIN_MS: z.coerce.number().int().min(0).default(3000),
  SEND_DELAY_RANGE_MS: z.coerce.number().int().min(0).default(2000),
  TYPING_MIN_MS: z.coerce.number().int().min(0).default(1000),
  TYPING_MAX_MS: z.coerce.number().int().min(0).default(3000),
  CATU_CRON_URL: z.string().url().optional().default("https://apps.catu.id/CATUJavaProd/rest/cronparamsromo"),
});

export type Env = z.infer<typeof EnvSchema>;
const parsedEnv = EnvSchema.safeParse(Bun.env);

if (!parsedEnv.success) {
  console.error(
    "❌ Invalid environment variables:",
    JSON.stringify(parsedEnv.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env: Env = parsedEnv.data;
export default env;
