#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import archiver from 'archiver';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import ignore from 'ignore';
import * as path from 'path';
import { z } from 'zod';
import TelegramBot = require('node-telegram-bot-api');

dotenv.config();

// Enable proper file content-type handling
process.env.NTBA_FIX_350 = '1';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  throw new Error('TELEGRAM_TOKEN and CHAT_ID are required in .env file');
}

const validatedChatId = CHAT_ID as string;
let bot: TelegramBot | null = null;
const pendingQuestions = new Map<string, (answer: string) => void>();
let lastQuestionId: string | null = null;

async function initializeBot() {
  try {
    bot = new TelegramBot(TELEGRAM_TOKEN!, {
      polling: true,
      filepath: false
    });

    const handleMessage = (msg: TelegramBot.Message) => {
      console.log('Received message:', {
        chatId: msg.chat.id.toString(),
        expectedChatId: validatedChatId,
        text: msg.text,
        replyToMessage: msg.reply_to_message?.text
      });

      if (msg.chat.id.toString() !== validatedChatId || !msg.text) {
        console.log('Message rejected: chat ID mismatch or no text');
        return;
      }

      let questionId = null;

      if (msg.reply_to_message?.text) {
        const match = msg.reply_to_message.text.match(/#([a-z0-9]+)\n/);
        if (match) {
          questionId = match[1];
        }
      }

      if (!questionId) {
        questionId = lastQuestionId;
      }

      console.log('Question ID (from reply or last):', questionId);
      console.log('Pending questions:', Array.from(pendingQuestions.keys()));

      if (questionId && pendingQuestions.has(questionId)) {
        console.log('Found matching question with ID:', questionId);
        const resolver = pendingQuestions.get(questionId)!;
        resolver(msg.text);
        pendingQuestions.delete(questionId);
        lastQuestionId = null;
        console.log('Question resolved and removed from pending');
      } else {
        console.log('No matching question found for this response');
      }
    };

    bot.on('message', handleMessage);

    bot.on('polling_error', (error: Error) => {
      if (error.message.includes('409 Conflict')) {
        return;
      }
      console.error('Polling error:', error.message);
    });

    const botInfo = await bot.getMe();
    console.log('Bot initialized successfully:', botInfo.username);

    process.once('SIGINT', () => {
      if (bot) {
        bot.stopPolling();
      }
      process.exit(0);
    });

    return true;
  } catch (error: any) {
    console.error('Error initializing bot:', error?.message || 'Unknown error');
    return false;
  }
}

async function zipProject(directory?: string): Promise<string> {
  const workingDir = directory || process.cwd();
  const projectName = path.basename(workingDir);
  const ig = ignore();
  const gitignorePath = path.join(workingDir, '.gitignore');
  const gitignoreContent = fs.existsSync(gitignorePath) ?
    fs.readFileSync(gitignorePath, 'utf8') :
    '';
  ig.add(gitignoreContent);

  const outputPath = path.join(workingDir, `${projectName}-project.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    output.on('close', () => {
      console.log(`Zipped ${archive.pointer()} total bytes`);
      resolve();
    });

    archive.on('error', (err: Error) => {
      reject(err);
    });

    archive.pipe(output);

    const addFilesFromDirectory = (dirPath: string) => {
      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const relativePath = path.relative(workingDir, fullPath);

        if (relativePath.startsWith('.git')) {
          continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          addFilesFromDirectory(fullPath);
        } else {
          if (!ig.ignores(relativePath)) {
            archive.file(fullPath, { name: relativePath });
          }
        }
      }
    };

    addFilesFromDirectory(workingDir);
    archive.finalize();
  });

  const stats = fs.statSync(outputPath);
  const TWO_GB = 2 * 1024 * 1024 * 1024;

  if (stats.size > TWO_GB) {
    fs.unlinkSync(outputPath);
    throw new Error('File size exceeds 2GB limit. Please implement file splitting or reduce the project size.');
  }

  return outputPath;
}

async function main() {
  const success = await initializeBot();
  if (!success) {
    console.error('Failed to initialize bot, exiting...');
    process.exit(1);
  }

  // Create MCP server
  const server = new McpServer({
    name: "mcp-communicator-telegram",
    version: "0.2.1"
  });

  // Add ask_user tool
  server.tool(
    "ask_user",
    { question: z.string() },
    async ({ question }) => {
      if (!bot) {
        throw new Error('Bot not initialized');
      }

      const questionId = Math.random().toString(36).substring(7);
      lastQuestionId = questionId;

      console.log('Asking question with ID:', questionId);

      await bot.sendMessage(parseInt(validatedChatId), `#${questionId}\n${question}`, {
        reply_markup: {
          force_reply: true,
          selective: true
        }
      });

      const response = await new Promise<string>((resolve) => {
        pendingQuestions.set(questionId, resolve);
      });

      return {
        content: [{
          type: "text",
          text: response
        }]
      };
    }
  );

  // Add notify_user tool
  server.tool(
    "notify_user",
    { message: z.string() },
    async ({ message }) => {
      if (!bot) {
        throw new Error('Bot not initialized');
      }

      await bot.sendMessage(parseInt(validatedChatId), message);
      return {
        content: [{
          type: "text",
          text: "Notification sent successfully"
        }]
      };
    }
  );

  // Add send_file tool
  server.tool(
    "send_file",
    { filePath: z.string() },
    async ({ filePath }) => {
      if (!bot) {
        throw new Error('Bot not initialized');
      }

      const fileStream = fs.createReadStream(filePath);
      await bot.sendDocument(parseInt(validatedChatId), fileStream, {}, {
        contentType: 'application/octet-stream',
        filename: path.basename(filePath)
      });

      return {
        content: [{
          type: "text",
          text: "File sent successfully"
        }]
      };
    }
  );

  // Add zip_project tool
  server.tool(
    "zip_project",
    { directory: z.string().optional() },
    async ({ directory }) => {
      if (!bot) {
        throw new Error('Bot not initialized');
      }

      const zipFilePath = await zipProject(directory);
      try {
        const fileStream = fs.createReadStream(zipFilePath);
        await bot.sendDocument(parseInt(validatedChatId), fileStream, {}, {
          contentType: 'application/zip',
          filename: path.basename(zipFilePath)
        });

        return {
          content: [{
            type: "text",
            text: "Project zipped and sent successfully"
          }]
        };
      } finally {
        // Clean up the zip file
        if (fs.existsSync(zipFilePath)) {
          fs.unlinkSync(zipFilePath);
        }
      }
    }
  );

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.log('MCP Communicator server running...');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});