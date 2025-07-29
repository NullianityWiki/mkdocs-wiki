import 'dotenv/config';
import { User } from 'src/utils/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { exportChat, getChatIdByChatName, login, sendMessage, sleep } from '../utils/common';
import { Client } from 'tdl';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;

const DRY_RUN = process.env.DRY_RUN === 'true';
const EXCLUDED_USERS = new Set<string>([]);
const LAST_MSGS_PERIOD = 60 * 60 * 24;
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
  const botInfo = await clientBOT.invoke({ _: 'getMe' }) as User;

  EXCLUDED_USERS.add(botInfo.usernames?.active_usernames[0] ?? '');

  const messages = await exportChat(clientUSER, chatId, Math.floor(Date.now() / 1000), null, userNamesCache, new Map());

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
