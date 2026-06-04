import type { TranslationJobResumeState } from "../services/translation/types";

export function getInternalJobSecret() {
  return (
    process.env.INTERNAL_JOB_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    ""
  );
}

export function resolveAppOrigin(requestOrigin?: string) {
  const fromEnv =
    process.env.SHOPIFY_APP_URL?.replace(/\/$/, "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return requestOrigin || fromEnv;
}

/** 独立 Serverless 调用，避免与 POST /app.data 共用 300s 上限。 */
export async function triggerTranslationJobRun(
  appOrigin: string,
  jobId: string,
  shop: string,
  options?: { continuation?: boolean },
): Promise<boolean> {
  const secret = getInternalJobSecret();
  const origin = resolveAppOrigin(appOrigin);
  if (!secret) {
    console.error(
      "[job-trigger] 未配置 INTERNAL_JOB_SECRET 或 SHOPIFY_API_SECRET，无法后台启动任务",
    );
    return false;
  }
  if (!origin) {
    console.error("[job-trigger] 无法解析应用 URL，无法触发续跑");
    return false;
  }

  const url = new URL("/api/translation/run", origin);
  if (options?.continuation) {
    url.searchParams.set("continuation", "1");
  }

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ jobId, shop }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[job-trigger] HTTP ${response.status} ${url.pathname}: ${body.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error("[job-trigger] 触发翻译任务失败", error);
    return false;
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
