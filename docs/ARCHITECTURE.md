# Arquitectura propuesta

## Alcance y flujo

Solo se aceptarán archivos de audio. Están implementados el sondeo, la preparación PCM, el muestreo, la transcripción completa de `prueba.wav` con whisper.cpp, candidatos de riesgo y MUTE PCM automático conservador. DeepFilterNet produjo un derivado experimental de M05 que el usuario rechazó por distorsión grave de conversaciones; no es una opción predeterminada. La transcripción de la hora está técnicamente completa, pero sin validación auditiva.

```text
audio original (solo lectura)
  → inspección y decodificación (ffprobe/FFmpeg)
  → referencia temporal PCM
  ├─→ separación/reducción de ruido (opcional; motor pendiente)
  └─→ transcripción del original o derivado verificado (whisper.cpp; muestras verificadas)
         → candidatos de riesgo → reglas automáticas conservadoras / revisión manual → intervalos aprobados
              → MUTE sobre original o pista separada alineada
                   → WAV PCM + informes JSON
```

Cada etapa que tenga entradas, configuración y versión de modelo idénticas podrá recuperar su resultado desde `cache/`. Los fallos deben detener la exportación final y dejar un estado diagnosticable, sin sobrescribir el audio original.

## Módulos previstos

| Módulo | Responsabilidad | Salida prevista |
| --- | --- | --- |
| CLI/orquestador (Node.js) | Validar rutas y opciones; ejecutar etapas; registrar estado | Manifiesto del trabajo |
| Sondeo (Node.js + ffprobe, implementado) | Verificar archivo legible y pistas de audio; obtener duración, códec, canales, frecuencia, índice y tamaño | JSON `probe 1.0` |
| Preparación (Node.js + FFmpeg, implementado) | Seleccionar una pista y decodificar a WAV PCM float32 sin resampleo ni mezcla | WAV e informe JSON en `output/prepared/` |
| Separación/mejora (adaptador de ejecutable o Python) | Proponer pista de habla reduciendo música/ruido; comprobar voces y alineación | Pista candidata y metadatos del modelo; DeepFilterNet solo en ensayo |
| Conservación de habla | Distinguir habla de canto y otras voces mediante señales adicionales y reglas revisables | Pista candidata y segmentos de habla |
| Transcripción (Node.js + whisper.cpp, muestras reales) | Fragmentar, recuperar y referir tiempos al original | JSON de transcripción parcial; hora bloqueada por calidad |
| Análisis de riesgo (Node.js, candidatos léxicos; contexto humano pendiente) | Proponer hallazgos con contexto y motivo | JSON de hallazgos revisables |
| Edición/exportación (Node.js, PCM implementado) | Silenciar intervalos aprobados sobre la pista candidata | WAV PCM con duración conservada |
| Informes/caché (Node.js) | Registrar procedencia, tiempos, acciones y claves de reutilización | JSON y derivados reutilizables |

La evaluación toma el WAV preparado o un WAV PCM original y crea recortes de 15–30 segundos en `output/samples/` con un manifiesto JSON. Estos recortes no son una etapa de limpieza. Node.js conserva la orquestación y cada modelo podrá tener un adaptador Python o ejecutable aislado. `block-processing.js` ya prepara ejecución secuencial, reanudación y unión de núcleos PCM; requiere un adaptador real y aún no tiene CLI. La ruta independiente de contenido acepta el original o una pista mejorada **solo con alineación verificada**, y consta de transcripción por fragmentos, candidatos de riesgo, revisión y MUTE. Su estado y límites están en [CONTENT_PIPELINE.md](CONTENT_PIPELINE.md); la separación experimental, en [PHASE_4B.md](PHASE_4B.md).

La separación *vocals/instrumental* no garantiza aislar habla: suele incluir canto, coros y efectos vocales. La conservación de habla requerirá evaluación adicional y revisión de casos ambiguos; no se promete eliminación perfecta de música o ruido.

## Tiempo y sincronización

