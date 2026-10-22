# Decisiones técnicas

Registro de decisiones de arquitectura. Las opciones futuras siguen sujetas a validación durante su fase.

## D-001 — CLI sin dependencias en la fase 1

**Decisión:** usar Node.js y su ejecutor de pruebas integrado para mostrar ayuda y comprobarla.

**Motivo:** permite validar la estructura sin instalar paquetes ni modelos antes de definir contratos de procesamiento.

## D-002 — Entrada inmutable y duración preservada por defecto

**Decisión:** el original se tratará como solo lectura; se producirán archivos derivados. La edición prevista aplica silencio en intervalos, no cortes.

**Motivo:** facilita auditoría, reversibilidad y sincronización con el contenido fuente.

## D-003 — Tiempo referido al original

**Decisión:** los JSON usarán milisegundos enteros desde el inicio original y los cambios en PCM usarán índices de muestra.

**Motivo:** evita mezclar bases temporales de modelos y reduce deriva acumulada.

## D-004 — Separación y riesgo como resultados revisables

**Decisión:** no equiparar una pista *vocals* con habla pura ni una clasificación de riesgo con idoneidad garantizada.

**Motivo:** el canto puede permanecer en la pista vocal y el juicio publicitario depende del contexto y de criterios de plataforma.

## D-005 — Caché por contenido, configuración y versiones

**Decisión:** los resultados de cada etapa se reutilizarán solo si coinciden la identidad del origen, los parámetros y las versiones de herramientas/modelos.

**Motivo:** evita recomputación sin mezclar derivados incompatibles.

## D-006 — Sondeo de solo lectura con ffprobe

**Decisión:** ejecutar `ffprobe` mediante `execFile`, con argumentos separados, desde un módulo Node.js reutilizable; aceptar su ruta mediante `--ffprobe-path`. Rechazar pistas de video reales, permitiendo carátulas adjuntas.

**Motivo:** identifica audio por las pistas declaradas en el archivo, funciona con rutas Windows que contienen espacios y evita ejecutar comandos mediante shell. No requiere cargar el audio completo ni instalar paquetes npm.

## D-007 — Duración y pistas múltiples explícitas

**Decisión:** usar la duración del contenedor cuando exista; en su ausencia, la mayor duración declarada por pistas válidas; si ninguna existe, `null`. Exponer todas las pistas válidas y marcar la primera como candidata inicial, sin mezclarla.

**Motivo:** no inventar una duración ni ocultar la existencia de varias pistas. La política de selección definitiva corresponde a una fase posterior.

## D-008 — Selección explícita al preparar varias pistas

**Decisión:** una única pista válida se prepara automáticamente; con varias se exige `--stream-index` y se usa el índice real de FFprobe en `-map`.

**Motivo:** evita preparar la pista equivocada o mezclar contenido sin una decisión del usuario. El JSON de `--probe` mantiene su contrato anterior.

## D-009 — WAV PCM float32 como pista de trabajo

**Decisión:** FFmpeg decodifica a `pcm_f32le`, manteniendo frecuencia y canales cuando el decodificador los admite. El archivo va a `output/prepared/`, con identidad basada en ruta, SHA-256 del contenido, índice y formato; no se sobrescribe y los temporales se eliminan ante fallos.

**Motivo:** float32 es compatible con modelos de audio y conserva exactamente muestras PCM enteras de hasta 24 bits al convertirlas; cuesta cuatro bytes por muestra y puede perder precisión de PCM entero de 32 bits. Una copia mono a 16 kHz reduciría información útil para separación de fuentes.

## D-010 — Sincronización conservadora

**Decisión:** registrar tiempos de inicio del contenedor y la pista. Rechazar offsets no nulos detectados; marcar como no verificada la alineación cuando falten tiempos. Informar duración y muestras del WAV y la diferencia respecto a la pista original, sin recortar ni rellenar.

**Motivo:** FFmpeg puede desplazar marcas temporales al crear WAV y los códecs con pérdida pueden introducir padding. La preparación no debe afirmar una alineación que no ha probado.

## D-011 — Evaluación antes de integrar separación

