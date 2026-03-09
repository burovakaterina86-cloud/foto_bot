import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const __aiFilename = fileURLToPath(import.meta.url);
const __aiDirname = path.dirname(__aiFilename);
const REFERENCE_PHOTOS_DIR = path.join(__aiDirname, '..', 'config', 'reference_photos');

export interface AiVerdict {
  verdict: 'ok' | 'fail';
  reason: string;
  confidence: number;
}

const AI_TIMEOUT_MS = 60_000;

const rulePrompts: Record<string, string> = {
  uniform_check: [
    'Ты — эксперт по контролю дресс-кода на предприятии.',
    'Проверь фото: сотрудник одет в рабочую униформу?',
    'Униформа — это фирменная одежда (фартук, поло с логотипом, спецодежда).',
    'Домашняя или уличная одежда без элементов формы — это FAIL.',
  ].join(' '),

  steam_check: [
    'Ты — эксперт по проверке работоспособности кофемашин.',
    'Проверь фото: кофемашина включена и работает?',
    'Признаки работы: пар, светящийся индикатор, дисплей включён, процесс приготовления.',
    'Выключенная машина, чёрный экран, отсутствие признаков работы — это FAIL.',
  ].join(' '),

  cleanliness_check: [
    'Ты — эксперт по контролю чистоты и порядка на рабочем месте.',
    'Проверь фото: на рабочем месте в целом чисто и порядок?',
    'Будь лояльным: мелкие недочёты (пыль, незначительные следы, небольшой беспорядок) — это OK.',
    'FAIL ставь ТОЛЬКО при явных серьёзных нарушениях: много мусора на полу, грязная посуда на столах, разлитые жидкости, сильный беспорядок.',
    'Если сомневаешься — ставь OK.',
  ].join(' '),

  temperature_check: [
    'Ты — эксперт по контролю температурного режима на кухне.',
    'Проверь фото: видна температура на термометре/дисплее холодильника?',
    'Допустимые диапазоны: холодильник от 0 до +6°C, морозильник от -18 до -25°C.',
    'OK если температура видна и в допустимом диапазоне.',
    'FAIL если: температура не видна, показания вне нормы, фото не содержит термометра.',
    'Если сомневаешься — ставь OK.',
  ].join(' '),

  photo_relevance: [
    'Ты — эксперт по проверке фотографий для рабочего чек-листа.',
    'Проверь: фото соответствует заданию из чек-листа?',
    'FAIL если: фото пустое, чёрное, размытое до неузнаваемости, скриншот, фото экрана, случайное фото не по теме, фото из интернета.',
    'OK если: на фото виден объект, описанный в задании, даже если качество среднее.',
    'Будь лояльным: если фото хотя бы примерно соответствует заданию — ставь OK.',
    'Если сомневаешься — ставь OK.',
  ].join(' '),
};

const SYSTEM_PROMPT = [
  'Ты проверяешь фотографии сотрудников для чек-листа.',
  'FAIL ставь только если АБСОЛЮТНО уверен (confidence >= 0.90).',
  'Если есть сомнения — ставь OK. Лучше пропустить чем ошибочно отклонить.',
  'Отвечай СТРОГО в формате JSON без markdown:',
  '{"verdict":"ok","reason":"...","confidence":0.95}',
  'verdict — только "ok" или "fail".',
  'reason — краткое объяснение на русском (1-2 предложения).',
  'confidence — число от 0.0 до 1.0, твоя уверенность в ответе.',
  'Не добавляй ничего кроме JSON.',
].join(' ');

const MIN_CONFIDENCE = 0.90;

