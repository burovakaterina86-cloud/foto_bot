import { google } from 'googleapis';
import type { Answer, Checklist, Run, User, Question, Shift } from '@prisma/client';

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

export interface SingleAnswerData {
  user: User;
  checklistTitle: string;
  questionText: string;
  taskType: string;
  photoUrl: string;
  aiVerdict?: string;
  aiReason?: string;
  runStartedAt: Date;
}

export async function appendSingleAnswer(data: SingleAnswerData): Promise<void> {
  if (!SHEETS_ID) return;

  const { user, checklistTitle, questionText, taskType, photoUrl, aiVerdict, aiReason, runStartedAt } = data;
  const sheets = getSheetsClient();
  const sheetName = LOCATION_TO_SHEET[user.location ?? 'restaurant'] ?? 'Ресторан';
  const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
  const username = user.username ? `@${user.username}` : '';
  const role = user.role ?? '';
  const now = new Date();
  const aiResult = aiVerdict ?? '';
  const isCorrect = aiVerdict === 'ok' ? 'Да' : aiVerdict === 'fail' ? 'Нет' : '';

  const row = [
    formatDate(now),                        // Дата
    displayName,                             // Имя сотрудника
    username,                                // Никнейм TG
    role,                                    // Роль
    checklistTitle,                          // Чек-лист
    questionText,                            // Задача
    taskType,                                // Тип ответа
    photoUrl,                                // Фото (ссылка)
    aiResult,                                // Результат AI
    aiReason ?? '',                          // Комментарий AI
    isCorrect,                               // Верно заполнено
    `${formatDate(runStartedAt)} ${formatTime(runStartedAt)}`, // Время начала
    `${formatDate(now)} ${formatTime(now)}`, // Время ответа
    '',                                      // Комментарий сотрудника
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: `${sheetName}!A:N`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    console.log(`[sheets] Answer recorded: ${questionText.substring(0, 30)}... → ${aiResult || 'no AI'}`);
  } catch (error) {
    console.error('[sheets] Failed to record single answer:', error);
  }
}

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
      answer.aiReason ?? '',                 // Комментарий AI
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
      range: `${sheetName}!A:N`,
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

export interface ShiftSummaryData {
  shift: Shift;
  user: User;
  failCount: number;
}

export async function recordShiftSummary(data: ShiftSummaryData): Promise<void> {
  if (!SHEETS_ID) {
    console.warn('[sheets] GOOGLE_SHEETS_ID not set, skipping shift summary');
    return;
  }

  const { shift, user, failCount } = data;
  const sheets = getSheetsClient();

  const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
  const role = user.role ?? '';
  const location = LOCATION_TO_SHEET[user.location ?? 'restaurant'] ?? 'Ресторан';
  const startedAt = shift.startedAt;
  const endedAt = shift.endedAt ?? new Date();
  const diffMs = endedAt.getTime() - startedAt.getTime();
  const hours = Math.round((diffMs / 3_600_000) * 10) / 10;

  const row = [
    formatDate(startedAt),        // Дата
    displayName,                   // Имя сотрудника
    role,                          // Роль
    location,                      // Локация
    formatTime(startedAt),         // Начало смены
    formatTime(endedAt),           // Конец смены
    String(hours),                 // Отработано часов
    String(failCount),             // Кол-во ошибок
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: 'Смены!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    console.log(`[sheets] Shift summary recorded for ${displayName} (${hours}h, ${failCount} errors)`);
  } catch (error) {
    console.error('[sheets] Failed to record shift summary:', error);
  }
}

export interface MonthlyStatsData {
  user: User;
  hoursToAdd: number;
  errorsToAdd: number;
}

export async function updateMonthlyStats(data: MonthlyStatsData): Promise<void> {
  if (!SHEETS_ID) {
    console.warn('[sheets] GOOGLE_SHEETS_ID not set, skipping monthly stats');
    return;
  }

  const { user, hoursToAdd, errorsToAdd } = data;
  const sheets = getSheetsClient();

  const displayName = user.displayName ?? user.firstName ?? 'Сотрудник';
  const role = user.role ?? '';
  const location = LOCATION_TO_SHEET[user.location ?? 'restaurant'] ?? 'Ресторан';
  const now = new Date();
  const month = `${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

  try {
    // Прочитать все данные из листа "Статистика"
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: 'Статистика!A:F',
    });

    const rows = existing.data.values ?? [];
    let foundRowIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === month && rows[i][1] === displayName) {
        foundRowIndex = i;
        break;
      }
    }

    if (foundRowIndex >= 0) {
      // Обновить существующую строку
      const currentHours = parseFloat(rows[foundRowIndex][4] ?? '0') || 0;
      const currentErrors = parseInt(rows[foundRowIndex][5] ?? '0', 10) || 0;
      const newHours = Math.round((currentHours + hoursToAdd) * 10) / 10;
      const newErrors = currentErrors + errorsToAdd;

      const rowNumber = foundRowIndex + 1; // 1-based
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEETS_ID,
        range: `Статистика!E${rowNumber}:F${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[String(newHours), String(newErrors)]] },
      });
      console.log(`[sheets] Monthly stats updated for ${displayName}: ${newHours}h, ${newErrors} errors`);
    } else {
      // Добавить новую строку
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEETS_ID,
        range: 'Статистика!A:F',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[month, displayName, role, location, String(hoursToAdd), String(errorsToAdd)]],
        },
      });
      console.log(`[sheets] Monthly stats created for ${displayName}: ${hoursToAdd}h, ${errorsToAdd} errors`);
    }
  } catch (error) {
    console.error('[sheets] Failed to update monthly stats:', error);
  }
}
