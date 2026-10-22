# Diagnóstico y evaluación de modelos (20-10-2026)

## Equipo observado, sin cambios de sistema

| Recurso | Resultado |
| --- | --- |
| Sistema | Windows 11, compilación 26200, x64 |
| CPU | AMD Ryzen 7 7730U with Radeon Graphics; 16 procesadores lógicos |
| RAM | 13,84 GiB totales; 1,73 GiB disponibles en el momento del sondeo |
| GPU | AMD Radeon (TM) Graphics integrada; registro de Windows informa 2 GiB de memoria de adaptador, posiblemente compartida. VRAM física dedicada no verificada. |
| NVIDIA CUDA | No se detectó GPU NVIDIA ni `nvidia-smi`; no hay CUDA utilizable verificado. |
| Software | Python 3.14.6; Node.js 24.15.0; FFmpeg y FFprobe 8.1.2 |
| Disco C: | 102,99 GiB libres de 475,90 GiB. La disponibilidad puede variar. |

WMI denegó acceso; RAM y disco se consultaron con APIs de Windows y el nombre de GPU/memoria de adaptador provino del registro. `torch` y `psutil` no están instalados. La memoria disponible baja aconseja cerrar otros procesos antes de ensayos de modelos, sin asumir que 2 GiB de adaptador equivalen a VRAM CUDA.

## Alternativas

| Modelo | Objetivo y beneficio posible | Windows, Python 3.14.6 y hardware | Música sobre habla, canto y varias voces | Licencia y acceso |
| --- | --- | --- | --- | --- |
| [SAM Audio](https://github.com/facebookresearch/sam-audio) | Aislar un sonido descrito por texto, p. ej. `people speaking`. Se aproxima mejor al objetivo semántico de conservar conversaciones. | El proyecto pide Python >=3.11 y **recomienda GPU CUDA**; no publica una cifra oficial de RAM/VRAM para inferencia. Sus dependencias PyTorch y repositorios externos no se han verificado para Python 3.14.6 ni para este Windows con AMD. Con 1,73 GiB de RAM libre y sin CUDA, la ejecución local queda sin viabilidad demostrada. | Puede separar habla de música mejor que una pista `vocals` en principio, pero el prompt puede omitir voces débiles, simultáneas o confundir canto. Hay que probar `people speaking` frente a otros prompts en los cinco casos, escuchando todas las voces. | [Licencia SAM](https://github.com/facebookresearch/sam-audio/blob/main/LICENSE), con condiciones propias; [pesos con acceso sujeto a aceptación en Hugging Face](https://huggingface.co/facebook/sam-audio-small). No se solicitó acceso ni se descargó nada. |
| [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) | Mejorar habla y suprimir ruido; no distingue semánticamente conversación de canto. | Binario oficial 0.5.6 Windows x64 CPU probado a 48 kHz, sin Python; ~81 MB de working set observado y 4,846 s para M05. | **Rechazado:** el usuario encontró la conversación gravemente distorsionada; M05/M25 pasaron a `[Música]` en ASR. La conversión aislada no causó este cambio. | Código de [doble licencia MIT/Apache-2.0](https://github.com/Rikorose/DeepFilterNet#license); ejecutable de [release oficial](https://github.com/Rikorose/DeepFilterNet/releases/tag/v0.5.6). |
| [Demucs](https://github.com/facebookresearch/demucs) | Separar fuentes musicales (`vocals`, batería, bajo y otros). Es una línea base para música, no para habla pura. | Hay [guía Windows](https://github.com/facebookresearch/demucs/blob/main/docs/windows.md) y modo CPU. El README estima >=3 GiB de VRAM, ~7 GiB con ajustes predeterminados; la GPU local no cumple la ruta CUDA. [PyPI 4.1.0](https://pypi.org/project/demucs/) declara Python >=3.10, pero PyTorch/torchaudio y Python 3.14.6 en este equipo no se han probado. CPU puede requerir más RAM de la disponible ahora. | `vocals` puede conservar habla y canto juntos; la música mezclada con habla puede filtrarse imperfectamente. Es probable que capture varias voces, pero no hay garantía con intervenciones simultáneas. | [MIT](https://github.com/facebookresearch/demucs/blob/main/LICENSE), paquete abierto en [PyPI](https://pypi.org/project/demucs/); los pesos se obtendrían al ejecutar modelos. El repositorio original indica mantenimiento limitado. |

La información de memoria de Demucs procede de su [README oficial](https://github.com/facebookresearch/demucs#memory-requirements-for-gpu-acceleration). Las otras cifras de memoria no se inventan: deben medirse con versión, configuración y duración fijadas. La compatibilidad de Python declarada por un paquete no demuestra que toda su cadena de dependencias funcione en 3.14.6.

## Recomendación provisional

**Ensayo local rechazado: DeepFilterNet 0.5.6 en CPU.** El usuario escuchó M05 y encontró las conversaciones gravemente distorsionadas. La conversión de formato sin modelo conservó prácticamente la señal; el filtrado cambió mucho el audio. No se promueve. Ver [diagnóstico y controles](QUALITY_DIAGNOSIS_M05.md).

**Candidato de investigación para aislamiento de conversaciones: SAM Audio**, pendiente de acceso a pesos y hardware viable. No está probado en este Windows CPU con ~1,9 GiB de RAM libre; no se recomienda instalarlo aquí todavía. Demucs queda como comparación musical, no como solución de habla frente a canto. Ninguna alternativa está aprobada para limpieza automática.

## Criterios para el siguiente ensayo

1. Reunir los cinco audios reales y generar un recorte de 15–30 s por caso con `sample-audio`. Guardar el caso A como referencia de voces que no deben perderse.
2. Verificar un modelo **distinto**, dirigido a habla frente a música, su licencia, recursos y disponibilidad Windows CPU antes de cualquier descarga grande. No reutilizar DeepFilterNet como filtro predeterminado.
3. Crear un adaptador **independiente** que reciba ruta de muestra y ruta de salida, y devuelva WAV más JSON con versión, parámetros, tiempo y memoria. Si requiere 48 kHz, generar un derivado FFmpeg con frecuencia explícita, sin tocar el WAV preparado ni cambiar canales salvo requisito comprobado.
4. Comparar cada salida con la misma muestra original usando el protocolo de [EVALUATION.md](EVALUATION.md). Empezar por A y E para detectar daño al habla y utilidad ante ruido; ejecutar también B, C y D antes de decidir. Rechazar la promoción si se pierde un participante o queda canto dominante en el escenario objetivo.
5. Solo después de resultados satisfactorios, añadir a Node.js una llamada a ese adaptador con selector de modelo y contrato de salida. La separación seguirá independiente del futuro análisis de idoneidad y nunca recortará automáticamente el audio.
