#!/usr/bin/env node

const { probeAudio, ProbeError } = require('./probe-audio');
const { prepareAudio } = require('./prepare-audio');
const { runTranscription } = require('./transcription-run');

const help = `limpiarAudio — sondeo de audio

Uso:
  npm run limpiar-audio -- --help
  npm run limpiar-audio -- --input "input/prueba.mp3" --probe
  npm run limpiar-audio -- --input "input/prueba.mp3" --prepare [--stream-index 0]
  npm run limpiar-audio -- --input "input/prueba.wav" --transcribe

Opciones:
  --help                 Muestra esta ayuda.
  --input <ruta>         Archivo de audio que se inspeccionará.
  --probe                Imprime metadatos JSON; no modifica el archivo.
  --prepare              Crea un WAV PCM de trabajo y metadatos JSON.
  --transcribe           Ejecuta Whisper sobre M05/M25/M50; la hora exige revisión de calidad.
  --quality-review <ruta> JSON de aprobación explícita para continuar con la hora.
  --stream-index <n>     Índice real de pista de audio para --prepare.
  --ffprobe-path <ruta>  Ejecutable de ffprobe (predeterminado: PATH).
  --ffmpeg-path <ruta>   Ejecutable de ffmpeg (predeterminado: PATH).

La reducción de música y el MUTE se añadirán en fases futuras; no se ejecutan con --transcribe.
`;

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };

  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--probe' || argument === '--prepare' || argument === '--transcribe') {
      const key = argument.slice(2);
      if (options[key]) throw new Error(`Argumento repetido: ${argument}`);
      options[key] = true;
    } else if (['--input', '--ffprobe-path', '--ffmpeg-path', '--stream-index', '--quality-review'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Falta un valor para ${argument}`);
      const key = { '--input': 'input', '--ffprobe-path': 'ffprobePath',
        '--ffmpeg-path': 'ffmpegPath', '--stream-index': 'streamIndex',
        '--quality-review': 'qualityReviewPath' }[argument];
      if (Object.hasOwn(options, key)) throw new Error(`Argumento repetido: ${argument}`);
      if (key === 'streamIndex') {
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new Error('--stream-index debe ser un entero no negativo.');
        }
        options[key] = Number(value);
      } else options[key] = value;
    } else {
      throw new Error(`Argumento desconocido: ${argument ?? '(ninguno)'}`);
    }
  }

  if (!options.input || [options.probe, options.prepare, options.transcribe].filter(Boolean).length !== 1) {
    throw new Error('Se requieren --input <ruta> y exactamente uno de --probe, --prepare o --transcribe. Use --help.');
  }
  if (options.probe && (options.streamIndex !== undefined || options.ffmpegPath !== undefined)) {
    throw new Error('--stream-index y --ffmpeg-path solo se admiten con --prepare.');
  }
  if (options.qualityReviewPath && !options.transcribe) {
    throw new Error('--quality-review solo se admite con --transcribe.');
  }
  if (options.transcribe && options.streamIndex !== undefined) {
    throw new Error('--stream-index no se admite con --transcribe en esta fase.');
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help);
      return;
    }
    const result = options.probe ? await probeAudio(options.input, { ffprobePath: options.ffprobePath }) :
      options.prepare ? await prepareAudio(options.input, options) :
        await runTranscription({ inputPath: options.input, ...options,
          onProgress: (event) => process.stderr.write(`Progreso: ${JSON.stringify(event)}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const label = error instanceof ProbeError || error.code ? `${error.code}: ` : '';
    process.stderr.write(`Error: ${label}${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
