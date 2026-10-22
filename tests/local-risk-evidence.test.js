const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadLocalRiskEvidence } = require('../src/local-risk-evidence');

test('evidencia local exige fuente, modelo y tiempo global verificables', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-risk-'));
  try {
    await mkdir(path.join(dir, 'local-review'));
    const transcript = { source: { sha256: 'source', sampleRateHz: 1000, sampleCount: 20000 },
      engine: { id: 'whisper.cpp', version: '1.9.5', parameters: { modelSha256: 'model' } } };
    const finding = { id: 'id', text: 'chucha', startMs: 5800, endMs: 6200 };
    const item = { findingId: 'id', sourceSha256: 'source', transcriptSha256: 'transcript',
      engine: 'whisper.cpp', engineVersion: '1.9.5', modelSha256: 'model',
      startSample: 0, endSample: 12000, startMs: 0, windowMs: 12000,
      matches: [{ text: 'chucha,', startMs: 5800, endMs: 6200,
        globalStartMs: 5800, globalEndMs: 6200, confidence: 0.8 }] };
    const file = path.join(dir, 'local-review', 'id-12s.json');
    await writeFile(file, JSON.stringify(item));
    let result = await loadLocalRiskEvidence(dir, [finding], transcript, 'transcript');
    assert.equal(result[0].sourceVerified, true);
    assert.equal(result[0].matches[0].aligned, true);
    await writeFile(file, JSON.stringify({ ...item, sourceSha256: 'wrong' }));
    result = await loadLocalRiskEvidence(dir, [finding], transcript, 'transcript');
    assert.equal(result[0].sourceVerified, false);
    assert.deepEqual(result[0].matches, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
