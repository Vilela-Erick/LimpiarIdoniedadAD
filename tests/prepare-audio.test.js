const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseArgs } = require('../src/cli');
const { prepareAudio, selectStream } = require('../src/prepare-audio');

const hasTools = ['ffmpeg', 'ffprobe'].every((name) =>
  spawnSync(name, ['-version'], { windowsHide: true }).status === 0);

async function fixture(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio preparación '));
  const source = path.join(dir, 'original con espacios.wav');
  const wav = Buffer.alloc(44 + 800 * 2);
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
  wav.writeUInt32LE(1600, 40);
  await fs.writeFile(source, wav);
  try { return await callback({ dir, source, wav, outputDir: path.join(dir, 'salida con espacios') }); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('selecciona automáticamente una pista e interpreta índices reales', () => {
  const probe = { audio: { streams: [
    { index: 1, codec: 'pcm_s16le' }, { index: 3, codec: 'pcm_s16le' },
  ] } };
  assert.equal(selectStream({ audio: { streams: [probe.audio.streams[0]] } }).index, 1);
  assert.throws(() => selectStream(probe), { code: 'STREAM_SELECTION_REQUIRED' });
  assert.equal(selectStream(probe, 3).index, 3);
  assert.throws(() => selectStream(probe, 2), { code: 'INVALID_STREAM_INDEX' });
});

test('la CLI valida modo e índice sin alterar --probe', () => {
  assert.deepEqual(parseArgs(['--input', 'audio.wav', '--probe']), { input: 'audio.wav', probe: true });
  assert.deepEqual(parseArgs(['--input', 'audio.wav', '--prepare', '--stream-index', '3']),
    { input: 'audio.wav', prepare: true, streamIndex: 3 });
  assert.throws(() => parseArgs(['--input', 'a.wav', '--probe', '--prepare']));
  assert.throws(() => parseArgs(['--input', 'a.wav', '--prepare', '--stream-index', '1.5']));
  assert.throws(() => parseArgs(['--input', 'a.wav', '--probe', '--stream-index', '0']));
});

test('limpia el archivo temporal si FFmpeg falla', async () => {
  await fixture(async ({ source, wav, outputDir }) => {
    const result = await prepareAudio(source, {
      outputDir,
      probe: async () => ({ source: { path: source, sizeBytes: wav.length },
        audio: { streams: [{ index: 0, codec: 'pcm_s16le', sampleRateHz: 8000, channels: 1, durationMs: 100 }] },
        timeline: { startMs: 0, durationMs: 100, durationSource: 'format' } }),
      runFfprobe: async () => ({ stdout: JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', start_time: '0' }], format: { start_time: '0' } }) }),
      runFfmpeg: async (_binary, args) => {
        await fs.writeFile(args.at(-1), Buffer.from('parcial'));
        throw new Error('fallo simulado');
      },
    }).catch((error) => error);
    assert.equal(result.code, 'FFMPEG_FAILED');
    assert.deepEqual(await fs.readdir(outputDir), []);
    assert.deepEqual(await fs.readFile(source), wav);
  });
});

test('rechaza un offset temporal no soportado antes de decodificar', async () => {
  await fixture(async ({ source, wav, outputDir }) => {
    let ffmpegCalled = false;
    await assert.rejects(prepareAudio(source, {
      outputDir,
      probe: async () => ({ source: { path: source, sizeBytes: wav.length },
        audio: { streams: [{ index: 0, codec: 'pcm_s16le', sampleRateHz: 8000, channels: 1, durationMs: 100 }] },
        timeline: { startMs: 0, durationMs: 100, durationSource: 'format' } }),
      runFfprobe: async () => ({ stdout: JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', start_time: '0.125' }], format: { start_time: '0' } }) }),
      runFfmpeg: async () => { ffmpegCalled = true; },
    }), { code: 'UNSUPPORTED_OFFSET' });
    assert.equal(ffmpegCalled, false);
    assert.deepEqual(await fs.readFile(source), wav);
  });
});

test('prepara un WAV corto sin cambiar el original, la frecuencia ni los canales', { skip: !hasTools }, async () => {
  await fixture(async ({ source, wav, outputDir }) => {
    const result = await prepareAudio(source, { outputDir });
    assert.equal(result.audio.selectedStreamIndex, 0);
    assert.equal(result.prepared.codec, 'pcm_f32le');
    assert.equal(result.prepared.sampleRateHz, 8000);
    assert.equal(result.prepared.channels, 1);
    assert.equal(result.prepared.sampleCount, 800);
    assert.equal(result.prepared.durationMs, 100);
    assert.equal(result.timeline.durationDifferenceMs, 0);
    assert.deepEqual(await fs.readFile(source), wav);
    assert.deepEqual(JSON.parse(await fs.readFile(result.prepared.metadataPath, 'utf8')), result);
    await assert.rejects(prepareAudio(source, { outputDir }), { code: 'OUTPUT_EXISTS' });
  });
});

test('dos pistas requieren índice y -map extrae solo la seleccionada', { skip: !hasTools }, async () => {
  await fixture(async ({ dir, source, outputDir }) => {
    const multi = path.join(dir, 'dos pistas.mka');
    const make = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', source, '-i', source, '-map', '0:a:0', '-map', '1:a:0',
      '-c:a', 'pcm_s16le', '-f', 'matroska', multi], { windowsHide: true, encoding: 'utf8' });
    assert.equal(make.status, 0, make.stderr);
    await assert.rejects(prepareAudio(multi, { outputDir }), { code: 'STREAM_SELECTION_REQUIRED' });
    await assert.rejects(prepareAudio(multi, { outputDir, streamIndex: 99 }), { code: 'INVALID_STREAM_INDEX' });
    const result = await prepareAudio(multi, { outputDir, streamIndex: 1 });
    assert.equal(result.audio.selectedStreamIndex, 1);
    assert.equal(result.prepared.sampleCount, 800);
  });
});

test('la CLI --prepare imprime JSON y deja resultados gestionados', { skip: !hasTools }, async () => {
  await fixture(async ({ source }) => {
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const run = spawnSync(process.execPath, [cli, '--input', source, '--prepare'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const result = JSON.parse(run.stdout);
    try {
      assert.equal(result.prepared.sampleCount, 800);
      assert.match(result.prepared.path, /output[\\/]prepared/);
      assert.equal((await fs.stat(result.prepared.path)).isFile(), true);
    } finally {
      await fs.rm(result.prepared.path, { force: true });
      await fs.rm(result.prepared.metadataPath, { force: true });
    }
  });
});

test('dos originales con el mismo nombre en rutas distintas no colisionan', { skip: !hasTools }, async () => {
  await fixture(async ({ dir, source, outputDir }) => {
    const otherDir = path.join(dir, 'otra ruta');
    await fs.mkdir(otherDir);
    const otherSource = path.join(otherDir, path.basename(source));
    await fs.copyFile(source, otherSource);
    const first = await prepareAudio(source, { outputDir });
    const second = await prepareAudio(otherSource, { outputDir });
    assert.notEqual(first.prepared.path, second.prepared.path);
    assert.equal((await fs.stat(first.prepared.path)).isFile(), true);
    assert.equal((await fs.stat(second.prepared.path)).isFile(), true);
  });
});
