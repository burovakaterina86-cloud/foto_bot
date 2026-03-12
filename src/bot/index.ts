import { Telegraf, Markup, Input } from 'telegraf';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Context } from 'telegraf';
import { config, isAdmin } from '../config/index.js';
import { ensureUserFromContext, upsertRegisteredUser } from '../services/userService.js';
import { type RoleKey, roles, findRoleByLabel } from '../config/roles.js';
import { prisma } from '../db/client.js';
import { getActiveChecklistsForUserNow } from '../services/checklistService.js';
import {
  findActiveRun,
  createRun,
  getNextQuestion,
  saveAnswer,
  completeRun,
} from '../services/runService.js';
import { downloadTelegramFile } from '../utils/downloadFile.js';
import { validateImage } from '../utils/validateImage.js';
import { applyWatermark } from '../utils/watermark.js';
import { uploadPhoto } from '../services/storage.js';
import { verifyPhoto } from '../services/aiService.js';
import { calculateAndSaveShift } from '../services/shiftService.js';
import { computePhotoHash, hammingDistance, DUPLICATE_THRESHOLD } from '../utils/photoHash.js';
import { syncChecklists } from '../db/seed.js';
import { rateLimitMiddleware } from './rateLimit.js';
import { registerChecklistAdmin, sendChecklistList } from './adminChecklists.js';
import { onChecklistCompleted } from '../services/checklistService.js';
import { notifyManagers } from '../services/notificationService.js';
import { appendSingleAnswer } from '../services/sheetsService.js';

// --- Типы FSM ---

type RegistrationStep = 'awaiting_invite' | 'awaiting_name' | 'awaiting_role' | 'awaiting_location';

type RegistrationState = {
  step: RegistrationStep;
  tempName?: string;
  tempRole?: string;
};

const registrationState = new Map<number, RegistrationState>();

export const bot = new Telegraf(config.BOT_TOKEN);

import { whitelistMiddleware } from './whitelist.js';
bot.use(whitelistMiddleware);
bot.use(rateLimitMiddleware);

// --- Вспомогательные функции ---

async function sendMainMenu(ctx: Context, subtitle?: string) {
  const user = await getRegisteredUser(ctx);
  const buttons = user
    ? [['Старт', 'Меню']]
    : [['Регистрация']];

  const replyKeyboard = Markup.keyboard(buttons)
    .resize()
    .oneTime(false);

  const text = subtitle ? `${subtitle}` : 'Главное меню:';
  await ctx.reply(text, replyKeyboard);
}

function formatQuestionMessage(
  checklistTitle: string,
  questionNumber: number,
  totalQuestions: number,
  questionText: string,
): string {
  return [
    `📋 ${checklistTitle}`,
    `Вопрос ${questionNumber}/${totalQuestions}:`,
    '',
    questionText,
    '',
    '📸 Отправьте фото.',
  ].join('\n');
}

/**
 * Показать текущий вопрос активного run.
 * Если все вопросы отвечены — завершить run.
 */
