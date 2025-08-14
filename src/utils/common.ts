import { Client } from 'tdl';
import {
  Chat,
  chatMember,
  ChatMembers,
  File,
  FormattedText,
  ForumTopic,
  Message,
  MessageLink,
  Messages,
  User,
} from 'src/utils/tdlib-types';
import { EXCLUDE_USERS } from './exclude';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'path';
import axios from 'axios';

function getCustomTdDirectory(botToken?: string, phoneNumber?: string): string {
  const baseDir = path.resolve('tdlib-sessions');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir);
  }

  const safeName = botToken
    ? `bot_${botToken.replace(/[^a-zA-Z0-9]/g, '_')}`
    : `user_${(phoneNumber ?? 'unknown').replace(/[^0-9]/g, '')}`;

  const fullPath = path.join(baseDir, safeName);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath);
  }
  return fullPath;
}

export async function login(
  tdl: any,
  apiId: number,
  apiHash: string,
  botToken?: string,
  phoneNumber?: string,
) {
  // const cfg: TDLibConfiguration = {
  //   verbosityLevel: 3
  // };
  // tdl.configure(cfg);
  const dir = getCustomTdDirectory(botToken, phoneNumber);
  const client: Client = tdl.createClient({ apiId, apiHash, databaseDirectory: dir, filesDirectory: dir });
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
  from: number | null,
  to: number | null,
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean> | null,
  roundDate = true,
): Promise<Message[]> {
  const threadMessageId = thread.info.message_thread_id;

  // need to call before getMessageThreadHistory, otherwise we will get Message not found error
  await client.invoke({
    _: 'getMessage',
    chat_id: chatId,
    message_id: threadMessageId,
  });

  let allMessages: Message[] = [];
  let toDate;
  if (roundDate) {
    toDate = Math.floor((from ?? 0) / (60 * 60 * 24)) * (60 * 60 * 24);
  } else {
    toDate = from ?? 0;
  }
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
        console.log(`Fetched ${result.messages.length} messages with the last ${(new Date(resultLstMsg.date *
          1000)).toISOString()}`);
      }

      if (result.messages.length < 100) {
        break;
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
  const msgs = allMessages.reverse().map(m => {
    return {
      ...m,
      thread_name: thread.info.name,
    };
  }).filter(msg => {
    return msg.date > toDate && (!to || msg.date < to);
  });

  // msgs.forEach(msg => {
  //   console.log(`Message ${msg.id} threadMessageId:${threadMessageId} from ${(new Date(msg.date * 1000)).toISOString()}`);
  // })

  console.log(`Collected messages: ${msgs.length}/${allMessages.length}`);

  return enrichMessagesWithLinks(
    await enrichMessagesWithUserNames(userNamesCache, userExcludedCache, msgs, client),
    chatId, client, userExcludedCache,
  );
}

export async function exportChat(
  client: Client,
  chatId: number,
  from: number | null,
  to: number | null,
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean>,
  roundDate = true,
): Promise<Message[]> {
  let allMessages: Message[] = [];

  let toDate;
  if (roundDate) {
    toDate = Math.floor((from ?? 0) / (60 * 60 * 24)) * (60 * 60 * 24);
  } else {
    toDate = from ?? 0;
  }


  let fromMessageId = 0;

  console.log(`Exporting chat ${chatId} to date ${(new Date(toDate * 1000)).toISOString()}`);

  let tryCount = 0;
  while (true) {
    try {
      const result = await client.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: 100,
        only_local: false,
      }) as Messages;

      const msgs = (result.messages ?? []) as Message[];

      if (msgs.length === 0) {
        break;
      }
      allMessages.push(...msgs);
      const resultLstMsg = msgs[msgs.length - 1];
      fromMessageId = resultLstMsg.id as number;

      if (resultLstMsg.date < toDate) {
        console.log('Reached target date with msg', (new Date(resultLstMsg.date * 1000)).toISOString());
        break;
      } else {
        console.log(`Fetched messages with the last ${(new Date(resultLstMsg.date * 1000)).toISOString()}`);
      }
    } catch (e) {
      if (tryCount > 100) {
        console.error(`Failed to fetch messages for chat ${chatId} after multiple attempts.`);
        throw e;
      }
      console.log(`Error fetching messages for chat ${chatId}:`, e);
      await sleep(1000);
      tryCount++;
    }
  }

  const msgs = allMessages.reverse().filter(msg => {
    return msg.date > toDate && (!to || msg.date < to);
  });

  return await enrichMessagesWithUserNames(userNamesCache, userExcludedCache, msgs, client);
}

