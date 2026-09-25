# CLAUDE.md — Bank App

## Lo más importante

**La app entera vive en un solo archivo: `index.html`** (en la raíz del repo; HTML + CSS + JS todo junto, ~5600 líneas).
No hay React, no hay Vite, no hay build step. Editas el archivo y se ve el cambio. (`docs/` solo contiene notas de planificación en `superpowers/`, no la app.)

Bank es la app hermana de **Facturas** (`../Facturas`): mismo esqueleto (genie, tema, login, sync, backup, novedades, modo batería, SW), pero en vez de facturas/clientes lleva **fondos de ahorro** y **movimientos** de dinero. Nació copiando `Facturas/index.html` y podando/renombrando (ver `docs/superpowers/plans/2026-09-21-bank.md` y `docs/superpowers/specs/2026-09-21-bank-design.md`). El `CLAUDE.md` de Facturas es una buena referencia de estilo para pitfalls compartidos, pero **no** es fuente de verdad para Bank — este archivo sí lo es.

⚠️ **"Fondo" en el código, "Cuenta" en pantalla:** el modelo de datos y casi toda la nomenclatura interna (`fundBalance`, `openFundModal`, `#view-funds`, `bank_funds`, etc.) siguen llamándose "fondo" — pero el texto que ve el usuario dice **"Cuenta"** (pestaña "Cuentas", botón "+ Nueva cuenta", etc.). Es solo una palabra distinta para lo mismo; no cambies los nombres internos por esto, solo ten presente el desfase al tocar textos visibles.

## Stack

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML + JS vanilla + CSS (sin framework) |
| Auth / Sync | Firebase Auth + Firestore (`firebase-app`, `firebase-auth`, `firebase-firestore` v9 CDN, API compat) — proyecto real `bank-f0331`, separado del de Facturas (ver `firebase.initializeApp(...)`). `_isDev` salta el login en `localhost`/`127.0.0.1`/IP privada/`file:`, para poder probar sin tocar la nube |
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
├── icon.png / icon-192.png / icon-maskable.png   # Íconos propios (verde, "B" grande —
│                                                    # generados con System.Drawing, no son los de Facturas)
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
| `bank_tombstones` | `{ funds: {id: timestamp}, movements: {id: timestamp} }` — ids borrados y cuándo, ver "Tumbas de borrado" más abajo |

### sessionStorage (temporal)

| Key | Descripción |
|---|---|
| `bank_draft` | Borrador del formulario de movimiento en edición (`editingMovementId, formType, formFundId, formAmount, formDate, formNote, formDueDate, formLoanId, formToFundId, formCategory`) |
| `bankSplashShownSession` | Flag para no mostrar el splash dos veces en la misma sesión |

### Firestore (nube)

- `users/{uid}/funds/{f.id}` — cada fondo es un doc
- `users/{uid}/movements/{m.id}` — cada movimiento es un doc
- `users/{uid}/settings/main` — `{ profile, homeTab }`
- `users/{uid}/settings/tombstones` — `{ funds: {id: timestamp}, movements: {id: timestamp} }`, ver abajo
- Reglas: `users/{uid}/**` solo accesible para ese uid (mismo patrón que Facturas)
- Sincronización: merge (nube gana en conflicto de mismo `id`) — ver `_mergeCollection()`

⚠️ **Tumbas de borrado (`_tombFunds`/`_tombMovements`, `_recordTombstones`/`_clearTombstones`/`_fetchCloudTombstones`):**
sin esto, borrar algo en un dispositivo mientras otro estaba desconectado hacía que ese otro dispositivo **resucitara** lo borrado al reconectar — `_mergeCollection()` hace una unión local↔nube, y sin saber que un id fue borrado a propósito, trataba la copia vieja local como "nuevo, hay que subirlo". `deleteFund`/`deleteMovementById` registran una tumba (id + cuándo, no el contenido) local al instante y en la nube de fondo; `_loadFromFirestore()` las descarga (`_fetchCloudTombstones`) antes de mergear, y `_mergeCollection()` las usa para no resucitar ni resubir nada tumbado. `undoDelete()` limpia la tumba de lo que restaura; `_applyBackup()` (import/restore) limpia todas — el backup restaurado ES la verdad nueva. Se podan solas pasados 180 días (`TOMBSTONE_MAX_AGE_MS`).

## Estructura de datos

