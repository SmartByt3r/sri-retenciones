import type { IRetencion } from "../SRI/IRetencion";

export function JoinRawJsons(
    retenciones: {
        iva: IRetencion[];
        renta: IRetencion[];
        unknown: IRetencion[];
    }[]
) {
    const result: {
        iva: IRetencion[];
        renta: IRetencion[];
        unknown: IRetencion[];
    } = {
        iva: [],
        renta: [],
        unknown: [],
    };

    for (const retencion of retenciones) {
        result.iva.push(...retencion.iva);
        result.renta.push(...retencion.renta);
        result.unknown.push(...retencion.unknown);
    }

    return result;
}
