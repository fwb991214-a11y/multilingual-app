import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <Form method="post">
        <label>
          <span>店铺域名</span>
          <input
            type="text"
            name="shop"
            value={shop}
            onChange={(event) => setShop(event.currentTarget.value)}
            placeholder="your-store.myshopify.com"
          />
          {errors.shop && <p>{errors.shop}</p>}
        </label>
        <button type="submit">登录</button>
      </Form>
    </AppProvider>
  );
}
