import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Link,
  useFetcher,
  useLoaderData,
  useLocation,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getOrCreateShopSettings,
  getTranslationJob,
  listTranslationJobs,
  serializeTranslationJob,
  toShopSettingsRecord,
} from "../models/translation.server";
import { triggerTranslationJobRun } from "../lib/job-trigger.server";
import { getProviderLabel } from "../services/translation/labels";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") !== "resume") {
    return { ok: false, error: "未知操作" };
  }

  const jobId = String(formData.get("jobId") || "").trim();
  if (!jobId) {
    return { ok: false, error: "缺少任务 ID" };
  }

  const origin = new URL(request.url).origin;
  const trigger = await triggerTranslationJobRun(origin, jobId, session.shop, {
    continuation: true,
  });

  if (!trigger.ok) {
    return { ok: false, error: `续跑失败：${trigger.error}` };
  }

  return { ok: true, message: "已触发继续运行，请稍候刷新查看进度" };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedJobId = url.searchParams.get("job");

  const [jobs, settingsRow] = await Promise.all([
    listTranslationJobs(session.shop, 30),
    getOrCreateShopSettings(session.shop),
  ]);
  const selectedJob =
    selectedJobId != null
      ? await getTranslationJob(selectedJobId, session.shop)
      : jobs[0] ?? null;

  const settings = toShopSettingsRecord(settingsRow);

  return {
    jobs: jobs.map(serializeTranslationJob),
    selectedJob: selectedJob
      ? serializeTranslationJob(selectedJob)
      : null,
    providerLabel: getProviderLabel(settings.provider),
    openaiModel: settings.openaiModel,
  };
};

function jobProgressPercent(job: {
  processedItems: number;
  totalItems: number;
}) {
  if (job.totalItems <= 0) {
    return null;
  }
  return Math.min(
    100,
    Math.round((job.processedItems / job.totalItems) * 100),
  );
}

function isActivityLogLine(line: string) {
  return line.includes("[当前] ");
}

function stripLogTimestamp(line: string) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
}

function getLatestErrorLine(logs: string[]) {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (isActivityLogLine(line)) {
      continue;
    }
    const plain = stripLogTimestamp(line);
    if (
      plain.includes("翻译失败") ||
      plain.includes("API 错误") ||
      plain.includes("请求超时") ||
      plain.includes("网络连接失败") ||
      plain.includes("资源处理失败") ||
      plain.includes("任务失败") ||
      plain.startsWith("✗")
    ) {
      return plain;
    }
  }
  return null;
}

