import { Client } from 'tdl';
import { ForumTopic, Message, MessageLink, User } from 'src/tdlib-types';
import { EXCLUDE_USERS } from './exclude';
import { createHash } from 'node:crypto';

export async function login(
  tdl: any,
  apiId: number,
  apiHash: string,
  botToken?: string,
  phoneNumber?: string,
) {
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
      getPhoneNumber: async() => phoneNumber ?? '0',
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

export async function exportThread(
  client: Client,
  chatId: number,
  thread: ForumTopic,
  lastThreadMsgs: Map<number, Message> | null,
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean>,
): Promise<Message[]> {
  const threadMessageId = thread.info.message_thread_id;

  // need to call before getMessageThreadHistory, otherwise we will get Message not found error
  await client.invoke({
    _: 'getMessage',
    chat_id: chatId,
    message_id: threadMessageId,
  });

  let allMessages: Message[] = [];
  const lastThreadMsg = lastThreadMsgs ? lastThreadMsgs.get(threadMessageId) : null;
  const toDate = Math.floor((lastThreadMsg?.date ?? 0) / (60 * 60 * 24)) * (60 * 60 * 24);
  let fromMessageId = 0;

  console.log(`Exporting thread from chat ${chatId}, thread ${thread.info.name} to date ${(new Date(toDate *
    1000)).toISOString()}`);

  let tryCount = 0;
  while (true) {
    try {
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
      const resultLstMsg = result.messages[result.messages.length - 1];
      fromMessageId = resultLstMsg.id as number;

      if (resultLstMsg.date < toDate) {
        console.log('Reached target date with msg', (new Date(resultLstMsg.date * 1000)).toISOString());
        break;
      } else {
        console.log(`Fetched messages with the last ${(new Date(resultLstMsg.date * 1000)).toISOString()}`);
      }
    } catch (e) {
      if (tryCount > 100) {
        console.error(`Failed to fetch messages for thread ${thread.info.name} after multiple attempts.`);
        throw e;
      }
      console.log(`Error fetching messages for thread ${thread.info.name}:`, e);
      await sleep(1000);
      tryCount++;
    }
  }

  return enrichMessagesWithLinks(
    await enrichMessagesWithUserNames(userNamesCache, userExcludedCache, allMessages.reverse().map(m => {
      return {
        ...m,
        thread_name: thread.info.name,
      };
    }), client), chatId, client, userExcludedCache);
}

export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichMessagesWithUserNames(
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean>,
  messages: Message[],
  client: Client,
): Promise<Message[]> {
  return await Promise.all(messages.map(async(msg) => {
    if (msg.sender_id && msg.sender_id._ === 'messageSenderUser') {
      const userId = msg.sender_id.user_id;
      const userName = await getUserName(userNamesCache, userExcludedCache, client, userId);
      return {
        ...msg,
        sender_name: userName,
      };
    }
    return msg;
  }));
}

async function getUserName(
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean>,
  client: Client,
  userId: number,
): Promise<string> {
  if (userNamesCache.has(userId)) {
    return userNamesCache.get(userId)!;
  }

  const user = await client.invoke({
    _: 'getUser',
    user_id: userId,
  }) as User;
  const uName = user.usernames?.active_usernames ? '@' + user.usernames?.active_usernames[0] : 'unknown';
  let name = user.first_name
    + (user.last_name ? ' ' + user.last_name : '')
    + ('(' + uName + ')');

  if (EXCLUDE_USERS.has(uName)) {
    name = hashText(name);
    userExcludedCache.set(userId, true);
  }

  userNamesCache.set(userId, name);
  return name;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function enrichMessagesWithLinks(
  messages: Message[],
  chatId: number,
  client: Client,
  userExcludedCache: Map<number, boolean>,
): Promise<Message[]> {

  return await Promise.all(messages.map(async(msg) => {
    if (msg.sender_id && msg.sender_id._ === 'messageSenderUser') {
      const userId = msg.sender_id.user_id;
      if (userExcludedCache.has(userId)) {
        return {
          ...msg,
          link: '-',
        };
      }
    }

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
