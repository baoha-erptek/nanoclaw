/**
 * Telegram Channel for NanoClaw
 *
 * Uses Grammy (https://grammy.dev/) to connect to Telegram Bot API.
 * Supports group chats with @mention trigger detection.
 *
 * JID format: tg:<chat_id> (e.g., tg:-1001234567890)
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import { Bot, Context } from 'grammy';
import pino from 'pino';

import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
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

const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20 MB (Telegram Bot API limit)

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DownloadResult {
  readonly localPath: string;
  readonly containerPath: string;
  readonly fileSize: number;
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    mod
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${res.statusCode} downloading file`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      })
      .on('error', (err) => {
        file.close();
        try {
          fs.unlinkSync(destPath);
        } catch {
          /* ignore */
        }
        reject(err);
      });
  });
}

async function downloadTelegramFile(
  bot: Bot,
  token: string,
  fileId: string,
  destDir: string,
  filename: string,
): Promise<DownloadResult | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    fs.mkdirSync(destDir, { recursive: true });
    const localPath = path.join(destDir, filename);
    await downloadFile(url, localPath);

    const stat = fs.statSync(localPath);
    const containerPath = localPath
      .replace(/^.*\/groups\//, '/workspace/group/../groups/')
      .replace(/^.*groups\/[^/]+/, '/workspace/group');

    return {
      localPath,
      containerPath: `/workspace/group/attachments/${path.basename(path.dirname(localPath))}/${filename}`,
      fileSize: stat.size,
    };
  } catch (err) {
    logger.warn(
      { fileId, error: err instanceof Error ? err.message : String(err) },
      'Failed to download Telegram file',
    );
    return null;
  }
}

function resolveAttachmentDir(
  chatJid: string,
  messageId: string,
  groups: Record<string, { folder: string }>,
): string | null {
  const group = groups[chatJid];
  if (!group) return null;
  try {
    const groupDir = resolveGroupFolderPath(group.folder);
    return path.join(groupDir, 'attachments', messageId);
  } catch {
    return null;
  }
}

/**
 * Escape underscores outside of backtick code spans to prevent
 * Telegram's legacy Markdown parser from treating them as italic markers.
 */
function escapeTelegramMarkdown(text: string): string {
  // Split by backtick-delimited segments (both ``` and `)
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/);
  return parts
    .map((part, i) => {
      // Odd indices are code spans — leave them untouched
      if (i % 2 === 1) return part;
      // In non-code segments, escape bare underscores
      return part.replace(/_/g, '\\_');
    })
    .join('');
}

/**
 * Send a message with Markdown formatting, falling back to plain text
 * if Telegram rejects the formatting (HTTP 400).
 */
