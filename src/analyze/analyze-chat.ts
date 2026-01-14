import 'dotenv/config';
import {Message, User} from 'src/utils/tdlib-types';
import {getTdjson} from 'prebuilt-tdlib';
import {
    exportChat,
    extractJsonBlock,
    getPrivateChatIdByChatName,
    getPrompt,
    login,
    sendMessage,
    sleep,
} from '@/utils/common.js';
import {analyze, MessageOut, prepareMessages} from '@/moderation/moderation-utils.js';
import * as tdl from 'tdl';
import {Client} from 'tdl';
import {CommitRecord, loadGithubRecords} from '@/analyze/github-utils.js';

tdl.configure({tdjson: getTdjson()});

const {
    API_ID,
    API_HASH,
    BOT_TOKEN,
    PHONE_NUMBER,
    ANALYZE_CHAT_NAME,
    GITHUB_TOKEN,
    GITHUB_REPOS,
} = process.env;
const apiId = Number(API_ID), apiHash = API_HASH!, botToken = BOT_TOKEN!;
const phoneNumber = PHONE_NUMBER!, chatName = ANALYZE_CHAT_NAME!;

const WINDOW = Number(process.env.WINDOW ?? '15');
const MIN_SCORE = Number(process.env.MIN_SCORE ?? '9');
const WINDOW_GITHUB = Number(process.env.WINDOW_GITHUB ?? '15');
const DRY_RUN = process.env.DRY_RUN === 'true';
const EXCLUDED_USERS = new Set<string>([]);
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-pro-preview';
const LOAD_AGAIN_COUNT = 2;

type Result = {
    name: string,
    report: number,
    score: number,
    text: string,
    code: string,
}

const userNamesCache = new Map<number, string>();


async function main() {
    const clientUSER = await login(
        tdl,
        apiId,
        apiHash,
        undefined,
        phoneNumber,
    );
    const clientBOT = await login(
        tdl,
        apiId,
        apiHash,
        botToken,
        undefined,
    );
    const chatId = await getPrivateChatIdByChatName(clientUSER, chatName);

    if (!chatId) {
        throw new Error('chat not found');
    }

    const context = await getPrompt('context_' + chatId + '.txt');
    let prompt = (await getPrompt('prompt_' + chatId + '.txt')).replace('$PROJECT_CONTEXT', context);

    const botInfo = await clientBOT.invoke({_: 'getMe'}) as User;
    EXCLUDED_USERS.add(botInfo.usernames?.active_usernames[0] ?? '');

    const DAY = 60 * 60 * 24;
    const startDate = Math.floor(Date.now() / 1000) - (DAY * WINDOW);
    const finishDate = Math.floor(Date.now() / 1000);

    let messages: Message[] = [];
    //i have no clues why the first loading does not work and need to load again
    for (let i = 0; i < LOAD_AGAIN_COUNT; i++) {
        messages = await exportChat(clientUSER, chatId, startDate, finishDate, userNamesCache, new Map(), false);

        // console.log('data', new Date(messages[messages.length].date * 1000));
        // if (messages.length != 0 && messages[messages.length].date >= (finishDate - (60 * 60 * 24))) {
        //     break;
        // }

        await sleep(10000);
        console.log(`========================LOAD AGAIN==============================`);
    }

    console.log('Messages:', messages.length);

    const allMessagesOut: MessageOut[] = await prepareMessages(clientUSER, messages, EXCLUDED_USERS);

    console.log('Messages out:', allMessagesOut.length);

    if (GITHUB_REPOS && GITHUB_TOKEN) {
        const ghRecords = (await loadGithubRecords(
            GITHUB_REPOS!,
            WINDOW_GITHUB,
            GITHUB_TOKEN!,
        )).map((record: CommitRecord) => {
            return `
{
author: ${record.commit.author},        
date: ${record.commit.date},
head: ${record.commit.message},
files: ${JSON.stringify(record.files, null, 2)},
}        
        `;
        });

        prompt = prompt.replace('$COMMITS', JSON.stringify(ghRecords, null, 2));
    }

    const toAnalyzeGap = (new Date()).getDay() === 1 ? 3 * DAY : DAY;

    const result = await analyze(
        allMessagesOut,
        Math.floor(Date.now() / 1000) - toAnalyzeGap,
        prompt,
        MODEL,
        msg => `
{
date: ${(new Date(msg.date * 1000)).toISOString()},
link: ${msg.link},
from: ${msg.from},
text: ${msg.text},
}      
      `,
        allMessagesOut,
        undefined,
    );

    console.log('result:', result);

    const jsonResult = extractJsonBlock(result) as Result[];

    await send(jsonResult, clientBOT, chatId);


    await sleep(1000);
    console.log(`Done!`);
}

async function send(jsonResult: Result[], client: Client, chatId: number) {

    for (const r of jsonResult) {

        let text = `
**${r.name}**
R:${r.report} / S:${r.score}
\`\`\`    
${r.text}
\`\`\`  
      `;

        if (r.code && r.code.length > 0) {
            text += `
\`\`\`    
${r.code}
\`\`\`  
      
        `;
        }

        if (r.report < 8) {
            text += `
---
⚠️__Не хватает данных!__⚠️
        `;
        }

        console.log(text);

        if (!DRY_RUN && r.score >= MIN_SCORE) {
            await sendMessage(client, chatId, 0, null, text);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
