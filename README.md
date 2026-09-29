# sri_retenciones

Descargador de comprobantes electrónicos recibidos del SRI (Retenciones y Facturas).

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run main.ts
```

## Requisitos

- [Bun](https://bun.sh)
- Google Chrome o Chromium — se detecta solo (`/usr/bin/google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, o el Chrome empaquetado de puppeteer en `~/.cache/puppeteer`). Se puede forzar una ruta con la variable de entorno `CHROME_PATH`. En WSL instala el `.deb` de Google Chrome para Linux; no apuntes al `chrome.exe` de Windows (la conexión CDP y las rutas de descarga fallan).
- Una API key de [2captcha](https://2captcha.com) para resolver el reCAPTCHA Enterprise invisible del portal. Se configura con la variable de entorno `TWO_CAPTCHA_TOKEN` (si no está definida se usa la clave incluida en el código). El flujo: detecta el widget en la página (siteKey del iframe), crea la tarea en 2captcha (`createTask`), hace polling (`getTaskResult`), inyecta el token en el formulario y dispara la consulta vía el callback del widget (`onSubmit`), sin plugin de puppeteer. Si 2captcha falla por cualquier motivo (saldo, red, timeout), el programa pide resolver el captcha manualmente en la ventana de Chrome (el captcha invisible suele auto-validarse al consultar) y continúa automáticamente al validarse.

## Uso

Al ejecutar el programa aparece un menú interactivo (hecho con [@clack/prompts](https://github.com/bombshell-dev/clack)):

1. **Tipo de comprobante**: Retenciones, Facturas o Salir.
2. **RUC** (10 a 13 dígitos), **clave** del portal SRI (oculta al escribir) y **año** (Enter = año actual).
3. **Periodo**: todo el año o un mes específico. Si eliges solo el año, descarga los 12 meses.

Los comprobantes (PDFs) se guardan en `./<RUC>/Comprobantes/<año>/<mes>/<clave de acceso>/`, junto con los resúmenes:

- Retenciones: `IVA.xlsx`, `RENTA.xlsx` y `UNKNOWN.xlsx` por mes, y en `./<RUC>/` el `raw_result.json` más los tres Excel consolidados.
- Facturas: `FACTURAS.xlsx` por mes, y en `./<RUC>/` el `facturas.json` más el `FACTURAS.xlsx` consolidado.

## Logs

Cada ejecución escribe un log estructurado (JSON lines) en `./logs/sri-<fecha-hora>.log` con [pino](https://github.com/pinojs/pino). La consola muestra nivel info o superior en formato corto; el archivo guarda también los eventos debug (incluye la consola del navegador y las respuestas intermedias de la página). Al terminar la ejecución, o si falla con error, se imprime la ruta del log.

This project was created using `bun init` in bun v1.1.36. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
