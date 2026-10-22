# Protocolo de muestras y comparación

## Preparación de casos reales

Seleccionar, con permiso de uso, un audio local representativo de cada caso. Los tres recortes reales de `prueba.wav` obtenidos en fase 4B aún no se han escuchado ni clasificado como A–E; ver [PHASE_4B.md](PHASE_4B.md). Preparar la pista con `--prepare` y usar su JSON para recortar de 15 a 30 segundos:

```powershell
npm.cmd run limpiar-audio -- --input "C:\audio\conversacion.wav" --prepare
npm.cmd run sample-audio -- --prepared-metadata "output\prepared\archivo--id.json" --case A --start-ms 10000 --duration-ms 20000
```

La segunda orden usa `ffmpeg` para extraer muestras PCM float32 a `output/samples/` y escribe un JSON con ruta, caso, intervalo respecto del original, frecuencia, canales y número de muestras. No separa fuentes ni evalúa calidad. `--ffmpeg-path` y `--ffprobe-path` permiten indicar ejecutables fuera de `PATH`. Los archivos de prueba generados por tests solo verifican la función de recorte: **no** se usan para juzgar calidad perceptual.

| Caso | Fragmento que debe elegirse |
| --- | --- |
| A | Conversación sin música; referencia de conservación de voces. |
| B | Conversación con música instrumental claramente audible. |
| C | Conversación con canción y cantante simultáneos. |
| D | Dos o más participantes hablando a la vez, con voces reconocibles en el original. |
| E | Conversación con ruido ambiental y efectos transitorios. |

Para cada candidato, procesar **exactamente la misma muestra** y conservar original, muestra y salida por separado. Anotar versión/peso, parámetros, prompt, dispositivo, tiempo de pared y pico aproximado de memoria del proceso o árbol; repetir si hay variación notable. Ninguna salida de modelo se acepta solo porque se oye más baja.

## Comparación

| Dimensión | Medida objetiva posible | Escucha obligatoria |
| --- | --- | --- |
| Claridad del habla | Métricas de inteligibilidad solo si existe referencia adecuada; una transcripción automática futura puede orientar, pero puede errar. | ¿Se entienden palabras y consonantes al mismo volumen de escucha? |
| Conservación de todas las voces | Si hay anotaciones manuales por hablante, presencia por intervalos; sin referencias limpias no hay puntuación fiable. | Escuchar cada voz, especialmente voces bajas y habla simultánea; registrar pérdidas. |
| Reducción de música y ruido | Energía por segmentos **etiquetados** sin habla; SDR/SNR solo con fuentes de referencia reales. | ¿Se redujo fondo sin borrar habla ni dejar cantante dominante? |
| Distorsión | Clipping, picos y discontinuidades detectables; no prueban naturalidad. | ¿Hay sonido metálico, burbujeo, bombeo o consonantes cortadas? |
| Duración y alineación | `sampleCount`, frecuencia, diferencia de duración y offset estimado por correlación en tramos estables; la correlación puede ser engañosa tras separación. | ¿Permanece la conversación en su momento original? |
| Rendimiento | Tiempo de pared, factor tiempo real y pico RSS/VRAM cuando haya medidor disponible. | No aplica. |

Registro manual por caso y modelo: `claridad`, `vocesConservadas`, `musica`, `ruido`, `distorsion`, `alineacion` en escala ordinal 0–4 **solo después de escuchar**; anotar observaciones concretas y `pasa: true/false`. Las voces ausentes, especialmente en D, son fallo crítico aunque otras dimensiones mejoren. La escala no se completa automáticamente ni se promedian casos para ocultar fallos. Antes de comparar, igualar el volumen de reproducción para evitar sesgo perceptual; esa igualación no modifica los archivos exportados.

La separación se evaluará aparte del futuro análisis de idoneidad. El habla problemática se silenciará más adelante en intervalos manteniendo duración; nunca se recortará automáticamente.
