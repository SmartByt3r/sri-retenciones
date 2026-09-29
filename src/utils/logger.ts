import fs from "fs";
import path from "path";
import pino from "pino";

const LOGS_DIR = path.resolve("./logs");

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export const logFilePath = path.join(LOGS_DIR, `sri-${timestamp()}.log`);

fs.mkdirSync(LOGS_DIR, { recursive: true });

/**
 * Salida de consola: línea corta legible (HH:mm:ss LEVEL msg).
 * El archivo de log recibe los mismos eventos como líneas JSON
 * (incluye debug, que no sale por consola).
 */
const consoleStream = {
  write(line: string): void {
    try {
      const entry = JSON.parse(line) as {
        time?: number;
        level?: number;
        msg?: string;
      };
      const time = new Date(entry.time ?? Date.now());
      const p = (n: number) => String(n).padStart(2, "0");
      const hhmmss = `${p(time.getHours())}:${p(time.getMinutes())}:${p(time.getSeconds())}`;
      const levelName = pino.levels.labels[entry.level ?? 30] ?? "info";
      process.stdout.write(
        `${hhmmss} ${levelName.toUpperCase()} ${entry.msg ?? ""}\n`,
      );
    } catch {
      process.stdout.write(line);
    }
  },
};

export const logger = pino(
  { level: "debug" },
  pino.multistream([
    { stream: consoleStream, level: "info" },
    // Escritura síncrona: el log queda completo aunque el proceso termine
    // abruptamente (pino.destination con sync: true).
    {
      stream: pino.destination({ dest: logFilePath, sync: true }),
      level: "debug",
    },
  ]),
);

export function getLogFilePath(): string {
  return logFilePath;
}

/** Imprime la ruta del log de esta ejecución (consola, no al log). */
export function printLogLocation(): void {
  process.stdout.write(`Log de la ejecución: ${logFilePath}\n`);
}
