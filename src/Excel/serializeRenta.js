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
    ws.cell(1, 1)
        .string("Número de comprobante de retención 00X-00X-000000XXXX")
        .style(headerStyle);
    ws.cell(1, 2)
        .string("Número de autorización del comprobante de retención")
        .style(headerStyle);
    ws.cell(1, 3)
        .string("Fecha de emisión del comprobante de retención")
        .style(headerStyle);
    ws.cell(1, 4).string("RUC del agente de retención").style(headerStyle);
    ws.cell(1, 5).string("Base imponible").style(headerStyle);
    ws.cell(1, 6).string("% de Retención").style(headerStyle);
    ws.cell(1, 7).string("Valor Retenido").style(headerStyle);
    //Añadimos la info del comprobante primero
    let row = 2;
    let col = 1;
    retenciones.forEach((retencion, index) => {
        ws.cell(row, col++).string(
            `${retencion.establecimiento}-${retencion.puntoEmision}-${retencion.secuencial}`
        );
        ws.cell(row, col++).string(retencion.claveAcceso);
        ws.cell(row, col++).string(retencion.fechaEmision);
        ws.cell(row, col++).string(retencion.ruc);
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

export function WriteRetencionesRenta(retenciones, path) {
    AddRetencionesToWS(retenciones);
    WriteFile(path);
}
