import { Client } from 'tdl';
import { ForumTopic, Message, MessageLink, User } from 'src/tdlib-types';

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
    await enrichMessagesWithUserNames(userNamesCache, allMessages.reverse().map(m => {
      return {
        ...m,
        thread_name: thread.info.name,
      };
    }), client), chatId, client);
}

export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichMessagesWithUserNames(
  userNamesCache: Map<number, string>,
  messages: Message[],
  client: Client,
): Promise<Message[]> {
  return await Promise.all(messages.map(async(msg) => {
    if (msg.sender_id && msg.sender_id._ === 'messageSenderUser') {
      const userId = msg.sender_id.user_id;
      const userName = await getUserName(userNamesCache, client, userId);
      return {
        ...msg,
        sender_name: userName,
      };
    }
    return msg;
  }));
}

async function getUserName(userNamesCache: Map<number, string>, client: Client, userId: number): Promise<string> {
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
