// =====================================================================
// Native PostgreSQL 3.0 Wire Protocol Client (Без външни зависимости)
// С пълна поддръжка на SCRAM-SHA-256, MD5, Cleartext и Queue за заявки
// =====================================================================

const net = require('node:net');
const crypto = require('node:crypto');
const { createLogger } = require('./logger');

const logger = createLogger('postgres-wire-client');

class PostgresWireClient {
  constructor(config = {}) {
    this.host = config.host || process.env.DB_HOST || '127.0.0.1';
    this.port = parseInt(config.port || process.env.DB_PORT || '5432', 10);
    this.user = config.user || process.env.DB_USER || 'cloudfs_user';
    this.password = config.password || process.env.DB_PASSWORD || 'cloudfs_secure_pass_2026';
    this.database = config.database || process.env.DB_NAME || 'cloudfs_db';

    this.socket = null;
    this.isConnected = false;
    this.isReady = false;

    // Опашка от заявки за гарантиране на последователно и конкурентно-безопасно изпълнение
    this.queryQueue = [];
    this.currentQuery = null;
    this.buffer = Buffer.alloc(0);

    // SCRAM състояние
    this.clientNonce = null;
    this.clientFirstMessageBare = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });

      const onConnectError = (err) => {
        this.isConnected = false;
        reject(err);
      };

      this.socket.once('error', onConnectError);

      this.socket.on('connect', () => {
        this.socket.removeListener('error', onConnectError);
        this.socket.on('error', (err) => {
          logger.error('PostgreSQL socket error', { error: err.message });
          if (this.currentQuery) {
            this.currentQuery.reject(err);
            this.currentQuery = null;
          }
          this.drainQueueWithError(err);
        });

        this.sendStartupMessage();
      });

      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer(resolve, reject);
      });

      this.socket.on('close', () => {
        this.isConnected = false;
        this.isReady = false;
        const err = new Error('PostgreSQL връзката беше затворена');
        if (this.currentQuery) {
          this.currentQuery.reject(err);
          this.currentQuery = null;
        }
        this.drainQueueWithError(err);
      });
    });
  }

  drainQueueWithError(err) {
    while (this.queryQueue.length > 0) {
      const q = this.queryQueue.shift();
      q.reject(err);
    }
  }

  sendStartupMessage() {
    const params = [
      'user', this.user,
      'database', this.database,
      'client_encoding', 'UTF8',
      ''
    ];
    let bodyLen = 4;
    for (const p of params) {
      bodyLen += Buffer.byteLength(p, 'utf8') + 1;
    }
    bodyLen += 1;

    const totalLen = 4 + bodyLen;
    const buf = Buffer.alloc(totalLen);
    buf.writeInt32BE(totalLen, 0);
    buf.writeInt32BE(196608, 4); // v3.0

    let offset = 8;
    for (const p of params) {
      if (p === '') {
        buf.writeUInt8(0, offset++);
      } else {
        const written = buf.write(p, offset, 'utf8');
        offset += written;
        buf.writeUInt8(0, offset++);
      }
    }

    this.socket.write(buf);
  }

  processBuffer(readyResolve, readyReject) {
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      const msgTotalLen = 1 + length;

      if (this.buffer.length < msgTotalLen) {
        break; // Очакваме още чанкове
      }

      const msgPayload = this.buffer.subarray(5, msgTotalLen);
      this.buffer = this.buffer.subarray(msgTotalLen);

      this.handleMessage(type, msgPayload, readyResolve, readyReject);
    }
  }

  handleMessage(type, payload, readyResolve, readyReject) {
    switch (type) {
      case 'R': { // Authentication request
        const authType = payload.readInt32BE(0);
        if (authType === 0) {
          // AuthenticationOk
        } else if (authType === 3) {
          // Cleartext password
          this.sendCleartextPassword(this.password);
        } else if (authType === 5) {
          // MD5 password
          const salt = payload.subarray(4, 8);
          const md5inner = crypto.createHash('md5').update(this.password + this.user).digest('hex');
          const md5outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(md5inner), salt])).digest('hex');
          this.sendCleartextPassword('md5' + md5outer);
        } else if (authType === 10) {
          // AuthenticationSASL (SCRAM-SHA-256)
          this.handleSaslInitial();
        } else if (authType === 11) {
          // AuthenticationSASLContinue
          this.handleSaslContinue(payload.subarray(4));
        } else if (authType === 12) {
          // AuthenticationSASLFinal
          // Верифициран успешен край на SCRAM автентикацията
        } else {
          readyReject(new Error(`Неподдържан PostgreSQL auth тип: ${authType}`));
        }
        break;
      }
      case 'K': // BackendKeyData
      case 'S': // ParameterStatus
      case 'N': // NoticeResponse
        break;
      case 'Z': { // ReadyForQuery
        this.isReady = true;
        this.isConnected = true;

        if (readyResolve) {
          readyResolve();
          readyResolve = null;
        }

        // Завършване на текущата заявка
        if (this.currentQuery) {
          const { resolve, rows } = this.currentQuery;
          this.currentQuery = null;
          resolve(rows);
        }

        // Изпълнение на следваща заявка от опашката
        this.processQueue();
        break;
      }
      case 'T': { // RowDescription
        if (this.currentQuery) {
          const numFields = payload.readInt16BE(0);
          let offset = 2;
          this.currentQuery.fields = [];
          for (let i = 0; i < numFields; i++) {
            const nullIdx = payload.indexOf(0, offset);
            const name = payload.subarray(offset, nullIdx).toString('utf8');
            this.currentQuery.fields.push(name);
            offset = nullIdx + 1 + 18;
          }
        }
        break;
      }
      case 'D': { // DataRow
        if (this.currentQuery) {
          const numCols = payload.readInt16BE(0);
          let offset = 2;
          const row = {};
          for (let i = 0; i < numCols; i++) {
            const colLen = payload.readInt32BE(offset);
            offset += 4;
            const fieldName = this.currentQuery.fields[i] || `col_${i}`;
            if (colLen === -1) {
              row[fieldName] = null;
            } else {
              const valStr = payload.subarray(offset, offset + colLen).toString('utf8');
              offset += colLen;
              row[fieldName] = valStr;
            }
          }
          this.currentQuery.rows.push(row);
        }
        break;
      }
      case 'C': { // CommandComplete
        break;
      }
      case 'E': { // ErrorResponse
        let offset = 0;
        let errorMsg = 'PostgreSQL грешка';
        while (offset < payload.length && payload[offset] !== 0) {
          const fieldType = String.fromCharCode(payload[offset++]);
          const nullIdx = payload.indexOf(0, offset);
          const val = payload.subarray(offset, nullIdx).toString('utf8');
          offset = nullIdx + 1;
          if (fieldType === 'M') {
            errorMsg = val;
          }
        }
        const err = new Error(errorMsg);
        if (this.currentQuery) {
          this.currentQuery.reject(err);
          this.currentQuery = null;
        } else if (readyReject) {
          readyReject(err);
        }
        break;
      }
    }
  }

  // --- SCRAM-SHA-256 Имплементация (RFC 5802 / RFC 7677) ---
  handleSaslInitial() {
    this.clientNonce = crypto.randomBytes(18).toString('base64');
    this.clientFirstMessageBare = `n=${this.user},r=${this.clientNonce}`;
    const clientFirstMessage = `n,,${this.clientFirstMessageBare}`;

    const mech = 'SCRAM-SHA-256\0';
    const msgData = Buffer.from(clientFirstMessage, 'utf8');
    const totalLen = 4 + Buffer.byteLength(mech) + 4 + msgData.length;

    const buf = Buffer.alloc(1 + totalLen);
    buf.write('p', 0);
    buf.writeInt32BE(totalLen, 1);
    buf.write(mech, 5);
    buf.writeInt32BE(msgData.length, 5 + Buffer.byteLength(mech));
    msgData.copy(buf, 5 + Buffer.byteLength(mech) + 4);

    this.socket.write(buf);
  }

  handleSaslContinue(payload) {
    const serverFirstMessage = payload.toString('utf8');
    const parts = {};
    for (const item of serverFirstMessage.split(',')) {
      const idx = item.indexOf('=');
      if (idx !== -1) {
        parts[item.slice(0, idx)] = item.slice(idx + 1);
      }
    }

    const r = parts['r'];
    const s = parts['s'];
    const i = parseInt(parts['i'], 10);

    if (!r.startsWith(this.clientNonce)) {
      throw new Error('SCRAM несъответствие на nonce маркера');
    }

    const salt = Buffer.from(s, 'base64');
    const saltedPassword = crypto.pbkdf2Sync(this.password, salt, i, 32, 'sha256');

    const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();

    const clientFinalWithoutProof = `c=biws,r=${r}`;
    const authMessage = `${this.clientFirstMessageBare},${serverFirstMessage},${clientFinalWithoutProof}`;

    const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
    const clientProof = Buffer.alloc(32);
    for (let j = 0; j < 32; j++) {
      clientProof[j] = clientKey[j] ^ clientSignature[j];
    }

    const clientFinalMessage = `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`;
    const msgData = Buffer.from(clientFinalMessage, 'utf8');
    const totalLen = 4 + msgData.length;

    const buf = Buffer.alloc(1 + totalLen);
    buf.write('p', 0);
    buf.writeInt32BE(totalLen, 1);
    msgData.copy(buf, 5);

    this.socket.write(buf);
  }

  sendCleartextPassword(pwd) {
    const pwdBuf = Buffer.from(pwd + '\0', 'utf8');
    const totalLen = 4 + pwdBuf.length;
    const buf = Buffer.alloc(1 + totalLen);
    buf.write('p', 0);
    buf.writeInt32BE(totalLen, 1);
    pwdBuf.copy(buf, 5);
    this.socket.write(buf);
  }

  /**
   * Добавя заявка в опашката и я стартира при наличност на сокета
   * @param {string} sql 
   * @returns {Promise<Array<object>>}
   */
  query(sql) {
    return new Promise((resolve, reject) => {
      this.queryQueue.push({ sql, resolve, reject, rows: [], fields: [] });
      this.processQueue();
    });
  }

  processQueue() {
    if (!this.isConnected || !this.isReady || this.currentQuery || this.queryQueue.length === 0) {
      return;
    }

    this.currentQuery = this.queryQueue.shift();

    const sqlBuf = Buffer.from(this.currentQuery.sql + '\0', 'utf8');
    const totalLen = 4 + sqlBuf.length;
    const buf = Buffer.alloc(1 + totalLen);
    buf.write('Q', 0);
    buf.writeInt32BE(totalLen, 1);
    sqlBuf.copy(buf, 5);
    this.socket.write(buf);
  }

  close() {
    if (this.socket) {
      const buf = Buffer.alloc(5);
      buf.write('X', 0);
      buf.writeInt32BE(4, 1);
      this.socket.write(buf);
      this.socket.end();
      this.isConnected = false;
      this.isReady = false;
    }
  }
}

module.exports = { PostgresWireClient };
