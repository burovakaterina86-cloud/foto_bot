import type { Checklist, User } from '@prisma/client';
import { prisma } from '../db/client.js';
import { config } from '../config/index.js';
import { appendAnswers, recordShiftSummary, updateMonthlyStats } from './sheetsService.js';

type ActiveChecklistsResult = {
  checklists: Checklist[];
  nextTimeText: string | null;
};

/**
 * Начало текущего дня (00:00:00) по серверному времени.
 */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map((v) => Number.parseInt(v, 10));
  return h * 60 + m;
}

function formatMinutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

export async function getActiveChecklistsForUserNow(
  user: User,
  now: Date,
): Promise<ActiveChecklistsResult> {
  if (!user.role) {
    return { checklists: [], nextTimeText: null };
  }

  const role = user.role;

  const all = await prisma.checklist.findMany({
    where: { role },
    orderBy: { title: 'asc' },
  });

  if (all.length === 0) {
    return { checklists: [], nextTimeText: null };
  }

  // В тестовом режиме показываем все чек-листы без фильтра по времени
  if (config.TEST_MODE) {
    const todayStart = startOfDay(now);
    const completedRuns = await prisma.run.findMany({
      where: {
        userId: user.id,
        checklistId: { in: all.map((cl) => cl.id) },
        completedAt: { not: null, gte: todayStart },
      },
      select: { checklistId: true },
    });
    const completedChecklistIds = new Set(completedRuns.map((r) => r.checklistId));
    const notCompleted = all.filter((cl) => !completedChecklistIds.has(cl.id));
    return { checklists: notCompleted, nextTimeText: null };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const openWindows: { start: number; end: number }[] = [];
  const closeWindows: { start: number; end: number }[] = [];

  for (const cl of all) {
    if (!cl.timeWindows) continue;
    let windows: { start: string; end: string }[] = [];
    try {
      windows = JSON.parse(cl.timeWindows) as { start: string; end: string }[];
    } catch {
      continue;
    }

    for (const w of windows) {
      const start = parseTimeToMinutes(w.start);
      const end = parseTimeToMinutes(w.end);
      if (cl.type === 'open') {
        openWindows.push({ start, end });
      } else if (cl.type === 'close') {
        closeWindows.push({ start, end });
      }
    }
  }

  const openEnd =
    openWindows.length > 0
      ? Math.max(...openWindows.map((w) => w.end))
      : null;
  const closeStart =
    closeWindows.length > 0
      ? Math.min(...closeWindows.map((w) => w.start))
      : null;

  const active: Checklist[] = [];

  for (const cl of all) {
    if (cl.type === 'open' || cl.type === 'close') {
      if (!cl.timeWindows) continue;
      let windows: { start: string; end: string }[] = [];
      try {
        windows = JSON.parse(cl.timeWindows) as { start: string; end: string }[];
      } catch {
        continue;
      }

      const within = windows.some((w) => {
        const start = parseTimeToMinutes(w.start);
        const end = parseTimeToMinutes(w.end);
        return nowMinutes >= start && nowMinutes <= end;
      });

      if (within) {
        active.push(cl);
      }
      continue;
    }

    if (cl.type === 'periodic') {
      if (openEnd != null && closeStart != null) {
        if (nowMinutes > openEnd && nowMinutes < closeStart) {
          active.push(cl);
        }
      } else {
        active.push(cl);
      }
    }
  }

  // Убираем чек-листы, которые пользователь уже завершил сегодня
  if (active.length > 0) {
    const todayStart = startOfDay(now);

    const completedRuns = await prisma.run.findMany({
      where: {
        userId: user.id,
        checklistId: { in: active.map((cl) => cl.id) },
        completedAt: { not: null, gte: todayStart },
      },
      select: { checklistId: true },
    });

    const completedChecklistIds = new Set(completedRuns.map((r) => r.checklistId));
    const notCompleted = active.filter((cl) => !completedChecklistIds.has(cl.id));

    if (notCompleted.length > 0) {
      return { checklists: notCompleted, nextTimeText: null };
    }
    // Все доступные чек-листы уже пройдены — покажем "нет активных"
  }

  const futureStarts: number[] = [];

  for (const w of [...openWindows, ...closeWindows]) {
    if (w.start > nowMinutes) {
      futureStarts.push(w.start);
    }
  }

  let nextTimeText: string | null = null;

  if (futureStarts.length > 0) {
    const next = Math.min(...futureStarts);
    nextTimeText = formatMinutesToTime(next);
  } else if (openWindows.length > 0) {
    const earliestOpen = Math.min(...openWindows.map((w) => w.start));
    nextTimeText = formatMinutesToTime(earliestOpen);
  }

  return { checklists: [], nextTimeText };
}

/**
 * Вызывается после завершения чек-листа.
 * Загружает полные данные run + answers + questions и отправляет в Google Sheets.
 */
export async function onChecklistCompleted(runId: number): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: true,
      answers: {
        include: { question: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!run) return;

  const user = await prisma.user.findUnique({ where: { id: run.userId } });
  if (!user) return;

  // Ответы записываются в Sheets сразу после каждого фото (appendSingleAnswer)
  // Здесь только смена и статистика для close чек-листов
  if (run.checklist.type === 'close') {
    const shift = await prisma.shift.findFirst({
      where: { userId: run.userId },
      orderBy: { createdAt: 'desc' },
    });

    if (shift) {
      const diffMs = (shift.endedAt ?? new Date()).getTime() - shift.startedAt.getTime();
      const hours = Math.round((diffMs / 3_600_000) * 10) / 10;
      const failCount = shift.failCount ?? 0;

      await recordShiftSummary({ shift, user, failCount });
      await updateMonthlyStats({ user, hoursToAdd: hours, errorsToAdd: failCount });
    }
  }
}

