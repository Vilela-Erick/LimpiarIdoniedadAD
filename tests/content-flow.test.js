const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { processContent } = require('../src/content-flow');

function wav16(samples) {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

test('separa transcripción, análisis y render; exige revisión y alineación', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio flujo '));
  try {
    const originalPath = path.join(dir, 'original.wav');
    const enhancedPath = path.join(dir, 'enhanced.wav');
    const outputPath = path.join(dir, 'final.wav');
    const cacheRoot = path.join(dir, 'cache');
    const original = wav16(16000);
    await fs.writeFile(originalPath, original);
    await fs.writeFile(enhancedPath, original);
    const transcript = { schemaVersion: '1.0', source: { path: originalPath },
      words: [{ text: 'mierda', startMs: 500, endMs: 700, confidence: 0.9 }],
      untimedWords: [] };
    const opts = { originalPath, transcript, cacheRoot, outputPath, marginMs: 0, fadeMs: 0 };
    const pending = await processContent(opts);
    assert.equal(pending.status, 'awaiting_review');
    assert.equal(pending.output, null);
    assert.equal(pending.findings.length, 1);
    assert.ok(pending.transcriptPath.includes('transcription'));
    assert.ok(pending.analysisPath.includes('risk'));
    await assert.rejects(processContent({ ...opts, audioToMutePath: enhancedPath,
      reviewDecisions: [{ id: pending.findings[0].id, decision: 'approve', reason: 'Revisado' }] }),
    { code: 'UNVERIFIED_AUDIO_ALIGNMENT' });
    const result = await processContent({ ...opts, reviewDecisions: [
      { id: pending.findings[0].id, decision: 'approve', reason: 'Revisado' },
    ] });
    assert.equal(result.status, 'content_rendered_pending_listening');
    assert.equal(result.render.totalMutedSamples, 1600);
    assert.deepEqual(await fs.readFile(originalPath), original);
    assert.equal((await fs.readFile(outputPath)).length, original.length);
    assert.equal((await fs.readdir(path.join(cacheRoot, 'transcription'))).length, 1);
    assert.equal((await fs.readdir(path.join(cacheRoot, 'risk'))).length, 1);
    assert.equal((await fs.readdir(path.join(cacheRoot, 'render'))).length, 1);
    const reused = await processContent({ ...opts, reviewDecisions: [
      { id: pending.findings[0].id, decision: 'approve', reason: 'Revisado' },
    ] });
    assert.equal(reused.reused, true);
    const handle = await fs.open(outputPath, 'r+');
    try { await handle.write(Buffer.from([1]), 0, 1, 100); }
    finally { await handle.close(); }
    await assert.rejects(processContent({ ...opts, reviewDecisions: [
      { id: pending.findings[0].id, decision: 'approve', reason: 'Revisado' },
    ] }), { code: 'INVALID_RENDER_CACHE' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
