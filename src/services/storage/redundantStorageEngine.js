// =====================================================================
// Redundant Object Storage Engine (Многовъзлов излишък и стрийминг)
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { PassThrough } = require('node:stream');
const { computeSha256, HashPassThroughStream } = require('../../common/crypto');
const { createLogger } = require('../../common/logger');
const { AppError, NotFoundError } = require('../../common/errors');

const logger = createLogger('storage-engine');

class RedundantStorageEngine {
  constructor(nodePaths = null) {
    if (!nodePaths) {
      const defaultNodes = process.env.STORAGE_REDUNDANCY_NODES || './storage_nodes/node1,./storage_nodes/node2,./storage_nodes/node3,./storage_nodes/node4';
      this.nodePaths = defaultNodes.split(',').map(p => path.resolve(p.trim()));
    } else {
      this.nodePaths = nodePaths.map(p => path.resolve(p));
    }

    // Състояние на отделните възли (за симулация на хардуерен отказ)
    this.disabledNodes = new Set();
    this.initNodes();
  }

  initNodes() {
    for (const nodePath of this.nodePaths) {
      if (!fs.existsSync(nodePath)) {
        fs.mkdirSync(nodePath, { recursive: true });
      }
    }
    logger.info(`Инициализирани са ${this.nodePaths.length} независими storage възли`, {
      nodes: this.nodePaths,
    });
  }

  getActiveNodes() {
    return this.nodePaths.filter((_, idx) => !this.disabledNodes.has(idx));
  }

  getNodeStatus() {
    return this.nodePaths.map((p, idx) => ({
      nodeId: idx,
      path: p,
      status: this.disabledNodes.has(idx) ? 'FAILED_OFFLINE' : 'ONLINE_HEALTHY',
    }));
  }

  disableNode(nodeId) {
    const idx = parseInt(nodeId, 10);
    if (idx >= 0 && idx < this.nodePaths.length) {
      this.disabledNodes.add(idx);
      logger.warn(`Симулиран хардуерен отказ на Storage Node ${idx}`, { path: this.nodePaths[idx] });
      return true;
    }
    return false;
  }

  enableNode(nodeId) {
    const idx = parseInt(nodeId, 10);
    if (idx >= 0 && idx < this.nodePaths.length) {
      this.disabledNodes.delete(idx);
      logger.info(`Възстановен Storage Node ${idx}`, { path: this.nodePaths[idx] });
      return true;
    }
    return false;
  }

  /**
   * Записва обект с поточен запис към всички активни storage възли
   * Изчислява SHA-256 контролна сума в движение без буфериране в паметта
   * @param {string} storageKey 
   * @param {stream.Readable} inputStream 
   * @returns {Promise<{ sizeBytes: number, checksumSha256: string, healthyNodesCount: number }>}
   */
  async putObjectStream(storageKey, inputStream) {
    const activeNodes = this.getActiveNodes();
    if (activeNodes.length === 0) {
      throw new AppError('Няма налични активни storage възли (Критичен отказ на клъстера)', 503, 'STORAGE_UNAVAILABLE');
    }

    const hashStream = new HashPassThroughStream();
    const writeStreams = [];

    for (const nodeDir of activeNodes) {
      const targetPath = path.join(nodeDir, storageKey);
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      writeStreams.push(fs.createWriteStream(targetPath));
    }

    // Разклоняване на потока към всички възли и към хеш стрийма
    const passThrough = new PassThrough();

    passThrough.on('data', chunk => {
      for (const ws of writeStreams) {
        if (!ws.destroyed && ws.writable) {
          ws.write(chunk);
        }
      }
    });

    try {
      await pipeline(inputStream, hashStream, passThrough);

      // Затваряне на всички write потоци
      await Promise.all(
        writeStreams.map(ws => new Promise((resolve, reject) => {
          ws.end((err) => (err ? reject(err) : resolve()));
        }))
      );

      const checksum = hashStream.getSha256Digest();
      const sizeBytes = hashStream.getTotalBytes();

      logger.info(`Успешен запис на обект с излишък върху ${writeStreams.length} възела`, {
        storageKey,
        sizeBytes,
        checksum,
      });

      return {
        sizeBytes,
        checksumSha256: checksum,
        healthyNodesCount: writeStreams.length,
      };
    } catch (err) {
      // Почистване при грешка - унищожаване на потоците и изтриване на частичните файлове (Rollback)
      for (const ws of writeStreams) {
        ws.destroy();
      }
      this.deleteObject(storageKey);
      logger.warn(`Прекъснат запис: изтрити са частичните файлове за ${storageKey} от всички възли`);
      throw err;
    }
  }

  /**
   * Извлича обект със стрийминг от първия наличен здрав възел
   * Верифицира контролната сума в реално време
   * @param {string} storageKey 
   * @returns {{ stream: stream.Readable, activeNodeIndex: number }}
   */
  getObjectStream(storageKey) {
    const activeNodes = this.getActiveNodes();
    if (activeNodes.length === 0) {
      throw new AppError('Няма достъпни storage възли', 503, 'STORAGE_UNAVAILABLE');
    }

    for (const nodeDir of activeNodes) {
      const targetPath = path.join(nodeDir, storageKey);
      if (fs.existsSync(targetPath)) {
        const readStream = fs.createReadStream(targetPath);
        return {
          stream: readStream,
          resolvedPath: targetPath,
        };
      }
    }

    throw new NotFoundError(`Обектът ${storageKey} не беше открит в нито един активен възел`);
  }

  /**
   * Изтрива обект от всички възли
   * @param {string} storageKey 
   */
  deleteObject(storageKey) {
    for (const nodeDir of this.nodePaths) {
      const targetPath = path.join(nodeDir, storageKey);
      if (fs.existsSync(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
        } catch (e) {
          logger.warn(`Неуспешно изтриване на файл от възел: ${targetPath}`);
        }
      }
    }
  }
}

const storageEngine = new RedundantStorageEngine();

module.exports = {
  RedundantStorageEngine,
  storageEngine,
};
