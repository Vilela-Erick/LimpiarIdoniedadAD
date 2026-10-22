const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { verifyRender } = require('../src/technical-mute');

test('integración real: M05 tiene MUTE técnico de longitud fija y exterior intacto', async (context) => {
  const root = path.join(__dirname, '..');
  const reportPath = path.join(root, 'output', 'runs', 'mute-test-M05', 'mutes_prueba.json');
  let report;
  try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return context.skip('No hay artefacto M05 local.');
    throw error;
  }
  assert.equal(report.approval.purpose, 'technical_test');
  assert.equal(report.realRiskCandidates, 0);
  assert.deepEqual(report.appliedIntervalsGlobalMs,
    [{ startMs: 309920, endMs: 311080 }]);
  const verification = await verifyRender(report.source.path, report.output.path,
    report.intervals[0], Math.round(report.parameters.fadeMs * report.source.sampleRateHz / 1000));
  assert.equal(verification.sampleCount, 1323000);
  assert.equal(verification.mutedNonzeroFrames, 0);
  assert.equal(verification.changedOutsideFrames, 0);
});
