import { readFileSync, writeFileSync } from 'fs';


const rawData = readFileSync('./tmp/result.json', 'utf-8');
const data: any = JSON.parse(rawData);
const processed = Array.from(data['messages']).map((msg: any) => {
  return {
    from: msg['from'],
    date: msg['date'],
    text: msg['text'],
  }
}).filter(msg => msg.text && msg.text.length > 0 && msg.from && msg.from.length > 0);

const now = new Date();
const yyyy = now.getFullYear();
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const outputFilename = `${yyyy}.${mm}.${dd}.json`;

writeFileSync(`./reports/${outputFilename}`, JSON.stringify(processed, null, 2), 'utf-8');
console.log(`${outputFilename} created with ${processed.length} messages.`);
