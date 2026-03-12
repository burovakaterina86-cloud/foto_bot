const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..');

// Найти client_secret_*.json в корне проекта
const files = fs.readdirSync(ROOT).filter(f => f.startsWith('client_secret_') && f.endsWith('.json'));
if (files.length === 0) {
  console.error('Не найден файл client_secret_*.json в корне проекта.');
  console.error('Скачай его из Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs');
  process.exit(1);
}

const secretPath = path.join(ROOT, files[0]);
console.log(`Используется: ${files[0]}`);

const credentials = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\n1. Открой эту ссылку в браузере:\n');
console.log(authUrl);
console.log('\n2. Разреши доступ и скопируй код из адресной строки\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Вставь код сюда: ', async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n=== TOKENS ===');
    console.log(JSON.stringify(tokens, null, 2));
    console.log('\n=== REFRESH TOKEN (добавь в .env) ===');
    console.log(tokens.refresh_token);
  } catch (err) {
    console.error('Ошибка получения токена:', err.message);
  }
  rl.close();
});
