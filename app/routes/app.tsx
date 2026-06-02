import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import appStyles from "../styles/app.css?url";

export const config = { runtime: "nodejs" } as const;

export const links = () => [{ rel: "stylesheet", href: appStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const location = useLocation();

  // Shopify embedded app 必须在路由跳转时保留 ?host=...&shop=... 等参数，否则 App Bridge 会失效导致白屏。
  const search = location.search || "";

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className="app-shell">
        <nav className="app-nav">
          <Link to={`/app${search}`}>批量翻译</Link>
          <Link to={`/app/jobs${search}`}>任务记录</Link>
          <Link to={`/app/settings${search}`}>翻译设置</Link>
        </nav>
        <Outlet />
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