const REFERENCE_SYSTEM_PROMPT = [
  'Ты проверяешь фотографии сотрудников для чек-листа.',
  'Тебе даны два изображения: первое — эталон (как должно выглядеть), второе — фото сотрудника.',
  '',
  'КРИТЕРИИ СРАВНЕНИЯ:',
  '- Тип объекта: на фото сотрудника тот же тип объекта/помещения/предмета что на эталоне.',
  '- Состояние: объект в приемлемом состоянии (чисто, аккуратно, на месте).',
  '- НЕ сравнивай: лица, фон, освещение, ракурс, точное расположение предметов.',
  '- Фото может быть снято с другого угла — это нормально.',
  '',
  'ПРАВИЛА ВЕРДИКТА:',
  '- FAIL только если ты АБСОЛЮТНО уверен (confidence >= 0.90) что фото не соответствует.',
  '- Если есть хоть малейшее сомнение — ставь OK.',
  '- Лучше пропустить сомнительное фото, чем ошибочно отклонить.',
  '',
  'Отвечай СТРОГО в формате JSON без markdown:',
  '{"verdict":"ok","reason":"...","confidence":0.95}',
  'verdict — только "ok" или "fail".',
  'reason — краткое объяснение на русском (1-2 предложения).',
  'confidence — число от 0.0 до 1.0, твоя уверенность в ответе.',
  'Не добавляй ничего кроме JSON.',
].join(' ');

const referenceHints: Record<string, string> = {
  uniform_check: 'Проверь что сотрудник в таком же типе униформы как на эталоне (фартук, поло, спецодежда). Не сравнивай лицо, причёску или фон.',
  cleanliness_check: 'Проверь что помещение/зона в похожем чистом состоянии как на эталоне. Допустимы мелкие отличия в расстановке предметов.',
  photo_relevance: 'Проверь что на фото тот же тип объекта/зоны что на эталоне.',
};

function buildReferencePrompt(aiRule: string, questionText: string): string {
  const hint = referenceHints[aiRule] ?? 'Проверь что фото сотрудника соответствует эталону по содержанию.';
  return `${hint}

Вопрос из чек-листа: "${questionText}"`;
}

function buildUserPrompt(aiRule: string, questionText: string): string {
  const rulePrompt = rulePrompts[aiRule];
  if (rulePrompt) {
    return `${rulePrompt}\n\nВопрос из чек-листа: "${questionText}"`;
  }
  return `Проверь фото по правилу: "${aiRule}".\nВопрос из чек-листа: "${questionText}"`;
}

function parseAiResponse(content: string): AiVerdict {
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const verdict = parsed['verdict'] === 'fail' ? 'fail' : 'ok';
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : 'Нет описания';
  let confidence = typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return { verdict, reason, confidence };
}

async function loadReferencePhoto(filename: string): Promise<string | null> {
  try {
    const filePath = path.join(REFERENCE_PHOTOS_DIR, filename);
    const buffer = await readFile(filePath);
    return buffer.toString('base64');
  } catch {
    console.warn(`[aiService] Reference photo not found: ${filename}`);
    return null;
  }
}

export async function verifyPhoto(
  imageBuffer: Buffer,
  aiRule: string,
  questionText: string,
  referencePhoto?: string | null,
): Promise<AiVerdict> {
  if (!config.OPENAI_API_KEY) {
    return { verdict: 'ok', reason: 'AI не настроен, фото принято', confidence: 0 };
  }

  try {
    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    const refBase64 = referencePhoto ? await loadReferencePhoto(referencePhoto) : null;

    let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];

    if (refBase64) {
      const refDataUrl = `data:image/jpeg;base64,${refBase64}`;
      messages = [
        { role: 'system', content: REFERENCE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildReferencePrompt(aiRule, questionText) },
            { type: 'image_url', image_url: { url: refDataUrl, detail: 'low' } },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ];
    } else {
      messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildUserPrompt(aiRule, questionText) },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ];
    }

    const response = await Promise.race([
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT_MS),
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { verdict: 'ok', reason: 'AI вернул пустой ответ, фото принято', confidence: 0 };
    }

    const result = parseAiResponse(content);

    // Порог уверенности: если AI не уверен на 90%+ — не наказываем сотрудника
    if (result.verdict === 'fail' && result.confidence < MIN_CONFIDENCE) {
      return {
        verdict: 'ok',
        reason: `AI не уверен (${Math.round(result.confidence * 100)}%), фото принято`,
        confidence: result.confidence,
      };
    }

    return result;
  } catch (error) {
    console.error('[aiService] error:', error);
    return { verdict: 'ok', reason: 'AI недоступен, фото принято', confidence: 0 };
  }
}
