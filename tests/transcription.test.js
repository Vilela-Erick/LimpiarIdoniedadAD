const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planTranscriptionChunks, normalizeChunk, transcribeChunks } = require('../src/transcription');

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

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

test('planifica fragmentos y conserva tokens con tiempos cero para revisión', () => {
  assert.deepEqual(planTranscriptionChunks(20001, 8000, 1000).map((c) => [c.startSample, c.endSample]),
    [[0, 8000], [8000, 16000], [16000, 20001]]);
  const result = normalizeChunk({ segments: [{ text: 'dos palabras', startMs: 0, endMs: 1000,
    words: [{ text: 'dos', startMs: 0, endMs: 300, confidence: 0.8 },
      { text: 'palabras', startMs: 400, endMs: 400 }] }] },
  { index: 1, startSample: 8000, endSample: 16000 }, 8000, 300000);
  assert.deepEqual(result.words[0], { text: 'dos', startMs: 301000, endMs: 301300,
    confidence: 0.8, timingStatus: 'approximate' });
  assert.equal(result.untimedWords[0].reason, 'invalid_or_zero_duration');
  const overlapping = planTranscriptionChunks(16000, 8000, 1000, 100);
  assert.equal(overlapping[0].expandedEndSample, 8800);
  assert.equal(overlapping[1].expandedStartSample, 7200);
  const first = normalizeChunk({ segments: [{ text: 'frontera', startMs: 960, endMs: 1060,
    words: [{ text: 'frontera', startMs: 960, endMs: 1060 }] }] }, overlapping[0], 8000);
  const second = normalizeChunk({ segments: [{ text: 'frontera', startMs: 60, endMs: 160,
    words: [{ text: 'frontera', startMs: 60, endMs: 160 }] }] }, overlapping[1], 8000);
  assert.equal(first.words.length, 0);
  assert.equal(second.words.length, 1);
});

test('transcribe por fragmentos recuperables y mantiene tiempo del original',
  { skip: !hasFfmpeg }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio asr '));
    try {
      const inputPath = path.join(dir, 'con espacios.wav');
      const cacheRoot = path.join(dir, 'cache');
      await fs.writeFile(inputPath, wav16(20000));
      let calls = 0;
      const adapter = { id: 'test-only', version: '1', parameters: {},
        async run({ inputPath: chunkFile }) {
          calls++;
          assert.ok((await fs.stat(chunkFile)).size > 44);
          if (calls === 2) throw new Error('fallo simulado');
          return { segments: [{ text: 'hola', startMs: 0, endMs: 200,
            words: [{ text: 'hola', startMs: 0, endMs: 200, confidence: 0.9 }] }] };
        } };
      const options = { inputPath, adapter, cacheRoot, chunkMs: 1000, referenceOffsetMs: 300000 };
      await assert.rejects(transcribeChunks(options), /fallo simulado/);
      const cacheDir = path.join(cacheRoot, (await fs.readdir(cacheRoot))[0]);
      assert.deepEqual((await fs.readdir(cacheDir)).filter((name) => name.startsWith('.tmp-')), []);
      const progress = [];
      adapter.run = async () => {
        calls++;
        return { segments: [{ text: 'hola', startMs: 0, endMs: 200,
          words: [{ text: 'hola', startMs: 0, endMs: 200, confidence: 0.9 }] }] };
      };
      const result = await transcribeChunks({ ...options, onProgress: (event) => progress.push(event) });
      assert.equal(calls, 4);
      assert.deepEqual(progress.map((event) => event.reused), [true, false, false]);
      assert.deepEqual(result.words.map((word) => word.startMs), [300000, 301000, 302000]);
      assert.equal(result.source.sampleCount, 20000);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
