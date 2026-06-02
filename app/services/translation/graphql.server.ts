import type {
  AdminGraphqlClient,
  ExistingTranslation,
  ShopLocale,
  TranslatableContentItem,
  TranslatableResourceType,
  TranslationInputPayload,
} from "./types";

const TRANSLATABLE_RESOURCES_QUERY = `#graphql
  query TranslatableResources($resourceType: TranslatableResourceType!, $first: Int!, $after: String) {
    translatableResources(first: $first, after: $after, resourceType: $resourceType) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          resourceId
          translatableContent {
            key
            value
            digest
            locale
          }
        }
      }
    }
  }
`;

const TRANSLATABLE_RESOURCE_QUERY = `#graphql
  query TranslatableResource($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent {
        key
        value
        digest
        locale
      }
      translations(locale: $locale) {
        key
        value
        outdated
      }
    }
  }
`;

const REGISTER_TRANSLATIONS_MUTATION = `#graphql
  mutation TranslationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      userErrors {
        field
        message
      }
      translations {
        key
        locale
        value
      }
    }
  }
`;

const SHOP_LOCALES_QUERY = `#graphql
  query ShopLocales {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

async function parseGraphqlResponse<T>(response: Response): Promise<T> {
  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join("; "));
  }

  if (!json.data) {
    throw new Error("GraphQL 响应缺少 data 字段");
  }

  return json.data;
}

export async function fetchShopLocales(
  admin: AdminGraphqlClient,
): Promise<ShopLocale[]> {
  const response = await admin.graphql(SHOP_LOCALES_QUERY);
  const data = await parseGraphqlResponse<{
    shopLocales: ShopLocale[];
  }>(response);
  return data.shopLocales;
}

export async function fetchTranslatableResourcesPage(
  admin: AdminGraphqlClient,
  resourceType: TranslatableResourceType,
  cursor?: string | null,
  first = 25,
) {
  const response = await admin.graphql(TRANSLATABLE_RESOURCES_QUERY, {
    variables: {
      resourceType,
      first,
      after: cursor ?? null,
    },
  });

  const data = await parseGraphqlResponse<{
    translatableResources: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        node: {
          resourceId: string;
          translatableContent: TranslatableContentItem[];
        };
      }>;
    };
  }>(response);

  return data.translatableResources;
}

export async function fetchResourceWithTranslations(
  admin: AdminGraphqlClient,
  resourceId: string,
  locale: string,
) {
  const response = await admin.graphql(TRANSLATABLE_RESOURCE_QUERY, {
    variables: { resourceId, locale },
  });

  const data = await parseGraphqlResponse<{
    translatableResource: {
      resourceId: string;
      translatableContent: TranslatableContentItem[];
      translations: ExistingTranslation[];
    } | null;
  }>(response);

  return data.translatableResource;
}

export async function registerTranslations(
  admin: AdminGraphqlClient,
  resourceId: string,
  translations: TranslationInputPayload[],
) {
  if (translations.length === 0) {
    return { translations: [], userErrors: [] };
  }

  const response = await admin.graphql(REGISTER_TRANSLATIONS_MUTATION, {
    variables: { resourceId, translations },
  });

  const data = await parseGraphqlResponse<{
    translationsRegister: {
      userErrors: Array<{ field: string[] | null; message: string }>;
      translations: Array<{ key: string; locale: string; value: string }>;
    };
  }>(response);

  const result = data.translationsRegister;
  if (result.userErrors.length > 0) {
    throw new Error(
      result.userErrors.map((error) => error.message).join("; "),
    );
  }

  return result;
}

export async function registerTranslationsWithFallback(
  admin: AdminGraphqlClient,
  resourceId: string,
  translations: TranslationInputPayload[],
) {
  if (translations.length === 0) {
    return { succeeded: 0, failed: 0, errors: [] as string[] };
  }

  try {
    await registerTranslations(admin, resourceId, translations);
    return { succeeded: translations.length, failed: 0, errors: [] as string[] };
  } catch {
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const item of translations) {
      try {
        await registerTranslations(admin, resourceId, [item]);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        const message =
          error instanceof Error ? error.message : String(error);
        errors.push(`[${item.key}] ${message}`);
      }
    }

    return { succeeded, failed, errors };
  }
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
