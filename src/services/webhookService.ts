import { config } from '../config/index.js';
import { prisma } from '../db/client.js';

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

function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

async function postToMake(payload: Record<string, unknown>): Promise<void> {
  if (!config.MAKE_WEBHOOK_URL) return;

  const res = await fetch(config.MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Make responded ${res.status}`);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('429') || msg.includes('5')) {
      // Check for 5xx status codes
      const match = msg.match(/(\d{3})/);
      if (match) {
        const code = Number(match[1]);
        if (code === 429 || (code >= 500 && code < 600)) return true;
      }
    }
    // Network/timeout errors
    if (msg.includes('timeout') || msg.includes('abort') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
      return true;
    }
  }
  return true; // Default to retryable for unknown errors
}

export async function enqueueAnswer(data: {
  runId: number;
  questionId: number;
  checklist: string;
  checklistType: string;
  questionOrder: number;
  questionText: string;
  employeeName: string;
  employeeRole: string;
  aiVerdict?: string;
  aiReason?: string;
  aiConfidence?: number;
  photoPath: string;
}): Promise<void> {
  const idempotencyKey = `answer:${data.runId}:${data.questionId}`;

  const existing = await prisma.outbox.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return;

  const payload = {
    type: 'answer',
    run_id: data.runId,
    checklist: data.checklist,
    checklist_type: data.checklistType,
    question_order: data.questionOrder,
    question_text: data.questionText,
    employee_name: data.employeeName,
    employee_role: data.employeeRole,
    ai_verdict: data.aiVerdict ?? '',
    ai_reason: data.aiReason ?? '',
    ai_confidence: data.aiConfidence ?? '',
    photo_path: data.photoPath,
    timestamp: formatDateTime(new Date()),
  };

  await prisma.outbox.create({
    data: {
      eventType: 'answer',
      payloadJson: JSON.stringify(payload),
      idempotencyKey,
    },
  });
}

export async function enqueueShift(data: {
  shiftId: number;
  employeeName: string;
  employeeRole: string;
  shiftStart: string;
  shiftEnd: string;
  shiftMinutes: number;
  failCount: number;
}): Promise<void> {
  const idempotencyKey = `shift:${data.shiftId}`;

  const existing = await prisma.outbox.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return;

  const start = new Date(data.shiftStart);
  const end = new Date(data.shiftEnd);
  const hours = Math.floor(data.shiftMinutes / 60);
  const mins = data.shiftMinutes % 60;

  const payload = {
    type: 'shift_summary',
    employee_name: data.employeeName,
    employee_role: data.employeeRole,
    shift_start: formatDateTime(start),
    shift_end: formatDateTime(end),
    shift_minutes: `${hours}ч ${mins}мин`,
    fail_count: data.failCount,
    timestamp: formatDateTime(new Date()),
  };

  await prisma.outbox.create({
    data: {
      eventType: 'shift_summary',
      payloadJson: JSON.stringify(payload),
      idempotencyKey,
    },
  });
}

export async function processOutbox(): Promise<void> {
  const now = new Date();

  const events = await prisma.outbox.findMany({
    where: {
      status: 'pending',
      nextRetryAt: { lte: now },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  for (const event of events) {
    try {
      const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
      await postToMake(payload);

      await prisma.outbox.update({
        where: { id: event.id },
        data: { status: 'sent' },
      });
    } catch (error) {
      const attempts = event.attempts + 1;
      const errMsg = error instanceof Error ? error.message : String(error);

      if (attempts >= 3 || !isRetryable(error)) {
        await prisma.outbox.update({
          where: { id: event.id },
          data: {
            status: 'failed',
            attempts,
            lastError: errMsg,
          },
        });
        console.error(`[outbox] Event #${event.id} failed permanently: ${errMsg}`);
      } else {
        const delayMs = 1000 * Math.pow(2, attempts - 1); // 1s, 2s, 4s
        const nextRetry = new Date(Date.now() + delayMs);

        await prisma.outbox.update({
          where: { id: event.id },
          data: {
            attempts,
            nextRetryAt: nextRetry,
            lastError: errMsg,
          },
        });
        console.warn(`[outbox] Event #${event.id} retry ${attempts}/3 in ${delayMs}ms`);
      }
    }
  }
}
