# CLAUDE.md — Bank App

## Lo más importante

**La app entera vive en un solo archivo: `index.html`** (en la raíz del repo; HTML + CSS + JS todo junto, ~5450 líneas).
No hay React, no hay Vite, no hay build step. Editas el archivo y se ve el cambio. (`docs/` solo contiene notas de planificación en `superpowers/`, no la app.)

Bank es la app hermana de **Facturas** (`../Facturas`): mismo esqueleto (genie, tema, login, sync, backup, novedades, modo batería, SW), pero en vez de facturas/clientes lleva **fondos de ahorro** y **movimientos** de dinero. Nació copiando `Facturas/index.html` y podando/renombrando (ver `docs/superpowers/plans/2026-09-21-bank.md` y `docs/superpowers/specs/2026-09-21-bank-design.md`). El `CLAUDE.md` de Facturas es una buena referencia de estilo para pitfalls compartidos, pero **no** es fuente de verdad para Bank — este archivo sí lo es.

## Stack

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML + JS vanilla + CSS (sin framework) |
| Auth / Sync | Firebase Auth + Firestore (`firebase-app`, `firebase-auth`, `firebase-firestore` v9 CDN, API compat) — **Fase 1: proyecto placeholder** (`bank-placeholder`), ver `firebase.initializeApp(...)`. `_isDev` salta el login en `localhost`/`127.0.0.1`/IP privada/`file:`, así que la app funciona sin Firebase real todavía (Tarea 9 conecta el proyecto de verdad) |
| PDF | jsPDF (CDN, carga perezosa — ver `_ensureJsPDF()`) |
| PWA | Service Worker + manifest |
| Deploy | GitHub Pages (push a `main`); también se puede abrir `index.html` directamente (no hay servidor de build) |

## Estructura de archivos

```
Bank/
├── index.html          # ⭐ La app entera (HTML + CSS + JS)
├── manifest.json        # PWA manifest — name "Bank"
├── sw.js                 # Service worker — cache: 'bank-vN' (subir N en cada deploy);
│                          # 'bank-cdn-v1' aparte para CDNs externos (jsPDF, Firebase SDK).
│                          # index.html: caché primero + revalida de fondo, igual que Facturas.
├── check.sh              # Extrae el <script> principal y corre `node --check` — correr
│                          # SIEMPRE antes de reportar una tarea como terminada
├── icon.png / icon-192.png / icon-maskable.png   # Íconos PWA (Fase 1: copias de Facturas —
│                                                    # la Tarea 10 los reemplaza por unos propios)
└── docs/superpowers/{specs,plans}/   # Spec y plan de implementación (no son la app)
```

## Datos y persistencia

### localStorage (local, prefijo `bank_`)

⚠️ **El prefijo `bank_` es obligatorio y a propósito**: Facturas y Bank viven en el mismo dominio de GitHub Pages (`usuario.github.io/Facturas` y `/Bank`), y `localStorage` es por dominio, no por carpeta — sin prefijo propio, ambas apps se pisarían el tema, las copias automáticas, etc.

| Key | Descripción |
|---|---|
| `bank_funds` | Array JSON de fondos |
| `bank_movements` | Array JSON de movimientos (orden canónico: fecha desc, luego id desc — ver `_sortMovements`) |
| `bank_profile` | `{ name }` — tu nombre, para el encabezado del PDF |
| `bank_home_tab` | `'funds'` \| `'history'` — pestaña que se muestra al abrir la app (Ajustes → Apariencia → "Pantalla de inicio"; internamente "Movimientos" se guarda como `'history'`, resabio del nombre interno de la vista) |
| `bank_theme_mode` | `'light'` \| `'dark'` \| `'auto-system'` \| `'auto-time'` |
| `bank_theme` | Fallback heredado de una migración anterior (se lee, nunca se escribe — muerto en la práctica) |
| `bank_lite_mode` | `'true'`/`'false'` — "Menos efectos" (Ajustes → Apariencia). Ausente = decide sola (`_liteModeDefault()`: `prefers-reduced-transparency` o `navigator.deviceMemory <= 4`) |
| `bank_cl_seen` | Fecha ISO de la última mejora vista en el cartel de Novedades |
| `bank_cl_first_seen` | `{fecha: timestamp}` — cuándo vio ESTE dispositivo cada mejora por primera vez (controla los 3 días que dura la etiqueta NEW) |
| `bank_snapshots` | Hasta `SNAPSHOT_LIMIT` (3) copias automáticas antes de editar/borrar/importar |
| `bank_pre_import_backup` | Snapshot antes del último import (para deshacer) |
| `bank_pre_import_date` | Fecha ISO de ese snapshot |

