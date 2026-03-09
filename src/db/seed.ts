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
  reference_photo?: string;
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

      // Пересоздать вопросы этого чек-листа
      await prisma.question.deleteMany({ where: { checklistId: existing.id } });
      await prisma.question.createMany({
        data: checklist.tasks.map((t) => ({
          checklistId: existing.id,
          text: t.text,
          order: t.order,
          isRequired: t.type !== 'confirm',
          taskType: t.type ?? 'photo',
          section: t.section ?? null,
          referencePhoto: t.reference_photo ?? null,
          aiRule: t.ai_rule ?? null,
        })),
      });

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
              referencePhoto: t.reference_photo ?? null,
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
