const xl = require("excel4node");
let wb;

function AddFacturasToWS(facturas) {
  wb = new xl.Workbook();
  const headerStyle = wb.createStyle({
    border: {
      left: { style: "medium" },
      right: { style: "medium" },
      top: { style: "medium" },
      bottom: { style: "medium" },
    },
  });
  const ws = wb.addWorksheet("Facturas");
  //Encabezados
  ws.cell(1, 1).string("No").style(headerStyle);
  ws.cell(1, 2).string("RUC EMISOR").style(headerStyle);
  ws.cell(1, 3).string("RAZÓN SOCIAL EMISOR").style(headerStyle);
  ws.cell(1, 4).string("CLAVE DE ACCESO").style(headerStyle);
  ws.cell(1, 5).string("ESTABLECIMIENTO").style(headerStyle);
  ws.cell(1, 6).string("PUNTO DE EMISIÓN").style(headerStyle);
  ws.cell(1, 7).string("SECUENCIAL").style(headerStyle);
  ws.cell(1, 8).string("FECHA DE EMISIÓN").style(headerStyle);
  ws.cell(1, 9).string("SUBTOTAL SIN IMPUESTOS").style(headerStyle);
  ws.cell(1, 10).string("IVA").style(headerStyle);
  ws.cell(1, 11).string("TOTAL").style(headerStyle);
  ws.cell(1, 12).string("ESTADO").style(headerStyle);
  //Añadimos la info de las facturas
  let row = 2;
  let col = 1;
  facturas.forEach((factura, index) => {
    ws.cell(row, col++).number(index + 1);
    ws.cell(row, col++).string(factura.ruc);
    ws.cell(row, col++).string(factura.razonSocial);
    ws.cell(row, col++).string(factura.claveAcceso);
    ws.cell(row, col++).string(factura.establecimiento);
    ws.cell(row, col++).string(factura.puntoEmision);
    ws.cell(row, col++).string(factura.secuencial);
    ws.cell(row, col++).string(factura.fechaEmision);
    ws.cell(row, col++).number(factura.totalSinImpuestos);
    ws.cell(row, col++).number(factura.iva);
    ws.cell(row, col++).number(factura.total);
    ws.cell(row, col++).string(factura.estado ?? "");
    row++;
    col = 1;
  });
}

function WriteFile(path) {
  wb.write(path);
}

export function WriteFacturas(facturas, path) {
  AddFacturasToWS(facturas);
  WriteFile(path);
}
