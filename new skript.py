import os
import shutil
import re
import subprocess

# Пути
base_dir = os.path.abspath(os.path.dirname(__file__))  # папка скрипта
reports_dir = os.path.join(base_dir, reports)
docs_reports_dir = os.path.join(base_dir, docs, lore, reports)
history_path = os.path.join(base_dir, docs, lore, history.md)

# 1. Обновляем репозиторий — выполняем git pull
print(Обновляем репозиторий git pull...)
result = subprocess.run([git, pull], cwd=base_dir, capture_output=True, text=True)
print(result.stdout)
if result.returncode != 0
    print(Ошибка при git pull)
    print(result.stderr)
    exit(1)

# 2. Создаём папку для копирования, если нет
os.makedirs(docs_reports_dir, exist_ok=True)

# 3. Список уже скопированных файлов
existing_files = set(os.listdir(docs_reports_dir))

# 4. Копируем новые md-файлы из reports
new_files = []
for filename in os.listdir(reports_dir)
    if filename.endswith(.md) and filename not in existing_files
        shutil.copy2(os.path.join(reports_dir, filename), os.path.join(docs_reports_dir, filename))
        new_files.append(filename)

if new_files
    print(fСкопированы новые файлы {new_files})
else
    print(Новых файлов нет.)

# 5. Собираем все отчёты, сортируем
all_reports = sorted(
    [f for f in os.listdir(docs_reports_dir) if re.match(rd{4}-d{2}-d{2}.md, f)]
)

# 6. Формируем список ссылок
report_lines = [f- [{f[-3]}](reports{f}) for f in all_reports]

# 7. Читаем history.md
with open(history_path, r, encoding=utf-8) as f
    content = f.read()

# 8. Обновляем секцию с отчётами с помощью регулярки
new_content = re.sub(
    r(## Хроника Событий.n---nn)(- [.](reports.)n)(- [.](reports.)n)(---n),
    r1 + n.join(report_lines) + n,
    content,
    flags=re.DOTALL
)

# 9. Записываем обновленный history.md
with open(history_path, w, encoding=utf-8) as f
    f.write(new_content)

print(history.md обновлен)
