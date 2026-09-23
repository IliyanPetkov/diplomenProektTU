# Матрица на съответствието с дипломното задание (Diploma Evidence Matrix)

**Дипломен проект:** „Облачна информационна система за съхранение и управление на файлове с микросервисна архитектура“  
**ОКС:** „Бакалавър“, специалност „Компютърни системи и технологии“, ТУ - София

---

| Изискване от заданието | Реализиращи софтуерни файлове | API Ендпоинти | Елемент в Потребителския интерфейс | Автоматични тестове |
| :--- | :--- | :--- | :--- | :--- |
| **1. Микросервисна архитектура** | `src/services/*`, `src/common/httpServer.js` | Всички услуги на отделни портове (:8081 - :8086) | Единен достъп през Gateway (:8080) | `tests/api/api_e2e.test.js` |
| **2. API Gateway / Edge Service** | `src/services/gateway/index.js`, `rateLimiter.js` | `/api/v1/*`, `/health/live`, `/metrics` | Обслужва SPA интерфейса | `tests/security/security_regression.test.js` |
| **3. Автентикация и Сесии (Identity)** | `src/services/identity/index.js`, `src/common/jwt.js`, `crypto.js` | `POST /register`, `POST /login`, `POST /logout`, `GET /sessions` | Екран „Вход и Регистрация“, бутон „Изход“ | `tests/unit/crypto_and_tokens.test.js`, `tests/api/api_e2e.test.js` |
| **4. Йерархия на папки и файлови метаданни** | `src/services/metadata/index.js` | `GET /contents`, `POST /folders`, `PATCH /folders/:id`, `GET /search` | Навигационно дърво, Breadcrumbs, Търсачка | `tests/api/api_e2e.test.js` |
| **5. Версиониране на файлове и Optimistic Concurrency** | `src/services/metadata/index.js`, `src/common/errors.js` | `GET /files/:id/versions`, `POST /files/:id/versions/:vId/restore` | Модален прозорец „История на версиите“, бадж `v1` | `tests/api/api_e2e.test.js` |
| **6. Обектно хранилище със стрийминг и SHA-256** | `src/services/storage/index.js`, `redundantStorageEngine.js` | `POST /upload/init`, `PUT /upload/:id/stream`, `POST /upload/:id/commit` | Drag-and-Drop зона, Progress bar, SHA-256 бадж | `tests/integration/upload_lifecycle.test.js` |
| **7. Излишък на съхранението (Storage Redundancy)** | `src/services/storage/redundantStorageEngine.js` | `GET /storage/nodes`, `POST /storage/nodes/:id/fault` | Административен изглед на възлите с бутони за симулация | `tests/redundancy/redundancy_failure.test.js` |
| **8. Споделяне и публични връзки** | `src/services/sharing/index.js` | `POST /shares`, `POST /public-links`, `POST /public/:token/download` | Модален прозорец „Споделяне“, публична форма за парола | `tests/api/sharing.test.js` |
| **9. Realtime синхронизация** | `src/services/realtime/index.js`, `hub.js` | `GET /events` (Server-Sent Events) | Тост известия при отдалечена промяна и автоматично опресняване | `tests/realtime/realtime_sync.test.js` |
| **10. Неизменяем Одит журнал (Audit)** | `src/services/audit/index.js`, `src/common/auditClient.js` | `GET /audit/logs`, `GET /audit/stats`, `POST /audit/log` | Административен екран с одитна таблица и филтри | `tests/api/api_e2e.test.js` |
| **11. Контейнеризация и Оркестрация** | `compose.yaml`, `docker/Dockerfile.service`, `Dockerfile.gateway` | Всички контейнери със здраве и изолация | Готови мрежи `frontend-net` и `backend-net` | `compose.yaml` синтаксис и readiness |
| **12. Наблюдаемост (Observability)** | `src/common/metrics.js`, `monitoring/prometheus.yml`, `cloudfs-dashboard.json` | `GET /metrics`, Grafana порт 3000 | Административни метрики карти и Grafana Dashboard | `scripts/smoke_test.js` |
| **13. Фоново почистване и реконсилиация** | `src/services/background/cleanup.js` | CLI / фонов скрипт | Автоматично почистване на изоставени сесии | `tests/integration/failure_cleanup.test.js` |
