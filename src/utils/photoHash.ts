import sharp from 'sharp';

/**
 * Перцептивный хеш (dHash) — устойчив к пережатию, ресайзу, небольшим изменениям.
 * Уменьшаем до 9x8 grayscale, сравниваем соседние пиксели → 64-битный хеш.
 */
export async function computePhotoHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      hash += left < right ? '1' : '0';
    }
  }

  // Конвертируем 64-битную строку в 16-символьный hex
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(hash.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Расстояние Хэмминга между двумя hex-хешами.
 * Чем меньше — тем более похожи картинки. 0 = идентичны.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;

  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // Считаем биты в xor
    dist += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
  }
  return dist;
}

/** Порог: расстояние <= 10 из 64 бит = дубликат */
export const DUPLICATE_THRESHOLD = 10;
