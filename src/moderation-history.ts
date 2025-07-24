import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { exportThread, extractJsonBlock, getActiveThreads, getChatIdByChatName, login } from './common';
import { analyze, MessageOut, prepareMessages } from './moderation-utils';
import { createDB, getUser, upsertUser } from './db';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;

const DRY_RUN = process.env.DRY_RUN === 'true';
const EXCLUDED_USERS = new Set<string>([
  '@thread_export_nullianity_bot',
  '@nullianity_banhammer_bot',
  '@QuizariumBot',
]);
const EXCLUDED_THREADS = new Set<string>([
  'Квизы',
  '0 Навигация',
  '0 Новости и Голосования',
  '0 Админская',
]);
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';
const PROMPT = `
Проанализируй переписку и составь для каждого участника чата, нарушившего правила, баллы.
Баллы должны быть выставлены за сумму всех сообщений с нарушениями.
Баллы делятся по категориям:
- призыв к насилию
- оскорбление или дискриминация другого участника
- обсуждение политики
- провокация и троллинг
- не корректное общение

Верни рейтинги пользователей в формате массива JSON:
{
senderId: Отправитель ID,
senderName: Отправитель,
rate_violence: призыв к насилию,
rate_insult: оскорбление или дискриминация другого участника,
rate_political: обсуждение политики,
rate_trolling: провокация и троллинг,
rate_inappropriate: не корректное общение,
}
Не возвращай пользователя, если у него не было нарушений и баллы нулевые.
Твой ответ должен содержать ТОЛЬКО массив JSON объектов.

Это все сообщения требующие анализа модерации.
Формат сообщений: "senderId,senderName:text".
"""$LAST_MESSAGES"""
`;

export type ModResult = {
  senderId: string,
  senderName: string,
  rate_violence: string,
  rate_insult: string,
  rate_political: string,
  rate_trolling: string,
  rate_inappropriate: string,
}

const userNamesCache = new Map<number, string>();


async function main() {
  const clientUSER = await login(
    tdl,
    apiId,
    apiHash,
    undefined,
    phoneNumber,
  );
  const chatId = await getChatIdByChatName(clientUSER, chatName);

  const threads = await getActiveThreads(clientUSER, chatId);

  await collectHistoryToxic(clientUSER, chatId, threads);
}

async function collectHistoryToxic(client: Client, chatId: number, threads: Map<number, ForumTopic>) {
  const window = 60 * 60 * 24;
  let lastMsgDate = (Date.now() / 1000) - window;
  // const endDate = ((new Date('2025-07-20T21:06:19.000Z')).getTime() / 1000);
  // let lastMsgDate = ((new Date('2025-07-18T21:06:19.000Z')).getTime() / 1000) - window;

  let tryCount = 0;
  while (true) {
    try {
      const allMessages: Message[] = [];
      console.log(`Collect for date ${new Date(lastMsgDate * 1000).toISOString()} `);

      for (const thread of threads.values()) {
        if (thread.info.is_closed) {
          console.log(`Skipping closed thread ${thread.info.name} (${thread.info.message_thread_id})`);
          continue;
        }

        if (thread.info.name && EXCLUDED_THREADS.has(thread.info.name)) {
          console.log(`Skipping excluded thread ${thread.info.name}`);
          continue;
        }

        if (thread.last_message && thread.last_message.date < lastMsgDate) {
          console.log(`Skipping thread ${thread.info.name} with last message date ${new Date(thread.last_message.date *
            1000).toISOString()} older than ${new Date(lastMsgDate * 1000).toISOString()}`);
          continue;
        }

        const msgs = (await exportThread(
          client,
          chatId,
          thread,
          lastMsgDate,
          lastMsgDate + window,
          userNamesCache,
          null,
          false,
        ));
        if (msgs.length === 0) {
          // console.log(`No messages found in thread ${threadId} (${thread.info.name})`);
          continue;
        }

        allMessages.push(...msgs);
      }

      if (0 === allMessages.length) {
        console.log(`No new messages found in the last ${window} seconds, stopping...`);
        break;
      }

      ///////////////////////////

      console.log('All messages length:', allMessages.length);

      const allMessagesOut: MessageOut[] = await prepareMessages(allMessages, EXCLUDED_USERS);
      if (allMessagesOut.length === 0) {
        continue;
      }
      const results = extractJsonBlock(await analyze(
        allMessagesOut,
        lastMsgDate,
        PROMPT,
        MODEL,
        msg => `${msg.fromId},${msg.from}:${msg.text}\n`,
      )) as ModResult[];

      await processResults(results);
    } catch (e) {
      console.error('Error during moderation analysis:', e);
      tryCount++;
      if (tryCount < 10) {
        continue;
      }
    }
    ///////////////////////////

    lastMsgDate = Math.floor(lastMsgDate - (window / 2));

    // if(lastMsgDate < endDate) {
    //   console.log(`Reached end date ${new Date(endDate * 1000).toISOString()}, stopping...`);
    //   break;
    // }
  }
}

async function processResults(results: ModResult[]) {
  const db = await createDB('moderation.sqlite');

  if (!results || results.length === 0) {
    console.log(`No results to send, skipping...`);
    return;
  }
  for (const r of results) {
    try {
      await writeToxicLevel(db, r);
    } catch (e) {
      console.error(`Error processing result ${JSON.stringify(r, null, 2)}:`, e);
    }
  }
}


async function writeToxicLevel(db: any, result: ModResult) {
  let userId = -1;
  try {
    userId = Number(result.senderId);
  } catch (e) {
    console.error(`Error parsing senderId ${result.senderId} for result ${JSON.stringify(result, null, 2)}:`, e);
    return;
  }
  let rate_violence = 0;
  let rate_insult = 0;
  let rate_political = 0;
  let rate_trolling = 0;
  let rate_inappropriate = 0;
  try {
    rate_violence = Number(result.rate_violence);
    rate_insult = Number(result.rate_insult);
    rate_political = Number(result.rate_political);
    rate_trolling = Number(result.rate_trolling);
    rate_inappropriate = Number(result.rate_inappropriate);
  } catch (e) {
    console.error(`Error parsing rates for result ${JSON.stringify(result, null, 2)}:`, e);
    return;
  }
  if (userId < 0) {
    console.error(`Invalid userId ${userId} for result ${JSON.stringify(result, null, 2)}`);
    return;
  }
  let user = await getUser(db, userId);

  if (user) {
    user.rate_violence += rate_violence;
    user.rate_insult += rate_insult;
    user.rate_political += rate_political;
    user.rate_trolling += rate_trolling;
    user.rate_inappropriate += rate_inappropriate;
  } else {
    user = {
      id: userId,
      name: result.senderName,
      rate_violence: rate_violence,
      rate_insult: rate_insult,
      rate_political: rate_political,
      rate_trolling: rate_trolling,
      rate_inappropriate: rate_inappropriate,
      rate_total: 0,
    };
  }

  user.rate_total =
    user.rate_violence
    + user.rate_insult
    + user.rate_political
    + user.rate_trolling
    + user.rate_inappropriate;

  await upsertUser(db, user);

  console.log(`User ${user.name} (${user.id}) rates updated}`);
  return user;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
