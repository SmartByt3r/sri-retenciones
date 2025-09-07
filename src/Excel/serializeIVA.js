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
    ws.cell(1, 1).string("No").style(headerStyle);
    ws.cell(1, 2).string("RUC DEL AGENTE RETENCIÓN").style(headerStyle);
    ws.cell(1, 3).string("FECHA DE EMISIÓN").style(headerStyle);
    ws.cell(1, 4).string("SERIE").style(headerStyle);
    ws.cell(1, 5).string("SECUENCIA").style(headerStyle);
    ws.cell(1, 6)
        .string("AUTORIZACIÓN \n(comprobantes de retención físicos)")
        .style(headerStyle);
    ws.cell(1, 7)
        .string("CLAVE DE ACCESO\n(comprobantes de retención electrónicos)")
        .style(headerStyle);
    ws.cell(1, 8).string("BASE IMPONIBLE").style(headerStyle);
    ws.cell(1, 9).string("% DE RETENCIÓN DE IVA").style(headerStyle);
    ws.cell(1, 10).string("VALOR RETENIDO").style(headerStyle);
    //Añadimos la info del comprobante primero
    let row = 2;
    let col = 1;
    retenciones.forEach((retencion, index) => {
        ws.cell(row, col++).number(index + 1);
        ws.cell(row, col++).string(retencion.ruc);
        ws.cell(row, col++).string(retencion.fechaEmision);
        ws.cell(row, col++).string(retencion.puntoEmision);
        ws.cell(row, col++).string(retencion.secuencial);
        ws.cell(row, col++).string("");
        ws.cell(row, col++).string(retencion.claveAcceso);
        ws.cell(row, col++).number(retencion.valoresRetenidos.baseImponible);
        ws.cell(row, col++).number(
            retencion.valoresRetenidos.porcentajeRetenido
        );
        ws.cell(row, col++).number(retencion.valoresRetenidos.valorRetenido);
        row++;
        col = 1;
    });
}

function WriteFile(path) {
    wb.write(path);
}

export function WriteRetencionesIVA(retenciones, path) {
    AddRetencionesToWS(retenciones);
    WriteFile(path);
}
