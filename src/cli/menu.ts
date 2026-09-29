import {
  intro,
  outro,
  select,
  text,
  password,
  isCancel,
  cancel,
} from "@clack/prompts";
import { Months } from "../utils/months.ts";

export interface MenuResult {
  tipo: "retenciones" | "facturas";
  ruc: string;
  password: string;
  year: number;
  /** Mes seleccionado (1-12). `undefined` = todo el año. */
  month?: number;
  /** Directorio base de descarga (default: "." = directorio actual). */
  downloadPath: string;
}

/**
 * Menú principal del CLI (usa @clack/prompts). Devuelve los parámetros
 * para el scraper, o null si el usuario elige Salir o cancela.
 */
export async function runMenu(): Promise<MenuResult | null> {
  intro("SRI - Descarga de Comprobantes");

  const tipo = await select({
    message: "¿Qué tipo de comprobante quieres descargar?",
    options: [
      { value: "retenciones" as const, label: "Retenciones" },
      { value: "facturas" as const, label: "Facturas" },
      { value: "salir" as const, label: "Salir" },
    ],
  });
  if (isCancel(tipo) || tipo === "salir") {
    cancel("Saliendo...");
    return null;
  }

  const ruc = await text({
    message: "RUC",
    validate: (value) => {
      const v = (value ?? "").trim();
      if (!/^\d{10,13}$/.test(v)) {
        return "El RUC debe tener entre 10 y 13 dígitos";
      }
    },
  });
  if (isCancel(ruc)) {
    cancel("Operación cancelada");
    return null;
  }

  const clave = await password({
    message: "Clave del portal SRI",
    validate: (value) => {
      const v = (value ?? "").trim();
      if (!v) return "La clave no puede estar vacía";
    },
  });
  if (isCancel(clave)) {
    cancel("Operación cancelada");
    return null;
  }

  const currentYear = new Date().getFullYear();
  const yearInput = await text({
    message: `Año (Enter = ${currentYear})`,
    validate: (value) => {
      const v = (value ?? "").trim();
      if (v === "") return;
      if (!/^\d{4}$/.test(v)) {
        return "Ingresa un año de 4 dígitos (ej: 2024) o Enter para el año actual";
      }
    },
  });
  if (isCancel(yearInput)) {
    cancel("Operación cancelada");
    return null;
  }
  const year = yearInput.trim() === "" ? currentYear : Number(yearInput.trim());

  const periodo = await select({
    message: "¿Qué periodo quieres descargar?",
    options: [
      { value: "anio" as const, label: `Todo el año ${year}` },
      { value: "mes" as const, label: "Un mes específico" },
    ],
  });
  if (isCancel(periodo)) {
    cancel("Operación cancelada");
    return null;
  }

  let month: number | undefined;
  if (periodo === "mes") {
    const monthSelection = await select({
      message: "Mes",
      options: Object.entries(Months).map(([value, label]) => ({
        value: Number(value),
        label,
      })),
    });
    if (isCancel(monthSelection)) {
      cancel("Operación cancelada");
      return null;
    }
    month = monthSelection;
  }

  const downloadPathInput = await text({
    message: "Directorio de descarga (Enter = directorio actual)",
    placeholder: ".",
    validate: () => undefined, // siempre válido
  });
  if (isCancel(downloadPathInput)) {
    cancel("Operación cancelada");
    return null;
  }
  const downloadPath =
    downloadPathInput.trim() === "" ? "." : downloadPathInput.trim();

  outro("Iniciando descarga...");

  return {
    tipo,
    ruc: ruc.trim(),
    password: clave.trim(),
    year,
    month,
    downloadPath,
  };
}
