# Webhook Vercel para Rocketbot TestFire

Este proyecto recibe una corrida de Rocketbot en `POST /api/rpa/corridas` y la guarda en Postgres (Neon). Vercel despliega el código desde GitHub; Postgres conserva los datos.

## Archivos

- `api/rpa/corridas.js`: función HTTP que valida el secreto y persiste las corridas.
- `database.sql`: tabla `rpa_runs` donde se guardan los datos generales, las filas extraídas de la web, las transacciones API y el JSON original.
- `package.json`: dependencia del driver serverless Neon.

## Preparar y desplegar

1. Sube el contenido de esta carpeta a la raíz de un repositorio GitHub, o configura la carpeta como **Root Directory** del proyecto en Vercel.
2. En Vercel, conecta el repositorio GitHub y crea el proyecto.
3. Agrega una base Postgres desde el Marketplace de Vercel (por ejemplo Neon). Copia la cadena de conexión a `DATABASE_URL` si Vercel no la agregó automáticamente.
4. En el editor SQL de la base Postgres, ejecuta `database.sql` una vez.
5. En Vercel → Settings → Environment Variables, agrega `RPA_WEBHOOK_SECRET` con una clave larga aleatoria. Mantén el mismo valor en Rocketbot, en `VERCEL_WEBHOOK_SECRET`.
6. Instala dependencias y despliega el proyecto desde GitHub. La URL del webhook será `https://TU-DOMINIO.vercel.app/api/rpa/corridas`.
7. En Rocketbot, configura `URL_VERCEL_API` con esa URL y `VERCEL_WEBHOOK_SECRET` con la misma clave del paso 5.

## Variables de entorno en Vercel

| Nombre | Valor |
| --- | --- |
| `DATABASE_URL` | URL de conexión Postgres/Neon. La integración de almacenamiento puede inyectarla automáticamente. |
| `RPA_WEBHOOK_SECRET` | Secreto largo para autenticar los POST del robot. |

## Variables que usa Rocketbot

| Variable | Valor |
| --- | --- |
| `URL_VERCEL_API` | URL HTTPS desplegada terminada en `/api/rpa/corridas`. |
| `VERCEL_WEBHOOK_SECRET` | El mismo secreto que `RPA_WEBHOOK_SECRET`. |

El robot envía un JSON con `run_id`, `status`, `web_rows`, `api_rows`, `web_transactions`, `api_transactions`, fechas, equipo, usuario y mensajes de API/feedback. No incluye el token de Altoro ni las credenciales de login.

El `run_id` es clave primaria. Reenviar una corrida actualiza el mismo registro en vez de duplicarlo.
