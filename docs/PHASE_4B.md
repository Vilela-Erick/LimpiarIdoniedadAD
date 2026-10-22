# Fase 4B: audio real y estado de la prueba

## Fuente y muestras (20-10-2026)

`input/prueba.wav` es un único stream de audio (índice 0), RIFF/WAV PCM `pcm_s16le`, 44 100 Hz, 2 canales, 161 249 280 muestras por canal, 3 656,446259 s (1:00:56,446) y 644 997 198 bytes. SHA-256 antes y después del muestreo: `E01D519946CA44633AD159D0D558114AB5DBD670A6790106DF947C4428D94EF0`. FFprobe no declara `start_time`; el recorte por índice de muestra refiere al inicio del PCM, sin afirmar una alineación acústica externa al archivo. No se preparó una copia de la hora completa.

| Recorte | Intervalo en el original | Archivo en `output/samples/` | Resultado medido |
| --- | --- | --- | --- |
| M05 | 05:00–05:30 | `M05--0b6f2705996bd1c6d104.wav` y `.json` | 1 323 000 muestras/canal, 30 s |
| M25 | 25:00–25:30 | `M25--9ca0892449bf2c0e51e4.wav` y `.json` | 1 323 000 muestras/canal, 30 s |
| M50 | 50:00–50:30 | `M50--39f9acc7bc693e1e6605.wav` y `.json` | 1 323 000 muestras/canal, 30 s |

Cada muestra es WAV PCM float32 a 44 100 Hz estéreo (10 584 092 bytes). Son fragmentos originales decodificados; `evaluationStatus` sigue siendo `not_evaluated`. No se han escuchado ni clasificado sus contenidos A–E.

## Motor y decisión de ejecución

DeepFilterNet sigue siendo el primer candidato para una **línea base de reducción de ruido**. El [proyecto oficial](https://github.com/Rikorose/DeepFilterNet) documenta un ejecutable `deep-filter` precompilado que requiere entrada WAV a 48 kHz y publica [releases](https://github.com/Rikorose/DeepFilterNet/releases); el código declara MIT/Apache-2.0. No se verificó aún un artefacto Windows x64 concreto, su checksum, el peso incluido ni su consumo en este equipo. `deep-filter` no está instalado o disponible en `PATH`. No se instaló PyTorch ni se descargaron pesos. El PCM original a 44,1 kHz requeriría un derivado de 48 kHz para ese ejecutable; no se creó porque el motor no está disponible.

Por ello **no se procesaron las muestras con IA ni la hora completa**. No existen resultados A/B, puntuaciones perceptuales, tiempo ni memoria de inferencia medidos. No se generó `output/cleaned/prueba_voces.wav`. DeepFilterNet tampoco promete separar cantantes de voces habladas; la conservación de cada participante, risas y habla simultánea sigue pendiente de escucha.

## Infraestructura de bloques

`src/block-processing.js` expone `processBlocks` para un futuro adaptador real `{ id, version, parameters, run }`; no tiene CLI de limpieza. Lee por stream y muestras PCM, procesa un bloque a la vez y permite longitud de núcleo configurable (30 s por defecto) y contexto de solapamiento configurable. Cada bloque procesa `[expandedStart, expandedEnd)` y guarda solo `[coreStart, coreEnd)` en PCM float32 crudo. La unión concatena núcleos contiguos sin duplicar muestras ni añadir fundidos. **Esta estrategia evita duplicación y pérdida de duración, pero no garantiza continuidad perceptual en los bordes**; el modelo concreto determinará el solapamiento necesario y se deberá escuchar cada borde. No corrige latencia ni padding del modelo: rechaza un offset declarado distinto de cero y una cantidad de muestras distinta; un offset acústico no declarado sigue sin verificar.

Cada bloque terminado registra SHA-256, intervalo, tiempo de pared del adaptador y pico de memoria **solo si el adaptador lo informa**. La clave incluye SHA-256 del origen, ruta, stream, modelo, versión, parámetros y tamaño/solapamiento. Bloques validados se reutilizan al reanudar; archivos temporales de un bloque fallido se eliminan. Antes de cada bloque hay una comprobación conservadora de espacio libre. Se publica salida e informe sin sobrescribir. El informe marca `processed_pending_listening` y `qualityApproved: false`. Para el WAV de esta hora, la salida float32 prevista cabría en RIFF, pero faltan motor, evaluación, métricas y validación de alineación para ejecutarla.

Las pruebas automáticas emplean un adaptador de **copia de prueba** para verificar reanudación, unión y fallos. Ese adaptador no limpia audio y nunca se usó sobre `prueba.wav`.

## Siguiente ensayo

Verificar un binario Windows x64 auténtico de DeepFilterNet con licencia, versión, peso y checksum; después ensayar M05/M25/M50 en CPU usando derivados 48 kHz separados. Medir duración, offset, tiempo, RAM y espacio; escuchar cada voz y comparar fondo y artefactos. Solo entonces decidir si se intenta la hora completa por bloques. Si DeepFilterNet reduce voces o no atenúa música/canto, evaluar otro modelo de separación semántica antes de promover una salida como limpia.
