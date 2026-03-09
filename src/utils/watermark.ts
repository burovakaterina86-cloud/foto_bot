import sharp from 'sharp';

type WatermarkOptions = {
  displayName: string;
  date: Date;
  location?: string;
};

const GPS_COORDS = '55.7558, 37.6173';
const LOCATION_NAME = 'Тхали Карри';

export async function applyWatermark(
  buffer: Buffer,
  { displayName, date }: WatermarkOptions,
): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 800;
  const height = metadata.height ?? 600;

  const dateStr = formatDate(date);
  const line1 = `${displayName} | ${dateStr}`;
  const line2 = `${GPS_COORDS} | ${LOCATION_NAME}`;

  const fontSize = Math.max(14, Math.round(width * 0.025));
  const lineHeight = Math.round(fontSize * 1.4);
  const padding = Math.round(fontSize * 0.8);

  const longestLine = line1.length > line2.length ? line1 : line2;
  const estimatedTextWidth = Math.round(longestLine.length * fontSize * 0.6);
  const svgWidth = Math.min(estimatedTextWidth + padding * 2, width);
  const svgHeight = Math.min(lineHeight * 2 + padding * 2, height);

  const y1 = padding + fontSize;
  const y2 = y1 + lineHeight;

  const svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" rx="4" ry="4" fill="rgba(0,0,0,0.5)"/>
    <text x="${padding}" y="${y1}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="rgba(255,255,255,0.9)">${escapeXml(line1)}</text>
    <text x="${padding}" y="${y2}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="rgba(255,255,255,0.9)">${escapeXml(line2)}</text>
  </svg>`;

  const svgBuffer = Buffer.from(svg);

  return sharp(buffer)
    .composite([{ input: svgBuffer, gravity: 'southeast' }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

function formatDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${d}.${m}.${y} ${h}:${min}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