### sessionStorage (temporal)

| Key | Descripción |
|---|---|
| `bank_draft` | Borrador del formulario de movimiento en edición (`editingMovementId, formType, formFundId, formAmount, formDate, formNote, formDueDate, formLoanId`) |
| `bankSplashShownSession` | Flag para no mostrar el splash dos veces en la misma sesión |

### Firestore (nube — activo desde que hay un proyecto real conectado, Tarea 9)

- `users/{uid}/funds/{f.id}` — cada fondo es un doc
- `users/{uid}/movements/{m.id}` — cada movimiento es un doc
- `users/{uid}/settings/main` — `{ profile, homeTab }`
- Reglas: mismas que Facturas, `users/{uid}/**` solo accesible para ese uid
- Sincronización: merge (nube gana en conflicto de mismo `id`) — ver `_mergeCollection()`

## Estructura de datos

Del spec (`docs/superpowers/specs/2026-09-21-bank-design.md`), verificado contra `normalizeFunds()`/`normalizeMovements()`/`buildMovementObject()` en el código actual:

### Fondo
```js
{
  id: "1718000000000",   // Date.now().toString()
  name: "Vacaciones",
  goal: 3000,             // Number; 0 = sin meta
  color: "#2e7d32",       // string; puede ser '' (sin color elegido)
  createdAt: "2026-09-21" // fecha ISO (solo fecha, del día que se creó)
}
```

### Movimiento
```js
{
  id: "1718000000001",
  fundId: "1718000000000",
  type: "in" | "loan" | "repay" | "out",   // Meter · Sacar prestado · Devolver · Gastar
  amount: 100,             // Number, siempre > 0 (el signo lo da MOV_SIGN[type], no el monto)
  date: "2026-09-21",      // ISO date
  note: "",                // string, opcional
  dueDate: "",             // solo type==='loan'; ISO opcional, '' = sin vencimiento
  loanId: ""                // solo type==='repay'; id del movimiento 'loan' al que abona
}
```

**Nada derivado se guarda** — todo se calcula al vuelo desde el array `movements`:
- `MOV_TYPES` / `MOV_SIGN` — mapas fijos: `{in:'Meter', loan:'Sacar prestado', repay:'Devolver', out:'Gastar'}` / `{in:1, loan:-1, repay:1, out:-1}` (signo de cada tipo sobre "Tienes")
- **Tienes** (`fundBalance(fundId).have`) = suma de `MOV_SIGN[type] * amount` de los movimientos del fondo
- **Debes** (`fundBalance(fundId).owed`) = suma de `loanBalance(loan).balance` de cada préstamo del fondo
- **Saldo de un préstamo** (`loanBalance(loan)`) = `monto − suma de sus repay` — así borrar/editar una devolución nunca deja un préstamo desincronizado
- `fundBalance(null)` sin id = todos los fondos juntos (lo usa el Resumen)
- Borrar un préstamo (`deleteMovementById`) borra también sus devoluciones (quedarían apuntando a nada) — devuelve el array de todo lo borrado, para poder deshacer
- Editar un préstamo que ya tiene devoluciones no permite cambiarle el tipo (`buildMovementObject` lo valida y tira error)

## Funciones clave

### Modelo y saldos
- `normalizeFunds(arr)` / `normalizeMovements(arr)` — solo AÑADEN valores por defecto a datos que vienen de fuera (backup viejo, doc corrupto en la nube), nunca borran campos
- `_sortMovements(arr)` — orden canónico (fecha desc, id desc); todo array de movimientos pasa por acá antes de guardarse o compararse
- `fundBalance(fundId)` → `{have, owed}` · `loanBalance(loan)` → `{repaid, balance}` · `isLoanSettled(loan)` · `isLoanOverdue(m, today?)` · `openLoansOf(fundId)` (préstamos con saldo pendiente, para el selector de "Devolver")
- `fundById(id)` / `fundName(id)` (`'Sin fondo'` si no existe)
- ⚠️ `loanBalance()` es O(n) sobre `movements` por cada llamada, así que `fundBalance()` es O(n²) en la práctica (recorre movimientos y por cada préstamo vuelve a recorrer buscando sus repays). Con miles de movimientos convendría indexar repays por `loanId`; con el volumen normal de una app personal no se nota (`ponytail:` marcado en el código junto a `loanBalance`)

