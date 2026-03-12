import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from './client.js';
import { roles } from '../config/roles.js';

/** Маппинг русского названия роли → английский ключ */
const labelToKey = new Map(roles.map((r) => [r.label.toLowerCase(), r.key]));

type RawTaskSeed = {
  order: number;
  text: string;
  type?: 'photo' | 'confirm';
  section?: string;
  ai_rule?: string | null;
  reference_photo?: string | string[] | null;
};

type RawChecklistSeed = {
  id: string;
  role: string;
  type: 'open' | 'close' | 'periodic';
  name: string;
  time_windows?: { start: string; end: string }[];
  interval_hours?: number;
  source_audit_id?: string;
  tasks: RawTaskSeed[];
};

type ChecklistsConfig = {
  roles: string[];
  roleNames?: Record<string, string>;
  checklists: RawChecklistSeed[];
};

async function loadConfig(): Promise<ChecklistsConfig> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const filePath = path.join(__dirname, '..', 'config', 'checklists.json');

  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as ChecklistsConfig;
}

/**
 * Синхронизация чек-листов из checklists.json в БД.
 * Upsert по key — чек-листы, созданные через бот (не в JSON), не трогаются.
 * Возвращает количество импортированных чек-листов.
 */
export async function syncChecklists(): Promise<number> {
  const config = await loadConfig();
  const checklists = config.checklists;

  for (const checklist of checklists) {
    const roleKey = labelToKey.get(checklist.role.toLowerCase()) ?? checklist.role;

    const existing = await prisma.checklist.findUnique({ where: { key: checklist.id } });

    if (existing) {
      // Обновить метаданные чек-листа
      await prisma.checklist.update({
        where: { key: checklist.id },
        data: {
          title: checklist.name,
          description: `${checklist.role} — ${checklist.type}`,
          role: roleKey,
          type: checklist.type,
          timeWindows: checklist.time_windows
            ? JSON.stringify(checklist.time_windows)
            : null,
          intervalHours: checklist.interval_hours ?? null,
        },
      });

      // Обновить вопросы, сохраняя ID (чтобы не ломать ссылки из answers)
      const existingQuestions = await prisma.question.findMany({
        where: { checklistId: existing.id },
        select: { id: true, order: true },
      });
      const questionsByOrder = new Map(existingQuestions.map((q) => [q.order, q.id]));

      for (const t of checklist.tasks) {
        const qData = {
          text: t.text,
          order: t.order,
          isRequired: t.type !== 'confirm',
          taskType: t.type ?? 'photo',
          section: t.section ?? null,
          referencePhoto: Array.isArray(t.reference_photo) ? JSON.stringify(t.reference_photo) : t.reference_photo ?? null,
          aiRule: t.ai_rule ?? null,
        };

        const existingId = questionsByOrder.get(t.order);
        if (existingId) {
          await prisma.question.update({ where: { id: existingId }, data: qData });
          questionsByOrder.delete(t.order);
        } else {
          await prisma.question.create({ data: { checklistId: existing.id, ...qData } });
        }
      }

      // Удалить вопросы, которых больше нет в конфиге
      const removedIds = [...questionsByOrder.values()];
      if (removedIds.length > 0) {
        await prisma.question.deleteMany({ where: { id: { in: removedIds } } });
      }

      console.log(`✔ Checklist "${checklist.name}" обновлён (${checklist.tasks.length} вопросов)`);
    } else {
      // Создать новый
      const created = await prisma.checklist.create({
        data: {
          key: checklist.id,
          title: checklist.name,
          description: `${checklist.role} — ${checklist.type}`,
          role: roleKey,
          type: checklist.type,
          timeWindows: checklist.time_windows
            ? JSON.stringify(checklist.time_windows)
            : null,
          intervalHours: checklist.interval_hours ?? null,
          questions: {
            create: checklist.tasks.map((t) => ({
              text: t.text,
              order: t.order,
              isRequired: t.type !== 'confirm',
              taskType: t.type ?? 'photo',
              section: t.section ?? null,
              referencePhoto: Array.isArray(t.reference_photo) ? JSON.stringify(t.reference_photo) : t.reference_photo ?? null,
              aiRule: t.ai_rule ?? null,
            })),
          },
        },
        include: { questions: true },
      });

      console.log(`✔ Checklist "${created.title}" создан (${created.questions.length} вопросов)`);
    }
  }

  return checklists.length;
}

async function seed() {
  console.log('🌱 Seeding database from src/config/checklists.json...');
  const count = await syncChecklists();
  console.log(`✅ Seeding completed (${count} чек-листов)`);
}

seed()
  .catch((error) => {
    console.error('❌ Seeding failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
