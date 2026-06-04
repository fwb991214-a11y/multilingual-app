import type { LoaderFunctionArgs } from "react-router";
import {
  getStableTriggerOrigins,
  triggerTranslationJobRun,
} from "../lib/job-trigger.server";
import { listJobsNeedingContinuation } from "../models/translation.server";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

/**
 * Vercel Cron 入口（外部调度，不会触发 508 自调用检测）。
 * 在 Vercel 环境变量设置 CRON_SECRET；部署后于 Vercel → Cron Jobs 启用。
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const jobs = await listJobsNeedingContinuation(5);
  const origins = getStableTriggerOrigins();
  const appOrigin = origins[0] ?? "";

  if (!appOrigin) {
    return Response.json(
      { ok: false, error: "缺少 SHOPIFY_APP_URL，无法续跑" },
      { status: 500 },
    );
  }

  const started: string[] = [];
  const failed: string[] = [];

  for (const job of jobs) {
    if (process.env.VERCEL === "1" || process.env.VERCEL === "true") {
      const trigger = await triggerTranslationJobRun(appOrigin, job.id, job.shop, {
        continuation: true,
      });
      if (trigger.ok) {
        started.push(job.id);
      } else {
        failed.push(`${job.id}: ${trigger.error}`);
      }
    }
  }

  return Response.json({
    ok: true,
    pending: jobs.length,
    started: started.length,
    failed: failed.length,
    details: { started, failed: failed.slice(0, 3) },
  });
}
