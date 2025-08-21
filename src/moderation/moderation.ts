import 'dotenv/config';
import { forumTopic, Message } from 'src/utils/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import {
  extractJsonBlock,
  getActiveThreads,
  getPublicChatIdByChatName,
  login,
  sendMessage,
  sendMessageBOT,
  sleep,
} from '@/utils/common.js';
import { analyze, collectMessages, MessageOut, prepareMessages } from '@/moderation/moderation-utils.js';

import * as tdl from 'tdl';
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
const REPORT_TO_CHAT = -1002832182712;
const TAG_MODERATORS = '@belbix @forbiddenfromthebegining @Legoved @Alleks_88 @natastriver @Aleksandr_Luginin @kuraimonogotari';
const LAST_MSGS_PERIOD = 60 * 20;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';
const PROMPT = `
Проанализируй переписку и найди только те сообщения, которые действительно требуют модерации по причине грубого нарушений правил сообщества.
Мат в чате разрешен, не надо обращать на него внимание.
Не обращай внимание на небольшие нарушения правил, необходимо возвращать в ответе только грубые нарушения.
Участники могут общаться не сильно дружелюбно, но обращай внимание только на откровенную явную грубость переходящую черту нормального общения и ведущего к конфликту.
Не принимай за недружелюбие выражение сарказма, пассивно-агрессивный тон и токсичность.
Делай учет на то, что участники чата не являются экспертами в определении своего тона и могут допускать вольности.
Исходи из того, хотел ли человек обидеть участника чата в явной форме или нет.
Человек может прямо критиковать человека, переход на личности без грубого оскорбления можно игнорировать.
Будь лоялен к оффтопу и флуду.
Совершенно нормально не найти в сообщениях никаких нарушений, не надо "выискивать" нарушения на ровном месте только ради того, чтобы вернуть хоть что то.
Ты получишь премию в размере 100 долларов если проанализируешь сообщения корректно и вернешь только нарушающие сообщения либо пустой массив.

Верни ТОЛЬКО нарушающие сообщения в формате массива JSON объектов где:
{
id: message ID,
thread: ID треда сообщения,
link: Ссылка на сообщение,
sender: Отправитель,
reason: Причина нарушения описанная в оригинальном и забавном стиле,
score: Оценка грубости нарушения от 0 до 10(чем выше - тем грубее нарушение),
probability: Оценка вероятности того, что это ложное срабатывание от 0 до 10 (чем выше - тем ты уверение в своей правоте)
}
Твой ответ должен содержать ТОЛЬКО массив JSON объектов.

Вот правила сообщества:
1.3. Приоритет правил Telegram и закона.
Все участники обязаны соблюдать официальные Правила Telegram и законодательство стран участников.
В частности запрещается: разжигание ненависти и призывы к насилию.
1.4. Обсуждение мировой политики
Вы можете создать свой собственный телеграмм канал для обсуждение политических вопросов. Для обеспечения безопасности участников сообщества просьба в основном канале от этих тем воздержаться. 
2. Структура общения - топики
2.1. Создание топиков.
Каждый участник может создать новый топик. Тема и название топика обязаны не дублировать существующие и не нарушать остальные правила сообщества Telegram‑группы «Nullianity». 
2.2. Переименование/удаление.
Администрация может переименовывать или удалять топики при нарушении правил, дублировании либо отсутствии активности более 7 дней.
3. Контент‑политика
3.1. Запрещённый контент:
• любой контент нарушающий пункты 1.3 или 1.4
• реклама, реферальные ссылки, спам, флуд; 
• провокации, дезинформация; 
• шок‑контент, порнография;  
• оскорбления, дискриминация, троллинг;  
• публикация чужих личных данных (доксинг); 
• вредоносные ссылки и файлы, пиратство.
3.2. Обсуждение проектов.
Разрешено в соответствующем топике; автор принимает конструктивную критику; прямые ссылки на оплату/вступление - запрещены.

Формат сообщений:
{
link: Ссылка на сообщение,
thread: ID треда,
from: Ник пользователя,
text: Сообщение пользователя для анализа,
replyTo: Текст сообщения на которое отвечает пользователь (этот текст для контекста и не требует анализа модерации)
}

Это сообщения из треда "$THREAD_NAME" требующие анализа модерации:
"""$LAST_MESSAGES"""
`;

// {
//   thread: ID треда сообщения,
//   link: Ссылка на сообщение,
//   sender: Отправитель,
//   reason: Развернутая причина с указанием пункта правил,
// }
export type ModResult = {
  id: string,
  thread: string, // ID треда сообщения,
  link: string, // Ссылка на сообщение,
  sender: string, // Отправитель,
  reason: string, // Развернутая причина с указанием пункта правил,
  score: string,
  probability: string,
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
  const chatId = await getPublicChatIdByChatName(clientUSER, chatName);

  const threads = await getActiveThreads(clientUSER, chatId);

  for (const thread of threads.values()) {

    const threadMessages: Message[] = await collectMessages(
      clientUSER,
      chatId,
      new Map<number, forumTopic>([[thread.info.message_thread_id, thread]]),
      LAST_MSGS_PERIOD,
      userNamesCache,
      EXCLUDED_THREADS,
    );

    const allMessagesOut: MessageOut[] = await prepareMessages(clientUSER, threadMessages, EXCLUDED_USERS);

    const results = extractJsonBlock(await analyze(
      allMessagesOut,
      (Date.now() / 1000) - LAST_MSGS_PERIOD,
      PROMPT,
      MODEL,
      (msg: MessageOut) => `
{
link: ${msg.link},
thread: ${msg.thread},
from: ${msg.from},
text: ${msg.text},
replyTo: ${msg.replyTo},
}      
      `,
      undefined,
      thread.info.name,
    )) as ModResult[];

    const filteredResults = results.filter(r => Number(r.score) >= 6 && Number(r.probability) >= 9);

    await sendResults(chatId, filteredResults, DRY_RUN, botToken, REPORT_TO_CHAT);
  }

  await sleep(1000);
  console.log(`All done!`);
}


async function sendResults(
  chatId: number,
  results: ModResult[],
  DRY_RUN: boolean,
  botToken: string,
  REPORT_TO_CHAT: number,
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

  let out = '';
  for (const r of results) {
    try {
      // S:${r.score},P:${r.probability}
      // ${r.link}
      let text = `
${r.sender}
${r.reason}
---
ИИ может ошибаться, относитесь спокойней и с юмором :)
`;

      out += `S:${r.score},P:${r.probability}\n${r.link}\n${r.sender}\n${r.reason}\n\n`;

      console.log(text);

      let thread = 0;

      thread = Number(r.thread);

      if (!DRY_RUN) {
        await sendMessage(clientBOT, chatId, thread, Number(r.id), text);
      }

    } catch (e) {
      console.error(`Error processing result ${JSON.stringify(r, null, 2)}:`, e);
    }
  }

  // out = `${out}\n${TAG_MODERATORS}`;
  if (!DRY_RUN) {
    // send via API to simple chat
    await sendMessageBOT(botToken, REPORT_TO_CHAT, 0, null, `${out}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
