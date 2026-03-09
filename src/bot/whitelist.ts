import type { Context, MiddlewareFn } from 'telegraf';

const allowedRaw = process.env.ALLOWED_USER_IDS ?? '';
const allowedIds: Set<number> | null =
  allowedRaw.trim().length > 0
    ? new Set(allowedRaw.split(',').map((id) => Number(id.trim())).filter((id) => !Number.isNaN(id)))
    : null;

export const whitelistMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  if (!allowedIds) return next();

  const telegramId = ctx.from?.id;
  if (telegramId && allowedIds.has(telegramId)) return next();

  await ctx.reply('У вас нет доступа к этому боту.');
};
