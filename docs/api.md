# OpenAPI 3.0 API Спецификация

```yaml
openapi: 3.0.3
info:
  title: CloudFS API - Облачна система за файлове
  description: Микросервизно REST API за съхранение, управление, споделяне и одит на файлове (ТУ - София).
  version: 1.0.0
servers:
  - url: http://localhost:8080/api/v1
    description: API Gateway (Edge Service)

paths:
  /auth/register:
    post:
      summary: Регистрация на нов потребител
      tags: [Identity]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password, fullName]
              properties:
                email: { type: string, format: email }
                password: { type: string, minLength: 8 }
                fullName: { type: string }
      responses:
        '200': { description: Успешна регистрация }
        '409': { description: Имейлът вече съществува }

  /auth/login:
    post:
      summary: Вход в системата и получаване на JWT и Refresh токен
      tags: [Identity]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email: { type: string }
                password: { type: string }
      responses:
        '200':
          description: Успешен вход
          content:
            application/json:
              schema:
                type: object
                properties:
                  accessToken: { type: string }
                  refreshToken: { type: string }
                  sessionId: { type: string }
                  user: { type: object }
        '401': { description: Грешни потребителски данни }

  /contents:
    get:
      summary: Извличане на папки и файлове в текуща директория
      tags: [Metadata]
      security: [{ BearerAuth: [] }]
      parameters:
        - name: folderId
          in: query
          required: false
          schema: { type: string }
        - name: sortBy
          in: query
          schema: { type: string, enum: [name, size_bytes, updated_at] }
        - name: order
          in: query
          schema: { type: string, enum: [asc, desc] }
      responses:
        '200': { description: Списък с файлове, папки и текуща квота }

  /folders:
    post:
      summary: Създаване на нова папка
      tags: [Metadata]
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                parentId: { type: string, nullable: true }
      responses:
        '200': { description: Създадена папка }

  /upload/init:
    post:
      summary: Инициализиране на качване на файл (Upload Lifecycle INITIATED)
      tags: [Storage]
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [filename, sizeBytes]
              properties:
                filename: { type: string }
                sizeBytes: { type: integer }
                mimeType: { type: string }
                folderId: { type: string, nullable: true }
      responses:
        '200': { description: Сесия за качване }
        '413': { description: Превишена потребителска квота }

  /upload/{uploadId}/stream:
    put:
      summary: Поточно качване на съдържанието към възлите с излишък
      tags: [Storage]
      security: [{ BearerAuth: [] }]
      parameters:
        - name: uploadId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/octet-stream:
            schema: { type: string, format: binary }
      responses:
        '200': { description: Успешен стрийминг и изчислен SHA-256 }

  /upload/{uploadId}/commit:
    post:
      summary: Финализиране на качването (Upload Lifecycle COMMITTED)
      tags: [Storage]
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [sizeBytes, checksumSha256]
              properties:
                sizeBytes: { type: integer }
                checksumSha256: { type: string }
      responses:
        '200': { description: Файлът е записан успешно и активен }

  /download/{fileId}:
    get:
      summary: Поточно изтегляне на файл от активен възел с верификация на SHA-256
      tags: [Storage]
      security: [{ BearerAuth: [] }]
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Файлов поток
          headers:
            ETag: { schema: { type: string } }
            X-File-Checksum-SHA256: { schema: { type: string } }
            Content-Disposition: { schema: { type: string } }

  /shares:
    post:
      summary: Споделяне на ресурс към регистриран потребител
      tags: [Sharing]
      security: [{ BearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [granteeEmail, permission]
              properties:
                fileId: { type: string }
                granteeEmail: { type: string }
                permission: { type: string, enum: [viewer, editor] }
      responses:
        '200': { description: Ресурсът е споделен }

  /audit/logs:
    get:
      summary: Извличане на одитния журнал (Само за администратори)
      tags: [Audit]
      security: [{ BearerAuth: [] }]
      parameters:
        - name: action
          in: query
          schema: { type: string }
        - name: limit
          in: query
          schema: { type: integer, default: 50 }
      responses:
        '200': { description: Одитни записи }
        '403': { description: Достъпът е само за администратори }

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```
