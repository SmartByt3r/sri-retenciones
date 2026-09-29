export interface IFactura {
  razonSocial: string;
  ruc: string;
  claveAcceso: string;
  establecimiento: string;
  puntoEmision: string;
  secuencial: string;
  fechaEmision: string;
  totalSinImpuestos: number;
  iva: number;
  total: number;
  estado?: string;
}
