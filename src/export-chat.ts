import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { mkdirSync, writeFileSync } from 'fs';
import { exportThread, login } from './common';
import { readFileSync } from 'node:fs';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME, START_DATE, EXPORT_DIR } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;
const startTimestamp = START_DATE ? Math.floor(new Date(START_DATE!).getTime() / 1000) : 0;
const exportDir = EXPORT_DIR ?? './exports';

const userNamesCache = new Map<number, string>();

type MessageOut = {
  from: string;
  thread: string;
  link: string;
  date: string;
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

  let lastThreadMsgOld = new Map<number, Message>();
  try {
    const msgs =  JSON.parse(readFileSync(
      './exports/_last_msgs.json',
      { encoding: 'utf-8' },
    )) as Message[];

    for(const m of msgs) {
      if (m && m.message_thread_id) {
        lastThreadMsgOld.set(m.message_thread_id, m);
      }
    }
  } catch (e) {}

  const threadMessages = new Map<number, Message[]>();
  const lastThreadMsg = new Map<number, Message>();
  for (const thread of threads.values()) {
    const threadId = thread.info.message_thread_id;
    const msgs = (await exportThread(client, chatId, thread, lastThreadMsgOld, userNamesCache));
    // .filter(msg => {
    // return msg.date >= startTimestamp;
    // });
    if (msgs.length === 0) {
      console.log(`No messages found in thread ${threadId} (${thread.info.name})`);
      continue;
    }

    threadMessages.set(threadId, msgs);
    lastThreadMsg.set(threadId, msgs[msgs.length - 1]);

    // const lastMsg = lastThreadMsg.get(threadId);
    // if (!lastMsg || msgs[msgs.length - 1].date > lastMsg.date) {
    //   lastThreadMsg.set(threadId, msgs[msgs.length - 1]);
    // }
  }

  await writeByDays(threadMessages, lastThreadMsg);

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

async function writeByDays(threadMessages: Map<number, Message[]>, lastThreadMsg: Map<number, Message>) {
  console.log('Writing messages by days...');
  const byDate: Record<string, MessageOut[]> = {};
  for (const msgs of threadMessages.values()) {
    msgs.forEach((msg: Message) => {
      if (!msg || msg.content._ !== 'messageText' || !msg.content.text) {
        return;
      }

      const day = new Date(msg.date * 1000).toISOString().slice(0, 10);
      if (!byDate[day]) {
        byDate[day] = [];
      }

      // @ts-ignore
      const senderName = msg['sender_name'] || 'UnknownSender';

      // @ts-ignore
      const threadName = msg['thread_name'] || 'UnknownThread';

      // @ts-ignore
      const link = msg['link'] || '';

      const date = (new Date(msg.date * 1000)).toISOString();
      const textOut = msg.content.text.text;

      byDate[day].push({
        from: senderName,
        thread: threadName,
        link,
        date: date,
        text: textOut,
      });
    });
  }

  mkdirSync(exportDir, { recursive: true });

  for (const [day, msgs] of Object.entries(byDate)) {
    console.log(`Writing messages for day ${day}, count: ${msgs.length}`);
    const filename = `${exportDir}/${day}.json`;
    writeFileSync(
      filename,
      JSON.stringify(msgs, null, 2),
      { encoding: 'utf-8' },
    );
    console.log(`→ Saved ${msgs.length} msgs to ${filename}`);
  }

  console.log('Writing last messages...', lastThreadMsg.size);
  const outputMsgs: Message[] = [];
  Array.from(lastThreadMsg.values()).forEach(msg => outputMsgs.push(msg));
  writeFileSync(
    exportDir + '/_last_msgs.json',
    JSON.stringify(outputMsgs, null, 2),
    { encoding: 'utf-8' },
  );
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
