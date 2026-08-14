# uTracker API

Backend de uTracker: gestor de pedidos multi-tenant con workflow de estados personalizable.

## Stack

- Node.js + Express + TypeScript
- MongoDB + Mongoose
- JWT (access + refresh)

## Estructura

```
src/
  config/       # env y conexión a Mongo
  models/       # Tenant, User, Membership, Product, Customer, WorkflowState, Order, OrderLink
  middleware/   # auth, multi-tenancy, manejo de errores
  controllers/  # lógica de negocio por recurso
  routes/       # definición de endpoints
  services/     # seed de workflow por defecto, etc.
  utils/        # ApiError, asyncHandler, jwt
```

## Correr localmente

Necesitás una instancia de MongoDB. Opciones:

- **Docker** (más simple): `docker run -d -p 27017:27017 --name utracker-mongo mongo:7`
- **MongoDB Atlas** (free tier, sin instalar nada): crear cluster y usar su connection string en `MONGODB_URI`
- **Instalación local**: [MongoDB Community Server](https://www.mongodb.com/try/download/community)

Luego:

```bash
cp .env.example .env   # ajustar MONGODB_URI si hace falta
npm install
npm run dev
```

El servidor levanta en `http://localhost:4000`. Healthcheck: `GET /health`.

## Modelo mental del workflow

Cada tenant tiene **dos** líneas de estados independientes y personalizables, creadas por defecto al crear el negocio (`seedDefaultWorkflow`) y editables después:

- `fulfillment`: Recibido → En preparación → Listo → Entregado (+ Cancelado)
- `payment`: Pendiente → Parcial → Pagado (+ Reembolsado)

Un pedido (`Order`) referencia un estado actual de cada tipo (`fulfillmentState`, `paymentState`) y mantiene `stateHistory` con el registro completo de cambios.

El `position` de cada estado es **solo orden de visualización**: no hay reglas de transición, cualquier estado puede pasar a cualquier otro. Es deliberado — en la práctica los pedidos se saltean pasos y vuelven atrás.

### Qué pasa al editar el workflow con pedidos en curso

| | Comportamiento |
|---|---|
| Estado **actual** del pedido | Referencia viva: renombrar o recolorear se refleja en el acto |
| **Historial** (`stateHistory`) | **Congelado**: guarda nombre, color e ícono del momento de la transición |

Es el mismo patrón que `OrderItem`, que congela `name` y `unitPrice` para que cambiar el precio de un producto no reescriba pedidos viejos. Renombrar "Listo" a "Empacado" no debe hacer que un pedido de hace un mes afirme haber pasado por "Empacado".

Todo lo que escriba historial debe usar `buildHistoryEntry()` (`src/services/stateHistory.ts`) — así ningún sitio de escritura se olvida del snapshot.

Para datos anteriores a este cambio:

```bash
npm run migrate:history            # dry run
npm run migrate:history -- --apply
```

## Auth multi-tenant

1. `POST /api/auth/register` / `login` — cuenta de usuario (global, sin tenant).
2. `POST /api/tenants` — crea el negocio, genera membership `owner` y el workflow por defecto.
3. Todas las rutas de negocio requieren header `X-Tenant-Id: <tenantId>` — el middleware `requireTenant` valida que el usuario tenga membership activo ahí y resuelve su rol (`owner | admin | staff | driver`).

## Endpoints de workflow

Solo `owner` y `admin` pueden editarlo.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/tenants/workflow` | Devuelve los estados agrupados por `fulfillment` / `payment` |
| `POST` | `/api/tenants/workflow/states` | Crea un estado al final de la lista |
| `PATCH` | `/api/tenants/workflow/states/reorder` | Reordena; recibe `{ kind, orderedIds }` |
| `PATCH` | `/api/tenants/workflow/states/:id` | Renombra, color, ícono, roles, inicial/final, notificación |
| `DELETE` | `/api/tenants/workflow/states/:id` | Elimina y compacta las posiciones |

Invariantes que el backend hace cumplir (devuelven `409`/`400`, no rompen datos):

- Siempre hay **exactamente un estado inicial** por tipo. Marcar uno nuevo desmarca el anterior; desmarcar el único falla.
- El estado de **cancelación no se puede eliminar** ni dejar de ser final.
- **No se elimina un estado que tenga pedidos dentro** — el error dice cuántos hay.
- El estado inicial no se puede eliminar sin designar otro antes.

> La ruta `reorder` se registra **antes** que `/:id`, si no Express la interpreta como un id.

## Productos y servicios

Un solo modelo (`Product`) para ambos: comparten nombre, descripción, categoría, precio y estado. Dos entidades separadas duplicarían el ABM y el selector de pedidos sin ganar nada.

Los diferencia `kind` (`product` | `service`) y sobre todo `pricingMode`:

- **`fixed`** — el precio del catálogo es el precio.
- **`quoted`** — el precio del catálogo es solo referencia; el real se acuerda por pedido. `createOrder` **exige** `unitPrice` para estos ítems en lugar de asumir uno.

Los servicios fuerzan `trackStock: false` — no hay nada que contar.

### Líneas de pedido

`OrderItem.product` es **opcional**: una línea sin producto es un trabajo puntual que no justifica una entrada de catálogo (requiere `name` y `unitPrice`). `OrderItem.specs` guarda el detalle de ese pedido en particular — medidas, textos, colores.

Los links de pedido **rechazan ítems `quoted`**: el cliente vería un precio que nadie acordó. Esos pedidos se cargan a mano.

## Imágenes (Cloudflare R2)

R2 es compatible con S3, así que se usa `@aws-sdk/client-s3` contra `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` con `region: 'auto'` (R2 no tiene regiones).

**Toda la config de R2 es opcional.** Sin ella la API arranca igual y solo se desactiva la subida: `GET /api/uploads/status` devuelve `{configured:false}` y el frontend muestra un aviso en vez de un botón que fallaría.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/uploads/status` | Si el storage está configurado |
| `POST` | `/api/uploads` | Sube una imagen (multipart, campo `file`). Solo owner/admin |
| `DELETE` | `/api/uploads` | Borra por `url`. Solo owner/admin |

El archivo viaja por la API en vez de ir directo al bucket: así la validación es del lado del servidor y no hace falta configurar CORS en R2.

**Validaciones**, en este orden — todas corren antes de tocar el storage:

1. Tamaño (multer y de nuevo en el servicio, que es alcanzable desde otros lados)
2. **Magic bytes.** El `Content-Type` que declara el cliente es falsificable, así que mandan los bytes: un `.exe` renombrado a `.jpg` se rechaza con 400.
3. Recién ahí se sube.

Las claves son `<tenantId>/<carpeta>/<uuid>.<ext>` — acotadas por negocio y aleatorias, así que tener una no permite adivinar otras. `DELETE` verifica que la URL caiga bajo el prefijo del negocio.

> Borrar un ítem del catálogo es **soft delete** (`isActive: false`), así que sus imágenes **no** se borran: si lo reactivás, siguen ahí.

## Seguimiento del cliente

`GET /api/track/:token` — público, sin auth. El token es la credencial.

Cada `Order` lleva un `trackingToken` aleatorio generado por defecto en el schema, así que ambos caminos de creación lo obtienen sin tocar los controllers. **Nunca exponer el `_id`**: es enumerable y permitiría recorrer los pedidos de otros negocios.

El payload se arma campo por campo en el controller. No hacer spread del documento: filtraría notas internas, el repartidor asignado y los datos del cliente a cualquiera que tenga el link. El estado de cancelación se omite de los pasos salvo que el pedido esté efectivamente cancelado, para no alarmar sin motivo.

Para pedidos anteriores a esta feature:

```bash
npm run migrate:tracking            # dry run
npm run migrate:tracking -- --apply
```

### Iconos de estado

`WorkflowState.icon` guarda un **nombre** del registry del frontend (`"truck"`, `"circle-check"`), no un emoji. El backend no valida el nombre: si no existe, la UI cae a un placeholder neutro.

Para migrar datos viejos con emojis:

```bash
npm run migrate:icons            # dry run: imprime el plan sin tocar nada
npm run migrate:icons -- --apply # escribe los cambios
```

Mapea emojis conocidos a nombres y **deja intactos** los que no reconoce, listándolos al final para que los ajustes desde la UI.

## Pendiente (fases siguientes)

- Notificaciones WhatsApp al cambiar de estado (`WorkflowState.notifyCustomer` ya está en el modelo y es editable desde la UI, falta la integración)
- Vista de repartidor (rol `driver`)
- La confirmación de un link crea el `Customer` antes de validar los productos: si falla a mitad queda un cliente huérfano. Arreglarlo requiere transacciones, y eso pide Mongo en replica set.
