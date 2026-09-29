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

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function monthDirsForRange(
  ruc: string,
  year: number,
  monthStart: number,
  monthEnd: number,
) {
  const yearDir = path.resolve(`./${ruc}/Comprobantes/${year}`);
  if (!fs.existsSync(yearDir)) return [];
  return fs
    .readdirSync(yearDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(yearDir, entry.name))
    .filter((fullPath) => {
      const monthFile = fs.existsSync(path.join(fullPath, "raw_result.json"))
        ? "raw_result.json"
        : fs.existsSync(path.join(fullPath, "facturas_result.json"))
          ? "facturas_result.json"
          : null;
      if (monthFile === null) return false;
      const parsed = JSON.parse(
        fs.readFileSync(path.join(fullPath, monthFile), "utf-8"),
      ) as { month: number };
      return parsed.month >= monthStart && parsed.month <= monthEnd;
    });
}

async function downloadRetenciones(
  ruc: string,
  year: number,
  monthStart: number,
  monthEnd: number,
) {
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
      `./${ruc}/Comprobantes/${year}/${Months[retenciones.month]}`,
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
  for (const fullPath of monthDirsForRange(ruc, year, monthStart, monthEnd)) {
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
  const joinedRawPath = path.resolve(`./${ruc}`, "raw_result.json");
  ensureParentDir(joinedRawPath);
  fs.writeFileSync(joinedRawPath, JSON.stringify(joined, null, 2));
  WriteRetencionesIVA(joined.iva, path.resolve(`./${ruc}`, "IVA.xlsx"));
  WriteRetencionesRenta(joined.renta, path.resolve(`./${ruc}`, "RENTA.xlsx"));
  WriteRetencionesUnknown(
    joined.unknown,
    path.resolve(`./${ruc}`, "UNKNOWN.xlsx"),
  );
}

async function downloadFacturas(
  ruc: string,
  year: number,
  monthStart: number,
  monthEnd: number,
) {
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
      `./${ruc}/Comprobantes/${year}/${Months[facturas.month]}`,
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
  for (const fullPath of monthDirsForRange(ruc, year, monthStart, monthEnd)) {
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
  const joinedPath = path.resolve(`./${ruc}`, "facturas.json");
  ensureParentDir(joinedPath);
  fs.writeFileSync(joinedPath, JSON.stringify({ facturas }, null, 2));
  WriteFacturas(facturas, path.resolve(`./${ruc}`, "FACTURAS.xlsx"));
}

async function bootstrap() {
  const result = await runMenu();
  if (!result) {
    logger.info("Saliendo...");
    printLogLocation();
    return;
  }
  const { tipo, ruc, password, year, month } = result;
  const monthStart = month ?? 1;
  const monthEnd = month ?? 12;
  logger.info(
    `Descargando ${tipo} del ${year}${
      month ? ` (mes: ${Months[month]})` : " (todo el año)"
    }...`,
  );
  if (!fs.existsSync(path.resolve(`./${ruc}`))) {
    fs.mkdirSync(path.resolve(`./${ruc}`));
  }
  const startTime = performance.now();
  await SRIScrapper.Login(ruc, password);
  if (tipo === "retenciones") {
    await downloadRetenciones(ruc, year, monthStart, monthEnd);
  } else {
    await downloadFacturas(ruc, year, monthStart, monthEnd);
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
