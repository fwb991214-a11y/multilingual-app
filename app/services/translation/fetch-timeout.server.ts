export const OPENAI_REQUEST_TIMEOUT_MS = 120_000;
export const DEEPL_REQUEST_TIMEOUT_MS = 60_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutLabel: string,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `${timeoutLabel} 请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或稍后重试`,
      );
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (
        msg.includes("fetch failed") ||
        msg.includes("network") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound")
      ) {
        throw new Error(
          `${timeoutLabel} 网络连接失败：${error.message}。请确认服务器能访问对应 API`,
        );
      }
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
