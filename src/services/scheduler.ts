import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { prisma } from '../db/client.js';
import { config } from '../config/index.js';
import { getDriveClient } from './storage.js';

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

/**
 * Удаляет файлы старше 30 дней из Google Drive папки GOOGLE_DRIVE_FOLDER_ID.
 * Рекурсивно: сначала файлы внутри подпапок, потом пустые подпапки.
 */
async function cleanupOldDriveFiles(): Promise<void> {
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId || process.env.ENABLE_GOOGLE_DRIVE !== 'true') return;

  const drive = getDriveClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffISO = cutoff.toISOString();

  let totalDeleted = 0;
  let foldersDeleted = 0;

  // Получить все подпапки сотрудников
  const subfolders = await drive.files.list({
    q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 1000,
  });

  const folders = subfolders.data.files ?? [];

  for (const folder of folders) {
    if (!folder.id) continue;

    // Удалить старые файлы внутри подпапки
    let pageToken: string | undefined;
    do {
      const files = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false and createdTime < '${cutoffISO}'`,
        fields: 'nextPageToken, files(id, name)',
        spaces: 'drive',
        pageSize: 100,
        pageToken,
      });

      for (const file of files.data.files ?? []) {
        if (!file.id) continue;
        await drive.files.delete({ fileId: file.id });
        totalDeleted++;
      }

      pageToken = files.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Проверить, осталась ли подпапка пустой
    const remaining = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      fields: 'files(id)',
      spaces: 'drive',
      pageSize: 1,
    });

    if (!remaining.data.files || remaining.data.files.length === 0) {
      await drive.files.delete({ fileId: folder.id });
      foldersDeleted++;
    }
  }

  // Удалить старые файлы в корне папки (не в подпапках)
  let pageToken: string | undefined;
  do {
    const files = await drive.files.list({
      q: `'${rootFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false and createdTime < '${cutoffISO}'`,
      fields: 'nextPageToken, files(id, name)',
      spaces: 'drive',
      pageSize: 100,
      pageToken,
    });

    for (const file of files.data.files ?? []) {
      if (!file.id) continue;
      await drive.files.delete({ fileId: file.id });
      totalDeleted++;
    }

    pageToken = files.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(`[cleanup] Drive cleanup done: ${totalDeleted} files, ${foldersDeleted} empty folders deleted`);
}

export function startScheduler(bot: Telegraf<Context>): void {
  // Каждую минуту — расписание чек-листов
  cron.schedule('* * * * *', () => {
    processSchedule(bot).catch((error) => {
      console.error('[scheduler] Ошибка:', error);
    });
  });

  // Каждую ночь в 03:00 — очистка старых файлов на Google Drive
  cron.schedule('0 3 * * *', () => {
    cleanupOldDriveFiles().catch((error) => {
      console.error('[cleanup] Ошибка очистки Drive:', error);
    });
  });

  console.log('⏰ Scheduler started');
}
