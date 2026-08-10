import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  SECRET_KEY: z.string().min(32, "SECRET_KEY must be at least 32 characters — run: bun run generate-key"),
  WA1_NUMBER: z.string().optional().default(""),
  WA2_NUMBER: z.string().optional().default(""),
  DISPLAY_NAME_1: z.string().optional(),
  DISPLAY_NAME_2: z.string().optional(),
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
