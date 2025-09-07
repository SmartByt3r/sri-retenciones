import path from "path";
import fs from "fs";
import { WriteRetencionesIVA } from "./src/Excel/serializeIVA.js";
import { WriteRetencionesRenta } from "./src/Excel/serializeRenta.js";
import { WriteRetencionesUnknown } from "./src/Excel/serializeUnknown.js";
import SRIScrapper from "./src/SRI/SRIScrapper.ts";
import { Months } from "./src/utils/months.ts";
import type { IRetencion } from "./src/SRI/IRetencion.ts";
import { JoinRawJsons } from "./src/utils/json.ts";

const RUC = "1792734134001";
const password = "Tomas1792***";
const year = 2024;

async function bootstrap() {
    if (!fs.existsSync(path.resolve(`./${RUC}`))) {
        fs.mkdirSync(path.resolve(`./${RUC}`));
    }
    const startTime = performance.now();
    await SRIScrapper.Login(RUC, password);
    for await (const retenciones of SRIScrapper.GetRetencionesPerYear(year)) {
        console.log("Saving JSON result", JSON.stringify(retenciones, null, 2));
        fs.writeFileSync(
            path.resolve(
                `./${RUC}/Comprobantes/${year}/${
                    Months[retenciones.month]
                }/raw_result.json`
            ),
            JSON.stringify(retenciones, null, 2)
        );
        WriteRetencionesIVA(
            retenciones.iva,
            path.resolve(
                `./${RUC}/Comprobantes/${year}/${Months[retenciones.month]}`,
                `IVA.xlsx`
            )
        );
        WriteRetencionesRenta(
            retenciones.renta,
            path.resolve(
                `./${RUC}/Comprobantes/${year}/${Months[retenciones.month]}`,
                `RENTA.xlsx`
            )
        );
        WriteRetencionesUnknown(
            retenciones.unknown,
            path.resolve(
                `./${RUC}/Comprobantes/${year}/${Months[retenciones.month]}`,
                `UNKNOWN.xlsx`
            )
        );
    }
    await SRIScrapper.EndScrapper();
    const endTime = performance.now();
    console.log("Finished, time elapsed:", endTime - startTime);

    // Join all the raw_result.json files into one
    const entries = fs.readdirSync(
        path.resolve(`./${RUC}/Comprobantes/${year}`),
        {
            withFileTypes: true,
        }
    );
    const rawResults = [] as Array<{
        iva: IRetencion[];
        renta: IRetencion[];
        unknown: IRetencion[];
        month: number;
    }>;
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const fullPath = path.join(
                path.resolve(`./${RUC}/Comprobantes/${year}`),
                entry.name
            );
            const rawResultPath = path.join(fullPath, "raw_result.json");
            if (fs.existsSync(rawResultPath)) {
                const rawResult = JSON.parse(
                    fs.readFileSync(rawResultPath, "utf-8")
                ) as {
                    iva: IRetencion[];
                    renta: IRetencion[];
                    unknown: IRetencion[];
                    month: number;
                };
                rawResults.push(rawResult);
            } else {
                console.warn(
                    `No raw_result.json found in ${fullPath}, skipping...`
                );
            }
        }
    }
    const joined = JoinRawJsons(rawResults);
    fs.writeFileSync(
        path.resolve(`./${RUC}`, `raw_result.json`),
        JSON.stringify(joined, null, 2)
    );
    WriteRetencionesIVA(joined.iva, path.resolve(`./${RUC}`, `IVA.xlsx`));
    WriteRetencionesRenta(joined.renta, path.resolve(`./${RUC}`, `RENTA.xlsx`));
    WriteRetencionesUnknown(
        joined.unknown,
        path.resolve(`./${RUC}`, `UNKNOWN.xlsx`)
    );
}

bootstrap();
