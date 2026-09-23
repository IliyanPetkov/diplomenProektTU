# Архитектура на софтуерната система

**Дипломен проект:** „Облачна информационна система за съхранение и управление на файлове с микросервисна архитектура“  
**Автор:** Дипломант ТУ - София, специалност „Компютърни системи и технологии“

---

## 1. Компонентна архитектура (Component / Container View)

Системата е структурирана като набор от слабо свързани микросервиси, оркестрирани зад единен API Gateway / Edge Service.

```mermaid
graph TB
    subgraph "Клиентски слой"
        Browser["Уеб браузър (HTML5 / CSS3 / Vanilla JS SPA)"]
    end

    subgraph "Edge / Входен слой"
        Gateway["API Gateway / Reverse Proxy (:8080)<br/>• Маршрутизация и CORS<br/>• Rate Limiting (Token Bucket)<br/>• Correlation ID генерация<br/>• Security Headers"]
    end

    subgraph "Микросервисен слой"
        Identity["Identity Service (:8081)<br/>• Регистрация и Вход<br/>• PBKDF2 Хеширане<br/>• JWT & Refresh токени<br/>• Сесии и Роли"]
        Metadata["File Metadata Service (:8082)<br/>• Йерархия на папки<br/>• Версиониране на файлове<br/>• Кошче и Търсене<br/>• Optimistic Concurrency (ETag)"]
        Storage["Storage Service (:8083)<br/>• Streaming Multipart Upload<br/>• Streaming Download<br/>• Поточен SHA-256 хеш<br/>• Управление на клъстера"]
        Sharing["Sharing Service (:8084)<br/>• Споделяне към потребители<br/>• Публични крипто линкове<br/>• Пароли и валидност"]
        Realtime["Realtime Sync Service (:8085)<br/>• Server-Sent Events (SSE)<br/>• Монотонни курсори (Last-Event-ID)<br/>• Replay при прекъсване"]
        Audit["Audit Service (:8086)<br/>• Неизменяем (Append-Only) журнал<br/>• Филтриране по роли и действия<br/>• Без изтичане на пароли/съдържание"]
        Background["Background Reconciliation Worker<br/>• Почистване на прекъснати ъплоуди<br/>• Откриване на сирачни обекти"]
    end

    subgraph "Слой за съхранение и данни"
        DB[("PostgreSQL 16 / Релационна база данни<br/>• Схеми и Външни ключове<br/>• Транзакции и Индекси")]
        
        subgraph "Клъстер за съхранение с излишък (Redundancy)"
            Node1[("Storage Node 1")]
            Node2[("Storage Node 2")]
            Node3[("Storage Node 3")]
            Node4[("Storage Node 4")]
        end
    end

    subgraph "Наблюдаемост (Observability)"
        Prometheus["Prometheus (:9090)<br/>Събиране на метрики /metrics"]
        Grafana["Grafana (:3000)<br/>Визуализация на табла и аларми"]
    end

    Browser -->|HTTP/REST & SSE| Gateway
    Gateway --> Identity
    Gateway --> Metadata
    Gateway --> Storage
    Gateway --> Sharing
    Gateway --> Realtime
    Gateway --> Audit

    Identity --> DB
    Metadata --> DB
    Sharing --> DB
    Audit --> DB
    Background --> DB

    Storage --> Node1
    Storage --> Node2
    Storage --> Node3
    Storage --> Node4
    Background --> Node1

    Prometheus -.->|Scrape| Gateway
    Prometheus -.->|Scrape| Identity
    Prometheus -.->|Scrape| Storage
    Prometheus -.->|Scrape| Realtime
    Grafana --> Prometheus
```

---

## 2. Последователност при поточно качване (Upload Lifecycle Sequence)

