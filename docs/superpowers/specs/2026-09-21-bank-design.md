# Bank — diseño

Fecha: 2026-09-21

## Qué es

App personal de ahorro, hermana de Facturas (`Proyectos/Facturas`). Misma pinta, mismas animaciones, mismo login, nube, tema, copias automáticas, PWA. Cambia el contenido: en vez de facturas y clientes, lleva **fondos de ahorro** y **movimientos** de dinero en cada fondo.

Ejemplo: "Vacaciones" tiene 1,000. Saco 100 prestados → *Tienes 900 · Debes 100*. Devuelvo 100 → *Tienes 1,000 · Debes 0*.

## Cómo se construye

**Camino elegido:** copiar `Facturas/index.html` tal cual y transformarlo. Se quita lo que es de facturas, se renombra "factura → movimiento" y "cliente → fondo". Todo lo que no cambia (genie, tema, login, sync, backup, novedades, modo batería, SW) queda idéntico porque es el mismo código.

- Carpeta: `Proyectos/Bank`. Repo propio en GitHub (`Bank`), GitHub Pages.
- Archivos: `index.html` (toda la app), `sw.js` (`bank-vN`), `manifest.json`, `icon.png` / `icon-192.png` / `icon-maskable.png` nuevos (color distinto a Facturas para diferenciarla en el teléfono).
- Nombre visible: **Bank**.
- Firebase: **proyecto nuevo y separado** (Auth correo + Google, Firestore). El usuario lo crea en la consola y pega la configuración; las reglas son las mismas de Facturas (`users/{uid}/**` solo para ese uid).

**Orden de trabajo:** primero funciona **solo en local** (localStorage, sin nube) para probarla en el navegador; cuando guste, se conecta Firebase y se publica.

## Conceptos

### Fondo
```js
{
  id: "1718000000000",   // Date.now().toString()
  name: "Vacaciones",
  goal: 3000,            // opcional; 0/ausente = sin meta
  color: "#2e7d32",      // opcional, para la tarjeta
  createdAt: "2026-09-21"
}
```
Saldos calculados, no guardados:
- **Tienes** = Meter + Devolver − Sacar prestado − Gastar (de ese fondo)
- **Debes** = suma de (monto de cada préstamo − sus abonos)

### Movimiento
```js
{
  id: "1718000000001",
  fundId: "1718000000000",
  type: "in" | "loan" | "repay" | "out",   // Meter · Sacar prestado · Devolver · Gastar
  amount: 100,
  date: "2026-09-21",
  note: "",
  // solo type === 'loan':
  dueDate: "",         // ISO opcional; vencido si balance > 0 && dueDate < hoy
  repayments: [],      // [{ date, amount, movementId }] — abonos recibidos
  settled: false,      // true cuando la suma de repayments >= amount (se marca sola)
  // solo type === 'repay':
  loanId: ""           // a qué préstamo abona
}
```
- Un movimiento `repay` siempre apunta a un `loan` del mismo fondo. Al guardarlo se agrega a `loan.repayments` y, si el saldo llega a 0, `settled = true`. Al borrar o editar el `repay`, se recalcula (simétrico, como `deletePayment` en Facturas).
- `normalizeMovements()` fuerza `amount`, `repayments[].amount` a `Number` (mismo rol que `normalizeInvoices`).

## Pantallas (4 pestañas abajo: Fondos · Movimientos · Resumen · Ajustes)

**Fondos** — una tarjeta por fondo: nombre, *Tienes $X*, *Debes $Y* (solo si > 0), barra de progreso si tiene meta (`X de meta · %`). Botón "Nuevo fondo" (nombre, meta opcional, color opcional). Tocar tarjeta → se abre con genie la sub-vista del fondo: lista de sus movimientos + botón "Nuevo movimiento" (fondo preseleccionado). Menú ⋮ del fondo: editar, PDF estado del fondo, borrar (pide confirmación; borra también sus movimientos).

**Movimientos** — historial tipo Facturas: buscador (nota, fondo, monto), chips de año y de fondo (solo si hay > 1), tarjeta por movimiento: ícono/etiqueta del tipo, fondo, monto (verde entra / rojo sale), fecha, nota. Préstamos: *Debes $Z*, badge "vencido" en rojo si pasó `dueDate`, "devuelto" si `settled`. Menú ⋮: editar, **Devolver** (abre el formulario con type=repay y loanId prellenado; solo en préstamos con saldo), duplicar, borrar.

**Resumen** — dashboard: selector de período (mismo de Facturas) y de fondo. Métricas: Tienes (total o del fondo), Debes, Metido / Sacado / Devuelto / Gastado en el período, préstamos vencidos. Gráfica por mes (entradas vs salidas). Menú ⋮: PDF "Estado del fondo" (con fondo elegido) o "Resumen general".

