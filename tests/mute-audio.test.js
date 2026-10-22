const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planMuteIntervals, renderMute } = require('../src/mute-audio');
const { verifyMute } = require('../src/verify-mute');

function wav16(samples, rate = 8000) {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(16000, 44 + i * 2);
  return wav;
}

test('une intervalos superpuestos, convierte a muestras y rechaza cortes', () => {
  const actions = [
    { type: 'mute', approved: true, startMs: 100, endMs: 200 },
    { type: 'mute', approved: true, startMs: 180, endMs: 300 },
  ];
  assert.deepEqual(planMuteIntervals(actions, 8000, 8000, { marginMs: 10, fadeMs: 5 }).intervals,
    [{ startSample: 720, endSample: 2480 }]);
  assert.throws(() => planMuteIntervals([{ type: 'cut', approved: true, startMs: 1, endMs: 2 }], 8000, 8000),
    { code: 'INVALID_ACTION' });
  assert.throws(() => planMuteIntervals([{ type: 'mute', approved: true, startMs: 0, endMs: 0 }], 8000, 8000),
    { code: 'INVALID_ACTION' });
});

test('silencia sin cortar ni modificar la fuente y conserva muestras y bordes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio mute '));
  try {
    const input = path.join(dir, 'origen con espacios.wav');
    const output = path.join(dir, 'cleaned', 'final.wav');
    const original = wav16(16000);
    await fs.writeFile(input, original);
    const document = { preserveDuration: true, actions: [
      { type: 'mute', approved: true, startMs: 100, endMs: 200, reason: 'revisado' },
      { type: 'mute', approved: true, startMs: 180, endMs: 300, reason: 'revisado' },
    ] };
    const report = await renderMute(input, output, document, { marginMs: 10, fadeMs: 5 });
    const rendered = await fs.readFile(output);
    assert.equal(rendered.length, original.length);
    assert.equal(report.source.sampleCount, 16000);
    assert.equal(report.output.sampleCount, 16000);
    assert.equal(report.totalMutedSamples, 1760);
    assert.equal(rendered.readInt16LE(44 + 720 * 2), 0);
    assert.equal(rendered.readInt16LE(44 + 2479 * 2), 0);
    assert.equal(rendered.readInt16LE(44 + 680 * 2), 16000);
    assert.equal(rendered.readInt16LE(44 + 700 * 2) < 16000, true);
    assert.equal(rendered.readInt16LE(44 + 2500 * 2) < 16000, true);
    assert.equal(rendered.readInt16LE(44 + 2600 * 2), 16000);
    assert.deepEqual(await fs.readFile(input), original);
    assert.equal(JSON.parse(await fs.readFile(`${output}.json`, 'utf8')).totalMutedSamples, 1760);
    const verification = await verifyMute(input, output, report);
    assert.equal(verification.sampleCount, 16000);
    assert.equal(verification.mutedSamplesVerified, 1760);
    assert.equal(verification.outsideUnchanged, true);
    await assert.rejects(renderMute(input, output, document), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual((await fs.readdir(path.dirname(output))).sort(), ['final.wav', 'final.wav.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('silencia WAV float32 con encabezado desalineado respecto a los frames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio float '));
  try {
    const input = path.join(dir, 'f32.wav');
    const output = path.join(dir, 'mute.wav');
    const frames = 1000;
    const wav = Buffer.alloc(46 + frames * 4);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8); wav.writeUInt32LE(18, 16);
    wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(1000, 24); wav.writeUInt32LE(4000, 28);
    wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34);
    wav.writeUInt16LE(0, 36);
    wav.write('data', 38); wav.writeUInt32LE(frames * 4, 42);
    for (let i = 0; i < frames; i++) wav.writeFloatLE(i % 2 ? -0.5 : 0.5, 46 + i * 4);
    await fs.writeFile(input, wav);
    const report = await renderMute(input, output, { preserveDuration: true,
      actions: [{ type: 'mute', approved: true, startMs: 100, endMs: 200 }] },
    { marginMs: 0, fadeMs: 0 });
    const data = await fs.readFile(output);
    assert.equal(report.totalMutedSamples, 100);
    assert.equal(data.length, wav.length);
    assert.equal(data.readFloatLE(46 + 99 * 4), -0.5);
    assert.equal(data.readFloatLE(46 + 100 * 4), 0);
    assert.equal(data.readFloatLE(46 + 199 * 4), 0);
    assert.deepEqual(data.subarray(46 + 100 * 4, 46 + 200 * 4), Buffer.alloc(100 * 4));
    assert.equal(data.readFloatLE(46 + 200 * 4), 0.5);
    assert.deepEqual(await fs.readFile(input), wav);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
