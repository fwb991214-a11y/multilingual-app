import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Multilingual Translator</h1>
        <p className={styles.text}>
          基于 Shopify Translation API 的批量翻译应用，不依赖 Translate &amp;
          Adapt 插件字数限制。
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              店铺域名
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
              />
            </label>
            <button className={styles.button} type="submit">
              登录
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>读取</strong> 通过 translatableResources 拉取可翻译内容
          </li>
          <li>
            <strong>翻译</strong> 支持 Mock / OpenAI / DeepL
          </li>
          <li>
            <strong>上传</strong> 通过 translationsRegister 写回 Shopify
          </li>
        </ul>
      </div>
    </div>
  );
}
