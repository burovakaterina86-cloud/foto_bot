import type { Context } from 'telegraf';

const DOWNLOAD_TIMEOUT_MS = 60_000;

export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
): Promise<Buffer> {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const url = fileLink.href;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Failed to download file: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Загрузка файла превысила таймаут.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
