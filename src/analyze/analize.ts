import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import 'dotenv/config';

const EXPORTS_DIR = './exports';
const REPORTS_DIR = './docs/lore/reports';
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';


const PROMPT = `
Проанализируй экспорт переписки из Telegram (текст ниже):
Текст представлен в формате "ссылка,тред,отправитель:сообщение" за дату $EXPORT_DATE.
"""$CONTENT"""

Создай общий анализ переписки сообщества Нуллиантсва. 
Упор на основную тему сообщества - развитие, познание, науку, составление правил религии и тому подобное.
Игнорируй незначимые сообщения - приветсвия, пожелания, обсуждение банов, обсуждение модерации и прочее.
Выдели основные темы с ссылкой на ключевое сообщение в формате [отправитель](https://t.me/...).

Представь результат в Markdown.
В ответе не должно быть никакой лишней информации, только результат для сохранения в файл репорта.
Заголовок (#) репорта должен быть в формате "Анализ чата «Нуллианство» от ДЕНЬ МЕСЯЦ ГОД г."
Далее подзаголовок (##) обсуждаемая тема.
Внутри подзаголовок (###) с деталями.
В конце итоги дня с подзаголовоком (##) "Итоги".
`;

async function main() {
  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  await mkdir(REPORTS_DIR, { recursive: true });

  const filesExports = await readdir(EXPORTS_DIR);
  const filesReports = await readdir(REPORTS_DIR);
  const createdReports = new Set<string>();

  for (const file of filesReports.filter(f => f.endsWith('.md'))) {
    console.log(`Report already exists: ${file}`);
    createdReports.add(path.basename(file, '.md'));
  }

  // do not create reports for not full day
  createdReports.add(new Date(Date.now()).toISOString().slice(0, 10));

  for (const file of filesExports.filter(f => f.endsWith('.json'))) {
    const date = path.basename(file, '.json');
    if (file === '_last_msgs.json' || createdReports.has(date)) {
      console.log(`Skipping: ${file}`);
      continue;
    }
    const data = await readFile(path.join(EXPORTS_DIR, file), 'utf-8');

    const parsedData = JSON.parse(data) as {
      from: string;
      thread: string;
      link: string;
      date: string;
      text: string
    }[];

    let input = '';

    for(const msg of parsedData) {
      input += `${msg.link},${msg.thread},${msg.from}:${msg.text}\n`;
    }

    const prompt = PROMPT.replace('$EXPORT_DATE', date).replace('$CONTENT', input);

    console.log(`Generating report for ${date}...`);
    const response = await openai.chat.completions.create({
      model: MODEL,

      messages: [{ role: 'user', content: prompt }],
    });
    const md = response.choices[0].message.content ?? '';
    await writeFile(path.join(REPORTS_DIR, `${date}.md`), md);
    console.log(`Report for ${date} saved.`);
  }

}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

// // src/index.ts
// import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
// import path from 'path';
// import { VertexAI } from '@google-cloud/vertexai';
//
// const EXPORTS_DIR = './exports';
// const REPORTS_DIR = './reports';
// const MODEL_ID = 'models/gemini-2.5-pro';
//
// async function main() {
//
//   await mkdir(REPORTS_DIR, { recursive: true });
//
//
//   const vertexai = new VertexAI({
//     project: process.env.GOOGLE_CLOUD_PROJECT ?? '',
//     location: process.env.GOOGLE_CLOUD_REGION || 'us-central1',
//   });
//
//   // Получаем объект модели
//   const model = vertexai.getGenerativeModel(MODEL_ID);
//
//   const files = await readdir(EXPORTS_DIR);
//   for (const file of files.filter(f => f.endsWith('.json'))) {
//     const date = path.basename(file, '.json');
//     const content = await readFile(path.join(EXPORTS_DIR, file), 'utf-8');
//
//     const prompt = `
// Проанализируй экспорт переписки из Telegram (текст ниже):
// """${content}"""
//
// Вычлени основные треды и для каждого создай краткую сводку ключевых тем.
// Не включай треды без значимой активности за день.
// Включай ссылки на сообщения в формате [сообщение #ID](https://t.me/...).
// Представь результат в Markdown.
// В ответе не должно быть никакой лишней информации, только результат для сохранения в файл репорта.
//     `;
//
//     // Генерируем ответ от Gemini
//     const response = await model.generateContent({
//       prompt,
//       temperature: 0.7,
//       maxOutputTokens: 20000,
//     }); // :contentReference[oaicite:0]{index=0}
//
//     const md = response.text.trim();
//     await writeFile(path.join(REPORTS_DIR, `${date}.md`), md, 'utf-8');
//     console.log(`Отчёт за ${date} сохранён.`);
//   }
// }
//
// main().catch(err => {
//   console.error('Ошибка:', err);
//   process.exit(1);
// });


