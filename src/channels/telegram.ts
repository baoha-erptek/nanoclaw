/**
 * Telegram Channel for NanoClaw
 *
 * Uses Grammy (https://grammy.dev/) to connect to Telegram Bot API.
 * Supports group chats with @mention trigger detection.
 *
 * JID format: tg:<chat_id> (e.g., tg:-1001234567890)
 */
import { Bot, Context } from 'grammy';
import pino from 'pino';

import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const JID_PREFIX = 'tg:';

function chatIdToJid(chatId: number | string): string {
  return `${JID_PREFIX}${chatId}`;
}

function jidToChatId(jid: string): number {
  return Number(jid.slice(JID_PREFIX.length));
}

function createTelegramChannel(opts: ChannelOpts): Channel | null {
  // Read token from .env (NanoClaw doesn't load .env into process.env for security)
  const envSecrets = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = envSecrets.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set — Telegram channel disabled');
    return null;
  }

  const bot = new Bot(token);
  let connected = false;
  let botUsername = '';

  const channel: Channel = {
    name: 'telegram',

    async connect(): Promise<void> {
      const me = await bot.api.getMe();
      botUsername = me.username || '';
      logger.info({ username: botUsername }, 'Telegram bot identity resolved');

      bot.on('message:text', (ctx: Context) => {
        if (!ctx.message?.text || !ctx.chat || !ctx.from) return;

        const chatJid = chatIdToJid(ctx.chat.id);
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        const chatName =
          ctx.chat.type === 'private'
            ? `DM:${ctx.from.first_name}`
            : 'title' in ctx.chat
              ? ctx.chat.title || chatJid
              : chatJid;

        // Report chat metadata (name, channel type)
        opts.onChatMetadata(
          chatJid,
          new Date(ctx.message.date * 1000).toISOString(),
          chatName,
          'telegram',
          isGroup,
        );

        // Skip messages from bots (including self)
        if (ctx.from.is_bot) return;

        const senderName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ');

        const message: NewMessage = {
          id: String(ctx.message.message_id),
          chat_jid: chatJid,
          sender: String(ctx.from.id),
          sender_name: senderName,
          content: ctx.message.text,
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        opts.onMessage(chatJid, message);
      });

      // Handle photo messages with captions
      bot.on('message:photo', (ctx: Context) => {
        if (!ctx.chat || !ctx.from) return;

        const chatJid = chatIdToJid(ctx.chat.id);
        if (ctx.from.is_bot) return;

        const senderName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ');

        const caption = ctx.message?.caption || '[Photo received]';

        const message: NewMessage = {
          id: String(ctx.message!.message_id),
          chat_jid: chatJid,
          sender: String(ctx.from.id),
          sender_name: senderName,
          content: caption,
          timestamp: new Date(ctx.message!.date * 1000).toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        opts.onMessage(chatJid, message);
      });

      bot.catch((err) => {
        logger.error({ error: err.message }, 'Telegram bot error');
      });

      // Start polling (non-blocking)
      bot.start({
        onStart: () => {
          connected = true;
          logger.info(
            { username: botUsername },
            'Telegram bot started polling',
          );
        },
      });
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      const chatId = jidToChatId(jid);

      // Telegram has a 4096 character limit per message.
      // Split long messages at line boundaries.
      const MAX_LEN = 4000;
      if (text.length <= MAX_LEN) {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        return;
      }

      const lines = text.split('\n');
      let chunk = '';
      for (const line of lines) {
        if (chunk.length + line.length + 1 > MAX_LEN) {
          if (chunk) {
            await bot.api.sendMessage(chatId, chunk, {
              parse_mode: 'Markdown',
            });
          }
          chunk = line;
        } else {
          chunk = chunk ? `${chunk}\n${line}` : line;
        }
      }
      if (chunk) {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      }
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid.startsWith(JID_PREFIX);
    },

    async disconnect(): Promise<void> {
      connected = false;
      await bot.stop();
      logger.info('Telegram bot stopped');
    },
  };

  return channel;
}

registerChannel('telegram', createTelegramChannel);
