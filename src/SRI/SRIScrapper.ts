import fs from "fs";
import os from "os";
import path from "path";
import type { ElementHandle, HTTPResponse } from "puppeteer";
import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createInterface } from "readline/promises";
import { setTimeout } from "timers/promises";
import UserAgents from "user-agents";
import { logger } from "../utils/logger";
import { Months } from "../utils/months";
import {
  detectRecaptcha,
  getTwoCaptchaApiKey,
  injectRecaptchaToken,
  solveRecaptchaWith2Captcha,
} from "./CaptchaSolver";
import type { IFactura } from "./IFactura";
import type { IRetencion } from "./IRetencion";

/**
 * Alertas del SRI cuando el captcha es rechazado en la respuesta de la
 * consulta ("Captcha incorrecta" / "No se pudo validar el captcha en google").
 */
const CAPTCHA_REJECTED_RE =
  /captcha incorrect[oa]|no se pudo validar el captcha/i;

puppeteer.use(StealthPlugin());

/**
 * Normaliza una etiqueta del modal de detalle del SRI para usarla como clave
 * de búsqueda: quita tildes, pasa a mayúsculas y elimina caracteres no
 * alfanuméricos. Ej: "Punto de Emisión" -> "PUNTODEEMISION"
 */
export function normalizeLabel(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Convierte un valor monetario del portal SRI ("1.234,56", "1234,56",
 * "1234.56") a number. Devuelve 0 si no es un número válido.
 */
export function toMoney(s: string): number {
  const t = s.trim().replace(/\s/g, "");
  if (!t) return 0;
  let cleaned = t;
  if (cleaned.includes(".") && cleaned.includes(",")) {
    // "1.234,56" -> "1234.56"
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (cleaned.includes(",")) {
    // "1234,56" -> "1234.56"
    cleaned = cleaned.replace(",", ".");
  }
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Mapea los pares etiqueta/valor del modal de detalle de una FACTURA
 * (ver parseFacturaDialog) a un objeto IFactura. Etiquetas reales del
 * portal: "Número RUC", "Fecha Emisión", "Total Sin impuestos",
 * "Importe Total", "Total Propina", ... (normalizadas, ver normalizeLabel).
 */
export function mapFacturaFromLabels(
  pairs: Array<[string, string]>,
  claveAccesoFromRow: string,
  ivaFromTotalsTable?: number | null,
): IFactura {
  const labels = new Map<string, string>();
  for (const [label, value] of pairs) {
    const key = normalizeLabel(label);
    const val = (value ?? "").trim();
    // El primer valor no vacío gana: el panel de la factura abierta viene
    // primero en el DOM y los demás paneles de detalle están vacíos.
    if (key && val && !labels.has(key)) {
      labels.set(key, val);
    }
  }
  const get = (...keys: string[]): string => {
    for (const key of keys) {
      const value = labels.get(key);
      if (value) return value;
    }
    return "";
  };
  // SRI muestra los valores con 2 decimales: se redondea a centavos para
  // evitar ruido de punto flotante (ej: 16.05 - 14.95 = 1.1000000000000014).
  const roundMoney = (n: number): number => Math.round(n * 100) / 100;
  const totalSinImpuestos = roundMoney(
    toMoney(get("TOTALSINIMPUESTOS", "SUBTOTALSINIMPUESTOS")),
  );
  // "Importe total" (o "Valor total"/"Total") — nunca "Total descuento",
  // "Total Sin impuestos" ni "Total sin subsidio" (match exacto).
  const total = roundMoney(toMoney(get("IMPORTETOTAL", "VALORTOTAL", "TOTAL")));
  // IVA: de la tabla resumen de impuestos del modal (parseFacturaDialog);
  // fallback: derivado del total (total = sin impuestos + IVA + propina).
  const iva = roundMoney(
    ivaFromTotalsTable ??
      Math.max(
        0,
        total - totalSinImpuestos - toMoney(get("TOTALPROPINA", "PROPINA")),
      ),
  );
  return {
    razonSocial: get("RAZONSOCIAL"),
    ruc: get("NUMERORUC", "RUC", "RUCCI", "RUCEMISOR"),
    claveAcceso: get("CLAVEDEACCESO") || claveAccesoFromRow.trim(),
    establecimiento: get("ESTABLECIMIENTO"),
    puntoEmision: get("PUNTODEEMISION"),
    secuencial: get("SECUENCIAL"),
    fechaEmision: get("FECHAEMISION", "FECHADEEMISION"),
    totalSinImpuestos,
    iva,
    total,
    estado: get("ESTADO") || undefined,
  };
}

/**
 * Mapea los pares etiqueta/valor del modal de detalle de un COMPROBANTE DE
 * RETENCIÓN y las filas de su tabla de impuestos retenidos (cada fila un
 * objeto con las columnas por encabezado normalizado: NRO, IMPUESTO,
 * BASEIMPONIBLE, PORCENTAJERETENIDO, VALORRETENIDO, NUMERODOCSUSTENTO,
 * FECHADOCSUSTENTO) a los arrays de IRetencion (iva/renta/unknown).
 * Etiquetas reales del portal: "Número RUC", "Fecha Emisión",
 * "Id de Sujeto Retenido", ... (normalizadas, ver normalizeLabel).
 */
export function mapRetencionFromDialog(
  pairs: Array<[string, string]>,
  impuestoRows: Array<Record<string, string>>,
  claveAccesoFromRow: string,
): {
  iva: IRetencion[];
  renta: IRetencion[];
  unknown: IRetencion[];
} {
  const labels = new Map<string, string>();
  for (const [label, value] of pairs) {
    const key = normalizeLabel(label);
    const val = (value ?? "").trim();
    // El primer valor no vacío gana (el panel de la retención abierta viene
    // primero en el DOM y los demás paneles de detalle están vacíos).
    if (key && val && !labels.has(key)) {
      labels.set(key, val);
    }
  }
  const get = (...keys: string[]): string => {
    for (const key of keys) {
      const value = labels.get(key);
      if (value) return value;
    }
    return "";
  };
  const header = {
    razonSocial: get("RAZONSOCIAL"),
    ruc: get("NUMERORUC", "RUC", "RUCCI", "RUCEMISOR"),
    claveAcceso: get("CLAVEDEACCESO") || claveAccesoFromRow.trim(),
    establecimiento: get("ESTABLECIMIENTO"),
    puntoEmision: get("PUNTODEEMISION"),
    secuencial: get("SECUENCIAL"),
    fechaEmision: get("FECHAEMISION", "FECHADEEMISION"),
    idSujetoRetenido: get("IDDESUJETORETENIDO", "IDSUJETORETENIDO"),
    razonSocialSujetoRetenido: get(
      "RAZONSOCIALDESUJETORETENIDO",
      "RAZONSOCIALSUJETORETENIDO",
    ),
    ejercicioFiscal: get("EJERCICIOFISCAL"),
  };
  const result = {
    iva: [] as IRetencion[],
    renta: [] as IRetencion[],
    unknown: [] as IRetencion[],
  };
  for (const row of impuestoRows) {
    const retencion: IRetencion = {
      ...header,
      valoresRetenidos: {
        nro: row["NRO"] ?? "",
        impuesto: row["IMPUESTO"] ?? "",
        baseImponible: toMoney(row["BASEIMPONIBLE"] ?? ""),
        porcentajeRetenido: toMoney(row["PORCENTAJERETENIDO"] ?? ""),
        valorRetenido: toMoney(row["VALORRETENIDO"] ?? ""),
        docSustento: row["NUMERODOCSUSTENTO"] ?? row["DOCSUSTENTO"] ?? "",
        fechaDocSustento: row["FECHADOCSUSTENTO"] ?? "",
      },
    };
    const impuesto = retencion.valoresRetenidos.impuesto;
    if (impuesto === "IVA") {
      result.iva.push(retencion);
    } else if (impuesto === "RENTA") {
      result.renta.push(retencion);
    } else {
      result.unknown.push(retencion);
    }
  }
  return result;
}

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/**
 * Resuelve el ejecutable de Chrome/Chromium para puppeteer, en este orden:
 * 1. Variable de entorno CHROME_PATH (útil en WSL u otras rutas custom)
 * 2. Chrome/Chromium instalado en el sistema (rutas habituales de Linux)
 * 3. El Chrome empaquetado de puppeteer (~/.cache/puppeteer/chrome)
 * Lanza un error accionable si no encuentra ninguno.
 * Nota WSL: NO apuntes al chrome.exe de Windows — puppeteer no podría
 * conectarse al puerto de DevTools (localhost distinto en NAT) y las rutas
 * de descarga de Linux no existen para el proceso de Windows.
 */
export function resolveChromePath(): string {
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(
        `CHROME_PATH apunta a una ruta que no existe: ${envPath}`,
      );
    }
    return envPath;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Chrome empaquetado de puppeteer:
  // ~/.cache/puppeteer/chrome/linux-<version>/chrome-linux64/chrome
  const chromeCache = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "puppeteer",
    "chrome",
  );
  if (fs.existsSync(chromeCache)) {
    const entries = fs
      .readdirSync(chromeCache)
      .sort()
      .filter(
        (entry) =>
          fs.existsSync(
            path.join(chromeCache, entry, "chrome-linux64", "chrome"),
          ) ||
          fs.existsSync(
            path.join(chromeCache, entry, "chrome-linux", "chrome"),
          ),
      );
    if (entries.length > 0) {
      const latest = entries[entries.length - 1];
      const linux64 = path.join(
        chromeCache,
        latest,
        "chrome-linux64",
        "chrome",
      );
      if (fs.existsSync(linux64)) return linux64;
      return path.join(chromeCache, latest, "chrome-linux", "chrome");
    }
  }
  throw new Error(
    "No se encontró Chrome/Chromium. Opciones:\n" +
      "  1) Instalar Google Chrome para Linux (en WSL: descargar google-chrome-stable_current_amd64.deb e instalarlo con 'sudo dpkg -i')\n" +
      "  2) Definir la variable de entorno CHROME_PATH con la ruta del ejecutable",
  );
}

class SRIScrapper {
  private page?: Page;
  private browser?: Browser;
  private RUC!: string;

  async InitScrapper() {
    this.browser = await puppeteer.launch({
      executablePath: resolveChromePath(),
      defaultViewport: {
        width: 1366,
        height: 768,
      },
      headless: false,
      args: [
        "--start-maximized",
        "--no-sandbox",
        "--user-data-dir=/tmp/chromium",
        "--disable-web-security",
        "--disable-features=site-per-process,DownloadBubble,DownloadBubbleV2",
        "--no-first-run",
        "--no-default-browser-check",
        "--incognito",
      ],
      timeout: 120000,
      slowMo: 10,
    });
    const userAgents = new UserAgents();
    this.page = (await this.browser.pages())[0];
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setUserAgent(userAgents.random().toString());
    this.page?.on("console", (msg) => {
      logger.debug({ page: msg.text() }, "Console del navegador");
    });
  }

  private async NavigateToLogin() {
    logger.info("Going to Login");
    await this.page?.goto(
      "https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=57&idGrupo=55",
      { timeout: 0 },
    );
    // await this.page?.waitForSelector(
    //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
    // );
    // logger.info("Clicking Comprobantes electrónicos recibidos");
    // const factButton = await this.page?.$(
    //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
    // );
    // await factButton!.click();

    await this.page?.waitForSelector("#usuario");

    // await this.page?.goto(
    //     "https://srienlinea.sri.gob.ec/sri-en-linea/consulta/55"
    // );
    // await this.page?.waitForSelector(
    //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
    // );
    // logger.info("Clicking Comprobantes electrónicos recibidos");
    // const factButton = await this.page?.$(
    //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
    // );
    // await this.page?.goto(
    //     "https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT"
    // );
    // await factButton!.click();
    // await this.page?.waitForSelector("#usuario");
  }

  private async NavigateToComprobantes() {
    logger.info("Going to Comprobantes");
    // await this.page?.goto(
    //     "https://srienlinea.sri.gob.ec/sri-en-linea/consulta/55",
    //     { timeout: 0 }
    // );
    // await this.page?.waitForSelector(
    //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
    // );
    // logger.info("Clicking Comprobantes electrónicos recibidos");
    // const factButton = await this.page?.$(
    //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
    // );
    // await factButton!.click();
    await this.page?.waitForSelector('select[id="frmPrincipal:ano"]', {
      timeout: 0,
    });
  }

  async Login(RUC: string, password: string) {
    this.RUC = RUC;
    if (!this.page) await this.InitScrapper();
    await this.NavigateToLogin();
    logger.info("Typing credentials...");
    await (await this.page?.$("#usuario"))!.type(RUC);
    await (await this.page?.$("#password"))!.type(password);
    await (await this.page?.$('input[value="Ingresar"]'))!.click();
    await this.NavigateToComprobantes();
    return { RUC, nombre: "" };
  }

  /**
   * Hace click en el botón "Consultar" del formulario. El botón real es
   * frmPrincipal:btnBuscar (onclick: executeRecaptcha + submit de
   * PrimeFaces); se busca por id "contiene" (btnBuscar) y como fallback
   * por texto "Consultar", sin depender de ids completos.
   */
  private async clickConsultarButton(): Promise<void> {
    const byId = await this.page!.$('button[id*="btnBuscar"]');
    if (byId) {
      await byId.click();
      return;
    }
    const clicked = await this.page!.$$eval("button", (buttons) => {
      const btn = buttons.find((b) =>
        /consultar/i.test((b.textContent ?? "").trim()),
      );
      if (btn) {
        (btn as HTMLButtonElement).click();
        return true;
      }
      return false;
    });
    if (!clicked) {
      throw new Error('No se encontró el botón "Consultar" (btnBuscar)');
    }
  }

  /**
   * Resuelve el reCAPTCHA de la página de consulta:
   * 1. Detecta el widget (enterprise/invisible) y su siteKey + action
   * 2. Lo resuelve vía 2captcha (createTask + polling getTaskResult),
   *    inyecta el token en el textarea del formulario y hace click en
   *    "Consultar" — el SRI ejecuta executeRecaptcha → rcBuscar con el
   *    token del textarea serializado en el POST del formulario.
   * 3. Si 2captcha falla, el usuario lo resuelve manualmente en Chrome.
   */
  private async solvePageCaptcha(): Promise<void> {
    const apiKey = getTwoCaptchaApiKey();
    const pageUrl = this.page?.url() ?? "";
    try {
      logger.info("Detectando reCAPTCHA...");
      const info = await detectRecaptcha(this.page!);
      logger.info(
        `reCAPTCHA: siteKey=${info.siteKey.slice(0, 16)}... enterprise=${info.isEnterprise} invisible=${info.isInvisible} action=${info.action ?? "(desconocido)"}`,
      );
      const token = await solveRecaptchaWith2Captcha(apiKey, info, pageUrl);
      logger.info("Inyectando token y consultando...");
      await injectRecaptchaToken(this.page!, token);
      await this.clickConsultarButton();
    } catch (e) {
      logger.warn(
        `⚠  No se pudo resolver el captcha automáticamente: ${e instanceof Error ? e.message : String(e)}`,
      );
      await this.solveCaptchaManually();
    }
  }

  /**
   * Fallback manual: el usuario resuelve el captcha en la ventana de
   * Chrome. Se hace click en "Consultar" (para que aparezca el desafío
   * si el widget lo pide) y el programa continúa automáticamente cuando
   * el captcha se valida (waitForResponse del flujo normal).
   */
  private async solveCaptchaManually(): Promise<void> {
    logger.info("⚠  Resuelve el captcha en la ventana de Chrome:");
    logger.info("   - Haz clic en Consultar;");
    logger.info("   - Completa el desafío si aparece;");
    logger.info("   - Presiona Enter cuando el resultado aparezca.");
    await this.clickConsultarButton();
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("¿Listo? [Enter] ");
    rl.close();
  }

  /**
   * Espera la respuesta de la CONSULTA real (la que trae la tabla de
   * comprobantes o el mensaje de "No existen datos"), ignorando los
   * posts intermedios del formulario (ej. el formMessages que dispara
   * el click del botón) y la respuesta del documento del reload.
   */
  private async waitForQueryResponse(): Promise<HTTPResponse | undefined> {
    for (;;) {
      const response = await this.page?.waitForResponse(
        (res) => res.url().includes("comprobantesRecibidos.jsf"),
        { timeout: 0 },
      );
      if (!response) return undefined;
      let text = "";
      try {
        text = (await response.buffer())?.toString() ?? "";
      } catch {
        continue;
      }
      // Rechazo del captcha (alerta del SRI): devolverla para que el caller
      // reintente con un token nuevo — antes esto colgaba esperando la tabla
      // (la respuesta de rechazo también referencia tablaCompRecibidos)
      if (CAPTCHA_REJECTED_RE.test(text)) {
        return response;
      }
      if (
        text.includes("tablaCompRecibidos") ||
        text.includes("No existen datos")
      ) {
        return response;
      }
      logger.info("Respuesta intermedia ignorada (no es la consulta)...");
    }
  }

  async GetRetencionesPerMonth(
    month: number,
    year: number,
    attempts: number = 0,
  ): Promise<{
    iva: IRetencion[];
    renta: IRetencion[];
    unknown: IRetencion[];
  }> {
    logger.info(`Month: ${month} Year: ${year}`);
    if (attempts >= 10) {
      throw new Error("Attempts exceeded");
    }
    await this.page?.setUserAgent(new UserAgents().random().toString());
    const RECAPTCHA_TIMEOUT = 0;
    logger.info("Reloading page...");
    await this.page?.reload();
    logger.info("Typing form for recaptcha...");
    await this.page?.select('select[id="frmPrincipal:ano"]', year.toString());
    await this.page?.select('select[id="frmPrincipal:mes"]', month.toString());
    await this.page?.select('select[id="frmPrincipal:dia"]', "0");
    await this.page?.select(
      'select[id="frmPrincipal:cmbTipoComprobante"]',
      "6",
    );
    await this.solvePageCaptcha();
    let result = await this.waitForQueryResponse();
    const statusCode = result?.status();
    if (statusCode !== 200) {
      logger.info({ attempts }, "Server error, retrying");
      return this.GetRetencionesPerMonth(month, year, attempts + 1);
    }
    let responseString = (await result?.buffer())?.toString();
    if (responseString && CAPTCHA_REJECTED_RE.test(responseString)) {
      logger.warn("Captcha rechazado, resolución manual...");
      await this.solveCaptchaManually();
      // Verificar estado real del DOM después de la resolución manual
      const pageState = await this.page?.evaluate(() => {
        const alertEl = document.querySelector(
          ".ui-messages-warn-summary, .ui-growl-message",
        );
        const hasCaptchaAlert =
          /captcha incorrect[oa]|no se pudo validar el captcha/i.test(
            alertEl?.textContent ?? "",
          );
        const hasTable = !!document.querySelector(
          'tbody[id="frmPrincipal:tablaCompRecibidos_data"]',
        );
        const noData =
          document.body.textContent?.includes(
            "No existen datos para los parámetros  ingresados",
          ) ?? false;
        return { hasCaptchaAlert, hasTable, noData };
      });
      if (pageState?.hasCaptchaAlert && !pageState.hasTable) {
        throw new Error(
          "Captcha rechazado incluso después de resolución manual",
        );
      }
      if (pageState?.noData) {
        return { iva: [], renta: [], unknown: [] };
      }
    }
    const emptyResponse = responseString?.includes(
      "No existen datos para los parámetros  ingresados",
    );
    logger.info({ empty: emptyResponse ?? false }, "EmptyResponse?");

    if (emptyResponse) {
      return {
        iva: [],
        renta: [],
        unknown: [],
      };
    }

    await this.page?.waitForSelector("span.ui-paginator-current", {
      timeout: RECAPTCHA_TIMEOUT,
    });

    //Get the number of pages
    logger.info("Getting number of pages...");
    const pages = await this.page?.$eval("span.ui-paginator-current", (e) => {
      const text = (e as HTMLSpanElement).innerText.match(/\d+/g);
      if (!text) {
        throw new Error("No se pudo obtener el número de páginas");
      }
      const [, totalPages] = text;
      return Number.parseInt(totalPages);
    });
    logger.info({ pages }, "Number of pages");
    const retencionesIVA: IRetencion[] = [];
    const retencionesRenta: IRetencion[] = [];
    const retencionesUnknown: IRetencion[] = [];

    //Get table rows
    for (let page = 0; page < pages!; page++) {
      await this.page?.waitForSelector(
        'tbody[id="frmPrincipal:tablaCompRecibidos_data"]',
      );
      const tableRows = await this.page?.$$(
        'tbody[id="frmPrincipal:tablaCompRecibidos_data"] > tr',
      );
      if (!tableRows) throw new Error("No se encontraron retenciones");
      for (const [index, row] of tableRows!.entries()) {
        //Click on the row to get the details (link de la clave de acceso,
        //identificado por patrón de texto: sin ids autogenerados j_idtNN)
        logger.info("Clicking row to get details...");
        const claveAcceso = await this.findClaveLinkInRow(row, true);
        if (!claveAcceso) {
          throw new Error(
            `No se encontró el link de la clave de acceso en la fila ${index} (patrón 49 dígitos)`,
          );
        }
        logger.info("Waiting to get row details...");
        await this.page?.waitForSelector("div.ui-overlay-visible", {
          timeout: 0,
        });
        await this.page?.waitForResponse(
          (res) => {
            logger.debug({ url: res.url() }, "Response");
            return res.url().includes("comprobantesRecibidos.jsf");
          },
          { timeout: 0 },
        );
        await setTimeout(1000); // Wait for the modal to load
        //Click on the row to download File
        logger.info("Downloading File...");

        const downloadPath = path.resolve(
          `${this.RUC}/Comprobantes/retenciones/${year}/${Months[month]}/${claveAcceso}`,
        );
        logger.info({ downloadPath }, "DownloadPath");
        const pathExists = fs.existsSync(downloadPath);
        logger.info({ exists: pathExists }, "Path exist?");
        if (pathExists) {
          logger.info("Deleting existing download path");
          fs.rmSync(downloadPath, { recursive: true, force: true });
        }
        logger.info({ downloadPath }, "Creating download path");
        fs.mkdirSync(downloadPath, { recursive: true });
        // POST JSF inline desde el contexto del navegador
        const lnkPdfId = await row.$eval('a[id*="lnkPdf"]', (e) => e.id || "");
        const pdfBase64 = await this.page!.evaluate(async (btnId) => {
          const viewState = (
            document.querySelector(
              'input[name="javax.faces.ViewState"]',
            ) as HTMLInputElement
          )?.value;
          if (!viewState) throw new Error("No ViewState found");

          const params = new URLSearchParams();
          params.set("frmPrincipal", "frmPrincipal");
          const opciones = document.querySelector(
            "input[name='frmPrincipal:opciones']:checked",
          ) as HTMLInputElement;
          if (opciones) params.set("frmPrincipal:opciones", opciones.value);
          for (const [key, selector] of [
            ["frmPrincipal:ano", "select#frmPrincipal\\:ano"],
            ["frmPrincipal:mes", "select#frmPrincipal\\:mes"],
            ["frmPrincipal:dia", "select#frmPrincipal\\:dia"],
            [
              "frmPrincipal:cmbTipoComprobante",
              "select#frmPrincipal\\:cmbTipoComprobante",
            ],
          ] as [string, string][]) {
            const el = document.querySelector(selector) as
              HTMLSelectElement | HTMLInputElement;
            if (el?.value) params.set(key, el.value);
          }
          const captcha = document.querySelector(
            "textarea[name='g-recaptcha-response']",
          ) as HTMLTextAreaElement;
          params.set("g-recaptcha-response", captcha?.value || "");
          params.set("javax.faces.ViewState", viewState);
          params.set(btnId, btnId);

          const resp = await fetch(window.location.href.split("#")[0], {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: window.location.href,
            },
            body: params.toString(),
          });
          if (!resp.ok) throw new Error(`POST JSF failed: ${resp.status}`);
          const buf = await resp.arrayBuffer();
          return btoa(String.fromCharCode(...new Uint8Array(buf)));
        }, lnkPdfId);
        const pdfBuffer = Buffer.from(pdfBase64, "base64");
        const pdfFile = path.join(downloadPath, `comprobante.pdf`);
        fs.writeFileSync(pdfFile, new Uint8Array(pdfBuffer));
        logger.info({ pdfFile, size: pdfBuffer.length }, "PDF escrito directo");

        const lnkXmlId = await row.$eval('a[id*="lnkXml"]', (e) => e.id || "");
        if (lnkXmlId) {
          try {
            const xmlBase64 = await this.page!.evaluate(async (btnId) => {
              const viewState = (
                document.querySelector(
                  'input[name="javax.faces.ViewState"]',
                ) as HTMLInputElement
              )?.value;
              if (!viewState) throw new Error("No ViewState found");

              const params = new URLSearchParams();
              params.set("frmPrincipal", "frmPrincipal");
              const opciones = document.querySelector(
                "input[name='frmPrincipal:opciones']:checked",
              ) as HTMLInputElement;
              if (opciones) params.set("frmPrincipal:opciones", opciones.value);
              for (const [key, selector] of [
                ["frmPrincipal:ano", "select#frmPrincipal\\:ano"],
                ["frmPrincipal:mes", "select#frmPrincipal\\:mes"],
                ["frmPrincipal:dia", "select#frmPrincipal\\:dia"],
                [
                  "frmPrincipal:cmbTipoComprobante",
                  "select#frmPrincipal\\:cmbTipoComprobante",
                ],
              ] as [string, string][]) {
                const el = document.querySelector(selector) as
                  HTMLSelectElement | HTMLInputElement;
                if (el?.value) params.set(key, el.value);
              }
              const captcha = document.querySelector(
                "textarea[name='g-recaptcha-response']",
              ) as HTMLTextAreaElement;
              params.set("g-recaptcha-response", captcha?.value || "");
              params.set("javax.faces.ViewState", viewState);
              params.set(btnId, btnId);

              const resp = await fetch(window.location.href.split("#")[0], {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Referer: window.location.href,
                },
                body: params.toString(),
              });
              if (!resp.ok) throw new Error(`POST JSF failed: ${resp.status}`);
              const buf = await resp.arrayBuffer();
              return btoa(String.fromCharCode(...new Uint8Array(buf)));
            }, lnkXmlId);
            const xmlBuffer = Buffer.from(xmlBase64, "base64");
            const xmlFile = path.join(downloadPath, `comprobante.xml`);
            fs.writeFileSync(xmlFile, new Uint8Array(xmlBuffer));
            logger.info(
              { xmlFile, size: xmlBuffer.length },
              "XML escrito directo",
            );
          } catch (err) {
            logger.warn({ err }, "No se pudo descargar XML, continuando");
          }
        }

        // logger.info("Waiting download file...");
        // await this.page?.waitForResponse(
        //     "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf",
        //     { timeout: 0 }
        // );
        logger.info("Get modal...");
        const { iva, renta, unknown } =
          await this.parseRetencionDialog(claveAcceso);
        retencionesIVA.push(...iva);
        retencionesRenta.push(...renta);
        retencionesUnknown.push(...unknown);
        // Cerrar modal y esperar a que desaparezca
        await this.page?.keyboard.press("Escape");
        await this.page
          ?.waitForSelector("div.ui-overlay-visible", {
            hidden: true,
            timeout: 5000,
          })
          .catch(() => {});
        await setTimeout(300);
      }
      logger.info("Clicking next page...");
      await this.page?.$eval(
        "span.ui-paginator-next.ui-state-default.ui-corner-all",
        (e) => (e as HTMLSpanElement).click(),
      );
      await setTimeout(2000);
    }

    return {
      iva: retencionesIVA,
      renta: retencionesRenta,
      unknown: retencionesUnknown,
    };
  }
  async GetFacturasPerMonth(
    month: number,
    year: number,
    attempts: number = 0,
  ): Promise<IFactura[]> {
    logger.info(`Month: ${month} Year: ${year} (Facturas)`);
    if (attempts >= 10) {
      throw new Error("Attempts exceeded");
    }
    await this.page?.setUserAgent(new UserAgents().random().toString());
    const RECAPTCHA_TIMEOUT = 0;
    logger.info("Reloading page...");
    await this.page?.reload();
    logger.info("Typing form for recaptcha...");
    await this.page?.select('select[id="frmPrincipal:ano"]', year.toString());
    await this.page?.select('select[id="frmPrincipal:mes"]', month.toString());
    await this.page?.select('select[id="frmPrincipal:dia"]', "0");
    await this.page?.select(
      'select[id="frmPrincipal:cmbTipoComprobante"]',
      "1", // Factura (6 = Comprobante de Retención)
    );
    await this.solvePageCaptcha();
    let result = await this.waitForQueryResponse();
    const statusCode = result?.status();
    if (statusCode !== 200) {
      logger.info({ attempts }, "Server error, retrying");
      return this.GetFacturasPerMonth(month, year, attempts + 1);
    }
    let responseString = (await result?.buffer())?.toString();
    if (responseString && CAPTCHA_REJECTED_RE.test(responseString)) {
      logger.warn("Captcha rechazado, resolución manual...");
      await this.solveCaptchaManually();
      // Verificar estado real del DOM después de la resolución manual
      const pageState = await this.page?.evaluate(() => {
        const alertEl = document.querySelector(
          ".ui-messages-warn-summary, .ui-growl-message",
        );
        const hasCaptchaAlert =
          /captcha incorrect[oa]|no se pudo validar el captcha/i.test(
            alertEl?.textContent ?? "",
          );
        const hasTable = !!document.querySelector(
          'tbody[id="frmPrincipal:tablaCompRecibidos_data"]',
        );
        const noData =
          document.body.textContent?.includes(
            "No existen datos para los parámetros  ingresados",
          ) ?? false;
        return { hasCaptchaAlert, hasTable, noData };
      });
      if (pageState?.hasCaptchaAlert && !pageState.hasTable) {
        throw new Error(
          "Captcha rechazado incluso después de resolución manual",
        );
      }
      if (pageState?.noData) {
        return [];
      }
    }
    const emptyResponse = responseString?.includes(
      "No existen datos para los parámetros  ingresados",
    );
    logger.info({ empty: emptyResponse ?? false }, "EmptyResponse?");

    if (emptyResponse) {
      return [];
    }

    await this.page?.waitForSelector("span.ui-paginator-current", {
      timeout: RECAPTCHA_TIMEOUT,
    });

    //Get the number of pages
    logger.info("Getting number of pages...");
    const pages = await this.page?.$eval("span.ui-paginator-current", (e) => {
      const text = (e as HTMLSpanElement).innerText.match(/\d+/g);
      if (!text) {
        throw new Error("No se pudo obtener el número de páginas");
      }
      const [, totalPages] = text;
      return Number.parseInt(totalPages);
    });
    logger.info({ pages }, "Number of pages");
    const facturas: IFactura[] = [];

    //Get table rows
    for (let page = 0; page < pages!; page++) {
      await this.page?.waitForSelector(
        'tbody[id="frmPrincipal:tablaCompRecibidos_data"]',
      );
      const tableRows = await this.page?.$$(
        'tbody[id="frmPrincipal:tablaCompRecibidos_data"] > tr',
      );
      if (!tableRows) throw new Error("No se encontraron facturas");
      for (const [index, row] of tableRows!.entries()) {
        //Click on the row to get the details (link de la clave de acceso,
        //identificado por patrón de texto: sin ids autogenerados j_idtNN)
        logger.info("Clicking row to get details...");
        const claveAccesoFromRow = await this.findClaveLinkInRow(row, true);
        if (!claveAccesoFromRow) {
          throw new Error(
            `No se encontró el link de la clave de acceso en la fila ${index} (patrón 49 dígitos)`,
          );
        }
        logger.info("Waiting to get row details...");
        await this.page?.waitForSelector("div.ui-overlay-visible", {
          timeout: 0,
        });
        await this.page?.waitForResponse(
          (res) => res.url().includes("comprobantesRecibidos.jsf"),
          { timeout: 0 },
        );
        await setTimeout(1000); // Wait for the modal to load
        //Click on the row to download File
        logger.info("Downloading File...");
        //Primero el modal: es la fuente más confiable de la clave
        const factura = await this.parseFacturaDialog(claveAccesoFromRow);
        if (!factura.claveAcceso) {
          throw new Error(
            `No se pudo obtener la clave de acceso de la factura (fila ${index}): ni en la fila ni en el modal`,
          );
        }

        const downloadPath = path.resolve(
          `${this.RUC}/Comprobantes/Facturas/${year}/${Months[month]}/${factura.claveAcceso}`,
        );
        logger.info({ downloadPath }, "DownloadPath");
        const pathExists = fs.existsSync(downloadPath);
        logger.info({ exists: pathExists }, "Path exist?");
        if (pathExists) {
          logger.info("Deleting existing download path");
          fs.rmSync(downloadPath, { recursive: true, force: true });
        }
        logger.info({ downloadPath }, "Creating download path");
        fs.mkdirSync(downloadPath, { recursive: true });
        // POST JSF inline desde el contexto del navegador
        const lnkPdfId = await row.$eval('a[id*="lnkPdf"]', (e) => e.id || "");
        const pdfBase64 = await this.page!.evaluate(async (btnId) => {
          const viewState = (
            document.querySelector(
              'input[name="javax.faces.ViewState"]',
            ) as HTMLInputElement
          )?.value;
          if (!viewState) throw new Error("No ViewState found");

          const params = new URLSearchParams();
          params.set("frmPrincipal", "frmPrincipal");
          const opciones = document.querySelector(
            "input[name='frmPrincipal:opciones']:checked",
          ) as HTMLInputElement;
          if (opciones) params.set("frmPrincipal:opciones", opciones.value);
          for (const [key, selector] of [
            ["frmPrincipal:ano", "select#frmPrincipal\\:ano"],
            ["frmPrincipal:mes", "select#frmPrincipal\\:mes"],
            ["frmPrincipal:dia", "select#frmPrincipal\\:dia"],
            [
              "frmPrincipal:cmbTipoComprobante",
              "select#frmPrincipal\\:cmbTipoComprobante",
            ],
          ] as [string, string][]) {
            const el = document.querySelector(selector) as
              HTMLSelectElement | HTMLInputElement;
            if (el?.value) params.set(key, el.value);
          }
          const captcha = document.querySelector(
            "textarea[name='g-recaptcha-response']",
          ) as HTMLTextAreaElement;
          params.set("g-recaptcha-response", captcha?.value || "");
          params.set("javax.faces.ViewState", viewState);
          params.set(btnId, btnId);

          const resp = await fetch(window.location.href.split("#")[0], {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: window.location.href,
            },
            body: params.toString(),
          });
          if (!resp.ok) throw new Error(`POST JSF failed: ${resp.status}`);
          const buf = await resp.arrayBuffer();
          return btoa(String.fromCharCode(...new Uint8Array(buf)));
        }, lnkPdfId);
        const pdfBuffer = Buffer.from(pdfBase64, "base64");
        const pdfFile = path.join(downloadPath, `comprobante.pdf`);
        fs.writeFileSync(pdfFile, new Uint8Array(pdfBuffer));
        logger.info({ pdfFile, size: pdfBuffer.length }, "PDF escrito directo");

        const lnkXmlId = await row.$eval('a[id*="lnkXml"]', (e) => e.id || "");
        if (lnkXmlId) {
          try {
            const xmlBase64 = await this.page!.evaluate(async (btnId) => {
              const viewState = (
                document.querySelector(
                  'input[name="javax.faces.ViewState"]',
                ) as HTMLInputElement
              )?.value;
              if (!viewState) throw new Error("No ViewState found");

              const params = new URLSearchParams();
              params.set("frmPrincipal", "frmPrincipal");
              const opciones = document.querySelector(
                "input[name='frmPrincipal:opciones']:checked",
              ) as HTMLInputElement;
              if (opciones) params.set("frmPrincipal:opciones", opciones.value);
              for (const [key, selector] of [
                ["frmPrincipal:ano", "select#frmPrincipal\\:ano"],
                ["frmPrincipal:mes", "select#frmPrincipal\\:mes"],
                ["frmPrincipal:dia", "select#frmPrincipal\\:dia"],
                [
                  "frmPrincipal:cmbTipoComprobante",
                  "select#frmPrincipal\\:cmbTipoComprobante",
                ],
              ] as [string, string][]) {
                const el = document.querySelector(selector) as
                  HTMLSelectElement | HTMLInputElement;
                if (el?.value) params.set(key, el.value);
              }
              const captcha = document.querySelector(
                "textarea[name='g-recaptcha-response']",
              ) as HTMLTextAreaElement;
              params.set("g-recaptcha-response", captcha?.value || "");
              params.set("javax.faces.ViewState", viewState);
              params.set(btnId, btnId);

              const resp = await fetch(window.location.href.split("#")[0], {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Referer: window.location.href,
                },
                body: params.toString(),
              });
              if (!resp.ok) throw new Error(`POST JSF failed: ${resp.status}`);
              const buf = await resp.arrayBuffer();
              return btoa(String.fromCharCode(...new Uint8Array(buf)));
            }, lnkXmlId);
            const xmlBuffer = Buffer.from(xmlBase64, "base64");
            const xmlFile = path.join(downloadPath, `comprobante.xml`);
            fs.writeFileSync(xmlFile, new Uint8Array(xmlBuffer));
            logger.info(
              { xmlFile, size: xmlBuffer.length },
              "XML escrito directo",
            );
          } catch (err) {
            logger.warn({ err }, "No se pudo descargar XML, continuando");
          }
        }
        facturas.push(factura);
        // Cerrar modal para poder interactuar con la tabla
        await this.page?.keyboard.press("Escape");
        await setTimeout(500);
      }
      logger.info("Clicking next page...");
      await this.page?.$eval(
        "span.ui-paginator-next.ui-state-default.ui-corner-all",
        (e) => (e as HTMLSpanElement).click(),
      );
    }

    return facturas;
  }

  /**
   * Busca en una fila de la tabla el link de la clave de acceso por
   * patrón de texto (49 dígitos), sin depender de ids autogenerados por
   * JSF (j_idtNN), que cambian según el tipo de comprobante. Si click=true,
   * hace click en el link (abre el modal de detalle). Devuelve el texto
   * del link (la clave) o "" si no se encuentra.
   */
  private async findClaveLinkInRow(
    row: ElementHandle<Element>,
    click: boolean = false,
  ): Promise<string> {
    const clave = await row.$$eval(
      "a",
      (anchors, doClick) => {
        const anchor = anchors.find((a) =>
          /^\d{49}$/.test((a.textContent ?? "").trim()),
        );
        if (!anchor) return "";
        if (doClick) (anchor as HTMLAnchorElement).click();
        return (anchor.textContent ?? "").trim();
      },
      click,
    );
    return clave ?? "";
  }

  /**
   * Lee el modal de detalle de la retención:
   * 1. Pares etiqueta/valor del formulario (td.formulario-label + td.middle)
   * 2. Tabla de impuestos retenidos (encabezado con IMPUESTO,
   *    BASEIMPONIBLE y VALORRETENIDO): cada fila mapeada por encabezado
   *    normalizado (sin posiciones fijas)
   * El objetivo principal es el panel de retenciones; fallback: cualquier
   * dialog overlay visible.
   */
  private async parseRetencionDialog(claveAccesoFromRow: string): Promise<{
    iva: IRetencion[];
    renta: IRetencion[];
    unknown: IRetencion[];
  }> {
    const entries = await this.page?.$$eval(
      "div#form-detalle-comprobante-retencion\\3A panel-detalle-comprobante-retencion, div.ui-overlay-visible",
      (roots) => {
        const norm = (s: string | null) =>
          (s ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
        const pairs: Array<[string, string]> = [];
        let impuestoRows: Array<Record<string, string>> = [];
        for (const root of roots) {
          for (const tr of Array.from(root.querySelectorAll("tr"))) {
            const labelTd = tr.querySelector("td.formulario-label");
            const middleTd = tr.querySelector("td.middle");
            if (labelTd && middleTd) {
              pairs.push([
                labelTd.textContent ?? "",
                middleTd.textContent ?? "",
              ]);
            }
          }
          if (impuestoRows.length === 0) {
            for (const table of Array.from(
              root.querySelectorAll("table"),
            ) as HTMLTableElement[]) {
              const rows = Array.from(table.rows);
              if (rows.length < 2) continue;
              const headers = Array.from(rows[0].cells).map((c) =>
                norm(c.textContent),
              );
              // Tabla de impuestos retenidos (por ítem y resumen usan
              // otros encabezados)
              if (
                !headers.includes("IMPUESTO") ||
                !headers.includes("BASEIMPONIBLE") ||
                !headers.includes("VALORRETENIDO")
              ) {
                continue;
              }
              const dataRows: Array<Record<string, string>> = [];
              for (const row of rows.slice(1)) {
                const cells = Array.from(row.cells);
                if (cells.length < headers.length) continue;
                const record: Record<string, string> = {};
                headers.forEach((header, i) => {
                  if (header) {
                    record[header] = (cells[i]?.textContent ?? "").trim();
                  }
                });
                if (record["IMPUESTO"]) dataRows.push(record);
              }
              if (dataRows.length > 0) {
                impuestoRows = dataRows;
                break;
              }
            }
          }
          if (pairs.length > 0 && impuestoRows.length > 0) break;
        }
        return { pairs, impuestoRows };
      },
    );
    const { pairs, impuestoRows } = entries ?? {
      pairs: [],
      impuestoRows: [],
    };
    const result = mapRetencionFromDialog(
      pairs as Array<[string, string]>,
      impuestoRows,
      claveAccesoFromRow,
    );
    logger.info(
      {
        iva: result.iva.length,
        renta: result.renta.length,
        unknown: result.unknown.length,
      },
      "Retencion detalle",
    );
    if (!result.iva.length && !result.renta.length) {
      // Facilita ajustar selectores/etiquetas si el SRI cambia el modal
      logger.info({ labels: pairs }, "Retencion dialog raw labels");
    }
    return result;
  }

  private async parseFacturaDialog(
    claveAccesoFromRow: string,
  ): Promise<IFactura> {
    logger.info("Get modal...");
    logger.info("Get the details of the document...");
    // Lee el modal de detalle de la factura:
    // 1. Pares etiqueta/valor del formulario (td.formulario-label + td.middle)
    // 2. La tabla resumen de impuestos (encabezado con IMPUESTO y VALOR
    //    pero sin PORCENTAJE): suma la columna Valor de las filas IVA
    // El objetivo principal es el panel de facturas; fallback: cualquier
    // dialog overlay visible.
    const entries = await this.page?.$$eval(
      "div#form-detalle-factura\\3A panel-detalle-factura, div.ui-overlay-visible",
      (roots) => {
        const norm = (s: string | null) =>
          (s ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
        const num = (s: string | null) => {
          const n = Number((s ?? "").trim());
          return Number.isFinite(n) ? n : 0;
        };
        const pairs: Array<[string, string]> = [];
        let ivaTotal: number | null = null;
        for (const root of roots) {
          for (const tr of Array.from(root.querySelectorAll("tr"))) {
            const labelTd = tr.querySelector("td.formulario-label");
            const middleTd = tr.querySelector("td.middle");
            if (labelTd && middleTd) {
              pairs.push([
                labelTd.textContent ?? "",
                middleTd.textContent ?? "",
              ]);
            }
          }
          if (ivaTotal === null) {
            for (const table of Array.from(
              root.querySelectorAll("table"),
            ) as HTMLTableElement[]) {
              const rows = Array.from(table.rows);
              if (rows.length < 2) continue;
              const header = Array.from(rows[0].cells).map((c) =>
                norm(c.textContent),
              );
              // Tabla resumen de impuestos: tiene IMPUESTO y VALOR pero
              // no PORCENTAJE (las tablas por ítem sí tienen PORCENTAJE).
              if (
                !header.includes("IMPUESTO") ||
                !header.includes("VALOR") ||
                header.includes("PORCENTAJE")
              ) {
                continue;
              }
              // Filas: [nro, impuesto, código porcentaje, base, valor]
              let sum: number | null = null;
              for (const row of rows.slice(1)) {
                const cells = Array.from(row.cells);
                if (cells.length < 3) continue;
                if (norm(cells[1].textContent) === "IVA") {
                  sum = (sum ?? 0) + num(cells[cells.length - 1].textContent);
                }
              }
              if (sum !== null) {
                ivaTotal = sum;
                break;
              }
            }
          }
          if (pairs.length > 0 && ivaTotal !== null) break;
        }
        return { pairs, ivaTotal };
      },
    );
    const { pairs, ivaTotal } = entries ?? { pairs: [], ivaTotal: null };
    const factura = mapFacturaFromLabels(
      pairs as Array<[string, string]>,
      claveAccesoFromRow,
      ivaTotal,
    );
    if (!factura.ruc || !factura.fechaEmision) {
      // Facilita ajustar selectores/etiquetas si el SRI cambia el modal
      logger.info({ labels: pairs }, "Factura dialog raw labels");
    }
    logger.info({ factura }, "Factura detalle");
    return factura;
  }

  async *GetFacturasPerYear(
    year: number,
    monthStart: number = 1,
    monthEnd: number = 12,
  ) {
    const facturas: IFactura[] = [];
    for (let month = monthStart; month <= monthEnd; month++) {
      const monthFacturas = await this.GetFacturasPerMonth(month, year);
      facturas.push(...monthFacturas);
      yield {
        facturas: monthFacturas,
        month,
      };
    }
    return facturas;
  }

  async *GetRetencionesPerYear(
    year: number,
    monthStart: number = 1,
    monthEnd: number = 12,
  ) {
    const retencionesIVA: IRetencion[] = [];
    const retencionesRenta: IRetencion[] = [];
    const retencionesUnknown: IRetencion[] = [];
    for (let month = monthStart; month <= monthEnd; month++) {
      const { iva, renta, unknown } = await this.GetRetencionesPerMonth(
        month,
        year,
      );
      retencionesIVA.push(...iva);
      retencionesRenta.push(...renta);
      retencionesUnknown.push(...unknown);
      yield {
        iva,
        renta,
        unknown,
        month,
      };
    }
    return {
      iva: retencionesIVA,
      renta: retencionesRenta,
      unknown: retencionesUnknown,
    };
  }

  async EndScrapper() {
    // await this.browser?.close();
  }
}

export default new SRIScrapper();
