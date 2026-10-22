const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planBlocks, processBlocks } = require('../src/block-processing');

const hasTools = ['ffmpeg', 'ffprobe'].every((name) =>
  spawnSync(name, ['-version'], { windowsHide: true }).status === 0);

function wav16(samples, rate = 8000) {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE((i % 2000) - 1000, 44 + i * 2);
  return wav;
}

test('planifica núcleos contiguos y solapamientos sin duplicar muestras', () => {
  assert.deepEqual(planBlocks(20001, 8000, 1, 100), [
    { index: 0, coreStart: 0, coreEnd: 8000, expandedStart: 0, expandedEnd: 8800 },
    { index: 1, coreStart: 8000, coreEnd: 16000, expandedStart: 7200, expandedEnd: 16800 },
    { index: 2, coreStart: 16000, coreEnd: 20001, expandedStart: 15200, expandedEnd: 20001 },
  ]);
  assert.throws(() => planBlocks(100, 8000, 1, 1000), { code: 'INVALID_PLAN' });
});

test('exige adaptador y no acepta una salida sin motor', async () => {
  await assert.rejects(processBlocks({ inputPath: 'x.wav', outputPath: 'y.wav' }),
    { code: 'MODEL_REQUIRED' });
});

test('reanuda bloques válidos, une por muestras, preserva original y limpia temporales',
  { skip: !hasTools }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio bloques '));
    try {
      const inputPath = path.join(dir, 'origen con espacios.wav');
      const outputPath = path.join(dir, 'salida', 'voces.wav');
      const cacheRoot = path.join(dir, 'cache');
      const original = wav16(16001);
      await fs.writeFile(inputPath, original);
      let calls = 0;
      const model = { id: 'test-copy-only', version: '1', parameters: {},
        async run({ inputPath: blockInput, outputPath: blockOutput }) {
          calls++;
          if (calls === 2) throw new Error('fallo simulado');
          await fs.copyFile(blockInput, blockOutput);
          return { outputOffsetSamples: 0 };
        } };
      const options = { inputPath, outputPath, cacheRoot, model,
        chunkSeconds: 1, overlapMs: 100 };
      await assert.rejects(processBlocks(options), /fallo simulado/);
      assert.equal(await fs.access(outputPath).then(() => true, () => false), false);
      const runDir = path.join(cacheRoot, (await fs.readdir(cacheRoot))[0]);
      assert.deepEqual((await fs.readdir(runDir)).filter((name) => name.startsWith('.tmp-')), []);
      assert.equal((await fs.readdir(runDir)).filter((name) => name.startsWith('chunk-')).length, 1);

      const resumed = [];
      model.run = async ({ inputPath: blockInput, outputPath: blockOutput }) => {
        calls++;
        await fs.copyFile(blockInput, blockOutput);
        return { outputOffsetSamples: 0 };
      };
      const report = await processBlocks({ ...options, onProgress: (event) => resumed.push(event) });
      assert.equal(calls, 4);
      assert.deepEqual(resumed.map((event) => event.reused), [true, false, false]);
      assert.equal(report.status, 'processed_pending_listening');
      assert.equal(report.qualityApproved, false);
      assert.equal(report.output.sampleCount, 16001);
      assert.deepEqual(await fs.readFile(inputPath), original);
      const joined = await fs.readFile(outputPath);
      assert.equal(joined.toString('ascii', 0, 4), 'RIFF');
      assert.equal(joined.length, 44 + 16001 * 4);
      for (const i of [0, 7999, 8000, 15999, 16000]) {
        assert.ok(Math.abs(joined.readFloatLE(44 + i * 4) - ((i % 2000) - 1000) / 32768) < 1e-7);
      }
      assert.equal(JSON.parse(await fs.readFile(`${outputPath}.json`, 'utf8')).output.sampleCount, 16001);
      await assert.rejects(processBlocks(options), { code: 'OUTPUT_EXISTS' });
      assert.deepEqual((await fs.readdir(path.dirname(outputPath))).sort(), ['voces.wav', 'voces.wav.json']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

test('rechaza desfase declarado por el modelo y borra el bloque incompleto',
  { skip: !hasTools }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio offset '));
    try {
      const inputPath = path.join(dir, 'origen.wav');
      const outputPath = path.join(dir, 'salida.wav');
      const cacheRoot = path.join(dir, 'cache');
      await fs.writeFile(inputPath, wav16(8000));
      const model = { id: 'test-offset', version: '1',
        async run({ inputPath: source, outputPath: dest }) {
          await fs.copyFile(source, dest);
          return { outputOffsetSamples: 1 };
        } };
      await assert.rejects(processBlocks({ inputPath, outputPath, cacheRoot, model }),
        { code: 'UNSUPPORTED_MODEL_OFFSET' });
      const runDir = path.join(cacheRoot, (await fs.readdir(cacheRoot))[0]);
      assert.deepEqual(await fs.readdir(runDir), []);
      assert.equal(await fs.access(outputPath).then(() => true, () => false), false);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
