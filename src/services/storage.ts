import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';

const ENABLE_GOOGLE_DRIVE = process.env.ENABLE_GOOGLE_DRIVE === 'true';
const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH ?? './uploads';

// Единая корневая папка Google Drive
const DRIVE_ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Кэш ID подпапок сотрудников: "parentFolderId/employeeName" → folderId
const subfolderCache = new Map<string, string>();

export function getDriveClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET и GOOGLE_REFRESH_TOKEN должны быть заданы в .env');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return google.drive({ version: 'v3', auth });
}

/**
 * Найти или создать подпапку внутри parentFolderId.
 */
async function getOrCreateSubfolder(
  drive: ReturnType<typeof getDriveClient>,
  parentFolderId: string,
  folderName: string,
): Promise<string> {
  const cacheKey = `${parentFolderId}/${folderName}`;
  const cached = subfolderCache.get(cacheKey);
  if (cached) return cached;

  // Поиск существующей папки
  const query = [
    `name = '${folderName.replace(/'/g, "\\'")}'`,
    `'${parentFolderId}' in parents`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ].join(' and ');

  const list = await drive.files.list({
    q: query,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (list.data.files && list.data.files.length > 0) {
    const id = list.data.files[0].id!;
    subfolderCache.set(cacheKey, id);
    return id;
  }

  // Создание новой папки
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const id = created.data.id!;
  subfolderCache.set(cacheKey, id);
  console.log(`[storage] Created Drive folder: ${folderName} (${id})`);
  return id;
}

export interface UploadContext {
  displayName?: string;
}

export async function uploadPhoto(
  buffer: Buffer,
  filename: string,
  context?: UploadContext,
): Promise<string> {
  if (ENABLE_GOOGLE_DRIVE) {
    return uploadToGoogleDrive(buffer, filename, context);
  }
  return uploadToLocal(buffer, filename);
}

async function uploadToGoogleDrive(
  buffer: Buffer,
  filename: string,
  context?: UploadContext,
): Promise<string> {
  const drive = getDriveClient();

  if (!DRIVE_ROOT_FOLDER) {
    console.warn('[storage] GOOGLE_DRIVE_FOLDER_ID not set, falling back to local');
    return uploadToLocal(buffer, filename);
  }

  // Подпапка по имени сотрудника
  let targetFolderId = DRIVE_ROOT_FOLDER;
  const employeeName = context?.displayName;
  if (employeeName) {
    targetFolderId = await getOrCreateSubfolder(drive, DRIVE_ROOT_FOLDER, employeeName);
  }

  // Загрузка файла
  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [targetFolderId],
    },
    media: {
      mimeType: 'image/jpeg',
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
    supportsTeamDrives: true,
  });

  const fileId = response.data.id!;

  // Сделать публично доступным
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
    supportsAllDrives: true,
  });

  const link = response.data.webViewLink ?? response.data.webContentLink ?? `https://drive.google.com/file/d/${fileId}/view`;
  console.log(`[storage] Uploaded to Google Drive: ${filename} → ${link}`);
  return link;
}

async function uploadToLocal(buffer: Buffer, filename: string): Promise<string> {
  const dateDir = formatDateDir(new Date());
  const dirPath = join(LOCAL_STORAGE_PATH, dateDir);

  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, filename);
  await writeFile(filePath, buffer);

  console.log(`[storage] Photo saved locally: ${filePath}`);
  return filePath;
}

function formatDateDir(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