**Decisión:** crear recortes de audios reales desde el WAV preparado y comparar candidatos con el mismo conjunto A–E. Ensayar primero DeepFilterNet en CPU como línea base de ruido; mantener SAM Audio como candidato de aislamiento semántico si se dispone de entorno compatible. Ninguno se integra todavía en la CLI de limpieza.

**Motivo:** la GPU AMD local no aporta CUDA verificado y solo había 1,73 GiB de RAM libre al diagnosticar. DeepFilterNet declara soporte Windows, mientras que SAM Audio recomienda CUDA y exige acceso a pesos. La capacidad de preservar todas las voces y quitar canto debe probarse escuchando, no inferirse del nombre del modelo.

## D-012 — Prueba directa de PCM y bloques reanudables

**Decisión:** extraer muestras del WAV PCM real mediante índices de muestra sin preparar una segunda copia de la hora. Diseñar el procesamiento largo con bloques secuenciales, contexto solapado opcional y unión de núcleos no solapados. Validar hash y longitud antes de reutilizar un bloque; publicar salida solo tras verificar muestras.

**Motivo:** reduce uso de disco y RAM, permite continuar tras fallos y conserva cantidad de muestras. La unión no garantiza ausencia de artefactos perceptuales ni compensa latencia desconocida: ambos requieren evaluación del motor concreto. DeepFilterNet no está disponible en el equipo, por lo que no se ejecuta ni se genera un falso resultado limpio.

## D-013 — Contenido independiente de separación

**Decisión:** mantener transcripción, candidatos léxicos, revisión y MUTE como módulos independientes de la reducción de música. Exigir alineación verificada para transcripción o audio mejorado externos. Ninguna coincidencia léxica aprueba silencio por sí misma.

**Motivo:** la separación agresiva puede perder voces o perjudicar ASR; el original puede ser una referencia mejor. Las reglas de YouTube dependen del contexto, y un tiempo de palabra incorrecto podría silenciar habla inocua.

## D-014 — Primera opción ASR y edición PCM

**Decisión:** evaluar whisper.cpp base multilingüe en CPU antes de descargar modelos, con fragmentos recuperables y tiempos inválidos retenidos para revisión. Aplicar MUTE directamente sobre WAV PCM s16le/f32le en muestras, con márgenes y fundidos externos; rechazar `cut`.

**Motivo:** Windows y CPU están documentados para whisper.cpp sin depender del Python 3.14.6 local. La edición por muestras conserva exactamente la duración y permite verificar silencios sin codificación perceptual adicional. La compatibilidad y memoria reales del binario siguen sin medirse.

## D-015 — Motor ASR verificado y puerta de calidad

**Decisión:** instalar en la caché local el binario oficial CPU x64 `whisper.cpp` b5454 (versión 1.9.5) y `ggml-base.bin` multilingüe, comprobando los SHA-256 publicados. Ejecutar primero M05/M25/M50 y requerir una revisión de calidad vinculada a hashes antes de la hora completa. La ruta larga usa bloques de 30 s y 1,5 s de contexto, asignando segmentos/palabras al núcleo por su punto medio.

**Motivo:** las tres transcripciones reales presentan texto poco plausible, repeticiones y al menos un tiempo fuera del recorte. El buen consumo de RAM no compensa la incertidumbre de reconocimiento ni demuestra preservación de todas las voces. La revisión actual rechaza el procesamiento completo; los resultados parciales siguen disponibles para diagnóstico.

## D-016 — DeepFilterNet como candidato experimental, no como salida conjunta

**Decisión:** probar el binario oficial CPU Windows x64 de DeepFilterNet 0.5.6 en M05 y un control M25, sin incorporarlo aún a la CLI de limpieza. Conservar el derivado M05 como `muestra_deepfilter.wav`, registrar su compensación de retardo y rellenar únicamente las muestras finales faltantes para comparar duración. No producir `muestra_sin_musica.wav` ni `muestra_final.wav` hasta comprobar conservación de conversaciones, música residual y MUTE aprobado.

**Motivo:** el modelo es de mejora de habla ante ruido, no de aislamiento semántico de conversación frente a canto. En ambas muestras, Whisper devolvió solo `[Música]` tras el filtrado, aunque había segmentos en el original. Esa señal exige escucha antes de promover el resultado. No hubo candidatos ni intervalos MUTE aprobados en M05.

