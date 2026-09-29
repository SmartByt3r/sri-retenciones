import type { Page } from "puppeteer";
import { setTimeout } from "timers/promises";
import { logger } from "../utils/logger";

const TWO_CAPTCHA_API = "https://api.2captcha.com";

export interface RecaptchaInfo {
  siteKey: string;
  isEnterprise: boolean;
  isInvisible: boolean;
  /**
   * Action del widget reCAPTCHA Enterprise. El SRI lo define en el onclick
   * real del botón: executeRecaptcha('consulta_cel_recibidos','SI') →
   * grecaptcha.enterprise.execute({action}). Sin pasar el action a 2captcha,
   * el token se genera con otra acción y el servidor lo rechaza
   * ("Captcha incorrecta") aunque el cliente lo valide.
   */
  action?: string;
}

/**
 * API key de 2captcha: variable de entorno TWO_CAPTCHA_TOKEN o la clave
 * incluida por defecto.
 */
export function getTwoCaptchaApiKey(): string {
  return (
    process.env.TWO_CAPTCHA_TOKEN ?? "fecfd997a480ee0e1c2ff9cb6a3fc88c" // 2CAPTCHA API KEY ⚡
  );
}

/**
 * Detecta el widget reCAPTCHA de la página. El SRI lo renderiza
 * programáticamente (sin div .g-recaptcha), así que se lee del iframe
 * anchor: siteKey del parámetro "k" de la URL; enterprise/invisible
 * también de la URL. Fallback: cualquier elemento [data-sitekey].
 */
export async function detectRecaptcha(page: Page): Promise<RecaptchaInfo> {
  return page.evaluate(() => {
    const iframe = document.querySelector(
      'iframe[src*="/recaptcha/"]',
    ) as HTMLIFrameElement | null;
    let siteKey = "";
    let isEnterprise = false;
    let isInvisible = false;
    if (iframe) {
      isEnterprise = iframe.src.includes("/recaptcha/enterprise/");
      isInvisible = iframe.src.includes("size=invisible");
      const match = iframe.src.match(/[?&]k=([^&]+)/);
      if (match && match[1]) siteKey = match[1];
    }
    if (!siteKey) {
      const div = document.querySelector("[data-sitekey]");
      if (div) siteKey = div.getAttribute("data-sitekey") ?? "";
    }
    if (!siteKey) {
      throw new Error(
        "No se detectó ningún widget reCAPTCHA en la página (sin iframe anchor ni data-sitekey)",
      );
    }
    // Action: fuente de verdad = onclick del botón del SRI
    // (executeRecaptcha('consulta_cel_recibidos','SI'))
    let action = "";
    const onclickEl = document.querySelector('[onclick*="executeRecaptcha"]');
    if (onclickEl) {
      const onclick = onclickEl.getAttribute("onclick") ?? "";
      const match = onclick.match(/executeRecaptcha\(\s*['"]([^'"]+)['"]/);
      if (match && match[1]) action = match[1];
    }
    if (!action) {
      // Fallback: action de la config de render del widget
      try {
        const cfg = (
          window as unknown as {
            ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
          }
        ).___grecaptcha_cfg;
        const seen = new Set<unknown>();
        const walk = (obj: unknown, depth: number): boolean => {
          if (!obj || typeof obj !== "object" || depth > 6 || seen.has(obj)) {
            return false;
          }
          seen.add(obj);
          for (const v of Object.values(obj as Record<string, unknown>)) {
            if (v && typeof v === "object") {
              const vo = v as Record<string, unknown>;
              if (
                typeof vo.sitekey === "string" &&
                typeof vo.action === "string"
              ) {
                action = vo.action;
                return true;
              }
              if (walk(v, depth + 1)) return true;
            }
          }
          return false;
        };
        if (cfg?.clients) walk(cfg.clients, 0);
      } catch {
        // sin action conocido: se resuelve sin enterprisePayload (como antes)
      }
    }
    return { siteKey, isEnterprise, isInvisible, action };
  });
}

/**
 * Resuelve el reCAPTCHA vía la API de 2captcha:
 * 1. createTask (RecaptchaV2TaskProxyless + isEnterprise/isInvisible)
 * 2. Polling getTaskResult cada 5s hasta status "ready" → token
 * Docs: https://2captcha.com/api-docs/recaptcha-v2
 */
export async function solveRecaptchaWith2Captcha(
  apiKey: string,
  info: RecaptchaInfo,
  pageUrl: string,
  timeoutMs: number = 120000,
): Promise<string> {
  // 1. Crear la tarea
  // reCAPTCHA Enterprise con action → estilo v3 (score-based).
  // Sin action → v2 clásico (isEnterprise/isInvisible).
  const task: Record<string, unknown> = info.action
    ? {
        type: "RecaptchaV3TaskProxyless",
        websiteURL: pageUrl,
        websiteKey: info.siteKey,
        action: info.action,
        min_score: 0.3,
      }
    : {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: pageUrl,
        websiteKey: info.siteKey,
        isEnterprise: info.isEnterprise,
        isInvisible: info.isInvisible,
      };
  const createResponse = await fetch(`${TWO_CAPTCHA_API}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task,
    }),
  });
  const createJson = (await createResponse.json()) as {
    errorId: number;
    errorCode?: string;
    taskId?: number;
  };
  if (createJson.errorId !== 0 || !createJson.taskId) {
    throw new Error(
      `2captcha createTask falló: ${createJson.errorCode ?? `errorId=${createJson.errorId}`}`,
    );
  }
  logger.info(
    `2captcha: tarea ${createJson.taskId} creada, esperando solución...`,
  );

  // 2. Polling (la doc de 2captcha pide no consultar más seguido que 5s)
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `2captcha: timeout (${timeoutMs}ms) esperando la solución del captcha`,
      );
    }
    await setTimeout(5000);
    const resultResponse = await fetch(`${TWO_CAPTCHA_API}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId: createJson.taskId,
      }),
    });
    const resultJson = (await resultResponse.json()) as {
      errorId: number;
      errorCode?: string;
      status?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    };
    if (resultJson.errorId !== 0) {
      throw new Error(
        `2captcha getTaskResult falló: ${resultJson.errorCode ?? `errorId=${resultJson.errorId}`}`,
      );
    }
    if (resultJson.status === "ready") {
      const token =
        resultJson.solution?.gRecaptchaResponse ?? resultJson.solution?.token;
      if (token) {
        logger.info("2captcha: captcha resuelto");
        return token;
      }
    }
    // status "processing" → seguir esperando
  }
}

/**
 * Inyecta el token en la página: lo escribe en todos los textarea
 * g-recaptcha-response. El del widget está dentro del formulario
 * (frmPrincipal), así el token viaja en el POST de la consulta que
 * dispara el callback del widget (onSubmit → rcBuscar).
 * Nota: NO se sobreescribe grecaptcha.execute — el JS del SRI descarta
 * la promesa de execute() y depende del callback del widget; tocarlo
 * rompe el flujo (ver submitQueryWithCaptchaToken en SRIScrapper).
 */
export async function injectRecaptchaToken(
  page: Page,
  token: string,
): Promise<void> {
  await page.evaluate((injectedToken: string) => {
    for (const textarea of Array.from(
      document.querySelectorAll('textarea[id^="g-recaptcha-response"]'),
    )) {
      (textarea as HTMLTextAreaElement).value = injectedToken;
    }
  }, token);
}
