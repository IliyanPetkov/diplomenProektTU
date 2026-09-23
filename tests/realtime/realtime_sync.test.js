// =====================================================================
// Realtime Test: Синхронизация между две независими клиентски сесии
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { realtimeHub } = require('../../src/services/realtime/hub');

test('Realtime синхронизация: Две независими клиентски сесии получават събития', () => {
  const userId = 'sync-student-uuid';
  const client1Events = [];
  const client2Events = [];

  // Симулация на HTTP Response потоци за два независими браузърни прозореца/клиента
  const mockRes1 = {
    write: (data) => client1Events.push(data),
  };

  const mockRes2 = {
    write: (data) => client2Events.push(data),
  };

  realtimeHub.addClient('client-tab-1', userId, mockRes1);
  realtimeHub.addClient('client-tab-2', userId, mockRes2);

  // Излъчване на събитие за качен файл
  realtimeHub.broadcastEvent({
    type: 'FILE_UPLOAD',
    userId,
    name: 'project_report.pdf',
    sizeBytes: 4096,
  });

  assert.strictEqual(client1Events.length, 1, 'Клиент 1 трябва да получи събитието');
  assert.strictEqual(client2Events.length, 1, 'Клиент 2 трябва да получи събитието едновременно');

  assert.ok(client1Events[0].includes('FILE_UPLOAD'), 'Събитието трябва да съдържа правилния тип');
  assert.ok(client1Events[0].includes('project_report.pdf'), 'Събитието трябва да съдържа името на файла');

  // Почистване
  realtimeHub.removeClient('client-tab-1');
  realtimeHub.removeClient('client-tab-2');
});

test('Realtime Reconnect: Възстановяване след прекъсване чрез монотонни курсори (Last-Event-ID)', () => {
  const userId = 'reconnect-user-uuid';
  const replayedEvents = [];

  const mockRes = {
    write: (data) => replayedEvents.push(data),
  };

  // Генерираме няколко събития в системата
  const startSeq = realtimeHub.eventSequence;
  realtimeHub.broadcastEvent({ type: 'EVT_1', userId });
  realtimeHub.broadcastEvent({ type: 'EVT_2', userId });
  realtimeHub.broadcastEvent({ type: 'EVT_3', userId });

  // Клиентът се свързва отново с Last-Event-ID от преди прекъсването (startSeq + 1)
  realtimeHub.replayMissedEvents(startSeq + 1, userId, mockRes);

  assert.strictEqual(replayedEvents.length, 2, 'Трябва да бъдат преиграни точно двете пропуснати събития (EVT_2 и EVT_3)');
  assert.ok(replayedEvents[0].includes('EVT_2'));
  assert.ok(replayedEvents[1].includes('EVT_3'));
});
