import type { TranslationJobResumeState } from "../services/translation/types";

export function getInternalJobSecret() {
  return (
    process.env.INTERNAL_JOB_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    ""
  );
}

function collectOriginCandidates(requestOrigin?: string) {
  const candidates = [
    requestOrigin?.replace(/\/$/, ""),
    process.env.SHOPIFY_APP_URL?.replace(/\/$/, ""),
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.replace(/\/$/, ""),
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
  ].filter((value): value is string => Boolean(value?.trim()));

  return [...new Set(candidates)];
}

export function resolveAppOrigin(requestOrigin?: string) {
  const candidates = collectOriginCandidates(requestOrigin);
  return candidates[0] ?? "";
}

/** 独立 Serverless 调用，避免与 POST /app.data 共用 300s 上限。 */
export type TriggerJobResult = { ok: true } | { ok: false; error: string };

async function postRunEndpoint(
  origin: string,
  pathname: string,
  secret: string,
  jobId: string,
  shop: string,
  continuation: boolean,
): Promise<TriggerJobResult> {
  const url = new URL(pathname, origin);
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
      },
      body: JSON.stringify({ jobId, shop }),
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = await response.text();
    return {
      ok: false,
      error: `HTTP ${response.status} ${url.href}: ${body.slice(0, 160)}`,
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
  const secret = getInternalJobSecret();
  if (!secret) {
    const error =
      "未配置 INTERNAL_JOB_SECRET 或 SHOPIFY_API_SECRET，无法触发后台任务";
    console.error(`[job-trigger] ${error}`);
    return { ok: false, error };
  }

  const origins = collectOriginCandidates(appOrigin);
  if (origins.length === 0) {
    const error = "无法解析应用 URL（请设置 Vercel 环境变量 SHOPIFY_APP_URL）";
    console.error(`[job-trigger] ${error}`);
    return { ok: false, error };
  }

  const paths = ["/api/translation/run", "/api/translation/run.data"];
  const continuation = options?.continuation === true;
  let lastError = "未知错误";

  for (const origin of origins) {
    for (const pathname of paths) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await postRunEndpoint(
          origin,
          pathname,
          secret,
          jobId,
          shop,
          continuation,
        );
        if (result.ok) {
          return result;
        }
        lastError = result.error;
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
  }

  console.error(`[job-trigger] 触发失败: ${lastError}`);
  return { ok: false, error: lastError };
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