Del spec (`docs/superpowers/specs/2026-09-21-bank-design.md`), verificado contra `normalizeFunds()`/`normalizeMovements()`/`buildMovementObject()` en el código actual:

### Fondo
```js
{
  id: "1718000000000",   // Date.now().toString()
  name: "Vacaciones",
  goal: 3000,             // Number; 0 = sin meta
  goalDeadline: "",        // ISO opcional; con goal>0 activa _goalPaceInfo (cuánto ahorrar por mes/semana)
  planAmount: 0,           // Number; monto del plan de ahorro (0 = sin plan)
  planFreq: "",             // '' | 'daily' | 'weekly' | 'biweekly' | 'monthly' (ver PLAN_FREQ_DAYS/PLAN_FREQ_LABEL)
  planSetAt: "",            // ISO; desde cuándo cuenta el plan (se resetea si cambias monto/frecuencia en saveFundModal — NO es createdAt)
  color: "#2e7d32",       // string; puede ser '' (sin color elegido)
  createdAt: "2026-09-21" // fecha ISO (solo fecha, del día que se creó)
}
```

### Movimiento
```js
{
  id: "1718000000001",
  fundId: "1718000000000",
  type: "in" | "loan" | "repay" | "out" | "transfer",   // Meter · Sacar prestado · Devolver · Gastar · Transferir
  amount: 100,             // Number, siempre > 0 (el signo lo da MOV_SIGN[type] o _fundEffect, no el monto)
  date: "2026-09-21",      // ISO date
  note: "",                // string, opcional
  dueDate: "",             // solo type==='loan'; ISO opcional, '' = sin vencimiento
  loanId: "",                // solo type==='repay'; id del movimiento 'loan' al que abona
  toFundId: "",              // solo type==='transfer'; id de la cuenta DESTINO (fundId sigue siendo el origen)
  category: ""                // solo type==='out'; uno de OUT_CATEGORIES o '' (sin categoría)
}
```

