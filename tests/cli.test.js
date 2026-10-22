const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('la CLI muestra ayuda con --help', () => {
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Uso:/);
  assert.match(result.stdout, /--help/);
  assert.match(result.stdout, /--probe/);
  assert.match(result.stdout, /--transcribe/);
  assert.match(result.stdout, /fases futuras/);
});

for (const args of [[], ['--probe'], ['--input', 'archivo.wav'], ['--unknown'],
  ['--input', '--probe'], ['--help', '--probe'],
  ['--input', 'a.wav', '--transcribe', '--prepare'],
  ['--input', 'a.wav', '--probe', '--quality-review', 'review.json'],
  ['--input', 'a.wav', '--input', 'b.wav', '--probe']]) {
  test(`la CLI rechaza argumentos incorrectos: ${args.join(' ') || '(vacío)'}`, () => {
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error:/);
  });
}

test('la CLI informa un archivo inexistente en stderr', () => {
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const missing = path.join(__dirname, 'archivo-inexistente.wav');
  const result = spawnSync(process.execPath, [cli, '--input', missing, '--probe'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /FILE_NOT_FOUND/);
});
