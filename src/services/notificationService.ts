import type { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from '../config/index.js';
import { prisma } from '../db/client.js';

export async function notifyManagers(
  bot: Telegraf<Context>,
  userId: number,
  checklistName: string,
  failCount: number,
  location: string | null,
): Promise<void> {
  const managerIds =
    location === 'cafe'
      ? config.MANAGER_IDS_CAFE
      : config.MANAGER_IDS_RESTAURANT;

  if (managerIds.length === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const userName = user?.displayName ?? user?.firstName ?? 'Сотрудник';

  let message: string;
  if (failCount > 0) {
    message = [
      '⚠️ Нарушения в чек-листе',
      `Сотрудник: ${userName}`,
      `Чек-лист: ${checklistName}`,
      `Нарушений: ${failCount}`,
    ].join('\n');
  } else {
    message = [
      '✅ Чек-лист завершён',
      `Сотрудник: ${userName}`,
      `Чек-лист: ${checklistName}`,
      'Нарушений: нет',
    ].join('\n');
  }

  for (const managerId of managerIds) {
    try {
      await bot.telegram.sendMessage(managerId, message);
    } catch (error) {
      console.error(`[notificationService] Ошибка отправки менеджеру ${managerId}:`, error);
    }
  }
}
