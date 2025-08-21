import 'dotenv/config';
import { forumTopic, Message, messageSenderUser, User } from 'src/utils/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import {
  deleteMessages,
  extractJsonBlock,
  getActiveThreads,
  getPublicChatIdByChatName,
  login,
  sendMessage,
  sleep,
} from '@/utils/common.js';
import { analyze, collectMessages, MessageOut, prepareMessages } from '@/moderation/moderation-utils.js';
import * as tdl from 'tdl';
import { Client } from 'tdl';
import { STRICT_PROMPTS } from '@/moderation/moderation-prompts.js';

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
const DEFAULT_CORRECTNESS_LEVEL = 30;
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
  const chatId = await getPublicChatIdByChatName(clientUSER, chatName);
  const botInfo = await clientBOT.invoke({ _: 'getMe' }) as User;

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
      // continue;
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

    let allMsgsPure = await collectMessages(
      clientUSER,
      chatId,
      t,
      60 * 60 * 24 * 30,
      userNamesCache,
      new Set([]),
    );

    console.log(`Collected ${allMsgsPure.length} messages`);

    const botMsgs = allMsgsPure.filter((m: any) => (m.sender_id as messageSenderUser).user_id === botInfo.id);
    console.log('botMsgs', botMsgs.length);

    const MAX_MSG_CONTEXT = 100;
    if (allMsgsPure.length > MAX_MSG_CONTEXT) {
      allMsgsPure = allMsgsPure.slice(-MAX_MSG_CONTEXT);
      console.log(`Collected ${allMsgsPure.length} messages after limiting to last ${MAX_MSG_CONTEXT} messages`);
    }

    const allMsgs: MessageOut[] = await prepareMessages(clientUSER, allMsgsPure, EXCLUDED_USERS);

    allMsgs.unshift(...firstMsg);

    // allMsgs.forEach(msg => console.log(`${msg.id},${msg.from} (${msg.fromId}) ${msg.thread} ${msg.link} ${msg.date} ${msg.text}`));

    if (!prompt) {
      prompt = STRICT_PROMPTS.get('0') ?? '';
    }

    const results = extractJsonBlock(await analyze(
      msgsToAnalyze,
      (Date.now() / 1000) - LAST_MSGS_PERIOD,
      prompt,
      MODEL,
      (msg: MessageOut) => `{id:${msg.id},link:${msg.link},sender:${msg.from},text:${msg.text},replyTo:${msg.replyTo}\n`,
      allMsgs,
    )) as ModResult[];

    let maxCorrectnessLevel = DEFAULT_CORRECTNESS_LEVEL;
    const cMatch = thread.info.name.match(/\(L=(\d+)\)$/);
    if (cMatch) {
      maxCorrectnessLevel = parseInt(cMatch[1], 10);
      console.log('correctness level', maxCorrectnessLevel);
    }

    await sendResults(chatId, results, DRY_RUN, clientBOT, thread.info.message_thread_id, maxCorrectnessLevel);

    await deleteOldMsgs(clientBOT, botMsgs, chatId, thread);

  }

  await sleep(1000);
  console.log(`Done!`);
}

async function deleteOldMsgs(clientBOT: Client, botMsgs: Message[], chatId: number, thread: forumTopic) {
  const currentDate = Math.floor(Date.now() / 1000);
  for (const msg of botMsgs) {
    if (msg.date < (currentDate - 60 * 60)) {
      if ((msg.interaction_info?.reactions?.reactions?.length ?? 0) > 0) {
        console.log(`Old bot message ${msg.id} with reaction in thread ${thread.info.name}`);
        if (!DRY_RUN) {
          try {
            await deleteMessages(clientBOT, chatId, [msg.id]);
          } catch (e) {
            console.error(`Error deleting message ${msg.id} in thread ${thread.info.name}:`, e);
          }
        }
      }
    }
  }
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