function statusLabel(status: string) {
  switch (status) {
    case "pending":
      return "等待中";
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

export default function JobsPage() {
  const { jobs, selectedJob, providerLabel, openaiModel } =
    useLoaderData<typeof loader>();
  const resumeFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const location = useLocation();
  const baseSearchParams = new URLSearchParams(location.search);
  const latestError = selectedJob
    ? getLatestErrorLine(selectedJob.logs)
    : null;
  const activityIsError =
    selectedJob?.activityMessage?.startsWith("✗") ?? false;

  useEffect(() => {
    if (
      !selectedJob ||
      (selectedJob.status !== "pending" && selectedJob.status !== "running")
    ) {
      return;
    }

    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 4000);

    return () => clearInterval(interval);
  }, [selectedJob?.id, selectedJob?.status, revalidator]);

  return (
    <div>
      <h1 className="page-title">翻译任务</h1>

      <div className="section">
        <h2>任务列表</h2>
        {jobs.length === 0 ? (
          <p>暂无任务，请先在「批量翻译」页面创建任务。</p>
        ) : (
          jobs.map((job) => (
            <div key={job.id} className="job-card">
              <p>
                <Link
                  to={(() => {
                    const params = new URLSearchParams(baseSearchParams);
                    params.set("job", job.id);
                    return `/app/jobs?${params.toString()}`;
                  })()}
                >
                  {statusLabel(job.status)} ·{" "}
                  {new Date(job.createdAt).toLocaleString()}
                </Link>
              </p>
              <p>
                已译 {job.translatedItems} 字段 · 跳过 {job.skippedItems} · 失败{" "}
                {job.failedItems}
              </p>
              <p className="job-hint">
                「已译」是字段数（标题/描述等），不是商品件数；跳过含已有日文、过长或超时跳过。
              </p>
              {job.status === "running" && job.activityMessage && (
                <p className="job-activity">{job.activityMessage}</p>
              )}
              <p>语言: {job.targetLocales.join(", ")}</p>
            </div>
          ))
        )}
      </div>

      {selectedJob && (
        <div className="section">
          <h2>任务详情</h2>
          <p>状态: {statusLabel(selectedJob.status)}</p>
          <p>
            翻译引擎: {providerLabel}
            {providerLabel === "OpenAI" && openaiModel
              ? ` · 模型 ${openaiModel}`
              : ""}
          </p>

          {(selectedJob.status === "running" ||
            selectedJob.status === "pending") && (
            <>
              <p className="progress-explainer">
                按页从 Shopify 拉取资源并<strong>边扫描边翻译</strong>（不是先扫完全店再译）。
                进度在整批字段译完并上传后才增加，上传阶段不会误显示 100%。
              </p>
              {jobProgressPercent(selectedJob) != null && (
                <div className="progress-block">
                  <div className="progress-label">
                    字段处理进度 {selectedJob.processedItems} /{" "}
                    {selectedJob.totalItems}（{jobProgressPercent(selectedJob)}%）
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-valuenow={jobProgressPercent(selectedJob) ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="progress-fill"
                      style={{
                        width: `${jobProgressPercent(selectedJob)}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              {selectedJob.activityMessage && (
                <div
                  className={
                    activityIsError ? "activity-banner activity-error" : "activity-banner"
                  }
                >
                  <strong>{activityIsError ? "最近错误" : "当前步骤"}</strong>
                  <p>{selectedJob.activityMessage}</p>
                  <p className="activity-hint">
                    页面每约 4 秒自动刷新。调用 AI 时会显示字段、字数与文本预览；超时
                    （OpenAI 120 秒）或 API 错误会标 ✗ 并写入日志。
                  </p>
                </div>
              )}
              {(selectedJob.failedItems > 0 || latestError) && (
                <div className="banner-error">
                  {latestError ?? "部分字段翻译失败，请查看下方日志"}
                </div>
              )}
            </>
          )}

          <p>
            进度: {selectedJob.processedItems} / {selectedJob.totalItems || "?"}
          </p>
          <p>
            已翻译 {selectedJob.translatedItems} 个字段 · 跳过{" "}
            {selectedJob.skippedItems} · 失败 {selectedJob.failedItems}
          </p>
          <p className="job-hint">
            若商品很多但这里数字很小，可能是只跑完一批或续跑失败；请查看日志是否有「自动续跑」或「过长/超时跳过」。
          </p>
          {selectedJob.errorMessage && (
            <div className="banner-error">{selectedJob.errorMessage}</div>
          )}

          {resumeFetcher.data?.ok && (
            <div className="banner-success">{resumeFetcher.data.message}</div>
          )}
          {resumeFetcher.data?.error && (
            <div className="banner-error">{resumeFetcher.data.error}</div>
          )}

          {selectedJob.canResume && (
            <resumeFetcher.Form method="post" style={{ marginTop: 12 }}>
              <input type="hidden" name="intent" value="resume" />
              <input type="hidden" name="jobId" value={selectedJob.id} />
              <button
                type="submit"
                className="btn-primary"
                disabled={resumeFetcher.state !== "idle"}
              >
                {resumeFetcher.state !== "idle"
                  ? "正在触发续跑…"
                  : "继续本任务（从上次进度）"}
              </button>
            </resumeFetcher.Form>
          )}

          <h2 style={{ marginTop: 16 }}>日志</h2>
          {selectedJob.logs.filter((line) => !isActivityLogLine(line)).length ===
          0 ? (
            <p>暂无日志</p>
          ) : (
            <div className="log-box">
              {selectedJob.logs
                .filter((line) => !isActivityLogLine(line))
                .join("\n")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
