import type { HeadersFunction } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const config = { runtime: "nodejs" } as const;

export default function App() {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
