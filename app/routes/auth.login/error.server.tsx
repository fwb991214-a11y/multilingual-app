import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "请输入店铺域名" };
  }
  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "请输入有效的店铺域名" };
  }
  return {};
}