### Persistencia local y CRUD
- `loadData()` — carga todo, incluye `funds`/`movements`/`PROFILE` desde `bank_funds`/`bank_movements`/`bank_profile`
- `saveFunds()` / `saveMovements()` / `saveProfile()` (esta última también llama `_syncSettings()`)
- `addMovement(m)` / `updateMovement(id, m)` / `deleteMovementById(id)` — todas guardan local primero (revierten si `safeSetItem` falla por cupo lleno) y sincronizan a Firestore después; `updateMovement` además llama `takeSnapshot()` antes de aplicar el cambio
- `addFund(f)` / `updateFund(id, patch)` / `deleteFund(id)` — `deleteFund` también borra en cascada los movimientos de ese fondo (local + nube)

### Sincronización con Firestore
- `_syncMovement(m)` / `_syncFund(f)` / `_deleteMovementCloud(id)` / `_deleteFundCloud(id)` — fuego y olvida (no awaited); avisan con un toast si la escritura falla de verdad (no simplemente por estar offline: con persistencia offline habilitada, sin conexión la promesa queda pendiente, no cae en el catch)
- `_syncSettings()` — sube `{profile, homeTab}` a `settings/main`
- `_commitOpsInChunks(ops)` — helper compartido: corre una lista de `(batch) => void` en tandas de 450 (límite real de Firestore: 500 escrituras/batch). Lo usan `_replaceFirestoreAll` y `_mergeCollection` (dos veces, una por colección, en cada `_loadFromFirestore()`)
- `_replaceFirestoreAll()` — **borra todo en Firestore (fondos y movimientos) y re-sube el array local** — usar solo tras import/restore de backup
- `_mergeCollection(ref, local, normalize)` — merge de UNA colección local↔nube (nube gana en mismo id; lo que solo existe local se sube); la usa `_loadFromFirestore()` para fondos y movimientos por separado
- `_loadFromFirestore()` — descarga completa + merge; solo se llama al iniciar sesión o tras recuperar la conexión
- `_attachRealtimeListeners()` — engancha los 3 `onSnapshot` (funds, movements, settings) sin repetir la descarga completa; se usa para reconectar tras backgrounding largo. `_lastFundsFingerprint`/`_lastMovementsFingerprint` evitan repintar si el primer disparo trae lo mismo que `_loadFromFirestore()` ya bajó
- `_startRealtimeSync()` — `_loadFromFirestore()` + `_attachRealtimeListeners()`; solo para el login inicial

