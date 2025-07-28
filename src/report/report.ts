import { createReadStream, mkdirSync, writeFileSync } from 'fs';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick.js';
import { streamArray } from 'stream-json/streamers/StreamArray.js';
import { encoding_for_model } from 'tiktoken';

const MAX_TOKENS = 150_000;
const MODEL = 'gpt-4o';
const enc = encoding_for_model(MODEL);

type Msg = { from: string; date: string; text: string, text_entities: any[] };
type MsgOut = { from: string; date: string; text: string };

mkdirSync('./reports', { recursive: true });

let chunk: MsgOut[] = [];
let tokenSum = 0;
let part = 1;

function flush() {
  if (chunk.length === 0) {
    return;
  }
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const name = `${yyyy}.${mm}.${dd}-part${part}.json`;
  writeFileSync(`./reports/${name}`, JSON.stringify(chunk, null, 2), 'utf-8');
  console.log(`${name} saved (${chunk.length} msgs, ${tokenSum} tokens).`);
  chunk = [];
  tokenSum = 0;
  part += 1;
}

chain([
  createReadStream('./tmp/result.json', { encoding: 'utf-8' }),
  parser(),
  pick({ filter: 'messages' }),
  streamArray(),
  async({ value }) => {
    const { from, date, text, text_entities } = value as Msg;
    if (!text || !from) {
      return;
    }
    const textOut = text_entities[0]['text'];
    // console.log(`Processing message from ${from} at ${date}: "${textOut}"`);
    const tokens = enc.encode(textOut).length;
    if (tokenSum + tokens > MAX_TOKENS) {
      flush();
    }

    chunk.push({ from, date, text: textOut });
    tokenSum += tokens;
    // console.log('tokenSum:', tokenSum);
  },
])
  .on('data', () => {})
  .on('end', () => {
    console.log('Stream ended, flushing remaining messages...');
    flush();
    enc.free();
    console.log('All messages processed.');
  })
  .on('error', (err: unknown) => console.error('Stream error:', err));
