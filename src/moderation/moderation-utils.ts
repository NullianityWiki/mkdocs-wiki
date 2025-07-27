import 'dotenv/config';
import { Client } from 'tdl';
import { ForumTopic, Message, messageSenderUser } from 'src/tdlib-types';
import { exportThread } from '../common';
import OpenAI from 'openai';

export type MessageOut = {
  id: number;
  from: string;
  fromId: number;
  thread: number;
  link: string;
  date: number;
  text: string;
  replyTo: string;
}

export async function collectMessages(
  client: Client,
  chatId: number,
  threads: Map<number, ForumTopic>,
  EXTRACT_LAST_MSGS_PERIOD: number,
  userNamesCache: Map<number, string>,
  EXCLUDED_THREADS: Set<string>,
) {
  const toDate = (Date.now() / 1000) - EXTRACT_LAST_MSGS_PERIOD;

  const allMessages: Message[] = [];
  for (const thread of threads.values()) {
    if (thread.info.is_closed) {
      console.log(`Skipping closed thread ${thread.info.name} (${thread.info.message_thread_id})`);
      continue;
    }
    if (thread.info.name && EXCLUDED_THREADS.has(thread.info.name)) {
      console.log(`Skipping excluded thread ${thread.info.name}`);
      continue;
    }

    if (thread.last_message && thread.last_message.date < toDate) {
      console.log(`Skipping thread ${thread.info.name} with last message date ${new Date(thread.last_message.date *
        1000).toISOString()} older than ${new Date(toDate * 1000).toISOString()}`);
      continue;
    }

    const msgs = (await exportThread(
      client,
      chatId,
      thread,
      toDate,
      null,
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

  return allMessages;
}

export async function prepareMessages(client: Client, allMessages: Message[], EXCLUDED: Set<string>) {
  const allMessagesOut: MessageOut[] = [];

  for (const msg of allMessages) {
    if (!msg || msg.content._ !== 'messageText' || !msg.content.text) {
      continue;
    }

    // @ts-ignore
    const senderName = msg['sender_name'] || 'UnknownSender';

    let exclude = false;
    for (const excluded of EXCLUDED) {
      if (senderName.includes(excluded)) {
        exclude = true;
        break;
      }
    }
    if (exclude) {
      continue;
    }

    // @ts-ignore
    const link = msg['link'] || '';

    // const date = (new Date(msg.date * 1000)).toISOString();
    const textOut = msg.content.text.text;


    let replyMsgText = '';
    if (msg.reply_to && msg.reply_to._ === 'messageReplyToMessage') {
      try {
        const replyMsg = await client.invoke({
          _: 'getMessage',
          chat_id: msg.chat_id,
          message_id: msg.reply_to.message_id,
        }) as Message;

        if (replyMsg && replyMsg.content._ === 'messageText') {
          replyMsgText = replyMsg.content.text.text;
        }
      } catch (e) {
        console.log(`Error getting reply message for ${msg.id}:`, e);
      }
    }


    allMessagesOut.push({
      id: msg.id,
      from: senderName,
      fromId: (msg.sender_id as messageSenderUser)?.user_id ?? -1,
      thread: msg.message_thread_id,
      link,
      date: msg.date,
      text: textOut,
      replyTo: replyMsgText,
    });
  }

  return allMessagesOut;
}

export async function analyze(
  messages: MessageOut[],
  analyzeDate: number,
  PROMPT: string,
  MODEL: string,
  handler: (msg: MessageOut) => string,
  extraMsgs?: MessageOut[],
) {
  if (!messages || messages.length === 0) {
    console.log(`No messages to analyze, skipping...`);
    return '';
  }
  let lowestDate = Math.floor(Date.now() / 1000);
  let highestDate = 0;
  let msgCounter = 0;
  let msgCounterCtx = 0;


  let lastMessagesData = '';
  for (const msg of messages) {
    if (msg.date < analyzeDate) {
      continue;
    }
    lowestDate = Math.min(lowestDate, msg.date);
    highestDate = Math.max(highestDate, msg.date);
    lastMessagesData += handler(msg);
    msgCounter++;
  }

  console.log(`>>> Analyzing messages(${msgCounter} / ${msgCounterCtx + msgCounter}) from ${new Date(lowestDate *
    1000).toISOString()} to ${new Date(
    highestDate *
    1000).toISOString()}`);

  let prompt = PROMPT.replace('$LAST_MESSAGES', lastMessagesData);

  if(extraMsgs) {
    let extra = '';
    for (const msg of extraMsgs) {
      if (msg.date >= analyzeDate) {
        continue;
      }
      extra += handler(msg);
    }

    prompt = prompt.replace('$EXTRA_MESSAGES', extra);
  }

  // console.log(`Prompt:`, prompt);

  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    // apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });
  const result = response.choices[0].message.content ?? '';

  console.log(`result:\n`, result);

  //save last prompt to tmp dir
  const fs = require('fs');
  const path = require('path');
  const tmpDir = path.join(__dirname, '../../tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  fs.writeFileSync(path.join(tmpDir, `moder_last_prompt.txt`), prompt);
  fs.writeFileSync(path.join(tmpDir, `moder_last_result.txt`), result);

  console.log('Results saved!')

  return result;
}
