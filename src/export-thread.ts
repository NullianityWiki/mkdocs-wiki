import 'dotenv/config';
import { Client } from 'tdl';
import { mkdirSync, writeFileSync } from 'fs';
import { Message, User } from 'src/tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH!;
const botToken = process.env.BOT_TOKEN!;
const phoneNumber = process.env.PHONE_NUMBER!;
let chatName = process.env.CHAT_NAME!;
const threadMessageName = process.env.THREAD_NAME!;
let fromMessageId = Number(process.env.FROM_MESSAGE_ID ?? 0);

const userNamesCache = new Map<number, string>();

async function main() {
  const client = await login();

  const chat = await client.invoke({
    _: 'searchPublicChat',
    username: chatName,
  });
  console.log('→ CHAT_ID =', chat.id);
  const chatId = chat.id;

  const messagesPure = await exportThread(client, chatId, threadMessageName);

  const messagesWithUsers = await enrichMessagesWithUserNames(messagesPure, client);

  mkdirSync('./tmp', { recursive: true });
  writeFileSync(`./tmp/thread_${chatId}_${threadMessageName}.json`, JSON.stringify(messagesWithUsers, null, 2));
  console.log('Export completed:', messagesWithUsers.length, 'messages');
}


async function login() {
  const client: Client = tdl.createClient({ apiId, apiHash });
  client.on('error', console.error);
  client.on('update', (update: any) => {
    // console.log('Received update:', update);
  });


  if(botToken) {
    console.log('Logging in as bot');
    await client.loginAsBot(botToken);
  } else {
    console.log('Logging in as user');
    await client.login({
      type: 'user',
      getPhoneNumber: async () => phoneNumber,
      getAuthCode: async () => {
        return await new Promise<string>((resolve) => {
          process.stdout.write('Enter the authentication code: ');
          process.stdin.once('data', (data) => {
            resolve(data.toString().trim());
          });
        });
      }
    });
  }


  // const me = await client.invoke({ _: 'getMe' });
  // console.log('My user:', me);
  console.log('Logged in successfully');
  return client;
}

async function exportThread(
  client: Client,
  chatId: number,
  threadMessageName: string,
): Promise<Message[]> {
  console.log(`Exporting thread from chat ${chatId}, thread ${threadMessageName}`);

  const chatProps = await client.invoke({
    _: 'getChat',
    chat_id: chatId,
  });
  console.log('Chat properties:', chatProps.title);

  const forums = await client.invoke({
    _: 'getForumTopics',
    chat_id: chatId,
    query: threadMessageName,
    limit: 100,
  });
  // console.log('forums', Array.from(forums.topics).map((f: any) => f));
  if(forums.topics.length !== 1) {
    throw new Error(`Expected 1 forum topic, got ${forums.topics.length}`);
  }
  const threadMessageId = forums.topics[0].info.message_thread_id;
  console.log('Thread message ID:', threadMessageId);

  // need to call before getMessageThreadHistory, otherwise we will get Message not found error
  await client.invoke({
    _: 'getMessage',
    chat_id: chatId,
    message_id: threadMessageId,
  });
  const threadMsg = await client.invoke({
    _: 'getMessageProperties',
    chat_id: chatId,
    message_id: threadMessageId,
  });
  // console.log('Thread message:', threadMsg);
  if(!threadMsg?.can_get_message_thread) {
    console.log('Thread message:', threadMsg);
    throw new Error(`Cannot get message thread for message ID ${threadMessageId}`);
  }

  let allMessages: Message[] = [];

  while (true) {
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
  }

  return allMessages.reverse();
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


main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
