import 'dotenv/config';
import { ForumTopic, forumTopic } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import {
  extractJsonBlock,
  getActiveThreads,
  getChatIdByChatName,
  login,
  sendMessage,
  sendMessageBOT,
  sleep,
} from './common';
import { analyze, collectMessages, MessageOut, prepareMessages } from './moderation-utils';

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
const PROMPT = `Проанализируй переписку и выполни следующие задачи:

1. Найди все сообщения, которые нарушают ход конструктивной и рациональной дискуссии. Под нарушением понимается любое сообщение, которое:
- содержит откровенно эмоциональные, неконструктивные или провокационные утверждения;
- использует риторику без фактической аргументации (например, «всё это чушь», «вам бы книжек почитать»);
- подменяет тезис, использует демагогию, манипуляции или некомпетентные резюме чужой позиции;
- сознательно избегает аргументации в пользу утверждений и заменяет их на социальные сигналы, фразы для доминирования иерархией (например, снисходительный тон, сарказм без сути, оценка собеседника вместо доводов);
- затрудняет продолжение беседы или снижает её рациональный уровень.

2. Для каждого такого сообщения составь разбор **в виде оценки аргументативной и риторической адекватности**. Оцени:
- Насколько сообщение способствует конструктивному диалогу?
- Есть ли в нём логическая аргументация?
- Какие логические ошибки или риторические уловки в нём используются (если есть)?
- Нарушает ли оно правила сообщества?

3. Сообщения без грубых нарушений (например, оффтоп, сарказм, лёгкий троллинг) всё равно включай в итог, **если они подрывают интеллектуальную культуру общения** или способствуют скатыванию темы в спор без содержания.

4. Не возвращай нейтральные, доброжелательные и конструктивные сообщения даже при отсутствии аргументов — только те, что сбивают ход дискуссии или ведут к токсичному/неконструктивному общению.

Ты получишь премию в 100 долларов, если точно определишь все сообщения, мешающие рациональной дискуссии или нарушающие правила. 
Не добавляй ничего лишнего, не выдумывай - просто проанализируй строго, но честно.
В описании причины старайся быть кратким, но информативным. Не лей воду.
Если сообщение не имеет замечаний - не включай его в отчет.
Если ни одно сообщение ничего не нарушало - вышли пустой массив.


Верни ТОЛЬКО нарушающие сообщения в формате массива JSON объектов где:
{
thread: ID треда сообщения,
link: Ссылка на сообщение,
sender: Отправитель,
reason: Четко описанная причина с указанием конкретного нарушения и анализа аргументации,
}
Твой ответ должен содержать ТОЛЬКО массив JSON объектов.

Формат сообщений: "ссылка,отправитель:сообщение".

Это сообщения требующие анализа модерации:
"""$LAST_MESSAGES"""
`;

export type ModResult = {
  thread: string,
  link: string,
  sender: string,
  reason: string,
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

  for (const thread of threads.values()) {

    if (thread.info.is_closed || (thread.info.name && !thread.info.name.startsWith('00 '))) {
      continue;
    }

    if (thread.last_message && thread.last_message.date < (Date.now() / 1000) - LAST_MSGS_PERIOD) {
      console.log(`Skipping thread ${thread.info.name} ${thread.info.message_thread_id} with last message date ${new Date(thread.last_message.date * 1000).toISOString()} older than ${new Date((Date.now() / 1000) - LAST_MSGS_PERIOD * 1000).toISOString()}`);
      continue;
    }

    const t = new Map<number, forumTopic>([
      [thread.info.message_thread_id, thread],
    ]);

    const msgsToAnalyze: MessageOut[] = await prepareMessages(await collectMessages(
      clientUSER,
      chatId,
      t,
      LAST_MSGS_PERIOD,
      userNamesCache,
      new Set([]),
    ), EXCLUDED_USERS);

    const allMsgs: MessageOut[] = await prepareMessages(await collectMessages(
      clientUSER,
      chatId,
      t,
      60 * 60 * 24 * 30,
      userNamesCache,
      new Set([]),
    ), EXCLUDED_USERS);

    const results = extractJsonBlock(await analyze(
      msgsToAnalyze,
      (Date.now() / 1000) - LAST_MSGS_PERIOD,
      PROMPT,
      MODEL,
      msg => `${msg.link},${msg.from}:${msg.text}\n`,
      allMsgs,
    )) as ModResult[];

    await sendResults(chatId, results, DRY_RUN, botToken, thread.info.message_thread_id);
  }

  await sleep(1000);
  console.log(`Done!`);
}


async function sendResults(
  chatId: number,
  results: ModResult[],
  DRY_RUN: boolean,
  botToken: string,
  thread: number,
) {
  if (!results || results.length === 0) {
    console.log(`No results to send, skipping...`);
    return;
  }

  const clientBOT = await login(
    tdl,
    apiId,
    apiHash,
    botToken,
    undefined,
  );

  for (const r of results) {
    try {
      let text = `
${r.sender}
${r.link}
Комментарий от ИИ:
${r.reason}
`;

      console.log(text);

      if (!DRY_RUN) {
        await sendMessage(clientBOT, chatId, thread, null, text);
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
