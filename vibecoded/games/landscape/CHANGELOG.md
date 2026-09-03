# Changelog

Este archivo documenta la evolución técnica de la demo `landscape`, reconstruyendo la arquitectura y el desarrollo a partir de la progresión real de sus componentes.

## [2026-09-03] - Documentación Integrada

### Docs Viewer
- **Renderizador Markdown:** Implementación de `markdown.js`, un conversor propio y sin dependencias, acotado deliberadamente a las construcciones que usan los cuatro documentos del directorio (encabezados ATX, tablas GFM, bloques de código, listas con continuación, citas y el tramo inline). El escapado se aplica antes que cualquier regla, de modo que ningún documento puede inyectar marcado.
- **Superposición de Lectura:** Introducción de `docs.js`: overlay a pantalla completa con índice lateral por documento, seguimiento del encabezado en curso, memoria de scroll y caché por documento. Enlazable mediante `#docs/<documento>`, dejando intacta la query string que gobierna la pose y los ajustes.

### Input & Interaction
- **Suspensión de Controles:** `input.js` gana `suspend()`/`resume()`, de forma que abrir la documentación libera el puntero y detiene el vuelo en lugar de dejar la cámara desplazándose tras el overlay.
- **Corrección:** Las teclas escritas en un campo de texto dejan de interpretarse como controles de vuelo — hasta ahora, teclear en el campo de coordenadas movía la cámara.

### Panel Layout
- **Rejilla a Dos Columnas:** El panel pasa de 250 a 420 px y dispone controles en `grid` con `auto-fit`, plegándose a una columna cuando no hay ancho. La pila baja de ~1110 px a ~695 px.
- **Reserva de Espacio:** El panel declara un techo de altura y, en modo táctil (`body.touch`), descuenta las esquinas que ocupan el joystick (176 px inferiores) y la columna de botones (76 px a la derecha), de modo que nunca alcanza los controles de vuelo. Antes, fuera de la consulta `max-width: 560px`, el panel carecía de `overflow-y` y su mitad inferior quedaba sencillamente fuera de alcance.
- **Grupos Plegables:** Los controles se agrupan en `<details>` (View, Terrain, Streaming, Sun & motion), con el estado recordado en `localStorage`. El ancho se resuelve solo con `auto-fit`; la altura solo baja si los controles pueden guardarse.
- **Corrección:** `#panel .check { display: flex }` y `#panel label { display: block }` superaban en especificidad a la regla `[hidden]` del navegador, por lo que las cuatro filas que `showDataset()` oculta para el mapa de 2010 permanecían visibles.

### Accesibilidad
- **Diálogo Modal:** El visor declara `role="dialog"` y `aria-modal`, con nombre accesible, `nav` etiquetado y panel de lectura enfocable. Al abrir, el foco entra en el documento; `Tab` queda confinado al diálogo, `Esc` cierra desde cualquier punto y el foco vuelve al control que lo abrió.
- **Posición Anunciada:** `aria-current` marca el documento abierto y el encabezado en curso, que antes solo se distinguían por color.
- **Contraste y Foco:** Los enlaces del índice pasan de 3,75:1 a 7,77:1 sobre el fondo del visor, por encima del 4,5:1 que exige WCAG AA para texto normal, y se añade un anillo de foco visible sobre fondo oscuro.
- **Alcance en Táctil:** Botón `?` junto al resto de controles táctiles: en táctil el panel arranca oculto, de modo que el botón interior no era alcanzable.

### Testing
- **Validación del Renderizador:** `test-markdown.mjs` fija las reglas sobre literales y luego renderiza los cuatro documentos reales, contrastando encabezados, bloques de código, tablas y unicidad de anclas contra un escaneo independiente del fuente.

---

## [2026-09-02] - UI Refinement & Architectural Documentation

### Core & Documentation
- **Architectural Redesign:** Documentación del nuevo diseño estructural (`REDESIGN.md`: especificación técnica de la reconstrucción WebGL/Ray-marching) y de la experiencia de vuelo (`GLOBAL-FLIGHT.md`: diseño del sistema de vuelo con acoplamiento velocidad-zoom y seguimiento de terreno).
- **System Refinement:** Ajustes en el loop principal (`main.js`) y optimización de la interfaz de usuario (`ui.js`).
- **Testing & Tools:** Introducción de `test-window.mjs` para la validación de la ventana de renderizado.

### Terrain & Rendering
- **Tile Management:** Refinamiento de la lógica de `terrain-tiles.js` y `terrain-window.js`.

---

## [2026-09-02] - Navigation & Spatial Awareness

### Camera & Interaction
- **Spatial Navigation:** Refinamiento del sistema de cámara (`camera.js`) y la integración de la lógica de lugares (`places.js`).
- **Input & Tiles:** Ajustes en la interacción táctil y la sincronización de la visualización de tiles.

---

## [2026-08-31] - Data Integration & Terrain Tiling

### Data Pipeline & Environment
- **Imagery System:** Implementación de `imagery.js` para la gestión de texturas satelitales.
- **Terrain Tiling:** Introducción de la lógica de segmentación de terreno (`terrain-tiles.js` y `terrain-window.js`).
- **Environmental Simulation:** Implementación de la lógica de viento (`wind.js`).
- **Data Acquisition:** Introducción de `fetch-terrain.py` para la preparación de datos de relieve (`terrain-caldera.json/png`).

### Terrain Engine
- **Shader Enhancement:** Refinamiento de los shaders de terreno (`terrain.frag`) para la visualización de relieve.

---

## [2026-08-29] - Core Engine & Terrain Rendering Pipeline

### Core Engine & Rendering
- **WebGL Lifecycle:** Implementación de la gestión de contexto (`gl.js`), el loop principal (`main.js`) y el pipeline de renderizado (`renderer.js`).
- **Terrain Shaders:** Implementación de los shaders base para el procesamiento de relieve (`terrain.vert`, `terrain.frag`).
- **UI System:** Implementación inicial de la interfaz de usuario (`ui.js`).

### Input & Camera Control
- **Navigation System:** Implementación de la cámara (`camera.js`) y sistemas de control táctil e inclinación (`touch.js`, `tilt.js`, `input.js`).

### Asset & Tooling Pipeline
- **Tools:** Introducción de `convert-assets.py` para la preparación de assets.
- **Initial Assets:** Carga de mapas de altura (`heightmap.png`), texturas satelitales (`texture.png`) y mapas de cielo (`sky.png`).

---
*Nota: Este changelog se construye mediante ingeniería inversa de los commits para dotar de sentido técnico a la evolución del proyecto.*
