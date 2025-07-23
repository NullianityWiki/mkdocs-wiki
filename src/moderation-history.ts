import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { exportThread, extractJsonBlock, getActiveThreads, getChatIdByChatName, login } from './common';
import { analyze, MessageOut, ModResult, prepareMessages, sendResults } from './moderation-utils';

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
const REPORT_TO_THREAD = '0 Админская';
const REPORT_TO_CHAT = -1002832182712;
const TAG_MODERATORS = '@belbix @forbiddenfromthebegining @Legoved @Alleks_88 @natastriver @Aleksandr_Luginin @kuraimonogotari';
const LAST_MSGS_PERIOD = 60 * 20;
const EXTRACT_LAST_MSGS_PERIOD = LAST_MSGS_PERIOD * 2;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';
const PROMPT = `
Проанализируй переписку и найди только те сообщения, которые действительно требуют модерации по причине нарушений правил сообщества.
Мат в чате разрешен!
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
3 - Нарушение стиля общения (Явная грубость, переход на личности)
4 - Флуд, оффтоп, реклама (Сообщения вне темы, дублирование, нерелевантные ссылки)
5 - Провокации или троллинг (Намеренное раздражение участников или подстрекательство)
6 - Дезинформация или шок‑контент (Ложь, теория заговора, фейк-скрины, шокирующие медиа)
7 - Оскорбления и дискриминация (Оскорбления в адрес участника, национализм, сексизм и т.п.)
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
senderId: Отправитель ID,
reason: Развернутая причина с указанием пункта правил,
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

Формат сообщений: "id,ссылка,тред,отправитель,senderId:сообщение".

Это все сообщения требующие анализа модерации:
"""$LAST_MESSAGES"""


Это остальные сообщения для понимания общего контекста:
"""$ALL_MESSAGES"""

`;

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
  const window = 60 * 60 * 2;
  // let lastMsgDate = (Date.now() / 1000) - window;
  const endDate = ((new Date('2025-07-20T21:06:19.000Z')).getTime() / 1000);
  let lastMsgDate = ((new Date('2025-07-18T21:06:19.000Z')).getTime() / 1000) - window;

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
        lastMsgDate + (window / 2),
        PROMPT,
        MODEL,
      )) as ModResult[];

      await sendResults(chatId, results, TAG_MODERATORS, DRY_RUN, botToken, REPORT_TO_CHAT);
    } catch (e) {
      console.error('Error during moderation analysis:', e);
      tryCount++;
      if(tryCount < 10) {
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


main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
