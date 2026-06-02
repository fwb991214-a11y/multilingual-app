import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useLocation, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getTranslationJob,
  listTranslationJobs,
  serializeTranslationJob,
} from "../models/translation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedJobId = url.searchParams.get("job");

  const jobs = await listTranslationJobs(session.shop, 30);
  const selectedJob =
    selectedJobId != null
      ? await getTranslationJob(selectedJobId, session.shop)
      : jobs[0] ?? null;

  return {
    jobs: jobs.map(serializeTranslationJob),
    selectedJob: selectedJob
      ? serializeTranslationJob(selectedJob)
      : null,
  };
};

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
  const { jobs, selectedJob } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const location = useLocation();
  const baseSearchParams = new URLSearchParams(location.search);

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
                已译 {job.translatedItems} · 跳过 {job.skippedItems} · 失败{" "}
                {job.failedItems}
              </p>
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
            进度: {selectedJob.processedItems} / {selectedJob.totalItems || "?"}
          </p>
          <p>
            已翻译 {selectedJob.translatedItems} · 跳过 {selectedJob.skippedItems}{" "}
            · 失败 {selectedJob.failedItems}
          </p>
          {selectedJob.errorMessage && (
            <div className="banner-error">{selectedJob.errorMessage}</div>
          )}

          <h2 style={{ marginTop: 16 }}>日志</h2>
          {selectedJob.logs.length === 0 ? (
            <p>暂无日志</p>
          ) : (
            <div className="log-box">{selectedJob.logs.join("\n")}</div>
          )}
        </div>
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
