import 'dotenv/config';
import { getTdjson } from 'prebuilt-tdlib';
import { getAllChatMembers, getPublicChatIdByChatName, getUserName, login } from '@/utils/common.js';
import { Chat, chatEvent, ChatEvents, chatMember, chatTypeSupergroup, messageSenderUser } from 'src/utils/tdlib-types';
import { Client } from 'tdl';
import * as fs from 'node:fs';
import { mkdirSync } from 'fs';

const tdl = require('tdl');
tdl.configure({ tdjson: getTdjson() });

const { API_ID, API_HASH, BOT_TOKEN, PHONE_NUMBER, CHAT_NAME } = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = CHAT_NAME!;

const DRY_RUN = process.env.DRY_RUN === 'true';
const EXCLUDED_USERS = new Set<string>([]);
const LAST_MSGS_PERIOD = 60 * 60 * 24;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';

export type ModResult = {
  id: string,
  thread: string,
  link: string,
  sender: string,
  reason: string,
  recommendation: string,
  correctness: string,
}

const userNamesCache = new Map<number, string>();


async function main() {
  const client = await login(
    tdl,
    apiId,
    apiHash,
    undefined,
    phoneNumber,
  );

  const chatId = await getPublicChatIdByChatName(client, chatName);

  const chat = await client.invoke({
    _: 'getChat',
    chat_id: chatId,
  }) as Chat;

  // console.log(`Chat "${chat.title}" found ${JSON.stringify(chat, null, 2)}`);


  const allUsers: chatMember[] = await getAllChatMembers(client, (chat.type as chatTypeSupergroup).supergroup_id);


  // for (const user of allUsers) {
  //   const userId = (user.member_id as messageSenderUser).user_id;
  //   const allEvents = await allUserEvents(client, chatId, userId);
  //   let oldestEventDate = 0;
  //   for (const e of allEvents) {
  //     if (e.date < oldestEventDate || oldestEventDate === 0) {
  //       oldestEventDate = e.date;
  //     }
  //   }
  //   console.log(`User ${await getUserName(userNamesCache, null, client, userId)} joined at ${new Date(oldestEventDate * 1000).toISOString()}`);
  //
  //   break;
  // }

  await saveUsers(client, allUsers);

  console.log(`Done!`);
}

async function allUserEvents(client: Client, chatId: number, userId: number) {
  let lastEventId = 0;
  const allEvents: chatEvent[] = [];
  while (true) {
    const res = (await client.invoke({
      _: 'getChatEventLog',
      chat_id: chatId,
      query: '',
      from_event_id: lastEventId,
      limit: 100,
      // filters: {
      //   '@type': 'chatEventLogFilters',
      //   member_joins: true,
      // },
      user_ids: [userId],
    }) as ChatEvents);

    console.log(JSON.stringify(res.events.map(e => {
      return {
        id: e.id,
        date: new Date(e.date * 1000).toISOString(),
      }
    }), null, 2));

    if (res.events.length === 0) {
      console.log(`No more events found, exiting...`);
      break;
    }

    console.log(`Found ${res.events.length} events from ${lastEventId} to ${res.events[res.events.length - 1].id}`);

    allEvents.push(...res.events);
    lastEventId = Number(res.events[res.events.length - 1].id);
  }

  return allEvents;
}

async function saveUsers(client: Client, allUsers: chatMember[]) {
  const header = 'user_id,name,joined_date\n';
  const lines: string[] = [];

  for (const u of allUsers) {
    const userId = (u.member_id as messageSenderUser).user_id;
    const name = await getUserName(userNamesCache, null, client, userId);
    const joined = new Date(u.joined_chat_date * 1000).toISOString();

    const line = `${userId},${escapeCsv(name)},${joined}`;
    lines.push(line);

    console.log(`User ${name} joined at ${new Date(u.joined_chat_date * 1000).toISOString()}`);
  }

  const content = header + lines.join('\n');
  mkdirSync('./tmp', { recursive: true });
  fs.writeFileSync('./tmp/users.csv', content, 'utf-8');
  console.log(`Saved ${lines.length} users to users.csv`);
}

function escapeCsv(value: string): string {
  return value.replace(/,/g, '');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
