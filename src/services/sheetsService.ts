import { google } from 'googleapis';
import type { Answer, Checklist, Run, User, Question } from '@prisma/client';

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;

const LOCATION_TO_SHEET: Record<string, string> = {
  restaurant: 'Ресторан',
  cafe: 'Кофепоинт',
};

function getSheetsClient() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не задан в .env');

  const credentials = JSON.parse(json) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

type RunWithAnswers = Run & {
  checklist: Checklist;
  answers: (Answer & { question: Question })[];
};

export async function appendAnswers(
  run: RunWithAnswers,
  user: User,
): Promise<void> {
  if (!SHEETS_ID) {
    console.warn('[sheets] GOOGLE_SHEETS_ID not set, skipping');
    return;
  }

  const sheetName = LOCATION_TO_SHEET[user.location ?? 'restaurant'] ?? 'Ресторан';
  const sheets = getSheetsClient();

  const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
  const username = user.username ? `@${user.username}` : '';
  const role = user.role ?? '';
  const checklistTitle = run.checklist.title;
  const startTime = run.startedAt;
  const endTime = run.completedAt ?? new Date();

  const rows: string[][] = [];

  for (const answer of run.answers) {
    const taskType = answer.question.taskType ?? 'photo';
    const aiResult = answer.aiVerdict ?? '';
    const isCorrect = answer.aiVerdict === 'ok' ? 'Да' : answer.aiVerdict === 'fail' ? 'Нет' : '';

    rows.push([
      formatDate(answer.createdAt),         // Дата
      displayName,                           // Имя сотрудника
      username,                              // Никнейм TG
      role,                                  // Роль
      checklistTitle,                        // Чек-лист
      answer.question.text,                  // Задача
      taskType,                              // Тип ответа
      answer.value,                          // Фото (ссылка)
      aiResult,                              // Результат AI
      isCorrect,                             // Верно заполнено
      `${formatDate(startTime)} ${formatTime(startTime)}`, // Время начала
      `${formatDate(endTime)} ${formatTime(endTime)}`,     // Время окончания
      '',                                    // Комментарий сотрудника
    ]);
  }

  if (rows.length === 0) return;

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: `${sheetName}!A:M`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows,
      },
    });
    console.log(`[sheets] Appended ${rows.length} rows to "${sheetName}" for run #${run.id}`);
  } catch (error) {
    console.error(`[sheets] Failed to append rows for run #${run.id}:`, error);
  }
}
