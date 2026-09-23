# Changelog

Всички съществени промени по проекта се документират в този файл. Форматът се базира на [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), а проектът спазва [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-02
### Добавено (Added)
- Архитектура с микросервиси: API Gateway, Identity, Metadata, Storage, Sharing, Realtime Sync, Audit, Background Reconciliation.
- PostgreSQL база данни със схеми, външни ключове, индекси и транзакции.
- Обектно хранилище с S3 съвместимост и архитектура с 4-възлов излишък (storage redundancy / erasure coding).
- Стрийминг качване и изтегляне на файлове с поточно изчисление на SHA-256 контролна сума.
- Версиониране на файлове и защита от конфликти чрез оптимистично заключване (ETag/Version).
- Споделяне на файлове към регистрирани потребители (viewer/editor) и защитени публични линкове с криптографски случайни токени и срок на годност.
- Realtime синхронизация на браузърните сесии чрез SSE/WebSocket и възстановяване на събития по монотонни курсори.
- Append-only одит журнал за всяко критично действие без изтичане на пароли, токени и съдържание.
- Наблюдаемост чрез структуриран JSON logging, Correlation ID, Prometheus метрики и готов Grafana dashboard.
- Пълна уеб SPA конзола (HTML5, CSS3, Vanilla JavaScript) с drag-and-drop, йерархия на папки, кошче и администраторски преглед.
- Автоматизиран тестов пакет: Unit, Integration, API, Security (IDOR, Traversal, Expiry), Realtime и Storage Redundancy.
- Академична документация за ТУ - София, специалност „Компютърни системи и технологии“.