Жизненият цикъл на качване гарантира, че прекъснати или недовършени мрежови трансфери никога не оставят валиден файлов запис без физически обект.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Клиент (Браузър)
    participant GW as API Gateway
    participant ST as Storage Service
    participant MD as Metadata Service
    participant Nodes as Redundant Storage Nodes
    participant DB as База данни
    participant RT as Realtime Service
    participant AUD as Audit Service

    Client->>GW: POST /api/v1/upload/init (filename, size, folderId)
    GW->>ST: Инициализация на сесия
    ST->>DB: Проверка на потребителска квота
    ST->>DB: Запис в upload_sessions (Статус: INITIATED)
    ST-->>Client: { uploadId, tempStorageKey }

    Client->>GW: PUT /api/v1/upload/{uploadId}/stream (Chunked Binary Stream)
    GW->>ST: Поточен трансфер без RAM буфер
    ST->>DB: UPDATE upload_sessions SET status = 'UPLOADING'
    par Поточен паралелен запис към възлите с излишък
        ST->>Nodes: Stream към Node 1, 2, 3, 4
        ST->>ST: Изчисление на SHA-256 в движение (Transform Stream)
    end
    Nodes-->>ST: Всички възли потвърждават запис
    ST-->>Client: { actualSizeBytes, checksumSha256, status: READY_TO_COMMIT }

    Client->>GW: POST /api/v1/upload/{uploadId}/commit (checksumSha256, sizeBytes)
    GW->>ST: Финализиране
    ST->>Nodes: Преместване на обекта от temp/ към permanent objects/
    ST->>DB: Транзакция: Създаване на запис в files / file_versions
    ST->>DB: Транзакция: Начисляване на размера към used_bytes на потребителя
    ST->>DB: UPDATE upload_sessions SET status = 'COMMITTED'
    ST->>AUD: Запис в одитния журнал (FILE_UPLOAD)
    ST->>RT: Излъчване на събитие (FILE_UPLOAD)
    RT-->>Client: Realtime SSE известие към всички активни браузърни табове
    ST-->>Client: { fileId, name, version, checksumSha256, status: 'COMMITTED' }
```

---

## 3. Синхронизация в реално време (Realtime Synchronization Sequence)

```mermaid
sequenceDiagram
    autonumber
    actor TabA as Клиентска сесия A (Качва файл)
    actor TabB as Клиентска сесия B (Наблюдава)
    participant RT as Realtime Service
    participant Hub as Realtime Hub

    TabB->>RT: GET /events?token=Bearer_JWT (SSE връзка)
    RT->>Hub: Регистриране на клиентска сесия B
    Hub-->>TabB: HTTP 200 text/event-stream (Keep-Alive)

    Note over TabA: Сесия A качва файл или създава папка
    TabA->>Hub: Излъчване на събитие FOLDER_CREATED / FILE_UPLOAD
    Hub->>Hub: Нарастване на монотонния брояч (eventSeq = N + 1)
    Hub->>Hub: Запис в пръстеновидния буфер за replay
    Hub-->>TabB: data: { id: N+1, type: "FILE_UPLOAD", name: "diploma.pdf" }
    Note over TabB: Браузърът автоматично опреснява файловия списък

    Note over TabB: Мрежово прекъсване на сесия B
    TabB->>RT: Reconnect: GET /events?lastEventId=N+1
    RT->>Hub: Проверка на буфера за пропуснати събития
    Hub-->>TabB: Преиграване на всички събития с ID > N+1
```

---

## 4. Архитектура на разгръщане (Deployment View)

```mermaid
graph TD
    subgraph "Физически / Виртуален хост (Docker Host)"
        subgraph "Frontend Network"
            GW_C["cloudfs-gateway:8080"]
            GF_C["cloudfs-grafana:3000"]
        end

        subgraph "Backend Network (Изолирана вътрешна мрежа)"
            ID_C["cloudfs-identity:8081"]
            MD_C["cloudfs-metadata:8082"]
            ST_C["cloudfs-storage:8083"]
            SH_C["cloudfs-sharing:8084"]
            RT_C["cloudfs-realtime:8085"]
            AU_C["cloudfs-audit:8086"]
            
            PG_C[("cloudfs-postgres:5432")]
            PR_C["cloudfs-prometheus:9090"]

            subgraph "Storage Volumes (Simulated Redundancy)"
                M1[("minio1-data")]
                M2[("minio2-data")]
                M3[("minio3-data")]
                M4[("minio4-data")]
            end
        end
    end

    User[Потребител / Браузър] -->|Външен порт 8080| GW_C
    Admin[Администратор] -->|Външен порт 3000| GF_C
```
