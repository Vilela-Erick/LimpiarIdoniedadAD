const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const expectedBaseSha256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const defaultBinary = path.join(__dirname, '..', 'cache', 'whisper', 'bin', 'Release', 'whisper-cli.exe');
const defaultModel = path.join(__dirname, '..', 'cache', 'whisper', 'models', 'ggml-base.bin');

class WhisperError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.code = code; }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

function groupWordTokens(tokens) {
  const words = [];
  let current = null;
  const finish = () => {
    if (current && current.text.trim()) {
      const text = current.text.trim();
      if (Number.isSafeInteger(current.startMs) && Number.isSafeInteger(current.endMs) &&
          current.endMs > current.startMs) {
        words.push({ text, startMs: current.startMs, endMs: current.endMs,
          confidence: current.confidence, timingStatus: 'approximate' });
      } else words.push({ text, startMs: current.startMs, endMs: current.endMs,
        confidence: current.confidence, timingStatus: 'invalid' });
    }
    current = null;
  };
  for (const token of tokens ?? []) {
    if (typeof token.text !== 'string' || /^\[_/.test(token.text)) continue;
    const begins = /^\s/.test(token.text);
    if (begins) finish();
    if (!current) current = { text: '', startMs: token.offsets?.from,
      endMs: token.offsets?.to, confidence: Number.isFinite(token.p) ? token.p : null };
    current.text += token.text;
    current.endMs = token.offsets?.to;
    if (Number.isFinite(token.p)) current.confidence = current.confidence === null ?
      token.p : Math.min(current.confidence, token.p);
  }
  finish();
  return words;
}

function decodeWhisperJson(data) {
  if (data?.model?.type !== 'base' || data.model.multilingual !== true ||
      !Array.isArray(data.transcription)) {
    throw new WhisperError('INVALID_MODEL_OUTPUT', 'whisper.cpp no devolvió el modelo base multilingüe o segmentos válidos.');
  }
  return { language: data.result?.language ?? null,
    segments: data.transcription.map((item) => ({
      text: item.text ?? '', startMs: item.offsets?.from, endMs: item.offsets?.to,
      words: groupWordTokens(item.tokens),
    })) };
}

async function createWhisperCppAdapter(options = {}) {
  const binaryPath = path.resolve(options.binaryPath ?? defaultBinary);
  const modelPath = path.resolve(options.modelPath ?? defaultModel);
  const threads = options.threads ?? 4;
  const language = options.language ?? 'es';
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 16 || language !== 'es') {
    throw new WhisperError('INVALID_OPTIONS', 'Se requiere número de hilos válido e idioma español.');
  }
  if (!(await fs.stat(binaryPath).then((s) => s.isFile(), () => false))) {
    throw new WhisperError('BINARY_UNAVAILABLE', 'No se encontró whisper-cli.exe.');
  }
  const modelSha256 = await sha256(modelPath).catch((error) => {
    throw new WhisperError('MODEL_UNAVAILABLE', 'No se encontró el modelo base.', error);
  });
  if (modelSha256 !== expectedBaseSha256) {
    throw new WhisperError('MODEL_HASH_MISMATCH', 'El modelo base no coincide con el SHA-256 oficial registrado.');
  }
  let version;
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    version = `${stdout}${stderr}`.match(/whisper\.cpp version:\s*([\w.\-]+)/)?.[1];
  } catch (error) { throw new WhisperError('BINARY_FAILED', 'whisper-cli.exe no se pudo ejecutar.', error); }
  if (!version) throw new WhisperError('BINARY_FAILED', 'No se pudo verificar la versión de whisper.cpp.');
  return { id: 'whisper.cpp', version, parameters: { model: 'base', modelSha256,
    threads, language, wordTiming: 'token_approximate' },
  async run({ inputPath }) {
    const outputBase = path.join(path.dirname(inputPath), `.whisper-${randomUUID()}`);
    const outputJson = `${outputBase}.json`;
    const started = performance.now();
    try {
      await execFileAsync(binaryPath, ['-m', modelPath, '-f', inputPath, '-l', language,
        '-ojf', '-of', outputBase, '-ng', '-t', String(threads)],
      { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
      const raw = JSON.parse(await fs.readFile(outputJson, 'utf8'));
      return { ...decodeWhisperJson(raw), wallTimeMs: Math.round(performance.now() - started) };
    } catch (error) { throw new WhisperError('INFERENCE_FAILED', 'Falló la inferencia de whisper.cpp.', error); }
    finally { await fs.rm(outputJson, { force: true }); }
  } };
}

module.exports = { createWhisperCppAdapter, decodeWhisperJson, groupWordTokens, WhisperError };
