const test = require('node:test');
const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory, applyPlan } = require('../src/cleanup');

test('dry-run enumera solo temporales antiguos y protege resultados, caché y recortes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio inventario '));
  const uuid = '12345678-1234-1234-1234-123456789abc';
  try {
    for (const dir of ['output/prepared', 'output/samples', 'output/cleaned',
      'output/runs/review-snippets', 'cache/transcription-real/abc']) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
    }
    const temp = path.join(root, 'output/prepared', `.${uuid}.wav`);
    const recent = path.join(root, 'output/samples', `.${uuid}.wav`);
    const final = path.join(root, 'output/cleaned', 'prueba_muteada.wav');
    const snippet = path.join(root, 'output/runs/review-snippets', 'review.wav');
    const block = path.join(root, 'cache/transcription-real/abc', 'chunk-00000.json');
    await Promise.all([[temp, 10], [recent, 20], [final, 30], [snippet, 40], [block, 50]]
      .map(([file, size]) => fs.writeFile(file, Buffer.alloc(size))));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(temp, old, old);
    const result = await inventory(root);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.eligible[0].path, path.join('output/prepared', `.${uuid}.wav`));
    assert.equal(result.reclaimableBytes, 10);
    assert.equal(result.protected.cachedTranscriptionBlocks, 1);
    assert.equal(result.protected.files.some(item => item.path.endsWith('prueba_muteada.wav')), true);
    assert.equal(result.protected.files.some(item => item.path.endsWith('review.wav')), true);
    await assert.rejects(applyPlan(root, '0'.repeat(64)), /inventario cambi/);
    assert.equal((await fs.stat(temp)).size, 10);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('el inventario no sigue enlaces de directorio fuera del proyecto', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio enlace '));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'limpiar audio externo '));
  try {
    await fs.mkdir(path.join(root, 'output'), { recursive: true });
    const external = path.join(outside, '.12345678-1234-1234-1234-123456789abc.wav');
    await fs.writeFile(external, Buffer.alloc(99));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(external, old, old);
    try { await fs.symlink(outside, path.join(root, 'output', 'prepared'), 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Enlaces deshabilitados en este Windows'); return; }
      throw error;
    }
    const result = await inventory(root);
    assert.deepEqual(result.eligible, []);
    assert.equal((await fs.stat(external)).size, 99);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
