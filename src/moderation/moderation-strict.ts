import 'dotenv/config';
import { forumTopic, Message } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { extractJsonBlock, getActiveThreads, getChatIdByChatName, login, sendMessage, sleep } from '../common';
import { analyze, collectMessages, MessageOut, prepareMessages } from './moderation-utils';
import { Client } from 'tdl';
import { STRICT_PROMPTS } from './moderation-prompts';

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
const LAST_MSGS_PERIOD = 60 * 5;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';

export type ModResult = {
  id: string,
  thread: string,
  link: string,
  sender: string,
  reason: string,
  recommendation: string,
  correctness: string,
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
  const clientBOT = await login(
    tdl,
    apiId,
    apiHash,
    botToken,
    undefined,
  );
  const chatId = await getChatIdByChatName(clientUSER, chatName);

  const threads = await getActiveThreads(clientUSER, chatId);

  for (const thread of threads.values()) {
    let prompt = STRICT_PROMPTS.get(thread.info.name);

    if (!prompt && (thread.info.is_closed || (thread.info.name && !thread.info.name.startsWith('00 ')))) {
      continue;
    }

    if (thread.last_message && thread.last_message.date < (Date.now() / 1000) - LAST_MSGS_PERIOD) {
      console.log(`Skipping thread ${thread.info.name} ${thread.info.message_thread_id} with last message date ${new Date(
        thread.last_message.date * 1000).toISOString()} older than ${new Date((Date.now() / 1000) - LAST_MSGS_PERIOD *
        1000).toISOString()}`);
      continue;
    }


    const t = new Map<number, forumTopic>([
      [thread.info.message_thread_id, thread],
    ]);

    const msgsToAnalyze: MessageOut[] = await prepareMessages(clientUSER, await collectMessages(
      clientUSER,
      chatId,
      t,
      LAST_MSGS_PERIOD,
      userNamesCache,
      new Set([]),
    ), EXCLUDED_USERS);

    const firstMsg: MessageOut[] = await prepareMessages(
      clientUSER,
      [thread.last_message] as Message[],
      EXCLUDED_USERS,
    );
    const allMsgs: MessageOut[] = await prepareMessages(clientUSER, await collectMessages(
      clientUSER,
      chatId,
      t,
      60 * 60 * 24,
      userNamesCache,
      new Set([]),
    ), EXCLUDED_USERS);

    allMsgs.unshift(...firstMsg);

    // allMsgs.forEach(msg => console.log(`${msg.id},${msg.from} (${msg.fromId}) ${msg.thread} ${msg.link} ${msg.date} ${msg.text}`));

    if (!prompt) {
      prompt = STRICT_PROMPTS.get('0') ?? '';
    }
    // {
    //   id: Message ID,
    //   link: Ссылка на сообщение,
    //   sender: Отправитель,
    //   text: Текст сообщения
    //   replyTo: сообщения на которое ответили, если есть
    // }
    const results = extractJsonBlock(await analyze(
      msgsToAnalyze,
      (Date.now() / 1000) - LAST_MSGS_PERIOD,
      prompt,
      MODEL,
      msg => `{id:${msg.id},link:${msg.link},sender:${msg.from},text:${msg.text},replyTo:${msg.replyTo}\n`,
      allMsgs,
    )) as ModResult[];

    let maxCorrectnessLevel = 100;
    const cMatch = thread.info.name.match(/\(L=(\d+)\)$/);
    if (cMatch) {
      maxCorrectnessLevel = parseInt(cMatch[1], 10);
      console.log('correctness level', maxCorrectnessLevel);
    }

    await sendResults(chatId, results, DRY_RUN, clientBOT, thread.info.message_thread_id, maxCorrectnessLevel);
  }

  await sleep(1000);
  console.log(`Done!`);
}


async function sendResults(
  chatId: number,
  results: ModResult[],
  DRY_RUN: boolean,
  clientBOT: Client,
  thread: number,
  maxCorrectnessLevel: number,
) {
  if (!results || results.length === 0) {
    console.log(`No results to send, skipping...`);
    return;
  }

  for (const r of results) {
    try {
      let text = `
${r.sender}
${r.link}
**Комментарий от ИИ(${r.correctness}/100):**
\`\`\`
${r.reason}
\`\`\`
**Как было бы лучше сказать:**
\`\`\`
${r.recommendation}
\`\`\`
`;

      console.log(text);

      if (Number(r.correctness) > maxCorrectnessLevel) {
        console.log('Skip too correct message!');
        continue;
      }

      if (!DRY_RUN) {
        await sendMessage(clientBOT, chatId, thread, Number(r.id), text);
      }

    } catch (e) {
      console.error(`Error processing result ${JSON.stringify(r, null, 2)}:`, e);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
