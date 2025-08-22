import 'dotenv/config';
import { User } from 'src/utils/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import {
  exportChat,
  extractJsonBlock,
  getPrivateChatIdByChatName,
  getPrompt,
  login,
  sendMessage,
  sleep,
} from '@/utils/common.js';
import { analyze, MessageOut, prepareMessages } from '@/moderation/moderation-utils.js';
import * as tdl from 'tdl';
import { Client } from 'tdl';

tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, ANALYZE_CHAT_NAME } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = ANALYZE_CHAT_NAME!;

const DRY_RUN = process.env.DRY_RUN === 'true';
const EXCLUDED_USERS = new Set<string>([]);
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-pro-preview';

type Result = {
  name: string,
  past: number,
  current: number,
  future: number,
  recomendations: string,
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
  const chatId = await getPrivateChatIdByChatName(clientUSER, chatName);

  const context = await getPrompt('context_' + chatId + '.txt');
  const prompt = (await getPrompt('prompt_' + chatId + '.txt')).replace('$PROJECT_CONTEXT', context);

  const botInfo = await clientBOT.invoke({ _: 'getMe' }) as User;
  EXCLUDED_USERS.add(botInfo.usernames?.active_usernames[0] ?? '');

  const DAY = 60 * 60 * 24;
  const startDate = Math.floor(Date.now() / 1000) - DAY * 30;
  const finishDate = Math.floor(Date.now() / 1000);

  //i have no clues why the first loading does not work and need to load again
  await exportChat(clientUSER, chatId, startDate, finishDate, userNamesCache, new Map(), false);

  await sleep(1000);
  console.log(`LOAD AGAIN`);

  const messages = await exportChat(clientUSER, chatId, startDate, finishDate, userNamesCache, new Map(), false);
  console.log('Messages:', messages.length);

  const allMessagesOut: MessageOut[] = await prepareMessages(clientUSER, messages, EXCLUDED_USERS);

  console.log('Messages out:', allMessagesOut.length);

  const result = await analyze(
    allMessagesOut,
    Math.floor(Date.now() / 1000) - DAY,
    prompt,
    MODEL,
    msg => `
{
date: ${(new Date(msg.date * 1000)).toISOString()},
link: ${msg.link},
from: ${msg.from},
text: ${msg.text},
}      
      `,
    allMessagesOut,
    undefined,
  );

  console.log('result:', result);

  const jsonResult = extractJsonBlock(result) as Result[];

  await send(jsonResult, clientBOT, chatId);


  await sleep(1000);
  console.log(`Done!`);
}

async function send(jsonResult: Result[], client: Client, chatId: number) {

  for (const r of jsonResult) {

    let text = `
**${r.name}**      
P:${r.past} / C:${r.current} / F:${r.future}  
\`\`\`    
${r.recomendations}
\`\`\`  
      `;

    if (r.past < 8 || r.current < 8 || r.future < 8) {
      text += `
---
⚠️__Не хватает данных!__⚠️ 
__Опиши проделанную работу более подробно, включая что сделано, чем занимаешься сейчас и чем будешь заниматься в будущем.__
Просто ответь на это сообщение с кратким репортом.
        `;
    }

    console.log(text);

    if (!DRY_RUN) {
      await sendMessage(client, chatId, 0, null, text);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
