# AgentPrism — куда уходят деньги ИИ-агента для кода

AgentPrism читает локальные журналы Claude Code и показывает, за что платит агент: сколько стоит каждый шаг, какую часть стоимости составляет повторная отправка истории, какие блоки контекста тащатся после последнего использования и когда сжатие контекста действительно окупается. Всё считается локально, журналы не покидают компьютер, в базе нет текстов сообщений и содержимого файлов.

_EN: AgentPrism reads local Claude Code logs and shows where an AI coding agent's money goes: cost per call, the share spent re-sending history, context carried after its last use, and when compaction pays off. Local-first; no message text is stored. The docs in `docs/` and the code comments are in English._

![Экономика контекста одной сессии Claude Code из 3009 вызовов: промпт по вызовам, разбитый на нужное всегда, используемое, прежние рассуждения и то, что тащится после последнего использования](docs/assets/context-report.jpg)

## Что нашли на реальных журналах

Данные: 12 дней работы нескольких агентов на одной машине, срез до 04.11.2026. Деньги — эквивалент по прайсу API, не счёт. Метод и оговорки — в [docs/FINDINGS.md](docs/FINDINGS.md) и [docs/RESEARCH.md](docs/RESEARCH.md).

- Около 85 % стоимости основной цепочки — повторная отправка прошлого (чтение кэша ≈65 %, запись в кэш ≈20 %).
- Около 21 % стоимости промпта приходится на блоки после их последнего использования — это верхняя оценка по либеральному правилу, точность правила не измерена.
- Простое правило сжатия (по аналогии с задачей об аренде лыж) в симуляции держалось в пределах 4–16 % от оптимума, посчитанного по всей сессии, если цена «забывания» задана верно; при неверной цене проигрыш до 2,5 раза.

## Схема

```
журналы Claude Code (~/.claude/projects, JSONL)
        │  adapter-claude-code: разбор, цены по TTL кэша
        ▼
   packages/core ── детекторы потерь (11 штук) · реестр цен · реестр контекста · compare / switchback
        │                          │
        ▼                          ▼
   SQLite (токены, стоимость,     packages/cli: отчёты в терминале, --json, --html
   имена инструментов, хеши)      packages/sdk: трассы своих LLM-вызовов (adapter-traces)
```

Пакеты в `packages/`: `core`, `adapter-claude-code`, `adapter-traces`, `sdk`, `cli`. Устройство — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), форматы — [LOG_FORMAT](docs/LOG_FORMAT.md), [TRACE_FORMAT](docs/TRACE_FORMAT.md), [CORRECTIONS_FORMAT](docs/CORRECTIONS_FORMAT.md).

## Запуск одной командой

Нужен Node.js 22.13 или новее. Из клона репозитория, на встроенных тестовых журналах:

```bash
npm install && npm run build && node packages/cli/dist/index.js --root packages/adapter-claude-code/test/fixtures/projects --db .agentprism-try.db
```

На своих журналах (читаются `~/.claude/projects`):

```bash
npm link -w packages/cli    # команда agentprism в PATH
agentprism                  # расходы, дорогие сессии, главные находки
agentprism context          # экономика контекста последней сессии, когда сжимать
agentprism context --html r.html   # самодостаточная страница без текстов, путей и заголовков
agentprism findings         # детекторы потерь: доказательства, оценка стоимости, что исправить
agentprism compare          # стало ли дешевле после вашей правки: интервал и честный вердикт
```

Ко всем командам можно добавить `--json`; `--plugin ./my-plugin.mjs` подключает свои детекторы и адаптеры.

## Тесты

```bash
npm test
```

Результат запуска 18.11.2026 в чистой копии (Vitest 5, Node.js): **61 тест в 11 файлах, все прошли**. Там же прошли `npm run typecheck` и `npm run lint`. CI (`.github/workflows/ci.yml`) гоняет проверки на Ubuntu, Windows и macOS, Node 22 и 24; на этой публикации CI ещё не запускался.

## Ограничения

- Стоимость — оценка по прайсу API на 06.10.2026, а не счёт: на подписке цифры показывают относительный вес.
- «После последнего использования» — верхняя оценка: использование «по смыслу», без общего идентификатора, не видно.
- На журналах одного человека обычное «до/после» почти ничего не доказывает (дрейф работы); `compare` поправляет оценку и говорит «нет явного изменения», когда это так. Чтобы доказать эффект, служит `agentprism switchback`.
- Поддержан только Claude Code; другие агенты подключаются адаптерами.
- Выводы получены на журналах одного пользователя за 12 дней.

## Лицензия

MIT
