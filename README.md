# SIGA – Backend (Node.js + Express + MySQL)

API REST del Sistema de Información y Gestión Agropecuaria del MADR. Sigue el esquema `db/SIGA.sql`:
las reglas críticas (Reglas 3, 5, 8, 9, inmutabilidad de la cadena de custodia) **viven en la BD como triggers**;
el backend añade autenticación, permisos por rol, validaciones del BMM que el esquema no cubre y la API.

## Puesta en marcha

```bash
npm install
cp .env.example .env        # ya incluido un .env con la conexión a Aiven
mysql --ssl-mode=REQUIRED -h <host> -P <puerto> -u avnadmin -p < db/SIGA.sql   # solo si la BD aún no tiene el esquema
npm run check-db            # verifica SSL, tablas, triggers y procedimientos
npm run seed-passwords      # reemplaza los hashes de marcador (contraseña demo: Siga2026*)
npm run dev                 # http://localhost:3000/api/health
npm test                    # 58 pruebas de integración de las reglas del BMM
```

> **Aiven:** el script crea triggers y procedimientos. Si el `source` falla con *"You do not have the SUPER privilege and binary logging is enabled"*,
> activa `log_bin_trust_function_creators = ON` en *Service settings → Advanced configuration* y vuelve a ejecutarlo.
> Para verificar el certificado, descarga `ca.pem` desde la consola de Aiven y pon su ruta en `DB_SSL_CA`.

Usuarios demo (contraseña `Siga2026*`): `admin@madr.gov.co` (ADMIN), `inspector@ica.gov.co` (ENTIDAD/ICA),
`extensionista@madr.gov.co`, `maria.gomez@correo.co` y `cacaoteros.tumaco@correo.co` (PRODUCTOR).
Las entidades DIAN y ANT no tienen usuario semilla: créalos con `POST /api/usuarios` (ADMIN) y `entidad_id` 8 y 3.

## Endpoints (`/api`, JWT `Authorization: Bearer <token>`)

| Módulo | Ruta | Quién |
|---|---|---|
| Auth | `POST /auth/login` · `POST /auth/register` (productor) · `GET /auth/me` · `POST /auth/cambiar-password` | público / autenticado |
| Usuarios | `GET/POST /usuarios` · `PATCH /usuarios/:id` (rol, entidad, activo) | ADMIN |
| Catálogos | `GET /catalogos/entidades · municipios · productos` | público |
| Productores | `GET /productores` · `GET /productores/:id` · `GET /productores/documento/:tipo/:numero` · `POST` · `PATCH /:id` · `PATCH /:id/validar` · `PATCH /:id/estado` | PRODUCTOR solo lo suyo; registro: EXTENSIONISTA/ADMIN; validar/estado: ENTIDAD/ADMIN |
| Predios | `GET/POST /predios` · `PATCH /:id` · `PATCH /:id/verificar` · `PATCH /:id/fondo-tierras` | fondo de tierras: ANT/ADMIN |
| Lotes | `GET/POST /lotes` · `GET /lotes/:id` (id o código QR) · `GET/POST /lotes/:id/eventos` · `GET /lotes/:id/verificar-cadena` | PRODUCTOR (propios), EXTENSIONISTA, ADMIN |
| Offline | `POST /sync/eventos` (lote de hasta 200, idempotente) · `GET /sync/bootstrap` | autenticado |
| Alertas | `GET /alertas` · `POST /alertas` · `PATCH /alertas/:id/resolver` | abrir: ICA/ADMIN; cerrar: la misma entidad/ADMIN |
| Exportaciones | `GET/POST /exportaciones` · `GET /:id` · `POST /:id/recalcular` · `PATCH /:id/documentos-dian` · `PATCH /:id/aprobar` · `PATCH /:id/rechazar` | documentos: DIAN; aprobar/rechazar: DIAN, MADR, ADMIN |
| Dashboard | `GET /dashboard/resumen · cobertura-trazabilidad · cobertura-territorial · lotes-desactualizados · exportaciones-pendientes` | ENTIDAD, EXTENSIONISTA, ADMIN |
| Público (QR) | `GET /public/trazabilidad/:codigo` | sin login, sin datos personales |
| Auditoría | `GET /auditoria` | ADMIN |

Listados con `?page=&limit=` (máx. 100). Todas las fechas en UTC (ISO 8601 con zona en la entrada).
Errores: `{ "error": "...", "detalles": {...} }` — 400 validación, 401/403 acceso, 404, 409 duplicado, 422 regla de negocio.

## Dónde se cumple cada regla del BMM

| Regla | Dónde |
|---|---|
| R1 documento único | `uq_productor_documento` → 409 |
| R3 lote con alerta ICA no se vende/exporta | triggers `trg_alerta_ai`, `trg_lote_bu`, `trg_evento_bi` |
| R4 etapa requiere la anterior | `services/eventos.js` (PREREQ; valida presencia, no fecha, por el modo offline) |
| R5/R15 predio verificado antes de operar | trigger `trg_lote_bi` + `PATCH /predios/:id/verificar` |
| R7/R8 consulta previa (acta + fecha) | `productores.js` (zod) + CHECK de la BD |
| R8 (exportación) checklist 5/5 | trigger `trg_exportacion_bu` + `sp_recalcular_checklist` |
| R9 cifrado y bitácora | TLS a la BD (`config/db.js`) + `middlewares/audit.js` |
| R11 código único por lote | UUID v4 (cliente o servidor) con `uq_lote_codigo` |
| R16 Fondo de Tierras solo con predio completo | `predios.js` |
| R19/R20 permisos por rol, revisión al cambiar | `middlewares/auth.js` (recarga rol/estado del usuario en cada petición) |
| R21/R22 datos > 24 h sin actualizar | `v_lotes_desactualizados` → `/dashboard` |
| R24 / Táctica 4.1 offline | `POST /sync/eventos` |
| Táctica 1.2 cadena verificable | hash encadenado en BD + `GET /lotes/:id/verificar-cadena` |

## Límites conocidos (el esquema no los modela)
- **R12** (natural vs. procesado) y **R14** (solicitudes de cambio) no tienen columnas/tablas; hace falta ampliar el esquema.
- **R8 (consulta previa)**: la tabla guarda acta y fecha, no la comunidad ni el propósito.
- **Táctica 3.1** (contraste con la DIAN): hoy `DOCUMENTOS_DIAN` lo confirma un usuario DIAN a mano; no hay integración real.
- **SIEMBRA** es opcional en la cadena (el lote ya guarda `fecha_siembra` y los datos semilla no la incluyen).
