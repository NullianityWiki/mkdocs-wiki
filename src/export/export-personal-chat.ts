import 'dotenv/config';

import { getTdjson } from 'prebuilt-tdlib';
import { mkdirSync, writeFileSync } from 'fs';
import { exportPersonalChat, getPrivateChatIdByChatName, login } from '@/utils/common.js';
import { Message } from 'src/utils/tdlib-types';
import * as tdl from 'tdl';

tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, PHONE_NUMBER, PERSONAL_CHAT_NAME } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!;
const phoneNumber = PHONE_NUMBER!, chatName = PERSONAL_CHAT_NAME!;

const userNamesCache = new Map<number, string>();
const userExcludedCache = new Map<number, boolean>();

type MessageOut = {
  from: string;
  date: string;
  text: string
}

async function main() {
  const client = await login(
    tdl,
    apiId,
    apiHash,
    undefined,
    phoneNumber,
  );
  const chatId = await getPrivateChatIdByChatName(client, chatName);

  let lastMsg: Message | null = null;

  const messages = (await exportPersonalChat(client, chatId, lastMsg, userNamesCache, userExcludedCache));
  if (messages.length === 0) {
    console.log(`No messages found in chat ${chatId}`);
    return;
  }

  await writeResult(messages);

}


async function writeResult(messages: Message[]) {
  console.log('Writing messages...');
  const exportDir = `./tmp/chat-exports`;

  const resultMsgs: MessageOut[] = messages.map(msg => {
    if (!msg || msg.content._ !== 'messageText' || !msg.content.text) {
      return {
        from: '',
        date: '',
        text: '',
      };
    }

    // @ts-ignore
    const senderName: string = msg['sender_name'] || 'UnknownSender';

    const date = (new Date(msg.date * 1000)).toISOString();
    const textOut = msg.content.text.text;

    return {
      from: senderName,
      date: date,
      text: textOut,
    };
  }).filter(msg => msg.text && msg.text.length > 0);

  mkdirSync(exportDir, { recursive: true });

  const filename = `${exportDir}/chat_${chatName}.json`;
  writeFileSync(
    filename,
    JSON.stringify(resultMsgs, null, 2),
    { encoding: 'utf-8' },
  );
  console.log(`→ Saved ${resultMsgs.length} messages to ${filename}`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
