import { bot } from './bot/index.js';
import { startScheduler } from './services/scheduler.js';

// Отправка критических ошибок админам в Telegram
const sendErrorToAdmins = async (error: unknown) => {
  const adminIds = process.env.ADMIN_IDS?.split(',') ?? [];
  const text = `🚨 Критическая ошибка бота:\n\n${error instanceof Error ? error.stack : String(error)}`;

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId.trim(), text);
    } catch {
      console.error('Не удалось отправить ошибку админу:', adminId);
    }
  }
};

process.on('uncaughtException', async (err) => {
  console.error('uncaughtException:', err);
  await sendErrorToAdmins(err);
});

process.on('unhandledRejection', async (reason) => {
  console.error('unhandledRejection:', reason);
  await sendErrorToAdmins(reason);
});

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
});

// Настройка меню команд и запуск
(async () => {
  try {
    // Команды для всех (сотрудники)
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Начало работы' },
    ], { scope: { type: 'default' } });

    // Команды для администраторов (из ADMIN_IDS)
    const adminCommands = [
      { command: 'start', description: 'Начало работы' },
      { command: 'menu', description: 'Панель управления' },
    ];

    const adminIds = process.env.ADMIN_IDS?.split(',') ?? [];
    for (const adminId of adminIds) {
      try {
        await bot.telegram.setMyCommands(adminCommands, {
          scope: { type: 'chat', chat_id: Number(adminId.trim()) }
        });
      } catch {
        console.error('Не удалось установить команды для админа:', adminId);
      }
    }
  } catch (error) {
    console.error('Startup error (setMyCommands):', error);
  }
})();

bot.launch().catch((error) => {
  console.error('Bot launch error:', error);
  process.exit(1);
});
console.log('✅ Bot started');

startScheduler(bot);
