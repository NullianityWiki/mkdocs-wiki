# Проект «Нуллианство Вики»

Это репозиторий для разработки и ведения Вики-энциклопедии Нуллианство.

## Быстрый старт

### 1. Предварительные требования

Убедитесь, что на вашем компьютере установлены:

* **Node.js** (версия 18.x или выше)
* **Python** (версия 3.9 или выше) и `pip`

### 2. Установка

Следуйте этим шагам, чтобы настроить проект локально:

1. **Клонируйте репозиторий:**
   ```bash
   git clone https://github.com/YOUR-USERNAME/nullianism-wiki.git
   cd nullianism-wiki
   ```

2. **Установите зависимости Node.js:**
   ```bash
   yarn install
   ```

3. **Настройте виртуальное окружение Python:**
   Это создаст изолированную среду для Python-пакетов и не затронет вашу систему.
   ```bash
   python -m venv venv
   ```

4. **Активируйте виртуальное окружение:**

* **Для macOS / Linux:**
  ```bash
  source venv/bin/activate
  ```
* **Для Windows (PowerShell):**
  ```powershell
  .\venv\Scripts\Activate.ps1
  ```

5. **Установите зависимости Python:**
   ```bash
   pip install -r requirements.txt
   ```

### 3. Запуск проекта

   ```bash
   mkdocs serve
   ```
