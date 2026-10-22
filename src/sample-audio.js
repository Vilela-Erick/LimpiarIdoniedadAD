#!/usr/bin/env node

const { parseSampleArgs, createEvaluationSample } = require('./evaluation-sample');

const help = `Muestras de evaluación (solo recorte, sin limpieza)

Uso:
  npm run sample-audio -- --prepared-metadata <prepare.json> --case A --start-ms 0 --duration-ms 20000
  npm run sample-audio -- --input <pcm.wav> --label M05 --start-ms 300000 --duration-ms 30000

Casos: A conversación; B música instrumental; C canción con cantante;
       D habla simultánea; E ruidos y efectos.
Opciones: --stream-index <n> --ffmpeg-path <ruta> --ffprobe-path <ruta> --help
`;

async function main() {
  try {
    const options = parseSampleArgs(process.argv.slice(2));
    if (options.help) return process.stdout.write(help);
    const result = await createEvaluationSample(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Error: ${error.code ?? 'SAMPLE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
