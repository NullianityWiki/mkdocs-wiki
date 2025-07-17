import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { getTdjson } from 'prebuilt-tdlib';
import { exportThread, login, savePhotoFromMessage } from './common';
import { ForumTopics, Message } from 'src/tdlib-types';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH!;
const botToken = process.env.BOT_TOKEN!;
const phoneNumber = process.env.PHONE_NUMBER!;
let chatName = process.env.CHAT_NAME!;
const threadMessageName = process.env.THREAD_NAME!;
let fromDate = Number(process.env.THREAD_FROM_DATE ?? 0);

const userNamesCache = new Map<number, string>();
const userExcludedCache = new Map<number, boolean>();

async function main() {
  const client = await login(
    tdl,
    apiId,
    apiHash,
    botToken,
    phoneNumber,
  );

  const chat = await client.invoke({
    _: 'searchPublicChat',
    username: chatName,
  });
  console.log('→ CHAT_ID =', chat.id);
  const chatId = chat.id;

  const forums = await client.invoke({
    _: 'getForumTopics',
    chat_id: chatId,
    query: threadMessageName,
    limit: 100,
  }) as ForumTopics;
  // console.log('forums', Array.from(forums.topics).map((f: any) => f));
  if (forums.topics.length !== 1) {
    throw new Error(`Expected 1 forum topic, got ${forums.topics.length}`);
  }

  const messages = await exportThread(client, chatId, forums.topics[0], new Map<number, Message>(), userNamesCache, userExcludedCache);

  let output = '';
  let count = 0;
  for(const msg of messages) {

    //   await savePhotoFromMessage(client, msg, `./tmp/images`);

    if (!msg || msg.content._ !== 'messageText' || !msg.content.text) {
      continue;
    }
    if( fromDate && msg.date < fromDate) {
      continue;
    }

    // @ts-ignore
    const senderName = msg['sender_name'] || 'UnknownSender';

    // @ts-ignore
    const threadName = msg['thread_name'] || 'UnknownThread';

    // @ts-ignore
    const link = msg['link'] || '';

    const date = (new Date(msg.date * 1000)).toISOString();
    const textOut = msg.content.text.text;

    output += `${date},${link},${senderName}:${textOut}\n`;
    count++;
  }

  mkdirSync('./tmp', { recursive: true });
  writeFileSync(`./tmp/thread_${threadMessageName}.txt`, output);
  console.log(`Export completed: ${count} / ${messages.length} messages`);
}


main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
