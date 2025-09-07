import fs from "fs";
import path from "path";
import UserAgents from "user-agents";
import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import RecaptchaPlugin from "puppeteer-extra-plugin-recaptcha";
import type { IRetencion } from "./IRetencion";
import { Months } from "../utils/months";
import { setTimeout } from "timers/promises";

puppeteer.use(StealthPlugin());
puppeteer.use(
    RecaptchaPlugin({
        provider: {
            id: "2captcha",
            token: "fecfd997a480ee0e1c2ff9cb6a3fc88c", // REPLACE THIS WITH YOUR OWN 2CAPTCHA API KEY ⚡
        },
        visualFeedback: true,
    })
);

class SRIScrapper {
    private page?: Page;
    private browser?: Browser;
    private RUC!: string;

    async InitScrapper() {
        this.browser = await await puppeteer.launch({
            executablePath: "/usr/bin/google-chrome",
            defaultViewport: {
                width: 1366,
                height: 768,
            },
            headless: false,
            args: [
                "--start-maximized",
                "--no-sandbox",
                '--user-data-dir="/tmp/chromium"',
                "--disable-web-security",
                "--disable-features=site-per-process",
            ],
            timeout: 120000,
            slowMo: 10,
        });
        const userAgents = new UserAgents();
        this.page = (await this.browser.pages())[0];
        await this.page.setViewport({ width: 1920, height: 1080 });
        await this.page.setUserAgent(userAgents.random().toString());
        this.page?.on("console", (msg) => {
            for (let i = 0; i < msg.args().length; ++i)
                console.log(`${i}: ${msg.args()[i]}`);
        });
    }

    private async NavigateToLogin() {
        console.log("Going to Login");
        await this.page?.goto(
            "https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=57&idGrupo=55",
            { timeout: 0 }
        );
        // await this.page?.waitForSelector(
        //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
        // );
        // console.log("Clicking Comprobantes electrónicos recibidos");
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
        // console.log("Clicking Comprobantes electrónicos recibidos");
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
        console.log("Going to Comprobantes");
        // await this.page?.goto(
        //     "https://srienlinea.sri.gob.ec/sri-en-linea/consulta/55",
        //     { timeout: 0 }
        // );
        // await this.page?.waitForSelector(
        //     'a.ui-button.boton-link:has(div[title="Comprobantes electrónicos recibidos"])'
        // );
        // console.log("Clicking Comprobantes electrónicos recibidos");
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
        console.log("Typing credentials...");
        await (await this.page?.$("#usuario"))!.type(RUC);
        await (await this.page?.$("#password"))!.type(password);
        await (await this.page?.$('input[value="Ingresar"]'))!.click();
        await this.NavigateToComprobantes();
        return { RUC, nombre: "" };
    }

