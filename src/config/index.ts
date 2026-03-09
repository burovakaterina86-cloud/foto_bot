import 'dotenv/config';

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function getOptionalEnv(key: string): string | undefined {
  return process.env[key] || undefined;
}

export const config = {
  BOT_TOKEN: getEnv('BOT_TOKEN'),
  OPENAI_API_KEY: getOptionalEnv('OPENAI_API_KEY'),
  TEST_MODE: getOptionalEnv('TEST_MODE') === 'true',
  ADMIN_IDS: (getOptionalEnv('ADMIN_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  OWNER_ID: getOptionalEnv('OWNER_ID'),
  MAKE_WEBHOOK_URL: getOptionalEnv('MAKE_WEBHOOK_URL'),
  MANAGER_IDS_RESTAURANT: (getOptionalEnv('MANAGER_IDS_RESTAURANT') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  MANAGER_IDS_CAFE: (getOptionalEnv('MANAGER_IDS_CAFE') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
} as const;

export function isAdmin(telegramId: string): boolean {
  return config.ADMIN_IDS.includes(telegramId);
}
