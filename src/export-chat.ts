import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message, MessageLink, User } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { mkdirSync, writeFileSync } from 'fs';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME, START_DATE } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;
const startTimestamp = START_DATE ? Math.floor(new Date(START_DATE!).getTime() / 1000) : 0;

const userNamesCache = new Map<number, string>();

type MessageOut = {
  from: string;
  thread: string;
  link: string;
  date: string;
  text: string
}

async function main() {
  const client = await login();
  const chatId = await getChatIdByChatName(client, chatName);
  const threads = await getActiveThreads(client, chatId);

  let lastThreadMsgOld = new Map<number, Message>();
  // try {
  //   lastThreadMsgOld = JSON.parse(readFileSync(
  //     './exports/_last_msgs.json',
  //     { encoding: 'utf-8' },
  //   ));
  // } catch (e) {}

  const threadMessages = new Map<number, Message[]>();
  const lastThreadMsg = new Map<number, Message>();
  for (const thread of threads.values()) {
    const threadId = thread.info.message_thread_id;
    const msgs = (await exportThread(client, chatId, thread, lastThreadMsgOld));
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

async function exportThread(
  client: Client,
  chatId: number,
  thread: ForumTopic,
  lastThreadMsgs: Map<number, Message> | null,
): Promise<Message[]> {
  console.log(`Exporting thread from chat ${chatId}, thread ${thread.info.name}`);
  const threadMessageId = thread.info.message_thread_id;

  // need to call before getMessageThreadHistory, otherwise we will get Message not found error
  await client.invoke({
    _: 'getMessage',
    chat_id: chatId,
    message_id: threadMessageId,
  });

  let allMessages: Message[] = [];
  const lastThreadMsg = lastThreadMsgs ? lastThreadMsgs.get(threadMessageId) : null;
  let fromMessageId = lastThreadMsg ? lastThreadMsg.id : 0;

  while (true) {
    try {
      console.log(`Fetching messages starting from message ID ${fromMessageId}`);
      const result = await client.invoke({
        _: 'getMessageThreadHistory',
        chat_id: chatId,
        message_id: threadMessageId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: 100,
      }) as { messages: Message[] };

      if (result.messages.length === 0) {
        break;
      }
      allMessages.push(...result.messages);
      fromMessageId = result.messages[result.messages.length - 1].id as number;
    } catch (e) {
      console.log(`Error fetching messages for thread ${thread.info.name}:`, e);
      await sleep(1000);
    }
  }

  return enrichMessagesWithLinks(
    await enrichMessagesWithUserNames(allMessages.reverse().map(m => {
      return {
        ...m,
        thread_name: thread.info.name,
      };
    }), client), chatId, client);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichMessagesWithUserNames(messages: Message[], client: Client): Promise<Message[]> {
  return await Promise.all(messages.map(async(msg) => {
    if (msg.sender_id && msg.sender_id._ === 'messageSenderUser') {
      const userId = msg.sender_id.user_id;
      const userName = await getUserName(client, userId);
      return {
        ...msg,
        sender_name: userName,
      };
    }
    return msg;
  }));
}

async function getUserName(client: Client, userId: number): Promise<string> {
  if (userNamesCache.has(userId)) {
    return userNamesCache.get(userId)!;
  }

  const user = await client.invoke({
    _: 'getUser',
    user_id: userId,
  }) as User;
  const name = user.first_name
    + (user.last_name ? ' ' + user.last_name : '')
    + (user.usernames?.active_usernames ? '(@' + user.usernames?.active_usernames[0] + ')' : '');
  userNamesCache.set(userId, name);
  return name;
}

async function enrichMessagesWithLinks(messages: Message[], chatId: number, client: Client): Promise<Message[]> {
  return await Promise.all(messages.map(async(msg) => {
    const link = await getMsgLink(client, chatId, msg.id);
    return {
      ...msg,
      link,
    };
  }));
}

async function getMsgLink(client: Client, chatId: number, msgId: number): Promise<string> {
  const link = await client.invoke({
    _: 'getMessageLink',
    chat_id: chatId,
    message_id: msgId,
    in_message_thread: true,
  }) as MessageLink;
  return link.link;
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


  mkdirSync('./exports', { recursive: true });

  for (const [day, msgs] of Object.entries(byDate)) {
    console.log(`Writing messages for day ${day}, count: ${msgs.length}`);
    const filename = `./exports/${day}.json`;
    writeFileSync(
      filename,
      JSON.stringify(msgs, null, 2),
      { encoding: 'utf-8' },
    );
    console.log(`→ Saved ${msgs.length} msgs to ${filename}`);
  }

  console.log('Writing last messages...', lastThreadMsg.size);
  writeFileSync(
    './exports/_last_msgs.json',
    JSON.stringify(lastThreadMsg.values(), null, 2),
    { encoding: 'utf-8' },
  );
}

async function login() {
  const client: Client = tdl.createClient({ apiId, apiHash });
  client.on('error', console.error);
  client.on('update', (update: any) => {
    // console.log('Received update:', update);
  });


  if (botToken) {
    console.log('Logging in as bot');
    await client.loginAsBot(botToken);
  } else {
    console.log('Logging in as user');
    await client.login({
      type: 'user',
      getPhoneNumber: async() => phoneNumber,
      getAuthCode: async() => {
        return await new Promise<string>((resolve) => {
          process.stdout.write('Enter the authentication code: ');
          process.stdin.once('data', (data) => {
            resolve(data.toString().trim());
          });
        });
      },
    });
  }


  // const me = await client.invoke({ _: 'getMe' });
  // console.log('My user:', me);
  console.log('Logged in successfully');
  return client;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
