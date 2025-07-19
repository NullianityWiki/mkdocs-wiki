import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { exportThread, extractJsonBlock, login, sendMessage, sendMessageBOT, sleep } from './common';
import OpenAI from 'openai';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;

const DRY_RUN = process.env.DRY_RUN === 'true';
const EXCLUDED = new Set<string>([
  '@thread_export_nullianity_bot',
]);
const REPORT_TO_THREAD = '0 Админская';
const REPORT_TO_CHAT = -1002832182712;
const TAG_MODERATORS = '@belbix @forbiddenfromthebegining @Legoved @Alleks_88 @natastriver @Aleksandr_Luginin @kuraimonogotari';
const LAST_MSGS_PERIOD = 60 * 60;
const EXTRACT_LAST_MSGS_PERIOD = 60 * 60 * 2;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';
const PROMPT = `
Проанализируй переписку и найди только те сообщения, которые действительно требуют модерации по причине нарушений правил сообщества.

Запрещено не дружелюбное общение, в частности это:
- обесценивание
- снисходительный тон
- пассивно-агрессивный тон
- унижение человека
- критика без уточнения (сразу писать "это бред" вместо "можешь уточнить")
- шутки над человеком
- старички не на равных с новичками
- гейткипинг (ты не настоящий участник, если не...)
- "я просто пошутил(а)", когда человек явно задет.

Для каждого нарушения выставляй оценку от 1 до 10.
1 - Сомнительный тон (Неочевидная грубость, не по теме, но без явного зла)
2 - Мягкое нарушение этики (Раздражённость, пассивная агрессия, токсичный сарказм)
3 - Нарушение стиля общения (Явная грубость, переход на личности без мата)
4 - Флуд, оффтоп, реклама (Сообщения вне темы, дублирование, нерелевантные ссылки)
5 - Провокации или троллинг (Намеренное раздражение участников или подстрекательство)
6 - Дезинформация или шок‑контент (Ложь, теория заговора, фейк-скрины, шокирующие медиа)
7 - Оскорбления и дискриминация (Мат в адрес участника, национализм, сексизм и т.п.)
8 - Политический оффтоп (Явное нарушение п. 1.4, особенно если пост может вызвать угрозу)
9 - Публикация личных данных, вредоносное ПО (Частичный доксинг, ссылки на вирусы, социальная инженерия)
10 - Системное вредительство, бот-атака (Массовый спам, порнография, призывы к насилию)

Верни ТОЛЬКО нарушающие сообщения, в формате массива JSON объектов где:
{
id: ID сообщения,
thread: ID треда сообщения,
link: Ссылка на сообщение,
rate: Оценка серьезности нарушения от 1 до 10,
sender: Отправитель,
reason: Развернутая причина с указанием пункта правил,
recommendation: Прямое обращение к отправителю с краткой рекомендацией о неподобающем поведении,
}
Твой ответ должен содержать ТОЛЬКО массив JSON объектов.

Вот правила сообщества:
1. Общие положения
1.1. Назначение группы.
Группа создана для обсуждения идей Нуллианства и смежных тем в дружелюбной обстановке.  
1.2 Общайтесь вежливо, не переходите на личности. 
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
4. Модерация и санкции
При обнаружении нарушения, просьба написать в «0 Репорты и Жалобы» со ссылкой на нарушающее сообщение.
Меры при нарушении: 
• Замечание (сообщение админа с просьбой отредактировать или удалить нарушение), 
• Предупреждение (три предупреждения = мут), либо 
• Мут (лишение возможности публиковать в группу). 
Срок мута назначается ботом автоматически удваиваясь за каждое повторное нарушение. Первое нарушение несёт наказание в виде мута на 1 день.
• Кик (исключение из группы) только в исключительных случаях (таких как спам-ботов).
Сообщение нарушающее правила будет удалено.

Формат сообщений: "id,ссылка,тред,отправитель:сообщение".

Это все сообщения требующие анализа модерации:
"""$LAST_MESSAGES"""


Это остальные сообщения для понимания общего контекста:
"""$ALL_MESSAGES"""

`;

const userNamesCache = new Map<number, string>();

type MessageOut = {
  id: number;
  from: string;
  thread: number;
  link: string;
  date: number;
  text: string
}