    async GetRetencionesPerMonth(
        month: number,
        year: number,
        attempts: number = 0
    ): Promise<{
        iva: IRetencion[];
        renta: IRetencion[];
        unknown: IRetencion[];
    }> {
        console.log(`Month: ${month} Year: ${year}`);
        if (attempts >= 10) {
            throw new Error("Attempts exceeded");
        }
        await this.page?.setUserAgent(new UserAgents().random().toString());
        const RECAPTCHA_TIMEOUT = 0;
        console.log("Reloading page...");
        await this.page?.reload();
        console.log("Typing form for recaptcha...");
        await this.page?.select(
            'select[id="frmPrincipal:ano"]',
            year.toString()
        );
        await this.page?.select(
            'select[id="frmPrincipal:mes"]',
            month.toString()
        );
        await this.page?.select('select[id="frmPrincipal:dia"]', "0");
        await this.page?.select(
            'select[id="frmPrincipal:cmbTipoComprobante"]',
            "6"
        );
        const btnConsultar = await this.page!.$('button[id="btnRecaptcha"]');
        await btnConsultar?.click();
        await setTimeout(1000); // Wait for recaptcha to load
        console.log("Solving recaptachas...");
        await this.page
            ?.waitForSelector('iframe[src*="recaptcha/"]')
            .then(() => this.page?.solveRecaptchas())
            .then((result) => console.log(result?.solved))
            .catch((e) => console.log("NO CAPTCHAS FOUND"));
        const result = await this.page?.waitForResponse(
            "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf"
        );
        const statusCode = result?.status();
        if (statusCode !== 200) {
            console.log("Server error, retrying, currentAttempt", attempts);
            return this.GetRetencionesPerMonth(month, year, attempts++);
        }
        const responseString = (await result?.buffer())?.toString();
        const emptyResponse = responseString?.includes(
            "No existen datos para los parámetros  ingresados"
        );
        console.log("EmptyResponse?", emptyResponse);

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
        console.log("Getting number of pages...");
        const pages = await this.page?.$eval(
            "span.ui-paginator-current",
            (e) => {
                const text = (e as HTMLSpanElement).innerText.match(/\d+/g);
                if (!text) {
                    throw new Error("No se pudo obtener el número de páginas");
                }
                const [, totalPages] = text;
                return Number.parseInt(totalPages);
            }
        );
        console.log("Number of pages: ", pages);
        const retencionesIVA: IRetencion[] = [];
        const retencionesRenta: IRetencion[] = [];
        const retencionesUnknown: IRetencion[] = [];

        //Get table rows
        for (let page = 0; page < pages!; page++) {
            await this.page?.waitForSelector(
                'tbody[id="frmPrincipal:tablaCompRecibidos_data"]'
            );
            const tableRows = await this.page?.$$(
                'tbody[id="frmPrincipal:tablaCompRecibidos_data"] > tr'
            );
            if (!tableRows) throw new Error("No se encontraron retenciones");
            for (const [index, row] of tableRows!.entries()) {
                //Click on the row to get the details
                console.log("Clicking row to get details...");
                await row.$eval("div > a", (e) =>
                    (e as HTMLAnchorElement).click()
                );
                console.log("Waiting to get row details...");
                await this.page?.waitForSelector("div.ui-overlay-visible", {
                    timeout: 0,
                });
                await this.page?.waitForResponse(
                    (res) => {
                        console.log("Response", res);
                        console.log("URL", res.url());
                        return res.url().includes("comprobantesRecibidos.jsf");
                    },
                    { timeout: 0 }
                );
                await setTimeout(1000); // Wait for the modal to load
                //Click on the row to download File
                console.log("Downloading File...");
                const claveAcceso = await row.$eval(
                    `a[id="frmPrincipal:tablaCompRecibidos:${index}:j_idt65"]`,
                    (e) => (e as HTMLAnchorElement).innerText
                );

                const downloadPath = path.resolve(
                    `${this.RUC}/Comprobantes/${year}/${Months[month]}/${claveAcceso}`
                );
                console.log("DownloadPath", downloadPath);
                const pathExists = fs.existsSync(downloadPath);
                console.log("Path exist?", pathExists);
                if (pathExists) {
                    console.log("Deleting existing download path");
                    fs.rmSync(downloadPath, { recursive: true, force: true });
                }
                console.log("Creating download path", downloadPath);
                fs.mkdirSync(downloadPath, { recursive: true });
                const client = await this.browser?.target().createCDPSession();
                await client?.send("Browser.setDownloadBehavior", {
                    behavior: "allow",
                    downloadPath,
                    eventsEnabled: true,
                });
                // const downloadedFileName = await this.waitForDownloadComplete(
                //     downloadPath
                // );
                // const originalPath = path.join(
                //     downloadPath,
                //     downloadedFileName
                // );
                // const newFilename = `retencion-${claveAcceso}.pdf`;
                // const newPath = path.join(downloadPath, newFilename);

                // fs.renameSync(originalPath, newPath);
                // console.log("Archivo renombrado a:", newFilename);
                await row.$eval(
                    `a[id="frmPrincipal:tablaCompRecibidos:${index}:lnkPdf"]`,
                    (e) => (e as HTMLAnchorElement).click()
                );
                // console.log("Waiting download file...");
                // await this.page?.waitForResponse(
                //     "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf",
                //     { timeout: 0 }
                // );
                console.log("Get modal...");
                console.log("Get the details of the document...");
                const detalleRetencion = await this.page?.$(
                    "div#form-detalle-comprobante-retencion\\3A panel-detalle-comprobante-retencion"
                );
                const [details, values] = (await detalleRetencion?.$$eval(
                    "table",
                    (e) => [
                        (e[0] as HTMLTableElement).innerText,
                        (e[1] as HTMLTableElement).innerText,
                    ]
                )) as [string, string];

                const detailsArray = details
                    ?.split(/\r?\n/)
                    .map((e) => e.split("\t")[1]);
                const valuesArray = values
                    ?.split(/\r?\n/)
                    .slice(2, -1)
                    .map((e) => e.split("\t"));
                //Print details
                valuesArray.forEach((row) => {
                    let retentionRef = retencionesUnknown;
                    const impuestoType = row[1];
                    if (impuestoType === "IVA") {
                        retentionRef = retencionesIVA;
                    }
                    if (impuestoType === "RENTA") {
                        retentionRef = retencionesRenta;
                    }
                    const finalRetencion = valuesArray
                        .filter((value) => value[1] === impuestoType)
                        .map((row) => ({
                            razonSocial: detailsArray![2],
                            ruc: detailsArray![4],
                            claveAcceso: detailsArray![5],
                            establecimiento: detailsArray![6],
                            puntoEmision: detailsArray![7],
                            secuencial: detailsArray![8],
                            fechaEmision: detailsArray![10],
                            idSujetoRetenido: detailsArray![18],
                            razonSocialSujetoRetenido: detailsArray![19],
                            ejercicioFiscal: detailsArray![20],
                            valoresRetenidos: {
                                nro: row[0],
                                impuesto: row[1],
                                baseImponible: +row[2],
                                porcentajeRetenido: +row[3],
                                valorRetenido: +row[4],
                                docSustento: row[5],
                                fechaDocSustento: row[6],
                            },
                        }));
                    retentionRef.push(...finalRetencion);
                });
            }
            console.log("Clicking next page...");
            await this.page?.$eval(
                "span.ui-paginator-next.ui-state-default.ui-corner-all",
                (e) => (e as HTMLSpanElement).click()
            );
        }

        return {
            iva: retencionesIVA,
            renta: retencionesRenta,
            unknown: retencionesUnknown,
        };
    }
    waitForDownloadComplete(downloadPath: string): Promise<string> {
        return new Promise((resolve) => {
            const watcher = fs.watch(
                downloadPath,
                async (eventType, filename) => {
                    if (
                        eventType === "rename" &&
                        filename &&
                        !filename.endsWith(".crdownload")
                    ) {
                        watcher.close();
                        resolve(filename);
                    }
                }
            );
        });
    }
    async *GetRetencionesPerYear(year: number, monthStart: number = 1) {
        const retencionesIVA: IRetencion[] = [];
        const retencionesRenta: IRetencion[] = [];
        const retencionesUnknown: IRetencion[] = [];
        for (let month = monthStart; month <= 12; month++) {
            const { iva, renta, unknown } = await this.GetRetencionesPerMonth(
                month,
                year
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
