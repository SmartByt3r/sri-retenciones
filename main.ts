import path from "path";
import fs from "fs";
import { WriteRetencionesIVA } from "./src/Excel/serializeIVA.js";
import { WriteRetencionesRenta } from "./src/Excel/serializeRenta.js";
import { WriteRetencionesUnknown } from "./src/Excel/serializeUnknown.js";
import { WriteFacturas } from "./src/Excel/serializeFactura.js";
import SRIScrapper from "./src/SRI/SRIScrapper.ts";
import { Months } from "./src/utils/months.ts";
import type { IRetencion } from "./src/SRI/IRetencion.ts";
import type { IFactura } from "./src/SRI/IFactura.ts";
import { JoinRawJsons } from "./src/utils/json.ts";
import { runMenu } from "./src/cli/menu.ts";
import { logger, printLogLocation } from "./src/utils/logger.ts";

/**
 * Estructura unificada de directorios:
 *
 * {downloadPath}/
 * └── {ruc}/
 *     ├── retenciones/        ← comprobantes de retención
 *     │   └── {year}/
 *     │       └── {mes}/
 *     │           ├── IVA.xlsx
 *     │           ├── RENTA.xlsx
 *     │           ├── UNKNOWN.xlsx
 *     │           ├── raw_result.json
 *     │           └── {claveAcceso}/
 *     │               ├── comprobante.pdf
 *     │               └── comprobante.xml
 *     ├── Facturas/           ← comprobantes de factura
 *     │   └── {year}/
 *     │       └── {mes}/
 *     │           ├── FACTURAS.xlsx
 *     │           ├── facturas_result.json
 *     │           └── {claveAcceso}/
 *     │               ├── comprobante.pdf
 *     │               └── comprobante.xml
 *     ├── raw_result.json     ← consolidado retenciones (todo el periodo)
 *     ├── IVA.xlsx
 *     ├── RENTA.xlsx
 *     ├── UNKNOWN.xlsx
 *     ├── facturas.json       ← consolidado facturas (todo el periodo)
 *     └── FACTURAS.xlsx
 */

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function findMonthDirs(
  baseDir: string,
  year: number,
  monthStart: number,
  monthEnd: number,
  resultFile: string,
) {
  const yearDir = path.resolve(baseDir, String(year));
  if (!fs.existsSync(yearDir)) return [];
  return fs
    .readdirSync(yearDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(yearDir, entry.name))
    .filter((fullPath) => {
      const monthFile = fs.existsSync(path.join(fullPath, resultFile))
        ? resultFile
        : null;
      if (monthFile === null) return false;
      const parsed = JSON.parse(
        fs.readFileSync(path.join(fullPath, monthFile), "utf-8"),
      ) as { month: number };
      return parsed.month >= monthStart && parsed.month <= monthEnd;
    });
}

async function downloadRetenciones(
  downloadPath: string,
  ruc: string,
  year: number,
  monthStart: number,
  monthEnd: number,
) {
  const retencionesBase = path.resolve(downloadPath, ruc, "retenciones");

  for await (const retenciones of SRIScrapper.GetRetencionesPerYear(
    year,
    monthStart,
    monthEnd,
  )) {
    logger.info(
      {
        month: retenciones.month,
        iva: retenciones.iva.length,
        renta: retenciones.renta.length,
        unknown: retenciones.unknown.length,
      },
      "Saving JSON result",
    );
    const monthDir = path.resolve(
      retencionesBase,
      String(year),
      Months[retenciones.month],
    );
    const rawResultPath = path.join(monthDir, "raw_result.json");
    ensureParentDir(rawResultPath);
    fs.writeFileSync(rawResultPath, JSON.stringify(retenciones, null, 2));
    WriteRetencionesIVA(retenciones.iva, path.join(monthDir, "IVA.xlsx"));
    WriteRetencionesRenta(retenciones.renta, path.join(monthDir, "RENTA.xlsx"));
    WriteRetencionesUnknown(
      retenciones.unknown,
      path.join(monthDir, "UNKNOWN.xlsx"),
    );
  }

  // Join all the raw_result.json files of the selected months into one
  const rawResults = [] as Array<{
    iva: IRetencion[];
    renta: IRetencion[];
    unknown: IRetencion[];
    month: number;
  }>;
  for (const fullPath of findMonthDirs(
    retencionesBase,
    year,
    monthStart,
    monthEnd,
    "raw_result.json",
  )) {
    const rawResultPath = path.join(fullPath, "raw_result.json");
    if (fs.existsSync(rawResultPath)) {
      const rawResult = JSON.parse(fs.readFileSync(rawResultPath, "utf-8")) as {
        iva: IRetencion[];
        renta: IRetencion[];
        unknown: IRetencion[];
        month: number;
      };
      rawResults.push(rawResult);
    } else {
      logger.warn(`No raw_result.json found in ${fullPath}, skipping...`);
    }
  }
  const joined = JoinRawJsons(rawResults);
  const rucBase = path.resolve(downloadPath, ruc);
  ensureParentDir(path.join(rucBase, "raw_result.json"));
  const joinedRawPath = path.join(rucBase, "raw_result.json");
  fs.writeFileSync(joinedRawPath, JSON.stringify(joined, null, 2));
  WriteRetencionesIVA(joined.iva, path.join(rucBase, "IVA.xlsx"));
  WriteRetencionesRenta(joined.renta, path.join(rucBase, "RENTA.xlsx"));
  WriteRetencionesUnknown(joined.unknown, path.join(rucBase, "UNKNOWN.xlsx"));
}

