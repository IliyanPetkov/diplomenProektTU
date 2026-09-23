# Модел на данните (Data Model & Invariants)

**Дипломен проект:** „Облачна информационна система за съхранение и управление на файлове с микросервисна архитектура“  
**Специалност:** „Компютърни системи и технологии“, ТУ - София

---

## 1. Диаграма на релациите (Entity-Relationship Diagram)

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : "притежава"
    USERS ||--o{ FOLDERS : "притежава"
    USERS ||--o{ FILES : "притежава"
    USERS ||--o{ UPLOAD_SESSIONS : "инициира"
    USERS ||--o{ SHARES : "grantor / grantee"
    USERS ||--o{ PUBLIC_LINKS : "създава"
    
    FOLDERS ||--o{ FOLDERS : "подпапки (parent_id)"
    FOLDERS ||--o{ FILES : "съдържа"
    
    FILES ||--o{ FILE_VERSIONS : "история на версиите"
    FILES ||--o{ SHARES : "споделен ресурс"
    FILES ||--o{ PUBLIC_LINKS : "публичен достъп"

    USERS {
        varchar(36) id PK
        varchar(255) email UK
        text password_hash
        varchar(255) full_name
        varchar(20) role
        bigint quota_bytes
        bigint used_bytes
        timestamp created_at
        timestamp updated_at
    }

    SESSIONS {
        varchar(64) id PK
        varchar(36) user_id FK
        text refresh_token_hash
        text user_agent
        varchar(45) ip_address
        integer is_revoked
        timestamp expires_at
        timestamp created_at
    }

    FOLDERS {
        varchar(36) id PK
        varchar(36) owner_id FK
        varchar(36) parent_id FK
        varchar(255) name
        integer is_deleted
        timestamp deleted_at
        timestamp created_at
        timestamp updated_at
    }

    FILES {
        varchar(36) id PK
        varchar(36) owner_id FK
        varchar(36) folder_id FK
        varchar(255) name
        bigint size_bytes
        varchar(128) mime_type
        varchar(64) checksum_sha256
        varchar(255) storage_key
        integer version
        varchar(64) etag
        integer is_deleted
        timestamp deleted_at
        timestamp created_at
        timestamp updated_at
    }

    FILE_VERSIONS {
        varchar(36) id PK
        varchar(36) file_id FK
        integer version_number
        bigint size_bytes
        varchar(64) checksum_sha256
        varchar(255) storage_key
        varchar(36) created_by FK
        timestamp created_at
    }

    SHARES {
        varchar(36) id PK
        varchar(36) file_id FK
        varchar(36) folder_id FK
        varchar(36) grantor_id FK
        varchar(36) grantee_id FK
        varchar(20) permission
        timestamp created_at
    }

    PUBLIC_LINKS {
        varchar(36) id PK
        varchar(36) file_id FK
        varchar(36) folder_id FK
        varchar(36) creator_id FK
        varchar(64) token UK
        text password_hash
        timestamp expires_at
        integer is_revoked
        integer download_count
        timestamp created_at
    }

    UPLOAD_SESSIONS {
        varchar(36) id PK
        varchar(36) user_id FK
        varchar(36) target_folder_id
        varchar(255) filename
        bigint expected_size_bytes
        varchar(128) mime_type
        varchar(20) status
        varchar(255) temp_storage_key
        timestamp created_at
        timestamp updated_at
    }

    AUDIT_LOGS {
        varchar(36) id PK
        varchar(36) actor_id
        varchar(20) actor_role
        varchar(64) action
        varchar(32) target_type
        varchar(64) target_id
        varchar(16) result
        varchar(45) ip_address
        text user_agent
        varchar(64) correlation_id
        text details
        timestamp timestamp
    }
```

---

## 2. Системни инварианти и ограничения за цялостност

1. **Инвариант на дисковата квота:**  
   $$used\_bytes = \sum_{f \in ActiveFiles} f.size\_bytes + \sum_{v \in ActiveVersions} v.size\_bytes$$  
   Системата никога не позволява $used\_bytes > quota\_bytes$ при иницииране на качване.

2. **Оптимистичен контрол на конкурентността (Optimistic Concurrency Control):**  
   Всяка промяна във файл (преименуване, преместване, нова версия) се валидира чрез хедъра `If-Match: "<ETag>"`. Ако клиент изпрати остарял ETag, операцията се отхвърля с HTTP код `412 Precondition Failed`.

3. **Неизменяемост на одитния журнал (Append-Only Invariant):**  
   Таблицата `audit_logs` не поддържа операции `UPDATE` или `DELETE`. Записват се само успешни или неуспешни събития с метаданни, лишавани от тайни (пароли, токени и cookies).

4. **Жизнен цикъл на сесиите за качване (Upload Lifecycle FSM):**  
   Преходите между състоянията са строго дефинирани:  
   $$\text{INITIATED} \longrightarrow \text{UPLOADING} \longrightarrow \text{COMMITTED} \quad \text{или} \quad \text{ABORTED}$$  
   Прекъснати сесии никога не се превръщат в активни файлове без завършена стъпка `commit`.