## D-017 — Rechazo de DeepFilterNet en M05

**Decisión:** registrar la escucha del usuario como rechazo de `muestra_deepfilter.wav`; no activar DeepFilterNet como filtro predeterminado ni procesar la hora con él. Mantener el original y los artefactos anteriores, y exigir prueba auditiva de inteligibilidad de todos los hablantes antes de aceptar otro motor. La rama de contenido y MUTE aprobado permanece independiente.

**Motivo:** la comparación controlada muestra que la conversión de frecuencia/PCM mantiene prácticamente intacta la señal y los 12 segmentos ASR, mientras la inferencia de DeepFilterNet reduce ~13 dB el RMS y deja un solo `[Música]`. La causa interna exacta de la distorsión no se ha demostrado. [Diagnóstico y controles](QUALITY_DIAGNOSIS_M05.md).

## D-018 — MUTE técnico separado de idoneidad

**Decisión:** aceptar un documento de aprobación explícita con `purpose: "technical_test"`, hash del recorte e intervalo global solo para probar el render PCM de M05. Traducir sus tiempos al recorte, etiquetar la acción como prueba técnica y verificar silencio digital exacto, duración y muestras fuera de márgenes/fundidos. Los hallazgos de riesgo mantienen su revisión independiente.

**Motivo:** M05 no produjo candidatos léxicos, pero era necesario verificar un MUTE real sin fingir una infracción. El primer render float32 escribía `−0,0` al multiplicar muestras negativas por cero; ahora escribe cero binario explícito. Se preservó el artefacto de diagnóstico anterior.

## D-019 — Priorizar separación local y conservar la pista original como referencia

**Decisión:** descartar servicios de pago/API para esta fase. Evaluar primero en M05 un solo modelo local de UVR, `UVR-MDX-NET-Voc_FT.onnx`, sin instalar aún su motor ni pesos. Comparar la pista vocal con el original por escucha de todos los hablantes, música/canto residual y alineación antes de usarla para MUTE.

**Motivo:** Vilela-CLIPS y las instalaciones locales revisadas no ofrecen un separador reutilizable; FFmpeg solo realiza extracción/conversión/edición convencional. MDX-Net puede separar acompañamiento instrumental, pero su pista vocal incluye potencialmente canto y no garantiza conservar habla débil. La RAM libre medida (~2 GiB) desaconseja instalar y ejecutar sin comprobar primero los requisitos reales del motor.

## D-020 — Ensayo UVR-MDX aislado, aún sujeto a escucha

**Decisión:** instalar audio-separator CPU en `.venv` con Python 3.12 paralelo, y ejecutar únicamente M05 con `UVR-MDX-NET-Voc_FT.onnx`, lote 1 y tamaño de segmento nativo 256. Conservar los WAV originales y publicar la pista vocal solo como candidata de comparación, sin conectarla todavía a transcripción o MUTE.

**Motivo:** el ensayo de 10 s funcionó; tamaño 128 forzó conversión ONNX a PyTorch, mientras 256 usó ONNX Runtime CPU en los 30 s. Duración y alineación aproximada coinciden, pero los resultados técnicos no prueban inteligibilidad ni eliminación de cantantes. La revisión auditiva es la siguiente puerta de calidad.

## D-021 — Transcripción completa con incertidumbre explícita y MUTE solo aprobado

**Decisión:** tras la instrucción expresa del usuario, ejecutar la hora con Whisper base en bloques recuperables pese a la baja calidad de las muestras. Etiquetar el texto como no verificado y registrar tiempos inválidos sin inventarlos. Usar el perfil léxico estricto (`sensitivity: low`) para proponer revisión, sin aprobar automáticamente ninguna coincidencia. Renderizar el original solo cuando exista una decisión explícita vinculada al hash de la transcripción y a un intervalo válido; si quedan casos pendientes, etiquetar la salida como preliminar.

**Motivo:** la ausencia de coincidencias en una transcripción defectuosa no prueba idoneidad. YouTube valora frecuencia, prominencia y contexto; una regla léxica solo localiza candidatos. La revisión explícita permite reusar transcripción y caché sin silenciar habla inocua.