async function sendWithMarkdownFallback(
  bot: Bot,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    const sanitized = escapeTelegramMarkdown(text);
    await bot.api.sendMessage(chatId, sanitized, { parse_mode: 'Markdown' });
  } catch (err: unknown) {
    const isParseError =
      err instanceof Error &&
      'error_code' in err &&
      (err as { error_code: number }).error_code === 400 &&
      String(err.message).includes("can't parse entities");
    if (isParseError) {
      logger.warn({ chatId }, 'Markdown parse failed, sending as plain text');
      await bot.api.sendMessage(chatId, text);
    } else {
      throw err;
    }
  }
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

      // Handle photo messages — download image + include path
      bot.on('message:photo', async (ctx: Context) => {
        if (!ctx.chat || !ctx.from || !ctx.message?.photo) return;

        const chatJid = chatIdToJid(ctx.chat.id);
        if (ctx.from.is_bot) return;

        const senderName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ');

        const msgId = String(ctx.message.message_id);
        const caption = ctx.message.caption || '';
        let content: string;

        // Download the largest photo (last element in array)
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const attDir = resolveAttachmentDir(
          chatJid,
          msgId,
          opts.registeredGroups(),
        );

        if (attDir && photo.file_id) {
          const ext = 'jpg';
          const filename = `photo_${msgId}.${ext}`;
          const result = await downloadTelegramFile(
            bot,
            token,
            photo.file_id,
            attDir,
            filename,
          );
          if (result) {
            content =
              `[Photo: ${result.containerPath} (${formatFileSize(result.fileSize)})]\n${caption}`.trim();
          } else {
            content = `[Photo: download failed]\n${caption}`.trim();
          }
        } else {
          content = caption || '[Photo received]';
        }

        const message: NewMessage = {
          id: msgId,
          chat_jid: chatJid,
          sender: String(ctx.from.id),
          sender_name: senderName,
          content,
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        opts.onMessage(chatJid, message);
      });

      // Handle document messages (PDF, Excel, CSV, Word, etc.)
      bot.on('message:document', async (ctx: Context) => {
        if (!ctx.chat || !ctx.from || !ctx.message?.document) return;

        const chatJid = chatIdToJid(ctx.chat.id);
        if (ctx.from.is_bot) return;

        const senderName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ');

        const msgId = String(ctx.message.message_id);
        const doc = ctx.message.document;
        const caption = ctx.message.caption || '';
        const filename = doc.file_name || `document_${msgId}`;
        const mimeType = doc.mime_type || 'application/octet-stream';
        let content: string;

        const attDir = resolveAttachmentDir(
          chatJid,
          msgId,
          opts.registeredGroups(),
        );

        if (
          attDir &&
          doc.file_id &&
          (doc.file_size || 0) <= MAX_DOWNLOAD_SIZE
        ) {
          const result = await downloadTelegramFile(
            bot,
            token,
            doc.file_id,
            attDir,
            filename,
          );
          if (result) {
            content =
              `[Document: ${result.containerPath} (${formatFileSize(result.fileSize)}, ${mimeType})]\n${caption}`.trim();
          } else {
            content =
              `[Document: ${filename} - download failed (${mimeType})]\n${caption}`.trim();
          }
        } else if ((doc.file_size || 0) > MAX_DOWNLOAD_SIZE) {
          content =
            `[Document: ${filename} (${formatFileSize(doc.file_size || 0)}, ${mimeType}) - too large to download]\n${caption}`.trim();
        } else {
          content = `[Document: ${filename} (${mimeType})]\n${caption}`.trim();
        }

        const message: NewMessage = {
          id: msgId,
          chat_jid: chatJid,
          sender: String(ctx.from.id),
          sender_name: senderName,
          content,
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        opts.onMessage(chatJid, message);
      });

      // Handle video messages (metadata only, no download)
      bot.on('message:video', (ctx: Context) => {
        if (!ctx.chat || !ctx.from || !ctx.message?.video) return;

        const chatJid = chatIdToJid(ctx.chat.id);
        if (ctx.from.is_bot) return;

        const senderName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ');

        const video = ctx.message.video;
        const duration = video.duration || 0;
        const fileSize = video.file_size || 0;
        const caption = ctx.message.caption || '';
        const content =
          `[Video: ${duration}s, ${formatFileSize(fileSize)} - not downloaded]\n${caption}`.trim();

        const message: NewMessage = {
          id: String(ctx.message.message_id),
          chat_jid: chatJid,
          sender: String(ctx.from.id),
          sender_name: senderName,
          content,
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        opts.onMessage(chatJid, message);
      });

      // Handle voice messages (metadata only, no download)
      bot.on('message:voice', (ctx: Context) => {
        if (!ctx.chat || !ctx.from || !ctx.message?.voice) return;

        const chatJid = chatIdToJid(ctx.chat.id);
        if (ctx.from.is_bot) return;

        const senderName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ');

        const voice = ctx.message.voice;
        const duration = voice.duration || 0;
        const content = `[Voice message: ${duration}s - audio not supported]`;

        const message: NewMessage = {
          id: String(ctx.message.message_id),
          chat_jid: chatJid,
          sender: String(ctx.from.id),
          sender_name: senderName,
          content,
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
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
        await sendWithMarkdownFallback(bot, chatId, text);
        return;
      }

      const lines = text.split('\n');
      let chunk = '';
      for (const line of lines) {
        if (chunk.length + line.length + 1 > MAX_LEN) {
          if (chunk) {
            await sendWithMarkdownFallback(bot, chatId, chunk);
          }
          chunk = line;
        } else {
          chunk = chunk ? `${chunk}\n${line}` : line;
        }
      }
      if (chunk) {
        await sendWithMarkdownFallback(bot, chatId, chunk);
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

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
      if (!isTyping) return;
      const chatId = jidToChatId(jid);
      try {
        await bot.api.sendChatAction(chatId, 'typing');
      } catch (err) {
        logger.debug(
          { chatId, error: err instanceof Error ? err.message : String(err) },
          'Failed to send typing indicator',
        );
      }
    },
  };

  return channel;
}

registerChannel('telegram', createTelegramChannel);
