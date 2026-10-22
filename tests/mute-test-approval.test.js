const assert = require('node:assert/strict');
const test = require('node:test');
const { validateApproval } = require('../src/technical-mute');

test('MUTE técnico exige aprobación explícita, hash y tiempos dentro de la muestra', () => {
  const sample = { interval: { startMs: 300000, endMs: 330000 } };
  const approval = { purpose: 'technical_test', approved: true, sampleSha256: 'abc',
    startMs: 310000, endMs: 311000, reason: 'verificar PCM' };
  assert.deepEqual(validateApproval(approval, sample, 'abc'), {
    type: 'mute', approved: true, category: 'technical_test', reason: 'verificar PCM',
    startMs: 10000, endMs: 11000,
  });
  assert.throws(() => validateApproval({ ...approval, approved: false }, sample, 'abc'));
  assert.throws(() => validateApproval(approval, sample, 'otro hash'));
  assert.throws(() => validateApproval({ ...approval, endMs: 330001 }, sample, 'abc'));
});
