import type { Context } from 'telegraf';
import { prisma } from '../db/client.js';
import type { RoleKey } from '../config/roles.js';

export async function ensureUserFromContext(ctx: Context) {
  const from = ctx.from;

  if (!from) {
    throw new Error('Missing ctx.from, cannot identify user');
  }

  const telegramId = String(from.id);

  const user = await prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
    },
    update: {
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
    },
  });

  return user;
}

export async function upsertRegisteredUser(params: {
  telegramId: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  displayName: string;
  role: RoleKey;
  location?: string;
}) {
  const user = await prisma.user.upsert({
    where: { telegramId: params.telegramId },
    create: {
      telegramId: params.telegramId,
      firstName: params.firstName,
      lastName: params.lastName,
      username: params.username,
      displayName: params.displayName,
      role: params.role,
      location: params.location ?? null,
    },
    update: {
      firstName: params.firstName,
      lastName: params.lastName,
      username: params.username,
      displayName: params.displayName,
      role: params.role,
      location: params.location ?? null,
    },
  });

  return user;
}

