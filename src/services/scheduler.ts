import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { prisma } from '../db/client.js';
import { config } from '../config/index.js';
import { processOutbox } from './webhookService.js';

type TimeWindow = { start: string; end: string };

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map((v) => Number.parseInt(v, 10));
  return h * 60 + m;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Проверяет, завершил ли пользователь данный чек-лист сегодня
 * (есть run с completedAt != null ИЛИ status = missed).
 */
async function hasCompletedOrMissedToday(
  userId: number,
  checklistId: number,
  todayStart: Date,
): Promise<boolean> {
  const run = await prisma.run.findFirst({
    where: {
      userId,
      checklistId,
      startedAt: { gte: todayStart },
    },
  });
  return run !== null;
}

/**
 * Отправляет напоминание пользователю с inline-кнопкой старта чек-листа.
 */
async function sendReminder(
  bot: Telegraf<Context>,
  telegramId: string,
  checklistTitle: string,
  checklistKey: string,
): Promise<void> {
  try {
    await bot.telegram.sendMessage(
      telegramId,
      `📋 Пора пройти чек-лист: "${checklistTitle}"`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Начать', callback_data: `startChecklist:${checklistKey}` }],
          ],
        },
      },
    );
  } catch (error) {
    // Пользователь мог заблокировать бота
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('bot was blocked') || errMsg.includes('user is deactivated')) {
      console.warn(`[scheduler] Пользователь ${telegramId} заблокировал бота`);
    } else {
      console.error(`[scheduler] Ошибка отправки напоминания ${telegramId}:`, error);
    }
  }
}

/**
 * Создаёт пропущенный run (missed) для пользователя.
 */
async function createMissedRun(userId: number, checklistId: number): Promise<void> {
  const now = new Date();
  await prisma.run.create({
    data: {
      userId,
      checklistId,
      startedAt: now,
      completedAt: now,
      // completedAt заполнен, но без answers — значит missed
    },
  });
  console.log(`[scheduler] Missed run: userId=${userId}, checklistId=${checklistId}`);
}

/**
 * Основной cron-обработчик (каждую минуту).
 * Проверяет time_windows чек-листов и отправляет напоминания / фиксирует пропуски.
 */
async function processSchedule(bot: Telegraf<Context>): Promise<void> {
  if (config.TEST_MODE) return;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayStart = startOfDay(now);

  const checklists = await prisma.checklist.findMany({
    include: { questions: true },
  });

  // Группируем чек-листы по роли
  const roleChecklists = new Map<string, typeof checklists>();
  for (const cl of checklists) {
    const list = roleChecklists.get(cl.role) ?? [];
    list.push(cl);
    roleChecklists.set(cl.role, list);
  }

  // Находим время open.end и close.start для каждой роли
  const roleOpenEnd = new Map<string, number>();
  const roleCloseStart = new Map<string, number>();

  for (const [role, cls] of roleChecklists) {
    for (const cl of cls) {
      if (!cl.timeWindows) continue;
      let windows: TimeWindow[] = [];
      try {
        windows = JSON.parse(cl.timeWindows) as TimeWindow[];
      } catch {
        continue;
      }
      for (const w of windows) {
        if (cl.type === 'open') {
          const end = parseTimeToMinutes(w.end);
          roleOpenEnd.set(role, Math.max(roleOpenEnd.get(role) ?? 0, end));
        } else if (cl.type === 'close') {
          const start = parseTimeToMinutes(w.start);
          const current = roleCloseStart.get(role);
          roleCloseStart.set(role, current != null ? Math.min(current, start) : start);
        }
      }
    }
  }

  // Получаем всех пользователей с ролью
  const users = await prisma.user.findMany({
    where: { role: { not: null } },
  });

  for (const user of users) {
    if (!user.role) continue;

    const cls = roleChecklists.get(user.role) ?? [];

    for (const cl of cls) {
      if (cl.type === 'open' || cl.type === 'close') {
        if (!cl.timeWindows) continue;
        let windows: TimeWindow[] = [];
        try {
          windows = JSON.parse(cl.timeWindows) as TimeWindow[];
        } catch {
          continue;
        }

        for (const w of windows) {
          const start = parseTimeToMinutes(w.start);
          const end = parseTimeToMinutes(w.end);

          // Напоминание в начале окна
          if (nowMinutes === start) {
            const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
            if (!done) {
              await sendReminder(bot, user.telegramId, cl.title, cl.key);
            }
          }

          // Пропуск в конце окна
          if (nowMinutes === end) {
            const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
            if (!done) {
              await createMissedRun(user.id, cl.id);
            }
          }
        }
      }

      if (cl.type === 'periodic') {
        // Проверка: сотрудник начал смену сегодня
        if (!user.shiftStartedAt || user.shiftStartedAt < todayStart) continue;

        const openEnd = roleOpenEnd.get(user.role);
        const closeStart = roleCloseStart.get(user.role);
        if (openEnd == null || closeStart == null) continue;

        const intervalHours = cl.intervalHours ?? 2;
        const intervalMinutes = intervalHours * 60;

        // Напоминания каждые N часов между openEnd и closeStart
        if (nowMinutes > openEnd && nowMinutes < closeStart) {
          const elapsed = nowMinutes - openEnd;
          if (elapsed % intervalMinutes === 0) {
            const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
            if (!done) {
              await sendReminder(bot, user.telegramId, cl.title, cl.key);
            }
          }
        }

        // Пропуск periodic в момент closeStart
        if (nowMinutes === closeStart) {
          const done = await hasCompletedOrMissedToday(user.id, cl.id, todayStart);
          if (!done) {
            await createMissedRun(user.id, cl.id);
          }
        }
      }
    }
  }
}

export function startScheduler(bot: Telegraf<Context>): void {
  // Каждую минуту — расписание чек-листов
  cron.schedule('* * * * *', () => {
    processSchedule(bot).catch((error) => {
      console.error('[scheduler] Ошибка:', error);
    });
  });

  // Каждые 10 секунд — отправка событий из outbox
  let isProcessing = false;
  setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;
    try {
      await processOutbox();
    } catch (error) {
      console.error('[outbox worker] Ошибка:', error);
    } finally {
      isProcessing = false;
    }
  }, 10_000);

  console.log('⏰ Scheduler started');
}
