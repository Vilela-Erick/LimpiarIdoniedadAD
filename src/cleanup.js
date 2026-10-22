#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TEMP_NAME = new RegExp(`^\\.${UUID}\\.(wav|json)$`, 'i');
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const WORK_DIRS = ['output/prepared', 'output/samples', 'output/cleaned'];
const INVENTORY_DIRS = ['output/comparison', 'output/runs'];

function within(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function visit(root, relative, onFile) {
  const dir = path.join(root, relative);
  let directory;
  try { directory = await fs.lstat(dir); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (directory.isSymbolicLink() || !directory.isDirectory()) return;
  const realRoot = await fs.realpath(root);
  const realDir = await fs.realpath(dir);
  if (realDir !== realRoot && !within(realRoot, realDir)) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await visit(root, path.join(relative, entry.name), onFile);
    else if (stat.isFile()) await onFile(file, stat, entry.name);
  }
}

function holdReason(relative) {
  if (relative.startsWith(`output${path.sep}samples${path.sep}`)) return 'muestra_reutilizable';
  if (relative.includes(`${path.sep}review-snippets${path.sep}`)) return 'revision_pendiente';
  if (relative.startsWith(`output${path.sep}comparison${path.sep}`)) return 'comparacion_pendiente';
  if (relative.startsWith(`output${path.sep}cleaned${path.sep}`)) return 'resultado_o_diagnostico';
  if (relative.startsWith(`output${path.sep}prepared${path.sep}`)) return 'preparacion_reutilizable';
  return 'resultado_no_clasificado';
}

async function inventory(root = path.resolve(__dirname, '..'), now = Date.now()) {
  root = path.resolve(root);
  const eligible = [];
  const protectedFiles = [];
  for (const dir of [...WORK_DIRS, ...INVENTORY_DIRS]) {
    await visit(root, dir, async (file, stat, name) => {
      const relative = path.relative(root, file);
      const isTemp = WORK_DIRS.includes(dir) && path.dirname(relative) === path.normalize(dir) && TEMP_NAME.test(name);
      if (isTemp && stat.nlink === 1 && now - stat.mtimeMs >= MIN_AGE_MS) {
        eligible.push({ path: relative, bytes: stat.size, mtimeMs: stat.mtimeMs,
          dev: stat.dev, ino: stat.ino, reason: 'temporal_huerfano_mayor_24h' });
      } else if (/\.(wav|wave|mp3|f32|json)$/i.test(name)) {
        protectedFiles.push({ path: relative, bytes: stat.size,
          reason: isTemp ? 'temporal_reciente_o_enlazado' : holdReason(relative) });
      }
    });
  }
  let cachedBlocks = 0;
  let cachedBlockBytes = 0;
  await visit(root, 'cache/transcription-real', async (_file, stat, name) => {
    if (/^chunk-\d{5}\.json$/.test(name)) { cachedBlocks++; cachedBlockBytes += stat.size; }
  });
  eligible.sort((a, b) => a.path.localeCompare(b.path));
  protectedFiles.sort((a, b) => a.path.localeCompare(b.path));
  const bytes = eligible.reduce((sum, file) => sum + file.bytes, 0);
  const planHash = createHash('sha256').update(JSON.stringify(eligible)).digest('hex');
  return { schemaVersion: '1.0', mode: 'dry-run', root, eligible,
    reclaimableBytes: bytes, reclaimableGB: Number((bytes / 1e9).toFixed(6)), planHash,
    protected: { files: protectedFiles, cachedTranscriptionBlocks: cachedBlocks,
      cachedTranscriptionBytes: cachedBlockBytes },
    policy: 'Solo temporales huérfanos de >24 h en output/prepared, output/samples y output/cleaned; sin enlaces ni directorios. La limpieza automática está desactivada.' };
}

async function applyPlan(root, expectedHash) {
  const report = await inventory(root);
  if (report.planHash !== expectedHash) throw new Error('El inventario cambió; repita --dry-run.');
  for (const item of report.eligible) {
    const file = path.resolve(report.root, item.path);
    if (!within(report.root, file) || !WORK_DIRS.some(dir => path.dirname(item.path) === path.normalize(dir))) {
      throw new Error('Ruta fuera de la lista permitida.');
    }
    const realRoot = await fs.realpath(report.root);
    const realParent = await fs.realpath(path.dirname(file));
    if (!within(realRoot, realParent)) throw new Error('Destino externo al proyecto.');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        stat.dev !== item.dev || stat.ino !== item.ino || stat.size !== item.bytes ||
        stat.mtimeMs !== item.mtimeMs || Date.now() - stat.mtimeMs < MIN_AGE_MS ||
        !TEMP_NAME.test(path.basename(file))) throw new Error(`Archivo cambiado: ${item.path}`);
    await fs.unlink(file);
  }
  return { ...report, mode: 'apply', removed: report.eligible.length };
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--dry-run') return inventory();
  if (args.length === 2 && args[0] === '--apply' && /^[0-9a-f]{64}$/.test(args[1])) {
    return applyPlan(path.resolve(__dirname, '..'), args[1]);
  }
  throw new Error('Uso: npm run limpiar-temporales -- --dry-run | --apply <planHash>');
}

if (require.main === module) main().then(result => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });

module.exports = { inventory, applyPlan, main };
