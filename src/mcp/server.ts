/**
 * MCP Server para SRI Retenciones/Facturas.
 * Expone herramientas para que un agente (OpenCode, Claude Desktop, etc.)
 * controle la descarga de comprobantes del SRI.
 *
 * Transporte: stdio (para hosts locales como OpenCode/Claude Desktop).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import * as z from "zod/v4";

import SRIScrapper from "../SRI/SRIScrapper.ts";
import { Months } from "../utils/months.ts";

// Los logs del scrapper van a stderr (configurado en logger.ts)
// para que no interfieran con el protocolo stdio.

const server = new McpServer({
  name: "sri-retenciones",
  version: "1.0.0",
});

// --- sri_login ---
server.registerTool(
  "sri_login",
  {
    description:
      "Autenticarse en el portal SRI. Debe llamarse antes de cualquier consulta.",
    inputSchema: z.object({
      ruc: z.string().describe("RUC del contribuyente (10-13 dígitos)"),
      password: z.string().describe("Clave de acceso del portal SRI"),
      downloadPath: z
        .string()
        .optional()
        .describe(
          "Directorio base para descargas y reportes (default: directorio actual)",
        ),
    }),
  },
  async ({ ruc, password, downloadPath = "." }) => {
    try {
      await SRIScrapper.Login(ruc, password, downloadPath);
      return {
        content: [
          {
            type: "text",
            text: `Login exitoso para RUC ${ruc}. Directorio base: ${downloadPath}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error de login: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- sri_get_retenciones ---
server.registerTool(
  "sri_get_retenciones",
  {
    description:
      "Descargar comprobantes de retención para un mes/año específico. Devuelve resumen y guarda PDF/XML + Excel en disco.",
    inputSchema: z.object({
      year: z.number().describe("Año (ej: 2024)"),
      month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .describe("Mes (1=Enero, 12=Diciembre)"),
    }),
  },
  async ({ year, month }) => {
    try {
      const result = await SRIScrapper.GetRetencionesPerMonth(month, year);
      const summary = {
        month: Months[month],
        year,
        ivaCount: result.iva.length,
        rentaCount: result.renta.length,
        unknownCount: result.unknown.length,
        total: result.iva.length + result.renta.length + result.unknown.length,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error descargando retenciones: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- sri_get_facturas ---
server.registerTool(
  "sri_get_facturas",
  {
    description:
      "Descargar facturas para un mes/año específico. Devuelve resumen y guarda PDF/XML + Excel en disco.",
    inputSchema: z.object({
      year: z.number().describe("Año (ej: 2024)"),
      month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .describe("Mes (1=Enero, 12=Diciembre)"),
    }),
  },
  async ({ year, month }) => {
    try {
      const result = await SRIScrapper.GetFacturasPerMonth(month, year);
      const summary = {
        month: Months[month],
        year,
        facturasCount: result.length,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error descargando facturas: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- sri_get_retenciones_year ---
server.registerTool(
  "sri_get_retenciones_year",
  {
    description:
      "Descargar retenciones de todo el año (o rango de meses). Hace retry automático con recreate browser si falla un mes.",
    inputSchema: z.object({
      year: z.number().describe("Año (ej: 2024)"),
      monthStart: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Mes inicio (default: 1)"),
      monthEnd: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Mes fin (default: 12)"),
    }),
  },
  async ({ year, monthStart = 1, monthEnd = 12 }) => {
    try {
      const results: Array<{
        month: string;
        ivaCount: number;
        rentaCount: number;
        unknownCount: number;
      }> = [];
      for await (const ret of SRIScrapper.GetRetencionesPerYear(
        year,
        monthStart,
        monthEnd,
      )) {
        results.push({
          month: Months[ret.month],
          ivaCount: ret.iva.length,
          rentaCount: ret.renta.length,
          unknownCount: ret.unknown.length,
        });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ year, months: results }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- sri_get_facturas_year ---
server.registerTool(
  "sri_get_facturas_year",
  {
    description:
      "Descargar facturas de todo el año (o rango de meses). Hace retry automático con recreate browser si falla un mes.",
    inputSchema: z.object({
      year: z.number().describe("Año (ej: 2024)"),
      monthStart: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Mes inicio (default: 1)"),
      monthEnd: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Mes fin (default: 12)"),
    }),
  },
  async ({ year, monthStart = 1, monthEnd = 12 }) => {
    try {
      const results: Array<{ month: string; facturasCount: number }> = [];
      for await (const fact of SRIScrapper.GetFacturasPerYear(
        year,
        monthStart,
        monthEnd,
      )) {
        results.push({
          month: Months[fact.month],
          facturasCount: fact.facturas.length,
        });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ year, months: results }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- sri_close ---
server.registerTool(
  "sri_close",
  {
    description:
      "Cerrar la sesión del SRI, liberar browser y base de datos de checkpoint. Llamar al finalizar.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      await SRIScrapper.EndScrapper();
      return {
        content: [
          {
            type: "text",
            text: "Sesión cerrada, browser cerrado y recursos liberados.",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error cerrando sesión: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- sri_status ---
server.registerTool(
  "sri_status",
  {
    description: "Verificar el estado actual del servidor SRI MCP.",
    inputSchema: z.object({}),
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text: "SRI MCP server activo. Use sri_login para autenticarse antes de consultar.",
        },
      ],
    };
  },
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log a stderr para que no interfiera con el protocolo stdio
  console.error("SRI MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fallo al iniciar MCP server:", err);
  process.exit(1);
});