async function sendCurrentQuestion(ctx: Context, runId: number) {
  const next = await getNextQuestion(runId);

  if (!next) {
    // Все вопросы отвечены — завершаем
    const completed = await completeRun(runId);
    const answersCount = completed.answers.length;

    let shiftInfo = '';

    if (completed.checklist.type === 'close') {
      try {
        const shiftResult = await calculateAndSaveShift(
          completed.userId,
          completed,
        );
        const hours = Math.floor(shiftResult.minutes / 60);
        const mins = shiftResult.minutes % 60;
        shiftInfo = `\nСмена: ${hours}ч ${mins}мин`;
        if (shiftResult.failCount > 0) {
          shiftInfo += ` | Отклонённых фото: ${shiftResult.failCount}`;
        }

      } catch (error) {
        console.error('[shift calculation error]', error);
      }
    }

    // Отправка данных в Google Sheets
    onChecklistCompleted(runId).catch((err) => console.error('[sheets error]', err));

    await ctx.reply(
      `✅ Чек-лист "${completed.checklist.title}" завершён!\nОтветов: ${answersCount}${shiftInfo}`,
    );

    // Уведомление менеджерам локации
    {
      const runUser = await prisma.user.findUnique({ where: { id: completed.userId } });
      const failedAnswers = completed.answers.filter((a) => a.aiVerdict === 'fail').length;
      notifyManagers(bot, completed.userId, completed.checklist.title, failedAnswers, runUser?.location ?? null)
        .catch((err) => console.error('[manager notification error]', err));
    }

    // Уведомление владельцу
    if (config.OWNER_ID) {
      try {
        const user = await prisma.user.findUnique({ where: { id: completed.userId } });
        const userName = user?.displayName ?? user?.firstName ?? 'Сотрудник';
        const now = new Date();
        const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        await bot.telegram.sendMessage(
          config.OWNER_ID,
          `✅ ${userName} завершил чек-лист "${completed.checklist.title}"\nОтветов: ${answersCount} | ${dateStr} ${timeStr}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '📸 Посмотреть фото', callback_data: `viewPhotos:${runId}` },
              ]],
            },
          },
        );
      } catch (error) {
        console.error('[owner notification error]', error);
      }
    }

    return;
  }

  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { checklist: true },
  });

  if (!run) return;

  await ctx.reply(
    formatQuestionMessage(
      run.checklist.title,
      next.questionNumber,
      next.totalQuestions,
      next.question.text,
    ),
  );
}

/**
 * Получить зарегистрированного пользователя из ctx.
 * Возвращает null если не зарегистрирован.
 */
async function getRegisteredUser(ctx: Context) {
  const from = ctx.from;
  if (!from) return null;

  const telegramId = String(from.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });

  if (!user || !user.role) return null;
  return user;
}

// --- /start ---

async function handleStart(ctx: Context) {
  const from = ctx.from;
  if (!from) {
    await ctx.reply('Не могу определить пользователя.');
    return;
  }

  const user = await getRegisteredUser(ctx);

  if (!user) {
    registrationState.set(from.id, { step: 'awaiting_invite' });
    await ctx.reply(
      'Привет! Для регистрации введи инвайт-код.\nПопроси его у администратора.',
    );
    return;
  }

  // Проверка активного run — не сбрасывать
  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(
      `У вас есть незавершённый чек-лист: "${activeRun.checklist.title}".\nПродолжаем с текущего вопроса.`,
    );
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  // Показать доступные чек-листы
  await showAvailableChecklists(ctx, user);
}

async function showAvailableChecklists(
  ctx: Context,
  user: { id: number; role: string | null },
) {
  const now = new Date();
  const { checklists, nextTimeText } = await getActiveChecklistsForUserNow(
    user as Parameters<typeof getActiveChecklistsForUserNow>[0],
    now,
  );

  if (checklists.length === 0) {
    const timeHint =
      nextTimeText != null
        ? `Следующий чек-лист будет доступен в ${nextTimeText}.`
        : 'Все чек-листы на сегодня пройдены. Отличная работа!';
    await sendMainMenu(ctx, timeHint);
    return;
  }

  const buttons = checklists.map((cl) => [
    Markup.button.callback(cl.title, `startChecklist:${cl.key}`),
  ]);

  await ctx.reply('Доступные чек-листы:', Markup.inlineKeyboard(buttons));
}

// --- Команды ---

bot.start(handleStart);

bot.command('register', async (ctx) => {
  const from = ctx.from;
  if (!from) {
    await ctx.reply('Не могу определить пользователя.');
    return;
  }

  // Не давать перерегистрироваться при активном run
  const user = await getRegisteredUser(ctx);
  if (user) {
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      await ctx.reply(
        `Нельзя перерегистрироваться во время чек-листа "${activeRun.checklist.title}". Завершите его сначала.`,
      );
      return;
    }
  }

  registrationState.set(from.id, { step: 'awaiting_invite' });
  await ctx.reply('Введи инвайт-код. Попроси его у администратора.');
});

bot.command('menu', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;

  await ctx.reply(
    '⚙️ Панель управления',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('👥 Инвайт-коды', 'adm:invites'),
        Markup.button.callback('📋 Чек-листы', 'adm:checklists'),
      ],
      [
        Markup.button.callback('➕ Создать инвайт', 'adm:invite'),
        Markup.button.callback('🔄 Перезагрузить', 'adm:reload'),
      ],
      [
        Markup.button.callback('📊 Статус бота', 'adm:status'),
      ],
      [
        Markup.button.callback('🔍 Мой аккаунт', 'adm:debug_me'),
        Markup.button.callback('📖 Список команд', 'adm:help'),
      ],
    ]),
  );
});

async function handleDebugMe(ctx: Context) {
  try {
    const user = await ensureUserFromContext(ctx);
    const activeRun = await findActiveRun(user.id);

    const lines = [
      'Debug info:',
      `ID: ${user.id}`,
      `Telegram ID: ${user.telegramId}`,
      `Username: ${user.username ?? '—'}`,
      `Role: ${user.role ?? '—'}`,
      `Active run: ${activeRun ? `#${activeRun.id} (${activeRun.checklist.title})` : 'нет'}`,
    ];

    await ctx.reply(lines.join('\n'));
  } catch (error) {
    console.error('[debug_me error]', error);
    await ctx.reply('Ошибка при обращении к БД, попробуйте позже.');
  }
}

bot.command('debug_me', handleDebugMe);

// --- Админ-команды ---

async function handleHelp(ctx: Context) {
  await ctx.reply(
    [
      '📖 Список команд:',
      '',
      '/start — начало работы',
      '/menu — панель управления (только для админов)',
    ].join('\n'),
  );
}

async function handleInvite(ctx: Context) {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);

  const code = randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.inviteCode.create({
    data: { code, createdBy: telegramId, expiresAt },
  });

  await ctx.reply(`Код: ${code}\nДействует 24 часа (до ${expiresAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })})`);
}

async function handleInvites(ctx: Context) {
  const codes = await prisma.inviteCode.findMany({
    where: { isActive: true, usedBy: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (codes.length === 0) {
    await ctx.reply('Нет активных инвайт-кодов.');
    return;
  }

  const lines = codes.map((c) => {
    const hoursLeft = Math.max(0, Math.round((c.expiresAt.getTime() - Date.now()) / 3600000));
    return `${c.code} (осталось ${hoursLeft} ч)`;
  });
  await ctx.reply(`Активные коды (${codes.length}):\n${lines.join('\n')}`);
}

bot.command('invite', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvite(ctx);
});

bot.command('invites', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvites(ctx);
});

async function handleReload(ctx: Context) {
  try {
    await ctx.reply('Перезагружаю чек-листы...');
    const count = await syncChecklists();
    await ctx.reply(`Чек-листы перезагружены (${count} штук)`);
  } catch (error) {
    console.error('[reload error]', error);
    await ctx.reply('Ошибка при перезагрузке чек-листов.');
  }
}

async function handleStatus(ctx: Context) {
  try {
    const lines: string[] = [];

    try {
      await prisma.$queryRaw`SELECT 1`;
      lines.push('🟢 DB: ok');
    } catch {
      lines.push('🔴 DB: fail');
    }

    const uploadsDir = path.resolve('uploads');
    lines.push(existsSync(uploadsDir) ? '🟢 Storage: ok' : '🟡 Storage: папка uploads отсутствует');

    lines.push(config.OPENAI_API_KEY ? '🟢 AI: ключ настроен' : '🔴 AI: OPENAI_API_KEY не задан');

    const userCount = await prisma.user.count();
    lines.push(`👥 Пользователей: ${userCount}`);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const runsToday = await prisma.run.count({
      where: { startedAt: { gte: todayStart } },
    });
    const activeRuns = await prisma.run.count({
      where: { completedAt: null },
    });

    lines.push(`📋 Runs за сегодня: ${runsToday}`);
    lines.push(`▶️ Активных runs: ${activeRuns}`);

    const outboxPending = await prisma.outbox.count({ where: { status: 'pending' } });
    const outboxFailed = await prisma.outbox.count({ where: { status: 'failed' } });
    lines.push(`📬 Outbox: pending ${outboxPending}, failed ${outboxFailed}`);

    await ctx.reply(lines.join('\n'));
  } catch (error) {
    console.error('[status error]', error);
    await ctx.reply('Ошибка при получении статуса.');
  }
}

bot.command('reload', async (ctx) => {
  const from = ctx.from;
  if (!from || !isAdmin(String(from.id))) return;
  await handleReload(ctx);
});

bot.command('status', async (ctx) => {
  const from = ctx.from;
  if (!from || !isAdmin(String(from.id))) return;
  await handleStatus(ctx);
});

// --- Callback: админ-панель (/menu) ---

bot.action('adm:invites', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvites(ctx);
});

bot.action('adm:checklists', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await sendChecklistList(ctx);
});

bot.action('adm:invite', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleInvite(ctx);
});

bot.action('adm:reload', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleReload(ctx);
});

bot.action('adm:status', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleStatus(ctx);
});

bot.action('adm:debug_me', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleDebugMe(ctx);
});

bot.action('adm:help', async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;
  const telegramId = String(from.id);
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) return;
  await handleHelp(ctx);
});

// --- Callback: старт чек-листа ---

bot.action(/^startChecklist:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const from = ctx.from;
  if (!from) return;

  const user = await getRegisteredUser(ctx);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }

  // Проверка: нет ли уже активного run
  const activeRun = await findActiveRun(user.id);
  if (activeRun) {
    await ctx.reply(
      `У вас уже есть активный чек-лист: "${activeRun.checklist.title}".\nЗавершите его, прежде чем начинать новый.`,
    );
    await sendCurrentQuestion(ctx, activeRun.id);
    return;
  }

  const key = ctx.match[1];
  const checklist = await prisma.checklist.findUnique({
    where: { key },
    include: { questions: { orderBy: { order: 'asc' } } },
  });

  if (!checklist) {
    await ctx.reply('Чек-лист не найден.');
    return;
  }

  if (checklist.questions.length === 0) {
    await ctx.reply(`Чек-лист "${checklist.title}" пуст — нет вопросов.`);
    return;
  }

  // Записать время старта смены если ещё не записано сегодня
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (!user.shiftStartedAt || user.shiftStartedAt < todayStart) {
    await prisma.user.update({
      where: { id: user.id },
      data: { shiftStartedAt: new Date() },
    });
  }

  // Создаём run
  const run = await createRun(user.id, checklist.id);

  await ctx.reply(`Начинаем чек-лист: "${checklist.title}" (${checklist.questions.length} вопросов)`);
  await sendCurrentQuestion(ctx, run.id);
});

// --- Callback: просмотр фото владельцем ---

bot.action(/^viewPhotos:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const from = ctx.from;
  if (!from) return;

  const telegramId = String(from.id);
  // Доступ только владельцу или админу
  if (telegramId !== config.OWNER_ID && !isAdmin(telegramId)) {
    return;
  }

  const runId = Number(ctx.match[1]);
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      checklist: true,
      user: true,
      answers: {
        include: { question: true },
        orderBy: { question: { order: 'asc' } },
      },
    },
  });

  if (!run) {
    await ctx.reply('Чек-лист не найден.');
    return;
  }

  const photosWithFiles = run.answers.filter((a) => a.value && existsSync(a.value));

  if (photosWithFiles.length === 0) {
    await ctx.reply('Фото не найдены для этого чек-листа.');
    return;
  }

  const userName = run.user.displayName ?? run.user.firstName ?? 'Сотрудник';
  await ctx.reply(`📋 ${run.checklist.title} — ${userName}\nФото: ${photosWithFiles.length}`);

  // Отправляем группами до 10 штук (лимит Telegram mediaGroup)
  for (let i = 0; i < photosWithFiles.length; i += 10) {
    const batch = photosWithFiles.slice(i, i + 10);

    if (batch.length === 1) {
      const a = batch[0];
      const verdictText = a.aiVerdict ? ` [${a.aiVerdict}]` : '';
      const caption = `${a.question.order}. ${a.question.text}${verdictText}`;
      await ctx.replyWithPhoto(Input.fromLocalFile(a.value), { caption });
    } else {
      const media = batch.map((a) => {
        const verdictText = a.aiVerdict ? ` [${a.aiVerdict}]` : '';
        const caption = `${a.question.order}. ${a.question.text}${verdictText}`;
        return {
          type: 'photo' as const,
          media: Input.fromLocalFile(a.value),
          caption,
        };
      });
      await ctx.replyWithMediaGroup(media);
    }
  }
});

// --- Админ-управление чек-листами ---
registerChecklistAdmin(bot);

// --- Обработка фото ---

bot.on('photo', async (ctx) => {
  try {
    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }

    const activeRun = await findActiveRun(user.id);
    if (!activeRun) {
      await ctx.reply('Нет активного чек-листа. Фото не принято.');
      return;
    }

    const nextQ = await getNextQuestion(activeRun.id);
    if (!nextQ) {
      await sendCurrentQuestion(ctx, activeRun.id);
      return;
    }

    // Берём фото максимального размера
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;

    // Скачать файл
    const buffer = await downloadTelegramFile(ctx, fileId);

    // Валидация
    const validation = await validateImage(buffer);
    if (!validation.valid) {
      await ctx.reply(`❌ Фото отклонено: ${validation.reason}`);
      return;
    }

    // Проверка дубликата по перцептивному хешу
    const hash = await computePhotoHash(buffer);
    const existingAnswers = await prisma.answer.findMany({
      where: {
        photoHash: { not: null },
        run: { userId: user.id },
      },
      select: { photoHash: true },
    });
    const isDuplicate = existingAnswers.some(
      (a) => hammingDistance(hash, a.photoHash!) <= DUPLICATE_THRESHOLD,
    );
    if (isDuplicate) {
      await ctx.reply('❌ Это фото уже было отправлено ранее. Сделайте новое фото.');
      return;
    }

    // Водяной штамп
    const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
    const stamped = await applyWatermark(buffer, {
      displayName,
      date: new Date(),
      location: user.location ?? 'restaurant',
    });

    // AI-проверка (до штампа, на оригинальном фото)
    const aiRule = nextQ.question.aiRule;
    let aiVerdict: string | undefined;
    let aiReason: string | undefined;
    let aiConfidence: number | undefined;

    if (aiRule) {
      const result = await verifyPhoto(buffer, aiRule, nextQ.question.text, nextQ.question.referencePhoto);
      aiVerdict = result.verdict;
      aiReason = result.reason;
      aiConfidence = result.confidence;
    }

    // Сохранение фото (Google Drive или локально)
    const filename = `${randomUUID()}.jpg`;
    const filePath = await uploadPhoto(stamped, filename, {
      displayName,
    });

    // Сохранить путь к файлу с AI-вердиктом и хешем
    await saveAnswer(activeRun.id, nextQ.question.id, filePath, aiVerdict, aiReason, aiConfidence, hash);

    // Записать в Google Sheets сразу после каждого фото
    appendSingleAnswer({
      user,
      checklistTitle: activeRun.checklist.title,
      questionText: nextQ.question.text,
      taskType: nextQ.question.taskType ?? 'photo',
      photoUrl: filePath,
      aiVerdict,
      aiReason,
      runStartedAt: activeRun.startedAt,
    }).catch((err) => console.error('[sheets single answer error]', err));

    if (aiVerdict === 'fail') {
      await ctx.reply(`❌ Фото не прошло проверку: ${aiReason}. Попробуйте переснять.`);
      return;
    }

    await ctx.reply(`✅ Фото принято (${nextQ.questionNumber}/${nextQ.totalQuestions})`);

    // Показать следующий вопрос или завершить
    await sendCurrentQuestion(ctx, activeRun.id);
  } catch (error) {
    console.error('[photo handler error]', error);
    await ctx.reply('Произошла ошибка при обработке фото. Попробуйте ещё раз.');
  }
});

// --- Обработка документов (изображения, отправленные как файл) ---

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const mimeType = doc.mime_type ?? '';

  if (!mimeType.startsWith('image/')) {
    await ctx.reply('Отправьте фото, не файл.');
    return;
  }

  // Изображение отправлено как документ — обрабатываем аналогично фото
  try {
    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }

    const activeRun = await findActiveRun(user.id);
    if (!activeRun) {
      await ctx.reply('Нет активного чек-листа. Фото не принято.');
      return;
    }

    const nextQ = await getNextQuestion(activeRun.id);
    if (!nextQ) {
      await sendCurrentQuestion(ctx, activeRun.id);
      return;
    }

    // Скачать файл
    const buffer = await downloadTelegramFile(ctx, doc.file_id);

    // Валидация
    const validation = await validateImage(buffer);
    if (!validation.valid) {
      await ctx.reply(`❌ Фото отклонено: ${validation.reason}`);
      return;
    }

    // Проверка дубликата по перцептивному хешу
    const hash = await computePhotoHash(buffer);
    const existingAnswers = await prisma.answer.findMany({
      where: {
        photoHash: { not: null },
        run: { userId: user.id },
      },
      select: { photoHash: true },
    });
    const isDuplicate = existingAnswers.some(
      (a) => hammingDistance(hash, a.photoHash!) <= DUPLICATE_THRESHOLD,
    );
    if (isDuplicate) {
      await ctx.reply('❌ Это фото уже было отправлено ранее. Сделайте новое фото.');
      return;
    }

    // Водяной штамп
    const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
    const stamped = await applyWatermark(buffer, {
      displayName,
      date: new Date(),
      location: user.location ?? 'restaurant',
    });

    // AI-проверка (до штампа, на оригинальном фото)
    const aiRule = nextQ.question.aiRule;
    let aiVerdict: string | undefined;
    let aiReason: string | undefined;
    let aiConfidence: number | undefined;

    if (aiRule) {
      const result = await verifyPhoto(buffer, aiRule, nextQ.question.text, nextQ.question.referencePhoto);
      aiVerdict = result.verdict;
      aiReason = result.reason;
      aiConfidence = result.confidence;
    }

    // Сохранение фото (Google Drive или локально)
    const filename = `${randomUUID()}.jpg`;
    const filePath = await uploadPhoto(stamped, filename, {
      displayName,
    });

    // Сохранить путь к файлу с AI-вердиктом и хешем
    await saveAnswer(activeRun.id, nextQ.question.id, filePath, aiVerdict, aiReason, aiConfidence, hash);

    // Записать в Google Sheets сразу после каждого фото
    appendSingleAnswer({
      user,
      checklistTitle: activeRun.checklist.title,
      questionText: nextQ.question.text,
      taskType: nextQ.question.taskType ?? 'photo',
      photoUrl: filePath,
      aiVerdict,
      aiReason,
      runStartedAt: activeRun.startedAt,
    }).catch((err) => console.error('[sheets single answer error]', err));

    if (aiVerdict === 'fail') {
      await ctx.reply(`❌ Фото не прошло проверку: ${aiReason}. Попробуйте переснять.`);
      return;
    }

    await ctx.reply(`✅ Фото принято (${nextQ.questionNumber}/${nextQ.totalQuestions})`);
    await sendCurrentQuestion(ctx, activeRun.id);
  } catch (error) {
    console.error('[document handler error]', error);
    await ctx.reply('Произошла ошибка при обработке фото. Попробуйте ещё раз.');
  }
});

// --- Обработка текста ---

bot.action(/^reg:location:(restaurant|cafe)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const from = ctx.from;
  if (!from) return;

  const state = registrationState.get(from.id);
  if (!state || state.step !== 'awaiting_location') return;

  const location = ctx.match[1];
  const locationLabel = location === 'restaurant' ? '🍽 Ресторан' : '☕ Кофепоинт';
  const telegramId = String(from.id);

  const roleConfig = roles.find((r) => r.key === state.tempRole);

  const user = await upsertRegisteredUser({
    telegramId,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    username: from.username ?? null,
    displayName: state.tempName ?? from.first_name ?? 'Без имени',
    role: state.tempRole as RoleKey,
    location,
  });

  registrationState.delete(from.id);

  await ctx.editMessageText(
    [
      'Регистрация завершена ✅',
      `Имя: ${user.displayName}`,
      `Роль: ${roleConfig?.label ?? state.tempRole}`,
      `Локация: ${locationLabel}`,
    ].join('\n'),
  );

  await showAvailableChecklists(ctx, user);
});

bot.on('text', async (ctx) => {
  const from = ctx.from;
  const message = ctx.message;

  if (!from || !('text' in message)) return;

  const text = message.text.trim();

  // Кнопки основного меню
  if (text === 'Старт') {
    await handleStart(ctx);
    return;
  }

  if (text === 'Меню') {
    const user = await getRegisteredUser(ctx);
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
      return;
    }
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      await ctx.reply(
        `У вас есть незавершённый чек-лист: "${activeRun.checklist.title}".\nПродолжаем с текущего вопроса.`,
      );
      await sendCurrentQuestion(ctx, activeRun.id);
      return;
    }
    await showAvailableChecklists(ctx, user);
    return;
  }

  if (text.toLowerCase().startsWith('регистрация')) {
    const user = await getRegisteredUser(ctx);
    if (user) {
      const activeRun = await findActiveRun(user.id);
      if (activeRun) {
        await ctx.reply(
          `Нельзя перерегистрироваться во время чек-листа. Завершите "${activeRun.checklist.title}" сначала.`,
        );
        return;
      }
    }
    registrationState.set(from.id, { step: 'awaiting_invite' });
    await ctx.reply('Введи инвайт-код. Попроси его у администратора.');
    return;
  }

  // Команды — пропускаем
  if (text.startsWith('/')) return;

  // Регистрация FSM
  const state = registrationState.get(from.id);

  if (state) {
    if (state.step === 'awaiting_invite') {
      const invite = await prisma.inviteCode.findUnique({
        where: { code: text.toUpperCase() },
      });

      if (!invite || !invite.isActive || invite.usedBy || invite.expiresAt < new Date()) {
        await ctx.reply('Неверный или просроченный код. Попросите администратора выдать новый.');
        return;
      }

      // Пометить код как использованный
      await prisma.inviteCode.update({
        where: { id: invite.id },
        data: {
          usedBy: String(from.id),
          usedAt: new Date(),
          isActive: false,
        },
      });

      state.step = 'awaiting_name';
      await ctx.reply('Код принят! Как тебя лучше называть? Напиши имя/фамилию одним сообщением.');
      return;
    }

    if (state.step === 'awaiting_name') {
      if (text.length < 2) {
        await ctx.reply('Имя слишком короткое, напиши, пожалуйста, ещё раз.');
        return;
      }

      state.tempName = text;
      state.step = 'awaiting_role';

      const keyboard = Markup.keyboard(roles.map((role) => role.label))
        .oneTime()
        .resize();

      await ctx.reply('Выбери свою роль:', keyboard);
      return;
    }

    if (state.step === 'awaiting_role') {
      const roleConfig = findRoleByLabel(text);

      if (!roleConfig) {
        await ctx.reply('Не удалось распознать роль. Выбери вариант из клавиатуры.');
        return;
      }

      state.tempRole = roleConfig.key;
      state.step = 'awaiting_location';

      await ctx.reply('Выбери локацию:', Markup.inlineKeyboard([
        [Markup.button.callback('🍽 Ресторан', 'reg:location:restaurant')],
        [Markup.button.callback('☕ Кофепоинт', 'reg:location:cafe')],
      ]));
      return;
    }
  }

  // Если у пользователя активный run — напомнить что нужно фото
  const user = await getRegisteredUser(ctx);
  if (user) {
    const activeRun = await findActiveRun(user.id);
    if (activeRun) {
      await ctx.reply('Пожалуйста, отправьте фото.');
      return;
    }
  }
});
