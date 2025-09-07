export interface IRetencion {
    razonSocial: string;
    ruc: string;
    claveAcceso: string;
    establecimiento: string;
    puntoEmision: string;
    secuencial: string;
    fechaEmision: string;
    idSujetoRetenido: string;
    razonSocialSujetoRetenido: string;
    ejercicioFiscal: string;
    valoresRetenidos: {
        nro: string;
        impuesto: string;
        baseImponible: number;
        porcentajeRetenido: number;
        valorRetenido: number;
        docSustento: string;
        fechaDocSustento: string;
    };
}