- Usar el comienzo del audio original como `t=0`. Guardar intervalos como `[start_ms, end_ms)` con enteros y sin solapamientos tras normalización.
- Mantener un mapa explícito entre muestras PCM y tiempo: `sample_index = round(ms × sample_rate / 1000)`. Conservar la duración original medida en muestras y los parámetros de decodificación.
- Toda pista separada y toda transcripción debe referirse a la línea temporal original. Compensar latencia, desplazamiento y padding introducidos por modelos antes de combinar pistas.
- Por defecto, silenciar muestras dentro de los intervalos seleccionados, sin cortar ni reordenar audio. Aplicar fundidos breves dentro del intervalo cuando sean necesarios para evitar clics. Ajustar o rellenar la exportación a la duración original y verificar la diferencia de muestras o la tolerancia del códec.
- Si un modelo entrega tiempos imprecisos, ensanchar límites de forma configurada y registrar los límites originales y finales. Evitar silenciar tramos ambiguos de forma irreversible sin trazabilidad.

## Formatos y contratos

Los contratos implementados de sondeo y preparación, y las estructuras mínimas reservadas para etapas posteriores, se describen en [CONTRACTS.md](CONTRACTS.md). El sondeo conserva la primera pista como candidata por compatibilidad. La preparación la acepta automáticamente solo cuando es la única pista válida; con varias exige un índice explícito. Una duración desconocida se representa con `null` y exige resolución antes de cualquier edición dependiente del tiempo total.

- Entrada: archivo de audio original de solo lectura. Se determinarán extensiones y códecs admitidos mediante pruebas con FFmpeg en la fase de implementación.
- Intermedio implementado: WAV PCM float32, con frecuencia y canales de la pista seleccionada, en `output/prepared/`. No se convierte automáticamente a 16 kHz mono; esa representación, si se requiere, será un derivado posterior para transcripción. El nombre incluye un identificador de ruta, contenido, índice y formato; un resultado existente nunca se sobrescribe. Una fase posterior podrá mover estos derivados a `cache/`.
- Salida: formato de audio seleccionable; se definirán perfiles de códec y nombre estable antes de implementar la exportación.
- JSON UTF-8 versionado (`schemaVersion`) para los intercambios entre módulos. Todos los tiempos se expresarán en milisegundos respecto del original. El informe futuro registrará identidad criptográfica del original, versiones de herramientas/modelos, configuración, intervalos de riesgo, razón, confianza, decisión de edición, intervalos finales y duración de entrada/salida.
- La transcripción incluirá texto, idioma, intervalos y, cuando el modelo lo permita, palabras con tiempos. Los hallazgos mantendrán evidencia y contexto suficiente para auditar la decisión sin asumir que la transcripción sea perfecta.

## Análisis de riesgos y edición

La idoneidad publicitaria depende del contexto y de criterios externos cambiantes. El análisis deberá considerar expresiones, intención, contexto próximo y posibles errores de reconocimiento. Un hallazgo es una sugerencia revisable con explicación y nivel de confianza, no una garantía de monetización. La política de qué niveles se silencian automáticamente será configurable y se definirá antes de implementar esa etapa.

La edición tomará la unión normalizada de intervalos aprobados, la aplicará a la pista de habla conservada y registrará cada acción. El audio original nunca es destino de escritura.

## Caché y seguridad de archivos

- Calcular una clave por etapa a partir de SHA-256 del contenido original, nombre/versión de etapa, parámetros relevantes, versión de herramienta/modelo y clave de etapas anteriores.
- Escribir primero en un archivo temporal y publicar el derivado solo tras validarlo. Un resultado parcial o con versión distinta no se reutiliza.
- Guardar archivos derivados y metadatos en `cache/`, exportaciones e informes en `output/`. Ambos directorios están ignorados por Git.
- Resolver rutas y rechazar destinos que coincidan con el origen. Nunca editar ni mover el archivo original, incluidos los que estén fuera de `input/`.
- `limpiar-temporales --dry-run` enumera solo archivos temporales huérfanos con patrón UUID del proyecto, más de 24 horas de antigüedad y un único enlace, dentro de tres rutas de trabajo permitidas. Los bloques de transcripción, los recortes pendientes de revisión, los resultados y los modelos quedan protegidos. La eliminación manual requiere el hash del plan; se vuelven a validar ruta, tipo, tamaño y metadatos de cada archivo. No se borran carpetas ni se activa limpieza automática mientras falten resultados finales verificados o decisiones pendientes.
