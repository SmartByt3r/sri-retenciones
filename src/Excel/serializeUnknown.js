const xl = require("excel4node");
let wb;

function AddRetencionesToWS(retenciones) {
    wb = new xl.Workbook();
    const headerStyle = wb.createStyle({
        border: {
            left: { style: "medium" },
            right: { style: "medium" },
            top: { style: "medium" },
            bottom: { style: "medium" },
        },
    });
    const ws = wb.addWorksheet("Retenciones");
    //Encabezados
    ws.cell(1, 1).string("RUC").style(headerStyle);
    ws.cell(1, 2).string("Razon Social").style(headerStyle);
    ws.cell(1, 3).string("Clave de acceso").style(headerStyle);
    ws.cell(1, 4).string("Establecimiento").style(headerStyle);
    ws.cell(1, 5).string("Punto de emision").style(headerStyle);
    ws.cell(1, 6).string("Secuencial").style(headerStyle);
    ws.cell(1, 7).string("Fecha de emision").style(headerStyle);
    ws.cell(1, 8).string("ID sujeto retenido").style(headerStyle);
    ws.cell(1, 9).string("Razon social sujeto retenido").style(headerStyle);
    ws.cell(1, 10).string("Ejercicio Fiscal").style(headerStyle);
    ws.cell(1, 11).string("Nro").style(headerStyle);
    ws.cell(1, 12).string("Impuesto").style(headerStyle);
    ws.cell(1, 13).string("Base Imponible").style(headerStyle);
    ws.cell(1, 14).string("Porcentaje Retenido").style(headerStyle);
    ws.cell(1, 15).string("Valor Retenido").style(headerStyle);
    ws.cell(1, 16).string("Doc Sustento").style(headerStyle);
    ws.cell(1, 17).string("Fecha Doc Sustento").style(headerStyle);

    //Añadimos la info del comprobante primero
    let row = 2;
    let col = 1;
    retenciones.forEach((retencion) => {
        ws.cell(row, col++).string(retencion.ruc);
        ws.cell(row, col++).string(retencion.razonSocial);
        ws.cell(row, col++).string(retencion.claveAcceso);
        ws.cell(row, col++).string(retencion.establecimiento);
        ws.cell(row, col++).string(retencion.puntoEmision);
        ws.cell(row, col++).string(retencion.secuencial);
        ws.cell(row, col++).string(retencion.fechaEmision);
        ws.cell(row, col++).string(retencion.idSujetoRetenido);
        ws.cell(row, col++).string(retencion.razonSocialSujetoRetenido);
        ws.cell(row, col++).string(retencion.ejercicioFiscal);
        //Añadimos la info de las retenciones
        ws.cell(row, col++).string(retencion.valoresRetenidos.nro);
        ws.cell(row, col++).string(retencion.valoresRetenidos.impuesto);
        ws.cell(row, col++).number(retencion.valoresRetenidos.baseImponible);
        ws.cell(row, col++).number(
            retencion.valoresRetenidos.porcentajeRetenido
        );
        ws.cell(row, col++).number(retencion.valoresRetenidos.valorRetenido);
        ws.cell(row, col++).string(retencion.valoresRetenidos.docSustento);
        ws.cell(row, col++).string(retencion.valoresRetenidos.fechaDocSustento);
        row++;
        col = 1;
    });
}

function WriteFile(path) {
    wb.write(path);
}

export function WriteRetencionesUnknown(retenciones, path) {
    AddRetencionesToWS(retenciones);
    WriteFile(path);
}
