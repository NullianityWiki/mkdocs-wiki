import { promises as fs } from 'fs';
import * as path from 'path';

async function main() {
  await updateChronicle('./docs/lore/history.md');
}


async function updateChronicle(filePath: string) {
  // Папка с отчетами относительно пути файла
  const reportDir = path.resolve(path.dirname(filePath), './docs/lore/reports');

  // Чтение Markdown-файла
  const content = await fs.readFile(filePath, 'utf-8');

  // Регулярное выражение для существующих ссылок
  const regex = /^\s*- \[(\d{4}-\d{2}-\d{2})\]\(reports\/\1\.md\)/gm;
  const existingDates = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    existingDates.add(match[1]);
  }

  // Чтение списка файлов из папки отчетов
  const files = await fs.readdir(reportDir);
  // Фильтрация по формату YYYY-MM-DD.md
  const dateFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));

  // Собираем все даты из файлов
  const allDates = Array.from(new Set(dateFiles.map(f => f.slice(0, 10))));

  // Определяем новые (отсутствующие в existingDates)
  const newDates = allDates.filter(d => !existingDates.has(d));

  // Объединяем и сортируем по убыванию (новые сверху)
  const combined = Array.from(new Set([...existingDates, ...newDates])).sort((a, b) => b.localeCompare(a));

  // Группировка по годам и месяцам
  const grouped: Record<string, Record<string, string[]>> = {};
  combined.forEach(date => {
    const [year, month] = date.split('-');
    grouped[year] = grouped[year] || {};
    grouped[year][month] = grouped[year][month] || [];
    grouped[year][month].push(date);
  });

  // Формирование Markdown-разметки
  let newSection = '';
  Object.keys(grouped)
    .sort((a, b) => b.localeCompare(a))
    .forEach(year => {
      newSection += `\n### ${year}\n\n`;
      Object.keys(grouped[year])
        .sort((a, b) => b.localeCompare(a))
        .forEach(month => {
          newSection += `#### ${month}\n\n`;
          grouped[year][month].forEach(date => {
            newSection += `- [${date}](reports/${date}.md)\n`;
          });
          newSection += '\n';
        });
    });

  // Замена секции "Хроника Событий"
  const updated = content.replace(
    /### 📜 История изменений[\s\S]*$/m,
    `### 📜 История изменений\n\n*Здесь будут размещаться отчеты о жизни сообщества в хронологическом порядке.*${newSection}`
  );

  // Запись обратно в файл
  await fs.writeFile(filePath, updated, 'utf-8');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
