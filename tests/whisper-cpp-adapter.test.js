const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWhisperCppAdapter, decodeWhisperJson, groupWordTokens } = require('../src/whisper-cpp-adapter');

test('agrupa subpalabras sin inventar duración para tokens inválidos', () => {
  assert.deepEqual(groupWordTokens([
    { text: ' hola', offsets: { from: 0, to: 100 }, p: 0.8 },
    { text: 'mundo', offsets: { from: 100, to: 200 }, p: 0.7 },
    { text: ' otra', offsets: { from: 200, to: 200 }, p: 0.9 },
  ]), [
    { text: 'holamundo', startMs: 0, endMs: 200, confidence: 0.7, timingStatus: 'approximate' },
    { text: 'otra', startMs: 200, endMs: 200, confidence: 0.9, timingStatus: 'invalid' },
  ]);
  assert.throws(() => decodeWhisperJson({ model: { type: 'base', multilingual: false }, transcription: [] }),
    { code: 'INVALID_MODEL_OUTPUT' });
});

const root = path.join(__dirname, '..');
const binary = path.join(root, 'cache', 'whisper', 'bin', 'Release', 'whisper-cli.exe');
const model = path.join(root, 'cache', 'whisper', 'models', 'ggml-base.bin');
const asrSample = path.join(root, 'cache', 'whisper', 'experiments', 'M05-asr.wav');

test('integración real: whisper.cpp transcribe una muestra local',
  { skip: ![binary, model, asrSample].every((file) => require('node:fs').existsSync(file)) }, async () => {
    const adapter = await createWhisperCppAdapter();
    const result = await adapter.run({ inputPath: asrSample });
    assert.equal(adapter.version, '1.9.5');
    assert.equal(result.language, 'es');
    assert.ok(result.segments.length > 0);
    assert.ok(result.segments.every((segment) => segment.startMs >= 0 && segment.endMs <= 30000));
    assert.ok(result.wallTimeMs > 0);
    assert.equal((await fs.readdir(path.dirname(asrSample))).some((name) => name.startsWith('.whisper-')), false);
  });