async function main() {
  const clientBOT = await login(
    tdl,
    apiId,
    apiHash,
    botToken,
    undefined,
  );
  const clientUSER = await login(
    tdl,
    apiId,
    apiHash,
    undefined,
    phoneNumber,
  );
  const chatId = await getChatIdByChatName(clientUSER, chatName);
  // await sendMessage(client, chatId, 185594806272, 237812842496, `@belbix test, ignore this`);
  // if(chatId !== 0) {
  //   return;
  // }

  const threads = await getActiveThreads(clientUSER, chatId);
  // threads.forEach((thread, threadId) => {
  //   console.log(`Thread: ${thread.info.name}, ID: ${threadId} ${thread.info.is_closed ? '(closed)' : ''} ${thread.info.is_hidden ? '(hidden)' : ''}`);
  // });
  let resultThreadId = 0;

  const allMessages: Message[] = [];
  for (const thread of threads.values()) {
    if (thread.info.is_closed) {
      console.log(`Skipping closed thread ${thread.info.name} (${thread.info.message_thread_id})`);
      continue;
    }
    const threadId = thread.info.message_thread_id;
    if (thread.info.name === REPORT_TO_THREAD) {
      resultThreadId = threadId;
      // do not analyze the report thread
      continue;
    }

    let lastThreadMsgOld = new Map<number, number>();
    lastThreadMsgOld.set(threadId, (Date.now() / 1000) - EXTRACT_LAST_MSGS_PERIOD);

    const msgs = (await exportThread(
      clientUSER,
      chatId,
      thread,
      lastThreadMsgOld,
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

  const allMessagesOut: MessageOut[] = [];

  for (const msg of allMessages) {
    if (!msg || msg.content._ !== 'messageText' || !msg.content.text) {
      continue;
    }

    // @ts-ignore
    const senderName = msg['sender_name'] || 'UnknownSender';

    let exclude = false;
    for (const excluded of EXCLUDED) {
      if (senderName.includes(excluded)) {
        exclude = true;
        break;
      }
    }
    if (exclude) {
      continue;
    }

    // @ts-ignore
    const link = msg['link'] || '';

    // const date = (new Date(msg.date * 1000)).toISOString();
    const textOut = msg.content.text.text;

    allMessagesOut.push({
      id: msg.id,
      from: senderName,
      thread: msg.message_thread_id,
      link,
      date: msg.date,
      text: textOut,
    });
  }

  const result = extractJsonBlock(await analyze(allMessagesOut));

  let out = '';
  let tagAdmins = false;
  for (const r of result) {
    let text = `
⚠️${r.sender} ${r.recommendation}\n
${r.link}\n
Токсичность: ${r.rate} из 10\n
Причина:\n${r.reason}
`;
    let rate = 0;
    let extraEmoji = '';
    try {
      rate = Number(r.rate);
      if (rate >= 5) {
        extraEmoji = '🔥🔥🔥';
        tagAdmins = true;
        text = `${text}\n\n${TAG_MODERATORS}`;
      }
    } catch (e) {
      console.log(`Failed to parse rate for message ID ${r.id} in thread ${r.thread}: ${e}`);
    }

    out += `${r.link}\n${r.sender}\nReason(${r.rate}${extraEmoji}): ${r.reason}\n\n`;

    console.log(text);

    if (!DRY_RUN) {
      try {
        await sendMessage(clientBOT, chatId, r.thread, null, text);
      } catch (e) {
        console.error(`Failed to send message for ID ${r.id} in thread ${r.thread}:`, e);
      }
    }
  }

  if (tagAdmins) {
    out = `${out}\n${TAG_MODERATORS}`;
  }

  if (!DRY_RUN) {
    await sendMessageBOT(botToken, REPORT_TO_CHAT, 0, null, `${out}`);
  }

  await sleep(60000);
  console.log(`All done! Sent ${result.length} messages to ${chatName} (${chatId})`);
}

async function getChatIdByChatName(client: Client, _chatName: string) {
  console.log(`Searching for chat with name "${_chatName}"...`);
  const chat = await client.invoke({
    _: 'searchPublicChat',
    username: _chatName,
  });
  console.log('→ CHAT_ID =', chat.id);
  return chat.id;
}

async function getActiveThreads(client: Client, chatId: number) {
  console.log(`Fetching active threads in chat ${chatId}...`);

  const allTopics = new Map<number, ForumTopic>();
  let lastThreadDate = 0;

  let count = 0;
  while (true) {
    count++;
    const { topics } = await client.invoke({
      _: 'getForumTopics',
      chat_id: chatId,
      limit: 100,
      offset_date: lastThreadDate,
    }) as { topics: ForumTopic[] };

    if (topics.length === 0 || count > 3) {
      break;
    }

    // console.log(topics[0])

    for (const t of topics) {
      // console.log(`Thread: ${t.info.name}, ID: ${t.info.message_thread_id} ${t.info.is_closed ? '(closed)' : ''} ${t.info.is_hidden ? '(hidden)' : ''}`);
      allTopics.set(t.info.message_thread_id, t);
    }

    lastThreadDate = topics[topics.length - 1].last_message?.date ?? 0;
  }

  console.log(`Found ${allTopics.size} threads in chat ${chatId}`);
  return allTopics;
}

async function analyze(messages: MessageOut[]) {

  let allMessagesData = '';
  for (const msg of messages) {
    if (msg.date >= ((Date.now() / 1000) - LAST_MSGS_PERIOD)) {
      continue;
    }
    allMessagesData += `${msg.from}:${msg.text}\n`;
  }
  let lastMessagesData = '';
  for (const msg of messages) {
    if (msg.date < ((Date.now() / 1000) - LAST_MSGS_PERIOD)) {
      continue; // skip messages older than 1 hour
    }
    lastMessagesData += `${msg.id},${msg.link},${msg.thread},${msg.from}:${msg.text}\n`;
  }

  const prompt = PROMPT.replace('$ALL_MESSAGES', JSON.stringify(allMessagesData))
    .replace('$LAST_MESSAGES', lastMessagesData);

  // console.log(`Prompt:`, prompt);

  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    // apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });
  const result = response.choices[0].message.content ?? '';

  console.log(`result:\n`, result);

  //save last prompt to tmp dir
  const fs = require('fs');
  const path = require('path');
  const tmpDir = path.join(__dirname, '../tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  fs.writeFileSync(path.join(tmpDir, `moder_last_prompt.json`), JSON.stringify(prompt, null, 2));
  fs.writeFileSync(path.join(tmpDir, `moder_last_result.json`), JSON.stringify(result, null, 2));

  return result;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
