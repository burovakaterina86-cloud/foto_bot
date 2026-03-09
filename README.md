# Foto Bot

Telegram-бот на Node.js + TypeScript + Telegraf.

## 📋 Требования

- Node.js >= 18.0.0
- npm или yarn

## 🔧 Установка

```bash
# Установка зависимостей
npm install

# Настройка окружения
cp .env.example .env
# Отредактируй .env и добавь BOT_TOKEN
```

## ⚙️ Настройка

Заполни `.env`:

```env
BOT_TOKEN=your_bot_token_here
DATABASE_URL="file:./dev.db"
```

Токен получить у [@BotFather](https://t.me/BotFather).

## 🏃 Запуск

```bash
# Development (с hot-reload)
npm run dev

# Production (сборка + запуск)
npm run build
npm start

# Миграции и сиды БД
npm run db:migrate
npm run db:seed
```

## 📁 Структура проекта

```
src/
├── bot/        # Обработчики бота
├── config/     # Конфигурация
├── db/         # База данных (если нужна)
├── services/   # Сервисы
├── utils/      # Утилиты
└── index.ts    # Точка входа
```

## 📚 Команды бота

- `/start` — Приветствие

## 🛠️ Технологии

- Node.js
- TypeScript (strict)
- Telegraf 4.x