**Nada derivado se guarda** — todo se calcula al vuelo desde el array `movements`:
- `MOV_TYPES` / `MOV_SIGN` — mapas fijos: `{in:'Meter', loan:'Sacar prestado', repay:'Devolver', out:'Gastar', transfer:'Transferir'}` / `{in:1, loan:-1, repay:1, out:-1, transfer:0}`. `MOV_TYPES` (infinitivo) es solo para el formulario de crear/editar (botones de Tipo) — el título de la tarjeta en las listas de movimientos usa `MOV_TYPES_PAST` (pretérito: Metiste/Sacaste prestado/Devolviste/Gastaste/**Transferiste**), ver `_movementCardHTML()`.
- ⚠️ **`transfer` no tiene un signo fijo**: mueve dinero entre DOS cuentas propias, así que `MOV_SIGN.transfer = 0` (correcto para `fundBalance(null)`, el total de todas las cuentas junto — una transferencia entre tus propias cuentas no cambia cuánto tienes en total). El efecto real sobre UNA cuenta puntual (resta en el origen `fundId`, suma en el destino `toFundId`) lo calcula `_fundEffect(m, fundId)`, no `MOV_SIGN`. Cualquier función que recorra `movements` filtrando por una cuenta (no por "todas juntas") tiene que usar `_fundEffect`, no `MOV_SIGN[m.type] * m.amount` directo — si agregas un cálculo nuevo por-cuenta, revisa `fundBalance()`/`getBalanceByPeriod()`/`generateFundStatementPDF()` como ejemplos.
- **Tienes** (`fundBalance(fundId).have`) = suma de `_fundEffect(m, fundId)` (o `MOV_SIGN[type] * amount` si `fundId` es `null`, todas las cuentas juntas) de los movimientos del fondo — una transferencia cuenta para AMBOS lados (`m.fundId === fundId` o `m.toFundId === fundId`)
- **Debes** (`fundBalance(fundId).owed`) = suma de `loanBalance(loan).balance` de cada préstamo del fondo
- **Saldo de un préstamo** (`loanBalance(loan)`) = `monto − suma de sus repay` — así borrar/editar una devolución nunca deja un préstamo desincronizado
- `fundBalance(null)` sin id = todos los fondos juntos (lo usa el Resumen)
- Borrar un préstamo (`deleteMovementById`) borra también sus devoluciones (quedarían apuntando a nada) — devuelve el array de todo lo borrado, para poder deshacer
- Editar un préstamo que ya tiene devoluciones no permite cambiarle el tipo (`buildMovementObject` lo valida y tira error)
- Borrar una cuenta (`deleteFund`) borra también los movimientos donde es origen O destino de una transferencia, y limpia `dashboardFundFilter`/`historyFundFilter` si apuntaban a esa cuenta (si no, el Resumen/Movimientos quedaban "filtrando" por un id que ya no existe)

## Funciones clave

### Modelo y saldos
- `normalizeFunds(arr)` / `normalizeMovements(arr)` — solo AÑADEN valores por defecto a datos que vienen de fuera (backup viejo, doc corrupto en la nube), nunca borran campos
- `_sortMovements(arr)` — orden canónico (fecha desc, id desc); todo array de movimientos pasa por acá antes de guardarse o compararse
- `fundBalance(fundId)` → `{have, owed}` · `loanBalance(loan)` → `{repaid, balance}` · `isLoanSettled(loan)` · `isLoanOverdue(m, today?)` · `isLoanDueSoon(m, today?)` (vence en ≤7 días, no vencido todavía) · `openLoansOf(fundId)` (préstamos con saldo pendiente, para el selector de "Devolver")
- `fundById(id)` / `fundName(id)` (`'Sin fondo'` si no existe) · `_fundEffect(m, fundId)` (efecto de UN movimiento sobre UNA cuenta — ver arriba, obligatorio para `transfer`)
- `_goalPaceInfo(f)` → `{remaining, overdue, daysLeft?, monthly?, weekly?}` o `null` — cuánto falta y a qué ritmo para llegar a `goalDeadline`; `null` si no hay meta+fecha o ya se cumplió
- `_planPaceInfo(f)` → `{expected, diff, freqLabel, amount}` o `null` — compara lo que ya deberías llevar según el plan (`planAmount` × períodos transcurridos desde `planSetAt`) contra `fundBalance(f.id).have`; `diff` positivo = adelantado
- `fundBalance()` ya NO es O(n²): arma un índice `Map<loanId, repaidAmount>` una sola vez dentro de su propio bucle (antes cada préstamo llamaba `loanBalance()`, que recorría TODOS los movimientos por su cuenta). `loanBalance()` en sí sigue siendo O(n) por llamada — se usa donde solo hace falta mirar uno o pocos préstamos sueltos (tarjeta de movimiento, selector de "Devolver", PDF), no en un bucle sobre todos los movimientos.

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
- `renderFunds()` — tarjeta por fondo (Tienes/Debes/barra de meta); muestra "Meta cumplida" de forma permanente en la tarjeta si `have >= goal` (no solo el toast de `_checkGoalReached` al momento de cruzarla)
- `openFundPage(id, triggerEl)` / `closeFundPage()` / `renderFundPage()` — sub-vista de un fondo (genie desde la tarjeta): banner Tienes/Debes/Meta/Gastaste, línea de `_goalPaceInfo`/`_planPaceInfo` (+ botón "Registrar ahorro del plan" → `quickPlanDeposit(fundId, triggerEl)`, precarga un Meter con `planAmount`), gráfica de `_fundBalanceHistory(fundId)` (reusa `drawLineChart`), y lista de sus movimientos (propios + transferencias donde es origen o destino) + botón nuevo movimiento con ese fondo preseleccionado
- `openFundModal(id, triggerEl)` / `closeFundModal()` / `saveFundModal()` — modal nuevo/editar fondo (`#modal-fund`); `id` null = crear
- `_checkGoalReached(fundId, beforeHave)` — toast "¡Llegaste a tu meta!" si `beforeHave < goal` y ahora `have >= goal`; lo llaman `saveCurrentMovement()` (para cada cuenta afectada — una transferencia afecta dos) y `saveFundModal()` (si bajas la meta hasta que lo que ya tienes te alcance)

### Movimientos (pestaña Movimientos / historial)
- `filterMovements()` — recalcula `filteredMovements` según búsqueda/tipo/año/fondo y llama `renderHistory()` — usar SIEMPRE esta (no `renderHistory()` sola) tras borrar/duplicar/restaurar, mismo motivo que en Facturas: `renderHistory()` sola no recalcula el filtro activo. El filtro "Cuenta" incluye transferencias donde esa cuenta es origen O destino; la búsqueda de texto también mira `fundName(m.toFundId)`.
- `renderHistory()` / `_renderMovementList(list, el, emptyHTML, viewFundId?)` — pintan la lista (con separadores de mes si el orden es por fecha). ⚠️ **Paginada**: solo pinta `_movementListShown` (`MOVEMENT_PAGE_SIZE` = 100) de una vez, con un botón "Ver más" al final si sobran — con miles de movimientos, crear TODAS las tarjetas de una se sentía lento (medido: ~500ms/~19.000 nodos de DOM con 2.000 movimientos). `_movementListShown` se resetea a 100 en `setTypeFilter`/`setYearFilter`/`setFundFilter`/`setSortMode`/`debouncedFilterMovements`/`openFundPage`/al entrar a la pestaña `history` en `switchTab()` — cualquier filtro/orden/búsqueda NUEVO que agregues debe resetearlo también, o "Ver más" seguiría desde donde quedó el filtro anterior.
- `_movementCardHTML(m, today, {animate, delay, viewFundId})` — HTML de una tarjeta (`.mov-card`); la usan tanto el historial general (`viewFundId` null) como `renderFundPage()` (`viewFundId` = esa cuenta). Para `type==='transfer'` el signo/color (+/verde, −/rojo, o neutro/azul sin signo) depende de si `viewFundId` es el destino, el origen, o ninguno (lista general) — el título siempre dice "Transferiste" (pretérito fijo, ver `MOV_TYPES_PAST`), el subtítulo muestra "{origen} → {destino}".
- `confirmDelete(id, triggerEl)` / `undoDelete()` — borrar con deshacer (10s); si el movimiento es un préstamo, borra también sus devoluciones y avisa cuántas. Registra/limpia tumbas (ver "Tumbas de borrado").

### Formulario de movimiento
- `renderCreateForm()` — arma el HTML desde `formType`/`formFundId`/`formAmount`/etc.; si no hay ningún fondo todavía, muestra "Primero crea un fondo" en vez del formulario. El botón "Transferir" solo aparece si hay 2+ cuentas (`Object.entries(MOV_TYPES).filter(...)`); con `formType==='transfer'` muestra el selector "A qué cuenta" (`formToFundId`, excluye la cuenta de origen); con `formType==='out'` muestra el selector de categoría (`formCategory`, opciones de `OUT_CATEGORIES`)
- `buildMovementObject()` — valida y arma el objeto desde el estado del form; tira `Error` con mensaje si algo no es válido (monto ≤ 0, sin fondo, préstamo con devoluciones al que le cambian el tipo, transferencia sin cuenta destino elegida, etc.)
- `saveCurrentMovement(triggerEl)` — llama `buildMovementObject()` y luego `addMovement`/`updateMovement`, y `_checkGoalReached()` para cada cuenta afectada. ⚠️ Deshabilita el botón `#save-mov-btn` de verdad (no una bandera) hasta que `openCreate`/`editMovement` lo vuelvan a abrir — la función es 100% síncrona, así que una bandera que se prende/apaga DENTRO de la misma llamada ya estaba en `false` antes de que un segundo clic real (evento de UI aparte) la encontrara en `true`; un doble toque en "Guardar" duplicaba el movimiento. Mismo patrón en `saveFundModal()`/`#save-fund-btn`. Si agregas un botón de guardar nuevo en la app, replica este patrón, no una bandera sola.
- `openCreate(triggerEl, presetFundId?)` — abre el formulario en blanco; `presetFundId` (viene de `openFundPage`) precarga ese fondo
- `quickPlanDeposit(fundId, triggerEl)` — atajo "Registrar ahorro del plan" (página de la cuenta): abre el form en `in` con `formAmount` precargado al `planAmount` de esa cuenta
- `openRepayFor(loanId, triggerEl)` — atajo "Devolver" de una tarjeta de préstamo: abre el form en tipo `repay`, con `loanId` y el saldo completo precargado
- `editMovement(id, triggerEl)` / `duplicateMovement(id)` — cargar en el form para editar / clonar con fecha de hoy
- `saveDraft()` / `loadDraft()` / `clearDraft()` — borrador en `sessionStorage` (`bank_draft`), debounced 250ms + guardado forzado en `visibilitychange`

### Resumen (dashboard)
- `renderDashboard()` — métricas del período (Tienes, Debes, Metido/Sacado/Devuelto/Gastado — `transfer` no cuenta en ninguna de las 4, ver `calculateMetrics`), tarjeta "En qué gastaste" (`_spendingByCategory(list)`, solo si hay algún `out` en el período), gráfica por mes, tabla "Por fondo" (`_fundsTableHTML()`, usa la clase `.items-table`, con su propio CSS completo — ya no hereda de selectores genéricos de tabla, se borraron en la auditoría de 2026-09-24)
- `getDashboardMovements()` — movimientos dentro del período y fondo activos del Resumen (los usan métricas, gráfica y CSV); con `dashboardFundFilter` puesto incluye transferencias donde esa cuenta es origen O destino
- `getBalanceByPeriod(list)` — saldo ("Tienes") acumulado al cierre de cada mes/día del período, para la gráfica; con un fondo filtrado usa `_fundEffect`, sin filtro (todas las cuentas) usa `MOV_SIGN` directo
- `dashboardFundFilter` — `null` = todos los fondos, o id de un fondo — filtro adicional al período. `deleteFund()` lo limpia solo si apuntaba a la cuenta borrada.
- Las gráficas (`drawBarChart`/`drawLineChart`) soportan saldo negativo: `niceScaleRange(rawMax, rawMin, tickCount)` calcula un rango que baja de cero cuando hace falta (antes la línea se salía del recuadro). Se vuelven a dibujar solas en `resize` (debounced, mismo patrón que `positionBnLens`) — antes quedaban con el ancho viejo estirado al rotar el teléfono.

### PDF
- `_ensureJsPDF()` — inyecta jsPDF la PRIMERA vez que hace falta (perezoso, con verificación de integridad SRI); cualquier función nueva que genere PDF debe `await _ensureJsPDF()` antes de tocar `window.jspdf`
- **Una sola plantilla** (a diferencia de Facturas, que tenía 5): se dibuja directo con jsPDF, no hay `_pdfTplN` por diseño ni selector de plantilla
- `generateFundStatementPDF(fundId)` — "Estado del fondo": Tienes/Debes/Meta, tabla de movimientos de esa cuenta (propios + transferencias donde es origen o destino, con `_fundEffect` para el saldo acumulado) con saldo acumulado, préstamos pendientes al final
- `generateSummaryPDF()` — "Resumen general": una sección por fondo con sus saldos + totales
- Helpers compartidos: `_pdfTitle`, `_pdfSection`, `formatMoneyForPDF`, constantes `_PDF_W`/`_PDF_MARGIN`
- `_deliverPDF(doc, filename, title)` — delega en `_deliverBlobFile()`: iOS con `navigator.canShare` usa el menú nativo de compartir, todo lo demás (Android y escritorio) descarga el archivo directo vía `<a download>`. A diferencia de Facturas, Bank **no** tiene visor de PDF embebido en escritorio — el que venía copiado de Facturas (`_showPDFInApp`/`closePdfViewer`/`downloadPdfViewer`/`printPdfViewer`, `#modal-pdf-viewer`) nunca estuvo conectado a nada y se borró entero en la auditoría de 2026-09-24.

### Backup / Export
- `exportBackup()` — descarga JSON `{funds, movements, profile, exportedAt}`
- `exportMovementsCSV()` — CSV para Excel/contabilidad
- `confirmImportBackup()` — importa JSON y reemplaza TODO (local + Firestore, vía `_applyBackup` + `_replaceFirestoreAll`)
- `_applyBackup(obj)` — aplica un objeto de backup al estado en memoria + localStorage (lo usan tanto el import manual como `restorePreImportBackup`/`restoreSnapshot`)
- `restorePreImportBackup()` — deshace el último import
- `takeSnapshot(reason, movementsOverride?)` / `restoreSnapshot(idx)` — copias automáticas (máx. `SNAPSHOT_LIMIT` = 3)

### Auth
- `_auth.onAuthStateChanged(...)` — punto de entrada principal de la app
- `doLogin()` — a diferencia de Facturas, **confirma con el usuario** antes de crear una cuenta nueva cuando el correo no existe (`_confirmDialog`) — antes lo hacía directo y en silencio: un correo mal escrito abría una cuenta vacía sin avisar, y parecía que se había perdido todo
- `doGoogleLogin()` — mismo patrón que Facturas (popup normal o `signInWithRedirect` en PWA instalada)
- `doLogout()` — ⚠️ a diferencia de Facturas, **borra los datos financieros de este dispositivo** (`bank_funds`/`bank_movements`/`bank_profile`/`bank_snapshots`/`bank_tombstones`/etc. de `localStorage`, y los arrays `funds`/`movements` en memoria) antes de `_auth.signOut()` — quedan a salvo en la nube. Si no, la próxima persona que entrara con su cuenta en el mismo teléfono los vería, y sus propios datos terminarían subiéndose a la cuenta de quien cerró sesión (el merge de `_loadFromFirestore` trata lo que encuentra local como "para subir"). Sin conexión, el diálogo de confirmación avisa aparte que lo no sincronizado se perdería.
- `_isDev` — `true` en `localhost`/`127.0.0.1`/IP privada/`file:`; salta el login para poder probar sin tocar la nube

### Ajustes — sub-vistas
- `SETTINGS_SUBVIEWS` = `['novedades-page', 'tema-page', 'copias-page', 'perfil-page']` — Bank NO tiene "Clientes Guardados" ni "Tu Compañía" (eso era de Facturas)
- `_openSettingsSubView(id)` / `_closeSettingsSubView()` — mecanismo compartido, igual que Facturas
- Pares propios: `openTemaPage()`/`closeTemaPage()`, `openCopiasPage()`/`closeCopiasPage()`, `openPerfilPage()`/`closePerfilPage()` (+ `savePerfilFromSettings()`), `showChangelog(force)`/`closeChangelog()` (Novedades)

### Confirmaciones y modales
- `_confirmDialog(message, opts, triggerEl?)` — modal propio que reemplaza `confirm()` nativo (idéntico a Facturas)
- `MODAL_CLOSE_FNS` — mapea id de modal → función de cierre correcta (`modal-password`, `modal-import`, `modal-confirm`, `modal-changelog`, `modal-fund`); lo usa el listener de Esc
- `_topOpenModal()` (en `window._topOpenModal`) — resuelve el modal de ENCIMA cuando hay varios apilados, vía `data-open-order`

## Navegando `index.html`

Es un archivo de ~5600 líneas. Busca con Grep:

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
| Transferencias entre cuentas | `_fundEffect` o `formToFundId` |
| Meta con fecha / plan de ahorro | `_goalPaceInfo` o `_planPaceInfo` |
| Categorías de gasto | `OUT_CATEGORIES` o `_spendingByCategory` |
| Tumbas de borrado (sync multi-dispositivo) | `_tombFunds` o `_recordTombstones` |
| Paginación de la lista de movimientos | `MOVEMENT_PAGE_SIZE` o `_movementListShown` |

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
8. **`fundBalance()` ya no es O(n²)** (se arregló en la auditoría de 2026-09-24: arma un índice de devoluciones por préstamo una sola vez dentro de su propio bucle). `loanBalance()` en sí sigue siendo O(n) por llamada — está bien para los lugares que la usan sueltos (una tarjeta, un selector), pero si alguna vez la vuelves a meter en un bucle sobre TODOS los movimientos, vas a reintroducir el mismo problema; usa el patrón de índice de `fundBalance()` como ejemplo.
9. **`.items-table`** (usada por `_fundsTableHTML()` y la tarjeta "En qué gastaste" del Resumen) tiene su propio CSS completo — ya NO depende de selectores genéricos de tag (`table`, `thead th`, `tbody td`, etc., que existían para el viejo formulario de factura de Facturas y se borraron en la auditoría de 2026-09-24). Si agregas una tabla nueva sin la clase `.items-table`, no va a heredar ningún estilo de estas — dale la clase o defínele CSS propio.
10. **Ids con formato validado a la entrada (`_SAFE_ID` en `normalizeFunds`/`normalizeMovements`):** un backup manipulado a mano con un id de cuenta/movimiento que llevara comillas podía inyectar HTML/JS (probado en la auditoría de 2026-09-24 — un id como `99" data-x="1` se colaba tal cual en un atributo `data-card-id="${f.id}"` sin escapar). Se filtra en el único cuello de botella por el que pasan los tres orígenes de datos (localStorage, Firestore, backup importado): un id que no sea `/^[a-zA-Z0-9_-]+$/` hace que ese registro entero se descarte, igual que ya pasaba con un id ausente. Si agregas un campo nuevo que también vaya a un atributo HTML sin pasar por `escapeHTML()`, dale el mismo tratamiento — no confíes en que el llamador se acuerde de escapar.
11. **Botones de "Guardar" deshabilitados de verdad, no con una bandera** (`#save-mov-btn`, `#save-fund-btn`) — ver el pitfall en la sección "Formulario de movimiento" más arriba. Cualquier acción que se pueda disparar dos veces seguidas por un doble toque (no solo guardar) debería considerar el mismo patrón si el resultado de repetirla no es idempotente.
