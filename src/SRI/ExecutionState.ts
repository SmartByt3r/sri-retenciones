/**
 * Estado persistente de ejecución del scrapper usando la API nativa de
 * SQLite de Bun (`bun:sqlite`). Permite reanudar una ejecución interrumpida
 * (timeout, crash, error) desde el último punto procesado.
 *
 * Diseño:
 * - `checkpoint`: una fila por comprobante (clave de acceso) con su estado.
 *   El skip/reintento se hace por clave, no por página: si llegan
 *   comprobantes nuevos, la paginación se corre pero las claves ya
 *   descargadas no se repiten (idempotente).
 * - `month_progress`: progreso por (ruc, año, mes, tipo) para saber hasta
 *   qué página se avanzó y si el mes ya se completó.
 */
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger";

export type DocType = "retenciones" | "facturas";
export type CheckpointStatus = "downloaded" | "failed";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoint (
  ruc TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  clave_acceso TEXT NOT NULL,
  status TEXT NOT NULL,
  page INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ruc, year, month, doc_type, clave_acceso)
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_scope
  ON checkpoint (ruc, year, month, doc_type, status);

CREATE TABLE IF NOT EXISTS month_progress (
  ruc TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  last_page INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ruc, year, month, doc_type)
);
`;

export class ExecutionState {
  private db: Database;

  constructor(dbPath: string = process.env.SRI_STATE_DB ?? "sri-state.db") {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    logger.info({ dbPath }, "Estado de ejecución inicializado");
  }

  /** Marca un comprobante con un estado (upsert idempotente). */
  markProcessed(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
    claveAcceso: string,
    status: CheckpointStatus,
    page?: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO checkpoint
           (ruc, year, month, doc_type, clave_acceso, status, page, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (ruc, year, month, doc_type, clave_acceso)
         DO UPDATE SET status = excluded.status,
                       page = COALESCE(excluded.page, page),
                       updated_at = excluded.updated_at`,
      )
      .run(ruc, year, month, docType, claveAcceso, status, page ?? null);
  }

  /** Estado de un comprobante, o undefined si no se ha procesado. */
  getStatus(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
    claveAcceso: string,
  ): CheckpointStatus | undefined {
    const row = this.db
      .prepare(
        "SELECT status FROM checkpoint WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ? AND clave_acceso = ?",
      )
      .get(ruc, year, month, docType, claveAcceso) as
      { status: string } | undefined;
    return row ? (row.status as CheckpointStatus) : undefined;
  }

  /** ¿Existe registro para esta clave? */
  exists(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
    claveAcceso: string,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS cnt FROM checkpoint WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ? AND clave_acceso = ?",
      )
      .get(ruc, year, month, docType, claveAcceso) as
      { cnt: number } | undefined;
    return !!row?.cnt;
  }

  /** Conjunto de claves ya descargadas para un (ruc, año, mes, tipo). */
  getDownloadedClaves(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
  ): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT clave_acceso FROM checkpoint WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ? AND status = 'downloaded'",
      )
      .all(ruc, year, month, docType) as { clave_acceso: string }[];
    return new Set(rows.map((r) => r.clave_acceso));
  }

  /** Claves marcadas como fallidas (para reintentar). */
  getFailedClaves(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
  ): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT clave_acceso FROM checkpoint WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ? AND status = 'failed'",
      )
      .all(ruc, year, month, docType) as { clave_acceso: string }[];
    return new Set(rows.map((r) => r.clave_acceso));
  }

  /** Última página alcanzada para un scope (0 si nunca se procesó). */
  getLastPage(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
  ): number {
    const row = this.db
      .prepare(
        "SELECT last_page FROM month_progress WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ?",
      )
      .get(ruc, year, month, docType) as { last_page: number } | undefined;
    return row?.last_page ?? 0;
  }

  /** Actualiza el progreso de página de un scope. */
  setLastPage(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
    page: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO month_progress (ruc, year, month, doc_type, last_page, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', datetime('now'))
         ON CONFLICT (ruc, year, month, doc_type)
         DO UPDATE SET last_page = excluded.last_page,
                       status = excluded.status,
                       updated_at = excluded.updated_at`,
      )
      .run(ruc, year, month, docType, page);
  }

  /** Marca el scope como completado. */
  markMonthCompleted(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
  ): void {
    this.db
      .prepare(
        `INSERT INTO month_progress (ruc, year, month, doc_type, last_page, status, updated_at)
         VALUES (?, ?, ?, ?, 0, 'completed', datetime('now'))
         ON CONFLICT (ruc, year, month, doc_type)
         DO UPDATE SET status = excluded.status,
                       updated_at = excluded.updated_at`,
      )
      .run(ruc, year, month, docType);
  }

  /** ¿El scope ya se completó? */
  isMonthCompleted(
    ruc: string,
    year: number,
    month: number,
    docType: DocType,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT status FROM month_progress WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ?",
      )
      .get(ruc, year, month, docType) as { status: string } | undefined;
    return row?.status === "completed";
  }

  /** Limpia el progreso de un scope (útil para re-ejecución completa). */
  resetScope(ruc: string, year: number, month: number, docType: DocType): void {
    this.db
      .prepare(
        "DELETE FROM checkpoint WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ?",
      )
      .run(ruc, year, month, docType);
    this.db
      .prepare(
        "DELETE FROM month_progress WHERE ruc = ? AND year = ? AND month = ? AND doc_type = ?",
      )
      .run(ruc, year, month, docType);
  }

  close(): void {
    this.db.close();
    logger.info("Estado de ejecución cerrado");
  }
}
