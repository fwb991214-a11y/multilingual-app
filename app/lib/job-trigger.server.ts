import type { TranslationJobResumeState } from "../services/translation/types";

export function getInternalJobSecret() {
  return (
    process.env.INTERNAL_JOB_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    ""
  );
}

/** 独立 Serverless 调用，避免与 POST /app.data 共用 300s 上限。 */
export function triggerTranslationJobRun(
  appOrigin: string,
  jobId: string,
  shop: string,
  options?: { continuation?: boolean },
) {
  const secret = getInternalJobSecret();
  if (!secret) {
    console.error(
      "[job-trigger] 未配置 INTERNAL_JOB_SECRET 或 SHOPIFY_API_SECRET，无法后台启动任务",
    );
    return;
  }

  const url = new URL("/api/translation/run", appOrigin);
  if (options?.continuation) {
    url.searchParams.set("continuation", "1");
  }

  void fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jobId, shop }),
  }).catch((error) => {
    console.error("[job-trigger] 触发翻译任务失败", error);
  });
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
