import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { exportThread, login, sendMessageToThread } from './common';
import OpenAI from 'openai';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME, START_DATE, EXPORT_DIR } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;

const REPORT_TO_THREAD = '0 Админская';
const TAG_MODERATORS = '@belbix';
const LAST_MSGS_PERIOD = 60 * 60;
const EXTRACT_LAST_MSGS_PERIOD = 60 * 60 * 2;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';
const PROMPT = `
Проанализируй переписку и найди только те сообщения, которые действительно требуют модерации - по причине явных оскорблений, угроз, призывов к насилию, токсичности или нарушения личных границ.
Учитывай, что мат допустим, если он используется нейтрально или эмоционально, но не оскорбительно.
Не репорть конструктивную критику, критика приветствуется если она критикует идею, а не человека.
Не нужно указывать сообщения, которые приведены только для контекста или которые не нарушают правил, даже если они эмоциональны или резки.
Верни ТОЛЬКО нарушающие сообщения, в формате (разделяй каждый пункт переходом на новую строку \\n):
- Ссылка на сообщение
- Отправитель
- Причина (максимум 1–2 предложения, конкретная)
- Текст сообщения (урезать до 1-2 предложений если длинное)
Не пиши никаких заголовков, не объясняй ничего вне списка. Просто выведи нужные сообщения.

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

Это все сообщения за последний час требующие анализа модерации:
"""$LAST_MESSAGES"""


Это все сообщения за последние сутки для понимания общего контекста:
"""$ALL_MESSAGES"""

`;

const userNamesCache = new Map<number, string>();
const userExcludedCache = new Map<number, boolean>();

type MessageOut = {
  id: number;
  from: string;
  thread: string;
  link: string;
  date: number;
  text: string
}

async function main() {
  const client = await login(
    tdl,
    apiId,
    apiHash,
    botToken,
    phoneNumber,
  );
  const chatId = await getChatIdByChatName(client, chatName);
  const threads = await getActiveThreads(client, chatId);
  let resultThreadId = 0;

  const allMessages: Message[] = [];
  for (const thread of threads.values()) {
    const threadId = thread.info.message_thread_id;
    if( thread.info.name === REPORT_TO_THREAD) {
      resultThreadId = threadId;
      // do not analyze the report thread
      continue;
    }

    let lastThreadMsgOld = new Map<number, number>();
    lastThreadMsgOld.set(threadId, (Date.now() / 1000) - EXTRACT_LAST_MSGS_PERIOD);

    const msgs = (await exportThread(
      client,
      chatId,
      thread,
      lastThreadMsgOld,
      userNamesCache,
      userExcludedCache,
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

    // @ts-ignore
    const threadName = msg['thread_name'] || 'UnknownThread';

    // @ts-ignore
    const link = msg['link'] || '';

    // const date = (new Date(msg.date * 1000)).toISOString();
    const textOut = msg.content.text.text;

    allMessagesOut.push({
      id: msg.id,
      from: senderName,
      thread: threadName,
      link,
      date: msg.date,
      text: textOut,
    });
  }

  const result = await analyze(allMessagesOut);

  if (resultThreadId !== 0) {
    await sendMessageToThread(client, chatId, resultThreadId, `${TAG_MODERATORS}\n\n${result}`);
  }
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
    lastMessagesData += `${msg.id},${msg.link},${msg.from}:${msg.text}\n`;
  }

  //   allMessagesData = `
  // 111,https://t.me/chat/111,irina_k:Какой красивый закат сегодня!
  // 112,https://t.me/chat/112,serg1988:Это полная фигня, удаляй.
  // 113,https://t.me/chat/113,tatiana:Спасибо за помощь ❤️
  // 114,https://t.me/chat/114,vasya:Ты серьезно думаешь, что это умно?
  // 115,https://t.me/chat/115,nik_bot:Проверка соединения.
  // 116,https://t.me/chat/116,badguy666:Я тебя найду, понял?
  // 117,https://t.me/chat/117,lolita:Никогда не сдавайся ✨
  // 118,https://t.me/chat/118,harrypotter:Expecto patronum!
  // 119,https://t.me/chat/119,root:Удалите это немедленно.
  // 120,https://t.me/chat/120,anya123:Зачем ты так со мной?
  // 121,https://t.me/chat/121,zloyadmin:Все баны будут вечными.
  // 122,https://t.me/chat/122,oleg_oleg:Го в доту вечером?
  // 123,https://t.me/chat/123,maria_r:Обожаю твои посты!
  // 124,https://t.me/chat/124,xXx666:Ты ничтожество.
  // 125,https://t.me/chat/125,techsupport:Проблема решена, благодарим за ожидание.
  // 126,https://t.me/chat/126,vasilisa:Сегодня такой трудный день...
  // 127,https://t.me/chat/127,h8full:Заткнись уже!
  // 128,https://t.me/chat/128,kate_love:Ты лучший 💖
  // 129,https://t.me/chat/129,den4ik:Damn, that was epic.
  // 130,https://t.me/chat/130,botmod:Сообщение временно скрыто.
  // `.trim();
  //
  //
  //   lastMessagesData = `
  // 101,https://t.me/chat/101,ivan123:Привет, как дела?
  // 102,https://t.me/chat/102,anna_m:Ты выглядишь великолепно!
  // 103,https://t.me/chat/103,darkwolf:Ты — позор этого чата.
  // 104,https://t.me/chat/104,admin_bot:Пожалуйста, не флудите.
  // 105,https://t.me/chat/105,nastya99:❤️❤️❤️
  // 106,https://t.me/chat/106,killerbee:Лучше бы ты умер.
  // 107,https://t.me/chat/107,bot123:Сообщение удалено модератором.
  // 108,https://t.me/chat/108,aleksey:Когда стрим?
  // 109,https://t.me/chat/109,sasha:У меня плохое настроение.
  // 110,https://t.me/chat/110,anon:Ты никто и звать тебя никак.
  // `.trim();


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
  });
  const result = response.choices[0].message.content ?? '';

  console.log(`result:`, result);

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
