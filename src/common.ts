import { Client } from 'tdl';
import { ForumTopic, Message, MessageLink, User,File } from 'src/tdlib-types';
import { EXCLUDE_USERS } from './exclude';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'path';

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

  console.log('Collected messages:', allMessages.length);

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

  if (EXCLUDE_USERS.has(uName) && process.env.SKIP_EXCLUDED_USERS !== 'true') {
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
    synchronous: true
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
