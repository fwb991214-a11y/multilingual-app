import type { TranslationJobResumeState } from "../services/translation/types";

export function getInternalJobSecret() {
  return (
    process.env.INTERNAL_JOB_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    ""
  );
}

/** 必须是带协议的绝对地址，否则 Node fetch 会报 Invalid URL */
export function normalizeAppOrigin(origin?: string | null) {
  const trimmed = origin?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const withoutTrailingSlash = trimmed.replace(/\/$/, "");
  if (/^https?:\/\//i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }
  return `https://${withoutTrailingSlash}`;
}

/** Vercel 预览部署域名；函数自己 fetch 自己时会触发 508 Infinite loop detected */
export function isVercelPreviewDeploymentOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname.endsWith(".vercel.app") &&
      (hostname.includes("-projects.vercel.app") ||
        /^.+-[a-z0-9]+-[a-z0-9-]+-projects\.vercel\.app$/i.test(hostname))
    );
  } catch {
    return false;
  }
}

/**
 * 内部续跑/触发必须用稳定生产域名（Partner 里配置的 App URL），
 * 不能用当前请求的预览 URL（*.vercel.app 带 hash 的地址）。
 */
export function getStableTriggerOrigins(requestOrigin?: string) {
  const stable = [
    normalizeAppOrigin(process.env.SHOPIFY_APP_URL),
    normalizeAppOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  ].filter((value): value is string => Boolean(value));

  const unique = [...new Set(stable)];
  if (unique.length > 0) {
    return unique;
  }

  const request = normalizeAppOrigin(requestOrigin);
  if (request && !isVercelPreviewDeploymentOrigin(request)) {
    return [request];
  }

  const vercelUrl = normalizeAppOrigin(
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
  );
  if (vercelUrl && !isVercelPreviewDeploymentOrigin(vercelUrl)) {
    return [vercelUrl];
  }

  return [];
}

export function resolveAppOrigin(requestOrigin?: string) {
  const candidates = getStableTriggerOrigins(requestOrigin);
  return candidates[0] ?? "";
}

/** 独立 Serverless 调用，避免与 POST /app.data 共用 300s 上限。 */
export type TriggerJobResult = { ok: true } | { ok: false; error: string };

async function postRunEndpoint(
  origin: string,
  secret: string,
  jobId: string,
  shop: string,
  continuation: boolean,
): Promise<TriggerJobResult> {
  let url: URL;
  try {
    url = new URL("/api/translation/run", origin);
  } catch {
    return { ok: false, error: `无效的应用地址: ${origin}` };
  }
  if (continuation) {
    url.searchParams.set("continuation", "1");
  }

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
        "x-internal-translation-job": "1",
      },
      body: JSON.stringify({ jobId, shop }),
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = await response.text();
    return {
      ok: false,
      error: `HTTP ${response.status} ${url.href}: ${body.slice(0, 200)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${url.href}: ${message}` };
  }
}

export async function triggerTranslationJobRun(
  appOrigin: string,
  jobId: string,
  shop: string,
  options?: { continuation?: boolean },
): Promise<TriggerJobResult> {
  try {
    const secret = getInternalJobSecret();
    if (!secret) {
      const error =
        "未配置 INTERNAL_JOB_SECRET 或 SHOPIFY_API_SECRET，无法触发后台任务";
      console.error(`[job-trigger] ${error}`);
      return { ok: false, error };
    }

    const origins = getStableTriggerOrigins(appOrigin);
    if (origins.length === 0) {
      const error =
        "无法解析应用 URL。请在 Vercel 设置 SHOPIFY_APP_URL=https://multilingual-app-six.vercel.app（不要用预览域名）";
      console.error(`[job-trigger] ${error}`);
      return { ok: false, error };
    }

    const continuation = options?.continuation === true;
    if (continuation) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    let lastError = "未知错误";

    for (const origin of origins) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await postRunEndpoint(
          origin,
          secret,
          jobId,
          shop,
          continuation,
        );
        if (result.ok) {
          return result;
        }
        lastError = result.error;
        if (result.error.includes("508")) {
          lastError = `${result.error}（Vercel 禁止函数反复调用自己；请确认 SHOPIFY_APP_URL 为正式域名，并用手动「继续本任务」）`;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    console.error(`[job-trigger] 触发失败: ${lastError}`);
    return { ok: false, error: lastError };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[job-trigger] 未捕获异常: ${message}`);
    return { ok: false, error: message };
  }
}

export function parseResumeState(
  raw: string | null | undefined,
): TranslationJobResumeState | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as TranslationJobResumeState;
  } catch {
    return null;
  }
}

export function serializeResumeState(state: TranslationJobResumeState) {
  return JSON.stringify(state);
}
