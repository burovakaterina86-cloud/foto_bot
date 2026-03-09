import { prisma } from '../db/client.js';

/**
 * Найти активный (незавершённый) run пользователя.
 * Активный = completedAt === null.
 */
export async function findActiveRun(userId: number) {
  return prisma.run.findFirst({
    where: {
      userId,
      completedAt: null,
    },
    include: {
      checklist: true,
      answers: { select: { questionId: true } },
    },
  });
}

/**
 * Создать новый run для пользователя по чек-листу.
 * Возвращает run вместе с отсортированными вопросами.
 */
export async function createRun(userId: number, checklistId: number) {
  const run = await prisma.run.create({
    data: { userId, checklistId },
    include: {
      checklist: {
        include: {
          questions: { orderBy: { order: 'asc' } },
        },
      },
    },
  });
  return run;
}

/**
 * Получить следующий неотвеченный вопрос для run.
 * Возвращает { question, questionNumber, totalQuestions } или null если все отвечены.
 */
export async function getNextQuestion(runId: number) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: {
        include: {
          questions: { orderBy: { order: 'asc' } },
        },
      },
      answers: { select: { questionId: true } },
    },
  });

  if (!run) return null;

  const answeredIds = new Set(run.answers.map((a) => a.questionId));
  const questions = run.checklist.questions;
  const next = questions.find((q) => !answeredIds.has(q.id));

  if (!next) return null;

  const questionNumber = questions.findIndex((q) => q.id === next.id) + 1;

  return {
    question: next,
    questionNumber,
    totalQuestions: questions.length,
  };
}

/**
 * Сохранить ответ (фото) на вопрос.
 * value — путь к файлу в локальном хранилище.
 */
export async function saveAnswer(
  runId: number,
  questionId: number,
  value: string,
  aiVerdict?: string,
  aiReason?: string,
  aiConfidence?: number,
  photoHash?: string,
) {
  return prisma.answer.create({
    data: {
      runId,
      questionId,
      value,
      aiVerdict: aiVerdict ?? null,
      aiReason: aiReason ?? null,
      aiConfidence: aiConfidence ?? null,
      photoHash: photoHash ?? null,
    },
  });
}

/**
 * Завершить run (установить completedAt).
 */
export async function completeRun(runId: number) {
  return prisma.run.update({
    where: { id: runId },
    data: { completedAt: new Date() },
    include: {
      checklist: true,
      answers: true,
    },
  });
}