export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichMessagesWithUserNames(
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean> | null,
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

export async function getUserName(
  userNamesCache: Map<number, string>,
  userExcludedCache: Map<number, boolean> | null,
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

  if (userExcludedCache && EXCLUDE_USERS.has(uName) && process.env.SKIP_EXCLUDED_USERS !== 'true') {
    name = hashText(name);
    userExcludedCache.set(userId, true);
  }

  userNamesCache.set(userId, name);
  return name;
}

function hashText(text: string, start = 4, end = 4): string {
  const str = createHash('sha256').update(text).digest('hex');
  if (str.length <= start + end + 3) {
    return str;
  }
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

async function enrichMessagesWithLinks(
  messages: Message[],
  chatId: number,
  client: Client,
  userExcludedCache: Map<number, boolean> | null,
): Promise<Message[]> {

  return await Promise.all(messages.map(async(msg) => {
    if (msg.sender_id && msg.sender_id._ === 'messageSenderUser') {
      const userId = msg.sender_id.user_id;
      if (userExcludedCache && userExcludedCache.has(userId)) {
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

export async function downloadFile(
  client: Client,
  fileId: number,
): Promise<string> {
  return (await client.invoke({
    _: 'downloadFile',
    file_id: fileId,
    priority: 1,
    offset: 0,
    limit: 0,
    synchronous: true,
  }) as File).local.path;
}

// async function downloadFile(
//   client: Client,
//   fileId: number,
// ): Promise<string> {
//   return new Promise((resolve, reject) => {
//     const onUpdate = (update: any) => {
//       if (update._ === 'updateFile') {
//         console.log('update.file', update.file);
//         if (
//           update.file.id === fileId &&
//           update.file.local.is_downloading_completed) {
//           client.removeListener('update', onUpdate);
//           resolve(update.file.local.path);
//         }
//       }
//     };
//     client.on('update', onUpdate);
//
//     client.invoke({
//       _: 'downloadFile',
//       file_id: fileId,
//       priority: 1,
//       offset: 0,
//       limit: 0,
//     }).catch((err: any) => {
//       client.removeListener('update', onUpdate);
//       reject(err);
//     });
//   });
// }

export async function savePhotoFromMessage(
  client: Client,
  message: Message,
  outputDir: string,
): Promise<void> {
  if (message.content._ !== 'messagePhoto') {
    return;
  }

  const sizes = message.content.photo.sizes;
  const largest = sizes.reduce((prev, curr) =>
    curr.photo.size > prev.photo.size ? curr : prev,
  );

  // @ts-ignore
  const sender = message['sender_name'];

  const fileId = largest.photo.id;
  console.log(`Downloading file with ID ${fileId} from ${sender}`);
  const localPath = (await downloadFile(client, fileId));


  const fileName = getUniqueFileName(outputDir, sender);

  const targetPath = path.join(outputDir, fileName);
  fs.copyFileSync(localPath, targetPath);
  console.log(`Image saved to ${targetPath}`);
}

function getUniqueFileName(
  directory: string,
  baseName: string,
  extension: string = '.jpg',
): string {
  const safeBase = baseName.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'unknown';
  let counter = 1;
  let fileName = `${safeBase}_${counter}${extension}`;
  while (fs.existsSync(path.join(directory, fileName))) {
    fileName = `${safeBase}_${counter}${extension}`;
    counter++;
  }
  return fileName;
}

export async function sendMessage(
  client: Client,
  chatId: number,
  threadId: number,
  replyTo: number | null,
  text: string,
) {

  if (replyTo !== null) {
    try {
      await client.invoke({
        _: 'getMessage',
        chat_id: chatId,
        message_id: replyTo,
      }) as Message;
    } catch (e) {
      console.log(`Failed to fetch reply message with ID ${replyTo} in chat ${chatId}:`, e);
    }
  }

  // refresh chat
  await client.invoke({ _: 'getChat', chat_id: chatId });

  const chunks = splitTextIntoChunks(text, 4000);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    let parsed = undefined;
    try {
      parsed = await client.invoke({
        _: 'parseTextEntities',
        text: chunk,
        parse_mode: {
          _: 'textParseModeMarkdown',
        },
      }) as FormattedText;
    } catch (e) {
      console.log('not parsed');
    }

    const res = await client.invoke({
      _: 'sendMessage',
      chat_id: chatId,
      message_thread_id: threadId === 0 ? undefined : threadId,
      input_message_content: {
        '@type': 'inputMessageText',
        text: parsed ? parsed : {
          '@type': 'formattedText',
          text: chunk,
        },
      },
      reply_to: replyTo !== null ? {
        '@type': 'inputMessageReplyToMessage',
        message_id: replyTo,
      } : undefined,
    }) as Message;

    console.log(`Chunk ${i + 1}/${chunks.length} sent to thread ${threadId}` /*JSON.stringify(res, null, 2)*/);

    // wait a bit for make sure not collect too much in pending
    await sleep(1000);

    // let msgId = res.id;
    //
    //   let link = '';
    //   while (true) {
    //     if(msgId === 0) {
    //       console.log(`Waiting for message ID`);
    //       await sleep(1000);
    //       continue;
    //     }
    //     try {
    //       link = await getMsgLink(client, chatId, msgId)
    //     } catch (e) {
    //       console.log(`Failed to get link for message ${res.id}:`);
    //       await sleep(1000);
    //       continue;
    //     }
    //     break;
    //   }
    //   console.log('sent', link)
  }
}

export async function sendMessageBOT(
  botToken: string,
  chatId: number,
  threadId: number,
  replyTo: number | null,
  text: string,
) {
  const chunks = splitTextIntoChunks(text, 4000);

  for (let i = 0; i < chunks.length; i++) {
    const res = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      message_thread_id: threadId,
      // reply_parameters: replyTo !== null ? {
      //   message_id: replyTo,
      // } : undefined,
      // reply_to_message_id: replyTo ?? undefined,
      text: chunks[i],
    });

    if (res.status !== 200 || res.data?.ok === false) {
      throw new Error(`Failed to send part ${i + 1}/${chunks.length}: ${res.data?.description ?? res.statusText}`);
    } else {
      console.log(`Part ${i + 1}/${chunks.length} sent to thread ${threadId} in chat ${chatId}`);
    }
  }
}

function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize;
  }
  return chunks;
}

export function extractJsonBlock(text: string): any {
  if (!text || text.trim() === '') {
    return [];
  }
  const cleaned = text
    .replace(/^.*?```json\s*/s, '')  // убираем всё до блока
    .replace(/```[\s\S]*$/, '')     // убираем всё после
    .trim();

  // console.log(`Extracted JSON: ${cleaned}`);

  return JSON.parse(cleaned);
}


export async function getPublicChatIdByChatName(client: Client, _chatName: string) {
  console.log(`Searching for chat with name "${_chatName}"...`);
  const chat = await client.invoke({
    _: 'searchPublicChat',
    username: _chatName,
  });
  console.log('→ CHAT_ID =', chat.id);
  return chat.id;
}

export async function getPrivateChatIdByChatName(client: Client, _chatName: string) {
  console.log(`Searching for chat with name "${_chatName}"...`);

  const chats = await client.invoke({
    _: 'getChats',
    chat_list: { _: 'chatListMain' },
    limit: 100,
  });

  for (const chatId of chats.chat_ids) {
    const chat = await client.invoke({
      _: 'getChat',
      chat_id: chatId,
    }) as Chat;

    if (chat.title === _chatName) {
      console.log('Found chat:', chat.title, chatId);
      return chatId;
    }
  }

}

export async function getAllChatMembers(client: Client, supergroupId: number) {
  let usersOffset = 0;
  const allUsers: chatMember[] = [];
  while (true) {
    const users = (await client.invoke({
      _: 'getSupergroupMembers',
      supergroup_id: supergroupId,
      filter: {
        _: 'supergroupMembersFilterRecent',
      },
      offset: usersOffset,
      limit: 200,
      user_ids: [],
    }) as ChatMembers);

    if (users.members.length === 0) {
      console.log(`No more users found, exiting...`);
      break;
    }

    console.log(`Found ${users.members.length} users from offset ${usersOffset}`);

    usersOffset += 200;
    allUsers.push(...users.members);
  }

  return allUsers;
}

export async function getActiveThreads(client: Client, chatId: number) {
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
  // allTopics.forEach((thread, threadId) => {
  //   console.log(`Thread: ${thread.info.name}, ID: ${threadId} ${thread.info.is_closed ? '(closed)' : ''} ${thread.info.is_hidden ? '(hidden)' : ''}`);
  // });
  return allTopics;
}

export async function deleteMessages(
  client: Client,
  chatId: number,
  msgs: number[],
) {
  await client.invoke({
    _: 'deleteMessages',
    chat_id: chatId,
    message_ids: msgs,
    revoke: true,
  });
  console.log(`Deleted ${msgs.length} messages from chat ${chatId}`);
}

export async function getPrompt(fileName: string, dir = 'prompts') {
  const folderPath = path.resolve(dir);
  const files = fs.readdirSync(folderPath);
  const file = files.find(f => f === fileName);

  if (!file) {
    throw new Error(`Prompt "${fileName}" does not found ${folderPath}`);
  }
  const content = fs.readFileSync(path.join(folderPath, file), 'utf-8');
  return content.trim();
}
