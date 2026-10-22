const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareAudio } = require('../src/prepare-audio');
const { parseSampleArgs, createEvaluationSample } = require('../src/evaluation-sample');

const hasTools = ['ffmpeg', 'ffprobe'].every((name) =>
  spawnSync(name, ['-version'], { windowsHide: true }).status === 0);

test('valida caso e intervalo de 15 a 30 segundos', () => {
  assert.deepEqual(parseSampleArgs(['--help']), { help: true });
  assert.throws(() => parseSampleArgs(['--prepared-metadata', 'p.json', '--case', 'F',
    '--start-ms', '0', '--duration-ms', '20000']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseSampleArgs(['--prepared-metadata', 'p.json', '--case', 'A',
    '--start-ms', '0', '--duration-ms', '1000']), { code: 'INVALID_ARGUMENT' });
  assert.equal(parseSampleArgs(['--prepared-metadata', 'p.json', '--case', 'D',
    '--start-ms', '1000', '--duration-ms', '15000']).durationMs, 15000);
  assert.equal(parseSampleArgs(['--input', 'archivo.wav', '--label', 'M05',
    '--start-ms', '300000', '--duration-ms', '30000']).label, 'M05');
});

test('recorta exactamente 15 s de un WAV preparado sin alterar el original', { skip: !hasTools }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio caso '));
  try {
    const source = path.join(dir, 'con espacios.wav');
    const samples = 16 * 8000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(samples * 2, 40);
    await fs.writeFile(source, wav);
    const prepared = await prepareAudio(source, { outputDir: path.join(dir, 'prepared') });
    const options = { preparedMetadata: prepared.prepared.metadataPath,
      caseId: 'A', startMs: 1000, durationMs: 15000, outputDir: path.join(dir, 'samples') };
    const result = await createEvaluationSample(options);
    assert.equal(result.sample.sampleCount, 120000);
    assert.equal(result.sample.durationMs, 15000);
    assert.equal(result.interval.startSample, 8000);
    assert.equal(result.evaluationStatus, 'not_evaluated');
    assert.deepEqual(await fs.readFile(source), wav);
    await assert.rejects(createEvaluationSample(options), { code: 'OUTPUT_EXISTS' });
    await assert.rejects(createEvaluationSample({ ...options, caseId: 'B', startMs: 2000 }),
      { code: 'OUT_OF_RANGE' });
    const failedDir = path.join(dir, 'failed');
    await assert.rejects(createEvaluationSample({ ...options, outputDir: failedDir,
      runFfmpeg: async (_binary, args) => {
        await fs.writeFile(args.at(-1), 'parcial');
        throw new Error('fallo simulado');
      } }), { code: 'FFMPEG_FAILED' });
    assert.deepEqual(await fs.readdir(failedDir), []);
    const direct = await createEvaluationSample({ input: source, label: 'M00',
      startMs: 1000, durationMs: 15000, outputDir: path.join(dir, 'direct') });
    assert.equal(direct.sample.sampleCount, 120000);
    assert.equal(direct.source.syncStatus, 'pcm_wav_sample_aligned');
    assert.deepEqual(await fs.readFile(source), wav);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
