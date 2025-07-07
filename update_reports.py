import os
import shutil
import re

reports_dir = "reports"
docs_reports_dir = os.path.join("docs", "lore", "reports")
history_path = os.path.join("docs", "lore", "history.md")

# Создаём целевую папку, если её нет
os.makedirs(docs_reports_dir, exist_ok=True)

# Получаем список уже скопированных файлов
existing_files = set(os.listdir(docs_reports_dir))

# Копируем новые файлы
new_files = []
for filename in os.listdir(reports_dir):
    if filename.endswith(".md") and filename not in existing_files:
        shutil.copy2(os.path.join(reports_dir, filename), os.path.join(docs_reports_dir, filename))
        new_files.append(filename)

if new_files:
    print(f"Скопированы новые файлы: {new_files}")
else:
    print("Новых файлов нет.")

# Собираем все отчёты (включая старые и новые)
all_reports = sorted(
    [f for f in os.listdir(docs_reports_dir) if re.match(r"\d{4}-\d{2}-\d{2}\.md", f)],
    key=lambda x: x
)

# Генерируем список ссылок
report_lines = [f"- [{f[:-3]}](reports/{f})" for f in all_reports]

# Читаем оригинальный history.md
with open(history_path, "r", encoding="utf-8") as f:
    content = f.read()

# Удаляем старый список отчётов и лишние '---' в конце
new_content = re.sub(
    r"(## Хроника Событий.*?\n---\n\n)(- \[.*?\]\(reports/.*?\)\n)*(- \[.*?\]\(reports/.*?\)\n)?(---\n*)?",
    r"\1" + "\n".join(report_lines) + "\n",
    content,
    flags=re.DOTALL
)

# Перезаписываем history.md
with open(history_path, "w", encoding="utf-8") as f:
    f.write(new_content)

print("history.md обновлен")
