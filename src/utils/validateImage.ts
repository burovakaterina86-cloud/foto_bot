import sharp from 'sharp';

const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'] as const;
const MIN_DIMENSION = 100;

type ValidationResult =
  | { valid: true; width: number; height: number }
  | { valid: false; reason: string };

export async function validateImage(buffer: Buffer): Promise<ValidationResult> {
  try {
    const metadata = await sharp(buffer).metadata();

    if (!metadata.format || !(ALLOWED_FORMATS as readonly string[]).includes(metadata.format)) {
      return {
        valid: false,
        reason: `Неподдерживаемый формат: ${metadata.format ?? 'неизвестен'}. Допустимые: JPEG, PNG, WebP.`,
      };
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
      return {
        valid: false,
        reason: `Изображение слишком маленькое (${width}x${height}). Минимум: ${MIN_DIMENSION}x${MIN_DIMENSION}px.`,
      };
    }

    return { valid: true, width, height };
  } catch {
    return {
      valid: false,
      reason: 'Не удалось обработать файл как изображение.',
    };
  }
}
