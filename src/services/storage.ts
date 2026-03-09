import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STORAGE_TYPE = process.env.STORAGE_TYPE ?? 'local';
const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH ?? './uploads';

export async function uploadPhoto(
  buffer: Buffer,
  filename: string,
): Promise<string> {
  if (STORAGE_TYPE !== 'local') {
    throw new Error(`Unsupported storage type: ${STORAGE_TYPE}`);
  }

  const dateDir = formatDateDir(new Date());
  const dirPath = join(LOCAL_STORAGE_PATH, dateDir);

  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, filename);
  await writeFile(filePath, buffer);

  console.log(`[storage] Photo saved: ${filePath}`);

  return filePath;
}

function formatDateDir(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