**Ajustes** — igual que Facturas menos lo de empresa/logo/clientes/plantillas/mensajes:
- Perfil: tu nombre (para el encabezado del PDF).
- Apariencia: tema, menos efectos, **Pantalla de inicio: Fondos / Movimientos** (`bank_home_tab`).
- Copias automáticas, Backup JSON (exportar / importar / deshacer import), CSV de movimientos.
- Novedades (empieza con una entrada "Primera versión"), cerrar sesión.

Botón flotante "+" en Fondos y Movimientos → nuevo movimiento.

## Formulario de movimiento

Reemplaza al de factura. Vive en la misma vista `create` (genie desde el botón que lo abrió).
- **Tipo**: 4 botones grandes (Meter · Sacar prestado · Devolver · Gastar).
- **Fondo**: selector; preseleccionado si se entró desde un fondo. Si no hay fondos, el formulario pide crear uno primero.
- **Monto**, **Fecha** (hoy, calendario de Facturas), **Nota** opcional.
- Solo `loan`: *Devolver antes del…* (fecha opcional).
- Solo `repay`: *Préstamo* — lista de préstamos con saldo de ese fondo; si hay uno solo se elige solo; si no hay ninguno, aviso "No debes nada en este fondo".
- Validación: monto > 0; `repay` avisa (sin bloquear) si supera el saldo del préstamo, igual que `savePayment`.
- Borrador en `sessionStorage` (`bank_draft`) y "cambios sin guardar", como Facturas.

## PDF

Una sola plantilla (basada en una de las 5 de Facturas), `_ensureJsPDF()` perezoso igual:
- **Estado del fondo**: encabezado con nombre del usuario y del fondo, Tienes / Debes / Meta, tabla de movimientos (fecha, tipo, nota, entra, sale, saldo acumulado), préstamos pendientes al final.
- **Resumen general**: una sección por fondo con sus saldos + totales.
Entrega con `_deliverPDF` (compartir en móvil, visor/descarga en escritorio).

## Datos y persistencia

localStorage (prefijo `bank_`):
| Key | Qué |
|---|---|
| `bank_funds` | array de fondos |
| `bank_movements` | array de movimientos (más reciente primero) |
| `bank_profile` | `{ name }` |
| `bank_home_tab` | `'funds'` \| `'movements'` |
| `bank_theme_mode`, `bank_lite_mode`, `bank_cl_seen`, `bank_cl_first_seen`, `bank_snapshots`, `bank_pre_import_backup`, `bank_pre_import_date` | mismos roles que sus equivalentes `inv_*` |

sessionStorage: `bank_draft`, `splashShownSession`.

Firestore (fase 2):
- `users/{uid}/funds/{id}`, `users/{uid}/movements/{id}`, `users/{uid}/settings/main` (`profile`, `homeTab`).
- Mismo mecanismo: `_syncMovement`, `_syncFund`, `_syncSettings`, `_loadFromFirestore` (merge, nube gana), `_attachRealtimeListeners`, `_replaceFirestoreAll` tras import/restore, `_commitOpsInChunks`.

Backup JSON: `{ funds, movements, profile, exportedAt }`. Import reemplaza todo (local + nube) con snapshot previo para deshacer.

## Lo que se quita de Facturas

Tablas de ítems, plantillas de ítem, 5 diseños de PDF (queda 1), selector de diseño, logo y "Tu Compañía", directorio de clientes, mensaje de recordatorio, mensaje al compartir, modo selección (compartir/descargar varias), gastos aparte, impuesto por defecto, numeración de facturas, facturas recurrentes.

## Lo que se conserva tal cual

Login (correo, Google, olvidé contraseña), sync en tiempo real, banner offline, tema (claro/oscuro/auto), menos efectos, genie de vistas y modales, `_confirmDialog`, sub-vistas de Ajustes, novedades, copias automáticas, backup/CSV, PWA + service worker (caché primero + revalidar), splash, accesibilidad de modales (`_topOpenModal`), todos los pitfalls documentados en `Facturas/CLAUDE.md` (SW version bump, `{ once: true }`, `_prefersReducedMotion`, etc.).

## Pruebas

Sin framework. Un `_selfCheck()` en la consola que arma 1 fondo + Meter 1000, loan 100, repay 100 y comprueba con `console.assert` que Tienes = 1000 y Debes = 0, que `settled` se marca, y que borrar el repay vuelve a Debes = 100. Verificación visual en el navegador (preview) en cada fase.

## Fases

1. **Local:** copia + poda + fondos + movimientos + resumen + PDF + backup, solo localStorage. Se prueba en navegador.
2. **Nube y publicación:** proyecto Firebase nuevo (config del usuario), reglas, repo GitHub `Bank`, Pages, íconos, novedades.