### Vistas y navegación
- `_TAB_VIEWS` = `{funds:'view-funds', history:'view-history', dashboard:'view-dashboard', settings:'view-settings'}` — mapea nombre de pestaña → id de vista
- `_TAB_ORDER` = `{funds:0, history:1, dashboard:2, settings:3}` — define la dirección del slide al cambiar de pestaña
- `switchTab(tab)` — navega entre `'funds'`, `'history'` (Movimientos), `'dashboard'` (Resumen), `'settings'`
- `showView(name, triggerEl)` — solo abre `'create'` (el formulario); `_createFromTab` guarda desde qué pestaña se abrió (para que `closeCreate()` vuelva ahí)
- `closeCreate(triggerEl)` — cierra el formulario con genie hacia la tarjeta editada (si sigue en pantalla) o hacia `triggerEl`, y vuelve a `switchTab(_createFromTab)`
- `_createViewOpen` — bandera que evita que `switchTab()` recalcule `_createFromTab` mientras el formulario ya está abierto (ver Pitfall #3)
- `showDefaultView()` — punto de entrada tras login: reabre el formulario si hay un borrador sin guardar, si no muestra el historial
- `_refreshCurrentView()` — repinta lo que esté en pantalla (`renderFundPage`/`renderFunds`, `filterMovements`, o `renderDashboard` según cuál vista esté visible); la usan los listeners de Firestore, deshacer, duplicar, etc. — **llamarla siempre tras cambiar datos por fuera de una acción de UI directa**

### Fondos (pestaña Fondos)
- `renderFunds()` — tarjeta por fondo (Tienes/Debes/barra de meta)
- `openFundPage(id, triggerEl)` / `closeFundPage()` / `renderFundPage()` — sub-vista de un fondo (genie desde la tarjeta): lista de sus movimientos + botón nuevo movimiento con ese fondo preseleccionado
- `openFundModal(id, triggerEl)` / `closeFundModal()` / `saveFundModal()` — modal nuevo/editar fondo (`#modal-fund`); `id` null = crear

### Movimientos (pestaña Movimientos / historial)
- `filterMovements()` — recalcula `filteredMovements` según búsqueda/tipo/año/fondo y llama `renderHistory()` — usar SIEMPRE esta (no `renderHistory()` sola) tras borrar/duplicar/restaurar, mismo motivo que en Facturas: `renderHistory()` sola no recalcula el filtro activo
- `renderHistory()` / `_renderMovementList(list, el, emptyHTML)` — pintan la lista (con separadores de mes si el orden es por fecha)
- `_movementCardHTML(m, today, opts)` — HTML de una tarjeta (`.mov-card`); la usan tanto el historial general como `renderFundPage()`
- `confirmDelete(id, triggerEl)` / `undoDelete()` — borrar con deshacer (10s); si el movimiento es un préstamo, borra también sus devoluciones y avisa cuántas

### Formulario de movimiento
- `renderCreateForm()` — arma el HTML desde `formType`/`formFundId`/`formAmount`/etc.; si no hay ningún fondo todavía, muestra "Primero crea un fondo" en vez del formulario
- `buildMovementObject()` — valida y arma el objeto desde el estado del form; tira `Error` con mensaje si algo no es válido (monto ≤ 0, sin fondo, préstamo con devoluciones al que le cambian el tipo, etc.)
- `saveCurrentMovement(triggerEl)` — llama `buildMovementObject()` y luego `addMovement`/`updateMovement`
- `openCreate(triggerEl, presetFundId?)` — abre el formulario en blanco; `presetFundId` (viene de `openFundPage`) precarga ese fondo
- `openRepayFor(loanId, triggerEl)` — atajo "Devolver" de una tarjeta de préstamo: abre el form en tipo `repay`, con `loanId` y el saldo completo precargado
- `editMovement(id, triggerEl)` / `duplicateMovement(id)` — cargar en el form para editar / clonar con fecha de hoy
- `saveDraft()` / `loadDraft()` / `clearDraft()` — borrador en `sessionStorage` (`bank_draft`), debounced 250ms + guardado forzado en `visibilitychange`

### Resumen (dashboard)
- `renderDashboard()` — métricas del período (Tienes, Debes, Metido/Sacado/Devuelto/Gastado, préstamos vencidos), gráfica por mes, tabla "Por fondo" (`_fundsTableHTML()`, usa la clase genérica `.items-table`)
- `getDashboardMovements()` — movimientos dentro del período y fondo activos del Resumen (los usan métricas, gráfica y CSV)
- `getBalanceByPeriod(list)` — saldo ("Tienes") acumulado al cierre de cada mes/día del período, para la gráfica
- `dashboardFundFilter` — `null` = todos los fondos, o id de un fondo — filtro adicional al período

### PDF
- `_ensureJsPDF()` — inyecta jsPDF la PRIMERA vez que hace falta (perezoso); cualquier función nueva que genere PDF debe `await _ensureJsPDF()` antes de tocar `window.jspdf`
- **Una sola plantilla** (a diferencia de Facturas, que tenía 5): se dibuja directo con jsPDF, no hay `_pdfTplN` por diseño ni selector de plantilla
- `generateFundStatementPDF(fundId)` — "Estado del fondo": Tienes/Debes/Meta, tabla de movimientos de ese fondo con saldo acumulado, préstamos pendientes al final
- `generateSummaryPDF()` — "Resumen general": una sección por fondo con sus saldos + totales
- Helpers compartidos: `_pdfTitle`, `_pdfSection`, `formatMoneyForPDF`, constantes `_PDF_W`/`_PDF_MARGIN`
- `_deliverPDF(doc, filename, title)` — delega en `_deliverBlobFile()`: iOS con `navigator.canShare` usa el menú nativo de compartir, todo lo demás (Android y escritorio) descarga el archivo directo vía `<a download>`. ⚠️ A diferencia de Facturas, Bank **no** usa el visor de PDF embebido en escritorio: `_showPDFInApp()`/`closePdfViewer()`/`downloadPdfViewer()`/`printPdfViewer()` y el modal `#modal-pdf-viewer` siguen en el código (copiados de Facturas, con su entrada en `MODAL_CLOSE_FNS`) pero **nada los llama** — verificado que `_showPDFInApp(` no aparece en ningún otro lugar del archivo. Es código muerto real, no borrado en esta tarea por estar fuera del alcance de "CSS muerto" (Paso 2); candidato a limpieza en una futura pasada de JS muerto.

### Backup / Export
- `exportBackup()` — descarga JSON `{funds, movements, profile, exportedAt}`
- `exportMovementsCSV()` — CSV para Excel/contabilidad
- `confirmImportBackup()` — importa JSON y reemplaza TODO (local + Firestore, vía `_applyBackup` + `_replaceFirestoreAll`)
- `_applyBackup(obj)` — aplica un objeto de backup al estado en memoria + localStorage (lo usan tanto el import manual como `restorePreImportBackup`/`restoreSnapshot`)
- `restorePreImportBackup()` — deshace el último import
- `takeSnapshot(reason, movementsOverride?)` / `restoreSnapshot(idx)` — copias automáticas (máx. `SNAPSHOT_LIMIT` = 3)

### Auth
- `_auth.onAuthStateChanged(...)` — punto de entrada principal de la app
- `doLogin()` / `doGoogleLogin()` / `doLogout()` — mismos patrones que Facturas (`doGoogleLogin` usa popup normal o `signInWithRedirect` en PWA instalada)
- `_isDev` — `true` en `localhost`/`127.0.0.1`/IP privada/`file:`; salta el login para poder probar la app en Fase 1 sin Firebase real

### Ajustes — sub-vistas
- `SETTINGS_SUBVIEWS` = `['novedades-page', 'tema-page', 'copias-page', 'perfil-page']` — Bank NO tiene "Clientes Guardados" ni "Tu Compañía" (eso era de Facturas)
- `_openSettingsSubView(id)` / `_closeSettingsSubView()` — mecanismo compartido, igual que Facturas
- Pares propios: `openTemaPage()`/`closeTemaPage()`, `openCopiasPage()`/`closeCopiasPage()`, `openPerfilPage()`/`closePerfilPage()` (+ `savePerfilFromSettings()`), `showChangelog(force)`/`closeChangelog()` (Novedades)

### Confirmaciones y modales
- `_confirmDialog(message, opts, triggerEl?)` — modal propio que reemplaza `confirm()` nativo (idéntico a Facturas)
- `MODAL_CLOSE_FNS` — mapea id de modal → función de cierre correcta (`modal-pdf-viewer`, `modal-password`, `modal-import`, `modal-confirm`, `modal-changelog`, `modal-fund`); lo usa el listener de Esc
- `_topOpenModal()` (en `window._topOpenModal`) — resuelve el modal de ENCIMA cuando hay varios apilados, vía `data-open-order`

## Navegando `index.html`

Es un archivo de ~5450 líneas. Busca con Grep:

| Buscas... | Patrón |
|---|---|
| Inicio de la app | `onAuthStateChanged` |
| Modelo de datos / saldos | `fundBalance` o `loanBalance` |
| Formulario de movimiento | `renderCreateForm` |
| Historial de movimientos | `renderHistory` o `filterMovements` |
| Fondos | `renderFunds` o `openFundPage` |
| Resumen / dashboard | `renderDashboard` |
| Navegación entre pestañas | `_TAB_VIEWS` o `switchTab` |
| PDF | `generateFundStatementPDF` o `_ensureJsPDF` |
| Backup / import / export | `_applyBackup` o `exportBackup` |
| Firebase init | `firebase.initializeApp` |
| Service worker | `serviceWorker.register` |
| Tema oscuro | `applyTheme` o `bank_theme_mode` |
| Menos efectos / batería | `applyLiteMode` o `body.lite` |
| Sub-vistas de Ajustes | `_openSettingsSubView` |

## Reglas para editar

- **Edita siempre `index.html` directamente.** Es la única fuente de verdad.
- **Al modificar un movimiento en JS:** llama siempre `saveMovements()` + `_syncMovement(m)`.
- **Al modificar un fondo:** `saveFunds()` + `_syncFund(f)`.
- **Al modificar profile/homeTab:** `saveProfile()` (ya llama `_syncSettings()` sola) o `_syncSettings()` directo.
- **Tras cambiar datos por fuera de una acción de UI directa** (listener de Firestore, deshacer, duplicar, import): llama `_refreshCurrentView()` para repintar lo que esté en pantalla.
- **Tras import o restore de backup:** `_applyBackup()` + `_replaceFirestoreAll()`.
- **Nunca uses `confirm()` nativo** — usa `await _confirmDialog(msg, opts, triggerEl)`.
- **`./check.sh` antes de reportar cualquier tarea como terminada.** Corre `node --check` sobre el `<script>` principal — detecta errores de sintaxis JS, pero NO valida el CSS del `<style>` (revisa el balance de `{`/`}` a mano si tocaste bloques grandes de CSS).
- **⚠️ Sube la versión del SW en `sw.js` (`bank-vN` → `vN+1`) en CADA cambio de `index.html`.** Mismo motivo que Facturas: red-primero para HTML hace que el cambio se vea con conexión sin tocar la versión, pero subir `vN` garantiza la actualización también offline / en recargas.
- **Commits:** mensaje imperativo en español (`fix: …`, `feat: …`, `chore: …`).

## Pitfalls (heredados de Facturas, verificados contra el código actual de Bank)

1. **Genie + `{ once: true }`:** todo `addEventListener('animationend'/'transitionend', ...)` puesto sobre un elemento permanente necesita `{ once: true }` — si no, cada apertura/cierre acumula un listener más. Ver el patrón en `showView()`/`_growViewFromRect`/`_shrinkModalToRect`.
2. **`_prefersReducedMotion()`** es el único punto que las animaciones "genie" consultan para decidir si esperar `animationend` o llamar `onDone()`/`onGrown()` de una — devuelve `true` tanto con `prefers-reduced-motion` real del SO como con `_liteMode` ("Menos efectos") activo. Cualquier bandera nueva que ponga `animation:none` por CSS tiene que sumarse acá, o la vista se queda pegada a medio abrir/cerrar.
3. **`switchTab(tab)` no se usa para entrar a crear/editar** — eso pasa por `showView('create', ...)`, así que `_lastActiveTab` se queda apuntando a la pestaña de atrás mientras el formulario está abierto. La bandera `_createViewOpen` es la que evita que el atajo de "misma pestaña, no hacer nada" de `switchTab()` se cuele justo ahí (dejaría `view-create` sin esconderse). Cualquier vista nueva que se abra por fuera de `switchTab()` y cierre a través de `switchTab()` necesita el mismo tipo de bandera.
4. **`backdrop-filter` solo va en overlays flotantes** (`.modal`, `.overflow-dropdown`, `.toast`, `#modal-changelog .cl-card`, `#offline-banner`, `#bottom-nav`) — nada "en flujo" (tarjetas, botones, secciones de Ajustes, dashboard) lo lleva; usa `background: var(--lg-card); border: var(--lg-border); box-shadow: var(--lg-shadow);` sin blur para una superficie nueva, igual que `.dashboard-card`/`.metric-box`.
5. **`_topOpenModal()`** (definida junto a `setupModalA11y`, expuesta en `window._topOpenModal`) resuelve cuál modal está "encima" cuando hay varios apilados (p.ej. `_confirmDialog` sobre otro modal abierto) — Esc/Tab deben actuar sobre ESE, no el primero en el DOM.
6. **Claves de almacenamiento con prefijo `bank_` es obligatorio**, no cosmético: Facturas y Bank comparten dominio en GitHub Pages (`usuario.github.io/Facturas` y `/Bank`), y `localStorage`/`sessionStorage` son por dominio, no por carpeta — sin el prefijo se pisarían tema, copias automáticas, etc. entre las dos apps. Por el mismo motivo, el `BroadcastChannel` de sincronización multi-pestaña usa el nombre `'bank-tabs'` (no `'facturas-tabs'`) — dos nombres iguales en el mismo origen harían que las pestañas de Bank reaccionen a mensajes de Facturas y viceversa.
7. **`normalizeMovements()`/`normalizeFunds()`** son la única defensa contra datos con campos numéricos como string (backups viejos, docs corruptos en la nube) — si agregas un campo numérico nuevo a un fondo o movimiento, cuídalo ahí también.
8. **`loanBalance()` recorre todo `movements` por cada préstamo** (`fundBalance` es O(n²) en la práctica) — no importa con el volumen normal de una app personal, pero si se agregan miles de movimientos convendría indexar los `repay` por `loanId` (marcado `ponytail:` en el código, junto a `loanBalance`).
9. **`.items-table`** (usada por `_fundsTableHTML()` en el Resumen) hereda estilos base de selectores genéricos de tag (`table`, `thead th`, `tbody td`, etc. — ver el comentario "Header y filas con material glass" en el CSS) y solo sobreescribe algunas propiedades. No borres esos selectores genéricos pensando que son solo del viejo formulario de factura de Facturas: siguen siendo la base real de `.items-table`.