async function downloadFacturas(
  downloadPath: string,
  ruc: string,
  year: number,
  monthStart: number,
  monthEnd: number,
) {
  const facturasBase = path.resolve(downloadPath, ruc, "Facturas");

  for await (const facturas of SRIScrapper.GetFacturasPerYear(
    year,
    monthStart,
    monthEnd,
  )) {
    logger.info(
      { month: facturas.month, facturas: facturas.facturas.length },
      "Saving JSON result",
    );
    const monthDir = path.resolve(
      facturasBase,
      String(year),
      Months[facturas.month],
    );
    const resultPath = path.join(monthDir, "facturas_result.json");
    ensureParentDir(resultPath);
    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        { facturas: facturas.facturas, month: facturas.month },
        null,
        2,
      ),
    );
    WriteFacturas(facturas.facturas, path.join(monthDir, "FACTURAS.xlsx"));
  }

  // Join all the facturas_result.json files of the selected months into one
  const facturas: IFactura[] = [];
  for (const fullPath of findMonthDirs(
    facturasBase,
    year,
    monthStart,
    monthEnd,
    "facturas_result.json",
  )) {
    const resultPath = path.join(fullPath, "facturas_result.json");
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
        facturas: IFactura[];
        month: number;
      };
      facturas.push(...result.facturas);
    } else {
      logger.warn(`No facturas_result.json found in ${fullPath}, skipping...`);
    }
  }
  const rucBase = path.resolve(downloadPath, ruc);
  ensureParentDir(path.join(rucBase, "facturas.json"));
  const joinedPath = path.join(rucBase, "facturas.json");
  fs.writeFileSync(joinedPath, JSON.stringify({ facturas }, null, 2));
  WriteFacturas(facturas, path.join(rucBase, "FACTURAS.xlsx"));
}

async function bootstrap() {
  const result = await runMenu();
  if (!result) {
    logger.info("Saliendo...");
    printLogLocation();
    return;
  }
  const { tipo, ruc, password, year, month, downloadPath } = result;
  const monthStart = month ?? 1;
  const monthEnd = month ?? 12;
  const resolvedPath = path.resolve(downloadPath);
  logger.info(
    `Descargando ${tipo} del ${year}${
      month ? ` (mes: ${Months[month]})` : " (todo el año)"
    }...`,
  );
  logger.info({ downloadPath: resolvedPath }, "Directorio base");

  // Crear estructura base
  const rucBase = path.resolve(resolvedPath, ruc);
  if (!fs.existsSync(rucBase)) {
    fs.mkdirSync(rucBase, { recursive: true });
  }

  const startTime = performance.now();
  await SRIScrapper.Login(ruc, password, resolvedPath);
  if (tipo === "retenciones") {
    await downloadRetenciones(resolvedPath, ruc, year, monthStart, monthEnd);
  } else {
    await downloadFacturas(resolvedPath, ruc, year, monthStart, monthEnd);
  }
  await SRIScrapper.EndScrapper();
  const endTime = performance.now();
  logger.info({ elapsedMs: Math.round(endTime - startTime) }, "Finished");
  printLogLocation();
}

bootstrap().catch((error) => {
  logger.error(
    { err: error instanceof Error ? error.stack : String(error) },
    "Ejecución fallida",
  );
  printLogLocation();
  process.exitCode = 1;
});
