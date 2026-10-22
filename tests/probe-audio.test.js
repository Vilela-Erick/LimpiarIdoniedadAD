const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { probeAudio } = require('../src/probe-audio');

const validStream = { index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '8000', channels: 1, duration: '0.250' };

async function withFixture(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio '));
  const file = path.join(dir, 'audio con espacios.wav');
  try {
    await fs.writeFile(file, Buffer.from('dummy'));
    return await callback(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeRun(data, inspect = () => {}) {
  return async (executable, args, options) => {
    inspect(executable, args, options);
    return { stdout: JSON.stringify(data) };
  };
}

test('lee metadatos JSON sin depender de la extensión y pasa rutas con espacios como un argumento', async () => {
  await withFixture(async (file) => {
    const result = await probeAudio(file, {
      ffprobePath: 'C:\\Herramientas con espacios\\ffprobe.exe',
      run: fakeRun({ streams: [validStream], format: { duration: '0.250' } }, (executable, args, options) => {
        assert.equal(executable, 'C:\\Herramientas con espacios\\ffprobe.exe');
        assert.equal(args.at(-1), file);
        assert.equal(options.shell, undefined);
      }),
    });
    assert.deepEqual(result, {
      schemaVersion: '1.0',
      source: { path: file, sizeBytes: 5 },
      audio: { streams: [{ index: 0, codec: 'pcm_s16le', sampleRateHz: 8000, channels: 1, durationMs: 250 }], selectedStreamIndex: 0, multipleStreams: false },
      timeline: { startMs: 0, durationMs: 250, durationSource: 'format' },
    });
    assert.deepEqual(await fs.readFile(file), Buffer.from('dummy'));
  });
});

test('rechaza archivos sin pista de audio válida', async () => {
  await withFixture(async (file) => {
    await assert.rejects(probeAudio(file, { run: fakeRun({ streams: [{ index: 0, codec_type: 'subtitle' }] }) }),
      { code: 'NO_AUDIO_STREAM' });
  });
});

test('identifica múltiples pistas y usa la duración mayor si falta la del contenedor', async () => {
  await withFixture(async (file) => {
    const second = { ...validStream, index: 2, duration: '0.500' };
    const result = await probeAudio(file, { run: fakeRun({ streams: [validStream, second], format: {} }) });
    assert.equal(result.audio.multipleStreams, true);
    assert.equal(result.audio.selectedStreamIndex, 0);
    assert.deepEqual(result.audio.streams.map((stream) => stream.index), [0, 2]);
    assert.deepEqual(result.timeline, { startMs: 0, durationMs: 500, durationSource: 'stream' });
  });
});

test('representa duración desconocida con null', async () => {
  await withFixture(async (file) => {
    const result = await probeAudio(file, { run: fakeRun({ streams: [{ ...validStream, duration: 'N/A' }], format: { duration: 'N/A' } }) });
    assert.equal(result.audio.streams[0].durationMs, null);
    assert.deepEqual(result.timeline, { startMs: 0, durationMs: null, durationSource: 'unknown' });
  });
});

test('distingue ausencia de ffprobe de fallo de ffprobe', async () => {
  await withFixture(async (file) => {
    await assert.rejects(probeAudio(file, { run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }),
      { code: 'FFPROBE_UNAVAILABLE' });
    await assert.rejects(probeAudio(file, { run: async () => { throw new Error('bad data'); } }),
      { code: 'FFPROBE_FAILED' });
  });
});

test('la CLI informa cuando la ruta configurada de ffprobe no existe', async () => {
  await withFixture(async (file) => {
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const missingProbe = path.join(path.dirname(file), 'ffprobe-no-existe.exe');
    const result = spawnSync(process.execPath,
      [cli, '--input', file, '--probe', '--ffprobe-path', missingProbe], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /FFPROBE_UNAVAILABLE/);
  });
});

test('rechaza video con pista de audio', async () => {
  await withFixture(async (file) => {
    const video = { index: 1, codec_type: 'video', disposition: { attached_pic: 0 } };
    await assert.rejects(probeAudio(file, { run: fakeRun({ streams: [validStream, video] }) }),
      { code: 'NOT_AUDIO_ONLY' });
  });
});

test('integración: inspecciona un WAV breve generado localmente', { skip: spawnSync('ffprobe', ['-version'], { windowsHide: true }).status !== 0 }, async () => {
  await withFixture(async (file) => {
    const sampleRate = 8000;
    const samples = 800;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(samples * 2, 40);
    await fs.writeFile(file, wav);
    const result = await probeAudio(file);
    assert.equal(result.source.sizeBytes, wav.length);
    assert.equal(result.audio.streams[0].codec, 'pcm_s16le');
    assert.equal(result.audio.streams[0].sampleRateHz, sampleRate);
    assert.equal(result.audio.streams[0].channels, 1);
    assert.equal(result.timeline.durationMs, 100);
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const cliResult = spawnSync(process.execPath, [cli, '--input', file, '--probe'], { encoding: 'utf8' });
    assert.equal(cliResult.status, 0);
    assert.equal(cliResult.stderr, '');
    assert.deepEqual(JSON.parse(cliResult.stdout), result);
    assert.deepEqual(await fs.readFile(file), wav);
  });
});