## D-022 — Limpieza limitada a temporales huérfanos

**Decisión:** inventariar con `limpiar-temporales --dry-run` y permitir borrado manual solo con el hash del plan vigente. Son elegibles únicamente archivos temporales UUID de más de 24 horas en `output/prepared/`, `output/samples/` y `output/cleaned/`, tras comprobar que son archivos ordinarios con un solo enlace. No se recorren enlaces simbólicos ni se borran carpetas. Los derivados publicados, cachés y recortes de revisión se conservan; la limpieza automática queda desactivada.

**Motivo:** varios WAV aparentemente regenerables son pruebas, comparaciones o evidencia pendiente. Borrarlos por extensión o ubicación impediría verificar calidad o reanudar el trabajo. El plan y la revalidación evitan eliminar un archivo distinto del inventariado.

## D-023 — MUTE automático conservador de groserías fuertes

**Decisión:** por instrucción expresa del usuario, habilitar `autoMute` solo en reglas configuradas como grosería fuerte. Exigir coincidencia léxica completa, tiempo válido dentro del original y confianza ASR mínima 0,90. Una palabra de menor confianza puede aprobarse solo si un recorte cotejado muestra por muestra con el original permite que otra ventana del mismo audio la reconozca con confianza ≥0,95, solapamiento temporal y confianza inicial ≥0,20. Un `dismiss` manual prevalece; las demás categorías y los casos inciertos quedan pendientes. Se registra el tipo de aprobación, regla, tiempos de ambas ventanas y motivo. La salida conserva duración y queda como preliminar si hay pendientes o reducción musical no realizada.

**Motivo:** automatiza términos audibles con evidencia suficiente sin silenciar todas las coincidencias del diccionario. La segunda ventana usa el mismo modelo y no sustituye la escucha; por ello se requieren umbrales altos y se conserva la revisión humana opcional.

## D-024 — Corroboración local con tres ventanas para candidatos intermedios

**Decisión:** mantener las dos aprobaciones previas y aceptar un candidato de grosería fuerte con confianza inicial ≥0,65 solo si ventanas adicionales de 12 y 18 s del original, transcritas con el Whisper existente, reconocen la palabra completa con confianza ≥0,65 y tiempos solapados dentro de 750 ms. Validar hashes de fuente, transcripción y modelo, límites de muestra y tiempos globales antes de usar sus resultados. Silenciar la unión de los tres tiempos más márgenes de 80 ms y fundidos de 5 ms. Las ventanas usan el mismo modelo y el WAV sigue siendo preliminar hasta escucharlo.

**Motivo:** `chucha` a 58:26 apareció en tres ventanas con confianza 0,692/0,795/0,683 y tiempos concordantes; el recorte anterior de 6 s no la había detectado. Los dos candidatos `puta` a 27:37 y 54:37 obtuvieron señales débiles o contradictorias y continúan pendientes. Los 42 intervalos inciertos y 582 tokens sin tiempo se agrupan para revisión localizada, sin asignarles tiempos ficticios. La nueva salida no sobrescribe la versión con dos MUTE.

## D-025 — Primera integración UVR y MUTE acotada a 30 segundos

**Decisión:** reutilizar la pista vocal UVR-MDX ya probada en CPU con lote 1 y segmento 256, ahora sobre el original de 20:06–20:36. Conservar la salida cruda PCM s32 y convertir una copia a PCM f32 sin resampleo para `mute-audio.js`. Tras comprobar igualdad de muestras y desfase estimado en tres ventanas, trasladar el intervalo ya aprobado desde `mutes.json` restando el inicio global de la muestra; aplicar los mismos 80 ms de margen y 5 ms de fundido. Mantener los tres WAV para escucha comparativa y no extender la separación a la hora sin validar inteligibilidad y canto residual.

**Motivo:** el motor de MUTE actual acepta s16/f32; la conversión PCM no agrega filtros ni modifica la duración. La correlación estimó 0 muestras de desfase a 2, 12 y 22 s, pero no demuestra sincronización acústica exacta. El modelo puede conservar cantantes o deteriorar voces secundarias, por lo que una prueba técnica satisfactoria no basta para aprobarlo por calidad.
