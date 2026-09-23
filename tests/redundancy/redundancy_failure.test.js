// =====================================================================
// Redundancy & Failure Demonstration Test: Отказ на дисков възел и излишък
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { RedundantStorageEngine } = require('../../src/services/storage/redundantStorageEngine');
const { computeSha256 } = require('../../src/common/crypto');

test('Storage Redundancy: Симулация на отказ на възел и запазване на достъпността', async () => {
  const engine = new RedundantStorageEngine();
  const testStorageKey = `redundancy_tests/test_file_${Date.now()}.bin`;
  const fileContent = 'Критични данни за ТУ-София с излишък върху 4 независими дяла/възела!';
  const expectedHash = computeSha256(fileContent);

  // 1. Запис върху всички 4 активни възела
  const putResult = await engine.putObjectStream(testStorageKey, Readable.from([Buffer.from(fileContent)]));
  assert.strictEqual(putResult.healthyNodesCount, 4, 'Записът трябва да се разпредели върху 4-те възела');
  assert.strictEqual(putResult.checksumSha256, expectedHash);

  // 2. Симулация на отказ на Възел 0 (Storage Node 1)
  engine.disableNode(0);
  assert.strictEqual(engine.getActiveNodes().length, 3, 'Трябва да останат 3 активни възела');

  // Четене на файла при 1 отпаднал възел
  const readResult1 = engine.getObjectStream(testStorageKey);
  const chunks1 = [];
  for await (const chunk of readResult1.stream) {
    chunks1.push(chunk);
  }
  const readBuffer1 = Buffer.concat(chunks1);
  assert.strictEqual(readBuffer1.toString('utf8'), fileContent, 'Съдържанието при отпаднал Възел 1 трябва да е напълно достъпно');
  assert.strictEqual(computeSha256(readBuffer1), expectedHash, 'Контролната сума трябва да е побитово идентична');

  // 3. Симулация на отказ и на Възел 1 (Storage Node 2) - 2 отпаднали възела
  engine.disableNode(1);
  assert.strictEqual(engine.getActiveNodes().length, 2, 'Трябва да останат 2 активни възела');

  // Четене на файла при 2 отпаднали възела
  const readResult2 = engine.getObjectStream(testStorageKey);
  const chunks2 = [];
  for await (const chunk of readResult2.stream) {
    chunks2.push(chunk);
  }
  const readBuffer2 = Buffer.concat(chunks2);
  assert.strictEqual(readBuffer2.toString('utf8'), fileContent, 'Съдържанието остава достъпно дори при 2 отпаднали възела едновременно');
  assert.strictEqual(computeSha256(readBuffer2), expectedHash);

  // 4. Възстановяване на възлите (Cluster Recovery)
  engine.enableNode(0);
  engine.enableNode(1);
  assert.strictEqual(engine.getActiveNodes().length, 4, 'Всички 4 възела трябва отново да са онлайн');

  // Почистване
  engine.deleteObject(testStorageKey);
});
