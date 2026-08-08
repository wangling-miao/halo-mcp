import { marked } from "marked";
import { pinyin } from "pinyin-pro";

interface Env {
  HALO_BASE_URL: string;
  HALO_PAT: string;
  MCP_GATEWAY_KEY: string;
  HALO_TIMEOUT_MS?: string;
  MCP_ALLOWED_ORIGINS?: string;
}

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
};

class ToolError extends Error {}

const SERVER_INFO = {
  name: "halo-mcp-cloudflare-worker",
  title: "Halo CRUD MCP",
  version: "3.0.1",
};

const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MODERN_PROTOCOL = "2026-07-28";

const INSTRUCTIONS =
  "Manage Halo tags, categories, and articles through exactly 12 CRUD tools. " +
  "Query tools can list resources or fetch one resource by metadata.name. " +
  "Article deletion moves a post to the recycle bin by default; permanent deletion requires explicit confirmation.";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: false,
};

const UPDATE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: true,
  destructiveHint: true,
  idempotentHint: true,
};

const stringOrNull = { anyOf: [{ type: "string" }, { type: "null" }] };
const boolOrNull = { anyOf: [{ type: "boolean" }, { type: "null" }] };
const integerOrNull = { anyOf: [{ type: "integer" }, { type: "null" }] };
const objectOrNull = { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] };

const taxonomySummarySchema = {
  type: "object",
  properties: {
    name: stringOrNull,
    display_name: stringOrNull,
    slug: stringOrNull,
    permalink: stringOrNull,
    post_count: integerOrNull,
    spec: { type: "object", additionalProperties: true },
  },
  required: ["name", "display_name", "slug", "permalink", "post_count", "spec"],
  additionalProperties: true,
};

const postSummarySchema = {
  type: "object",
  properties: {
    name: stringOrNull,
    title: stringOrNull,
    slug: stringOrNull,
    published: { type: "boolean" },
    status: { type: "string", enum: ["PUBLISHED", "DRAFT"] },
    visible: stringOrNull,
    pinned: boolOrNull,
    priority: integerOrNull,
    categories: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    publish_time: stringOrNull,
    creation_timestamp: stringOrNull,
    url: stringOrNull,
  },
  required: [
    "name",
    "title",
    "slug",
    "published",
    "status",
    "visible",
    "pinned",
    "priority",
    "categories",
    "tags",
    "publish_time",
    "creation_timestamp",
    "url",
  ],
  additionalProperties: true,
};

const mutationResultSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    operation: { type: "string" },
    resource: { type: "string" },
    name: stringOrNull,
    message: { type: "string" },
    item: objectOrNull,
  },
  required: ["ok", "operation", "resource", "name", "message", "item"],
  additionalProperties: true,
};

const taxonomyQueryOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    resource: { type: "string" },
    mode: { type: "string", enum: ["single", "list"] },
    page: integerOrNull,
    size: integerOrNull,
    keyword: stringOrNull,
    total: integerOrNull,
    count: { type: "integer" },
    item: objectOrNull,
    items: { type: "array", items: taxonomySummarySchema },
  },
  required: ["ok", "resource", "mode", "page", "size", "keyword", "total", "count", "item", "items"],
  additionalProperties: true,
};

const articleQueryOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    resource: { type: "string", enum: ["article"] },
    mode: { type: "string", enum: ["single", "list"] },
    page: integerOrNull,
    size: integerOrNull,
    keyword: stringOrNull,
    publish_status: stringOrNull,
    total: integerOrNull,
    count: { type: "integer" },
    item: objectOrNull,
    items: { type: "array", items: postSummarySchema },
    markdown: stringOrNull,
    html: stringOrNull,
    raw_type: stringOrNull,
  },
  required: [
    "ok",
    "resource",
    "mode",
    "page",
    "size",
    "keyword",
    "publish_status",
    "total",
    "count",
    "item",
    "items",
    "markdown",
    "html",
    "raw_type",
  ],
  additionalProperties: true,
};

const tagFieldsSchema = {
  display_name: { type: "string", minLength: 1, description: "Tag display name" },
  slug: { type: "string", description: "Optional tag slug. When omitted on create, Chinese display_name is converted to lowercase pinyin joined with hyphens." },
  color: { type: "string", description: "Optional tag color supported by Halo themes/UI" },
  cover: { type: "string", description: "Optional cover image URL" },
};

const categoryFieldsSchema = {
  display_name: { type: "string", minLength: 1, description: "Category display name" },
  slug: { type: "string", description: "Optional category slug. When omitted on create, Chinese display_name is converted to lowercase pinyin joined with hyphens." },
  description: { type: "string", description: "Optional category description" },
  cover: { type: "string", description: "Optional cover image URL" },
  template: { type: "string", description: "Optional Halo theme template" },
  priority: { type: "integer", minimum: 0, description: "Category priority/order" },
  children: { type: "array", items: { type: "string" }, description: "Child category metadata.name values" },
};

const articleFieldsSchema = {
  title: { type: "string", minLength: 1, description: "Article title" },
  markdown: { type: "string", description: "Article body in Markdown" },
  slug: { type: "string", description: "Article URL slug" },
  excerpt: { type: "string", description: "Article excerpt. Empty string restores automatic excerpt generation." },
  categories: {
    type: "array",
    items: { type: "string" },
    description: "Category metadata.name, display name, or slug. Values must already exist.",
  },
  tags: {
    type: "array",
    items: { type: "string" },
    description: "Tag metadata.name, display name, or slug. Values must already exist.",
  },
  cover: { type: "string", description: "Optional cover image URL; empty string clears it" },
  allow_comment: { type: "boolean" },
  pinned: { type: "boolean" },
  visible: { type: "string", enum: ["PUBLIC", "INTERNAL", "PRIVATE"] },
  priority: { type: "integer", minimum: 0 },
};

const TOOLS = [
  // Tags: C / R / U / D
  {
    name: "halo_create_tag",
    title: "Create Halo tag",
    description: "Create one Halo article tag.",
    inputSchema: {
      type: "object",
      properties: tagFieldsSchema,
      required: ["display_name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: CREATE_ANNOTATIONS,
  },
  {
    name: "halo_query_tags",
    title: "Query Halo tags",
    description: "Fetch one Halo tag by metadata.name, or list/search tags when name is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact Halo metadata.name. When set, returns a single tag." },
        keyword: { type: "string", description: "Optional local filter over metadata.name, displayName, and slug." },
        page: { type: "integer", minimum: 0, default: 0 },
        size: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
    outputSchema: taxonomyQueryOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "halo_update_tag",
    title: "Update Halo tag",
    description: "Partially update one existing Halo tag. Only supplied fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Tag metadata.name" },
        ...tagFieldsSchema,
      },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: UPDATE_ANNOTATIONS,
  },
  {
    name: "halo_delete_tag",
    title: "Delete Halo tag",
    description: "Permanently delete one Halo tag by metadata.name. Halo will remove its associations from posts.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, description: "Tag metadata.name" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: DELETE_ANNOTATIONS,
  },

  // Categories: C / R / U / D
  {
    name: "halo_create_category",
    title: "Create Halo category",
    description: "Create one Halo article category.",
    inputSchema: {
      type: "object",
      properties: categoryFieldsSchema,
      required: ["display_name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: CREATE_ANNOTATIONS,
  },
  {
    name: "halo_query_categories",
    title: "Query Halo categories",
    description: "Fetch one Halo category by metadata.name, or list/search categories when name is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact Halo metadata.name. When set, returns a single category." },
        keyword: { type: "string", description: "Optional local filter over metadata.name, displayName, and slug." },
        page: { type: "integer", minimum: 0, default: 0 },
        size: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
    outputSchema: taxonomyQueryOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "halo_update_category",
    title: "Update Halo category",
    description: "Partially update one existing Halo category. Only supplied fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Category metadata.name" },
        ...categoryFieldsSchema,
      },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: UPDATE_ANNOTATIONS,
  },
  {
    name: "halo_delete_category",
    title: "Delete Halo category",
    description: "Permanently delete one Halo category by metadata.name. Halo will remove its associations from posts.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, description: "Category metadata.name" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: DELETE_ANNOTATIONS,
  },

  // Articles: C / R / U / D
  {
    name: "halo_create_article",
    title: "Create Halo article",
    description: "Create a Halo article from Markdown. Existing categories/tags can be referenced by name/displayName/slug. Publishes by default.",
    inputSchema: {
      type: "object",
      properties: {
        ...articleFieldsSchema,
        publish: { type: "boolean", default: true, description: "Publish immediately. false creates a draft." },
      },
      required: ["title", "markdown"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: CREATE_ANNOTATIONS,
  },
  {
    name: "halo_query_articles",
    title: "Query Halo articles",
    description: "Fetch one owned Halo article with Markdown by metadata.name, or list/search owned articles when name is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact article metadata.name. When set, returns article metadata and draft content." },
        keyword: { type: "string", description: "Optional Halo keyword filter when listing" },
        publish_status: { type: "string", enum: ["ANY", "PUBLISHED", "DRAFT"], default: "ANY" },
        page: { type: "integer", minimum: 0, default: 0 },
        size: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        include_html: { type: "boolean", default: false, description: "When querying one article, also return rendered HTML." },
      },
      additionalProperties: false,
    },
    outputSchema: articleQueryOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "halo_update_article",
    title: "Update Halo article",
    description: "Partially update article metadata and/or Markdown. Optionally publish or unpublish after updating.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Article metadata.name" },
        ...articleFieldsSchema,
        publish: { type: "boolean", description: "Optional desired publish state after the update." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: UPDATE_ANNOTATIONS,
  },
  {
    name: "halo_delete_article",
    title: "Delete Halo article",
    description: "Delete an owned article. By default it is moved to Halo's recycle bin. Permanent deletion requires permanent=true and confirm_permanent=true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Article metadata.name" },
        permanent: { type: "boolean", default: false, description: "false: recycle; true: permanently delete the Post resource" },
        confirm_permanent: { type: "boolean", default: false, description: "Must be true together with permanent=true" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: mutationResultSchema,
    annotations: DELETE_ANNOTATIONS,
  },
] as const;

function baseUrl(env: Env): string {
  const value = (env.HALO_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!value) throw new ToolError("HALO_BASE_URL is not configured");
  return value;
}

function requirePat(env: Env): string {
  const value = (env.HALO_PAT || "").trim();
  if (!value) throw new ToolError("HALO_PAT is not configured as a Cloudflare Worker secret");
  return value;
}

function timeoutMs(env: Env): number {
  const parsed = Number.parseInt(env.HALO_TIMEOUT_MS || "30000", 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 30000;
}

function buildHaloHeaders(env: Env): Headers {
  return new Headers({
    Authorization: `Bearer ${requirePat(env)}`,
    Accept: "application/json, */*",
    "Content-Type": "application/json",
    "User-Agent": `halo-mcp-cloudflare-worker/${SERVER_INFO.version}`,
  });
}

async function haloRequest(
  env: Env,
  method: string,
  path: string,
  options: { params?: Record<string, unknown>; jsonBody?: unknown } = {},
): Promise<any> {
  const url = new URL(`${baseUrl(env)}${path}`);
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Halo API timeout"), timeoutMs(env));
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: buildHaloHeaders(env),
      body: options.jsonBody === undefined ? undefined : JSON.stringify(options.jsonBody),
      redirect: "follow",
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ToolError(`Halo API error ${response.status} ${method} ${path}: ${text.slice(0, 4000)}`);
    }
    if (!text.trim()) return { status_code: response.status };
    try {
      return JSON.parse(text);
    } catch {
      return { status_code: response.status, text };
    }
  } catch (error: any) {
    if (error?.name === "AbortError") throw new ToolError(`Halo API request timed out after ${timeoutMs(env)} ms: ${method} ${path}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function asciiSlugFromTitle(title: string): string {
  const normalized = title.normalize("NFKD");
  return normalized
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function timestampSlug(prefix = "item"): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function makeSlug(title: string, slug?: string | null, prefix = "item"): string {
  let value = slug?.trim() ? slug.trim().toLowerCase() : asciiSlugFromTitle(title);
  value = value.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) value = timestampSlug(prefix);
  return value.slice(0, 100) || timestampSlug(prefix);
}

function pinyinSlugFromTitle(title: string): string {
  const syllables = pinyin(title, { toneType: "none", type: "array" }) as string[];
  const value = syllables
    .join("-")
    .toLowerCase()
    .replace(/ü/g, "v")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value;
}

function makeTaxonomySlug(displayName: string, slug?: string | null, prefix = "item"): string {
  if (slug?.trim()) return makeSlug(displayName, slug, prefix);
  const value = pinyinSlugFromTitle(displayName);
  return (value || timestampSlug(prefix)).slice(0, 100);
}

function taxonomyGenerateName(slug: string, fallback: string): string {
  // Halo metadata.generateName is a prefix. Keep room for Halo's generated suffix and always end in '-'.
  const base = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || fallback;
  return `${base}-`;
}

function renderMarkdown(markdown: string): string {
  return String(marked.parse(markdown, { gfm: true, breaks: false, async: false }));
}

function publicPostUrl(env: Env, slug: string): string {
  return `${baseUrl(env)}/archives/${slug}`;
}

function extractListItems(data: any): any[] {
  if (Array.isArray(data)) return data.filter((v) => v && typeof v === "object");
  if (data && typeof data === "object") {
    for (const key of ["items", "content", "data"]) {
      if (Array.isArray(data[key])) return data[key].filter((v: any) => v && typeof v === "object");
    }
  }
  return [];
}

function resourceDisplayName(resource: any): string | null {
  const spec = resource?.spec || {};
  const metadata = resource?.metadata || {};
  return spec.displayName ?? spec.display_name ?? spec.name ?? spec.title ?? metadata.name ?? null;
}

function resourceSlug(resource: any): string | null {
  return resource?.spec?.slug ?? null;
}

function summarizeTaxonomyItem(item: any): Record<string, any> {
  const metadata = item?.metadata || {};
  const spec = item?.spec || {};
  const status = item?.status || {};
  return {
    name: metadata.name ?? null,
    display_name: resourceDisplayName(item),
    slug: resourceSlug(item),
    permalink: status.permalink ?? status.url ?? null,
    post_count: status.postCount ?? item?.postCount ?? status.post_count ?? null,
    spec: { ...spec },
  };
}

function summarizePostItem(env: Env, item: any): Record<string, any> {
  const post = item && typeof item === "object" && item.post && typeof item.post === "object" ? item.post : item;
  const metadata = post?.metadata || {};
  const spec = post?.spec || {};
  const slug = spec.slug ?? null;
  const published = Boolean(spec.publish);
  return {
    name: metadata.name ?? null,
    title: spec.title ?? null,
    slug,
    published,
    status: published ? "PUBLISHED" : "DRAFT",
    visible: spec.visible ?? null,
    pinned: spec.pinned ?? null,
    priority: spec.priority ?? null,
    categories: Array.isArray(spec.categories) ? spec.categories : [],
    tags: Array.isArray(spec.tags) ? spec.tags : [],
    publish_time: spec.publishTime ?? spec.publish_time ?? null,
    creation_timestamp: metadata.creationTimestamp ?? null,
    url: slug ? publicPostUrl(env, String(slug)) : null,
  };
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, "");
}

function taxonomyEndpoint(kind: "categories" | "tags"): string {
  return `/apis/content.halo.run/v1alpha1/${kind}`;
}

async function getTaxonomyRaw(env: Env, kind: "categories" | "tags", name: string): Promise<Record<string, any>> {
  const data = await haloRequest(env, "GET", `${taxonomyEndpoint(kind)}/${encodeURIComponent(name)}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ToolError(`Halo returned an invalid ${kind.slice(0, -1)} object`);
  return data;
}

async function queryTaxonomy(
  env: Env,
  kind: "categories" | "tags",
  args: { name?: string | null; keyword?: string | null; page: number; size: number },
): Promise<Record<string, any>> {
  if (args.name) {
    const raw = await getTaxonomyRaw(env, kind, args.name);
    return {
      ok: true,
      resource: kind === "tags" ? "tag" : "category",
      mode: "single",
      page: null,
      size: null,
      keyword: null,
      total: null,
      count: 1,
      item: summarizeTaxonomyItem(raw),
      items: [],
    };
  }

  const data = await haloRequest(env, "GET", taxonomyEndpoint(kind), { params: { page: args.page, size: args.size } });
  let items = extractListItems(data).map(summarizeTaxonomyItem);
  if (args.keyword) {
    const q = normalizeLookupValue(args.keyword);
    items = items.filter((item) => [item.name, item.display_name, item.slug].some((v) => v && normalizeLookupValue(String(v)).includes(q)));
  }
  return {
    ok: true,
    resource: kind === "tags" ? "tag" : "category",
    mode: "list",
    page: args.page,
    size: args.size,
    keyword: args.keyword ?? null,
    total: data && typeof data === "object" ? data.total ?? null : null,
    count: items.length,
    item: null,
    items,
  };
}

function cleanResourceForUpdate(resource: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: { ...(resource.metadata || {}) },
    spec: { ...(resource.spec || {}) },
  };
  if (!payload.apiVersion || !payload.kind || !payload.metadata?.name) {
    throw new ToolError("Halo resource is missing apiVersion/kind/metadata.name and cannot be safely updated");
  }
  return payload;
}

function buildTagPayload(displayName: string, slug?: string | null, color?: string | null, cover?: string | null): Record<string, any> {
  const resolvedSlug = makeTaxonomySlug(displayName, slug, "tag");
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "Tag",
    metadata: { generateName: taxonomyGenerateName(resolvedSlug, "tag") },
    spec: {
      displayName,
      slug: resolvedSlug,
      color: color ?? "",
      cover: cover ?? "",
    },
  };
}

function buildCategoryPayload(args: {
  displayName: string;
  slug?: string | null;
  description?: string | null;
  cover?: string | null;
  template?: string | null;
  priority?: number | null;
  children?: string[] | null;
}): Record<string, any> {
  const resolvedSlug = makeTaxonomySlug(args.displayName, args.slug, "category");
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "Category",
    metadata: { generateName: taxonomyGenerateName(resolvedSlug, "category") },
    spec: {
      displayName: args.displayName,
      slug: resolvedSlug,
      description: args.description ?? "",
      cover: args.cover ?? "",
      template: args.template ?? "",
      priority: args.priority ?? 0,
      children: args.children ?? [],
    },
  };
}

async function createTaxonomyItem(env: Env, kind: "categories" | "tags", payload: Record<string, any>): Promise<Record<string, any>> {
  const created = await haloRequest(env, "POST", taxonomyEndpoint(kind), { jsonBody: payload });
  if (!created || typeof created !== "object" || Array.isArray(created)) throw new ToolError(`Halo returned an unexpected response after creating ${kind}`);
  return created;
}

async function updateTaxonomyItem(
  env: Env,
  kind: "categories" | "tags",
  name: string,
  apply: (payload: Record<string, any>) => void,
): Promise<Record<string, any>> {
  const current = await getTaxonomyRaw(env, kind, name);
  const payload = cleanResourceForUpdate(current);
  apply(payload);
  const updated = await haloRequest(env, "PUT", `${taxonomyEndpoint(kind)}/${encodeURIComponent(name)}`, { jsonBody: payload });
  if (!updated || typeof updated !== "object" || Array.isArray(updated)) throw new ToolError(`Halo returned an unexpected response after updating ${kind.slice(0, -1)}`);
  return updated;
}

async function deleteTaxonomyItem(env: Env, kind: "categories" | "tags", name: string): Promise<any> {
  return haloRequest(env, "DELETE", `${taxonomyEndpoint(kind)}/${encodeURIComponent(name)}`);
}

async function resolveTaxonomyNames(env: Env, kind: "categories" | "tags", values: unknown): Promise<string[]> {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ToolError(`${kind} must be an array of strings`);
  const cleaned = [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (!cleaned.length) return [];

  const data = await haloRequest(env, "GET", taxonomyEndpoint(kind), { params: { page: 0, size: 200 } });
  const known = extractListItems(data).map(summarizeTaxonomyItem);
  const byExactName = new Map<string, Record<string, any>>();
  const byNormalized = new Map<string, Record<string, any>>();
  for (const item of known) {
    if (item.name) byExactName.set(String(item.name), item);
    for (const candidate of [item.name, item.display_name, item.slug]) {
      if (candidate) byNormalized.set(normalizeLookupValue(String(candidate)), item);
    }
  }

  const names: string[] = [];
  for (const requested of cleaned) {
    const matched = byExactName.get(requested) || byNormalized.get(normalizeLookupValue(requested));
    if (!matched?.name) {
      throw new ToolError(
        `Halo ${kind.slice(0, -1)} not found: ${JSON.stringify(requested)}. ` +
          `Create it first with halo_create_${kind === "tags" ? "tag" : "category"}, or pass an existing metadata.name/displayName/slug.`,
      );
    }
    names.push(String(matched.name));
  }
  return [...new Set(names)];
}

function buildPostPayload(args: {
  title: string;
  markdown: string;
  slug: string;
  excerpt?: string | null;
  categories?: string[] | null;
  tags?: string[] | null;
  cover?: string | null;
  allowComment: boolean;
  pinned: boolean;
  visible: string;
  priority: number;
}): Record<string, any> {
  const contentJson = {
    raw: args.markdown,
    content: renderMarkdown(args.markdown),
    rawType: "markdown",
  };

  const spec: Record<string, any> = {
    title: args.title,
    slug: args.slug,
    allowComment: args.allowComment,
    deleted: false,
    publish: false,
    pinned: args.pinned,
    priority: args.priority,
    visible: args.visible,
    excerpt: {
      autoGenerate: !Boolean(args.excerpt?.trim()),
      raw: args.excerpt || "",
    },
    categories: args.categories || [],
    tags: args.tags || [],
  };
  if (args.cover !== undefined && args.cover !== null) spec.cover = args.cover;

  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "Post",
    metadata: {
      generateName: "post-",
      annotations: {
        "content.halo.run/content-json": JSON.stringify(contentJson),
      },
    },
    spec,
  };
}

function extractPostName(post: any): string {
  const name = post?.metadata?.name;
  if (!name) throw new ToolError(`Halo did not return metadata.name after creating post: ${JSON.stringify(post).slice(0, 1000)}`);
  return String(name);
}

function findContentJson(node: any): Record<string, any> | null {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findContentJson(value);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;

  const metadata = node.metadata || {};
  const annotations = metadata.annotations || node.annotations || {};
  const rawAnnotation = annotations["content.halo.run/content-json"];
  if (typeof rawAnnotation === "string" && rawAnnotation.trim()) {
    try {
      const parsed = JSON.parse(rawAnnotation);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return { raw: rawAnnotation, content: null, rawType: "unknown" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(node, "raw") && Object.prototype.hasOwnProperty.call(node, "content")) {
    return { raw: node.raw ?? null, content: node.content ?? null, rawType: node.rawType ?? node.raw_type ?? null };
  }

  for (const value of Object.values(node)) {
    const found = findContentJson(value);
    if (found) return found;
  }
  return null;
}

async function getOwnedPost(env: Env, name: string): Promise<Record<string, any>> {
  const data = await haloRequest(env, "GET", `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ToolError("Halo returned an invalid post object");
  return data;
}

async function getOwnedPostDraft(env: Env, name: string): Promise<Record<string, any>> {
  const data = await haloRequest(env, "GET", `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/draft`, {
    params: { patched: true },
  });
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ToolError("Halo returned an invalid draft snapshot");
  return data;
}

async function listPostsImpl(
  env: Env,
  args: { page: number; size: number; keyword?: string | null; publishStatus: "ANY" | "PUBLISHED" | "DRAFT" },
): Promise<Record<string, any>> {
  const data = await haloRequest(env, "GET", "/apis/uc.api.content.halo.run/v1alpha1/posts", {
    params: { page: args.page, size: args.size, keyword: args.keyword || undefined },
  });
  const items = data && typeof data === "object" && Array.isArray(data.items) ? data.items : [];
  let posts = items.map((item: any) => summarizePostItem(env, item));
  if (args.publishStatus === "PUBLISHED") posts = posts.filter((post: any) => post.published === true);
  if (args.publishStatus === "DRAFT") posts = posts.filter((post: any) => post.published === false);
  return {
    ok: true,
    resource: "article",
    mode: "list",
    page: args.page,
    size: args.size,
    keyword: args.keyword ?? null,
    publish_status: args.publishStatus,
    total: data && typeof data === "object" ? data.total ?? null : null,
    count: posts.length,
    item: null,
    items: posts,
    markdown: null,
    html: null,
    raw_type: null,
  };
}

async function querySingleArticle(env: Env, name: string, includeHtml: boolean): Promise<Record<string, any>> {
  const [post, draft] = await Promise.all([getOwnedPost(env, name), getOwnedPostDraft(env, name)]);
  const content = findContentJson(draft) || findContentJson(post) || {};
  const summary = summarizePostItem(env, post);
  return {
    ok: true,
    resource: "article",
    mode: "single",
    page: null,
    size: null,
    keyword: null,
    publish_status: summary.status,
    total: null,
    count: 1,
    item: { ...summary, raw: post },
    items: [],
    markdown: typeof content.raw === "string" ? content.raw : null,
    html: includeHtml && typeof content.content === "string" ? content.content : null,
    raw_type: content.rawType ?? content.raw_type ?? null,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

async function updateArticle(env: Env, name: string, args: Record<string, any>): Promise<Record<string, any>> {
  const current = await getOwnedPost(env, name);
  const payload = cleanResourceForUpdate(current);
  const spec = payload.spec;
  const changed: string[] = [];

  if (Object.prototype.hasOwnProperty.call(args, "title")) {
    spec.title = stringArg(args.title, "title", true)!;
    changed.push("title");
  }
  if (Object.prototype.hasOwnProperty.call(args, "slug")) {
    const slug = stringArg(args.slug, "slug", true)!;
    spec.slug = makeSlug(spec.title || "article", slug, "post");
    changed.push("slug");
  }
  if (Object.prototype.hasOwnProperty.call(args, "excerpt")) {
    const excerpt = stringArg(args.excerpt, "excerpt") ?? "";
    spec.excerpt = { autoGenerate: !Boolean(excerpt.trim()), raw: excerpt };
    changed.push("excerpt");
  }
  if (Object.prototype.hasOwnProperty.call(args, "categories")) {
    spec.categories = await resolveTaxonomyNames(env, "categories", args.categories);
    changed.push("categories");
  }
  if (Object.prototype.hasOwnProperty.call(args, "tags")) {
    spec.tags = await resolveTaxonomyNames(env, "tags", args.tags);
    changed.push("tags");
  }
  if (Object.prototype.hasOwnProperty.call(args, "cover")) {
    spec.cover = stringArg(args.cover, "cover") ?? "";
    changed.push("cover");
  }
  if (Object.prototype.hasOwnProperty.call(args, "allow_comment")) {
    spec.allowComment = boolArg(args.allow_comment, true);
    changed.push("allow_comment");
  }
  if (Object.prototype.hasOwnProperty.call(args, "pinned")) {
    spec.pinned = boolArg(args.pinned, false);
    changed.push("pinned");
  }
  if (Object.prototype.hasOwnProperty.call(args, "visible")) {
    const visible = stringArg(args.visible, "visible", true)!;
    if (!["PUBLIC", "INTERNAL", "PRIVATE"].includes(visible)) throw new ToolError("visible must be PUBLIC, INTERNAL, or PRIVATE");
    spec.visible = visible;
    changed.push("visible");
  }
  if (Object.prototype.hasOwnProperty.call(args, "priority")) {
    spec.priority = intArg(args.priority, 0, 0, Number.MAX_SAFE_INTEGER);
    changed.push("priority");
  }

  let updatedPost = current;
  if (changed.length > 0) {
    updatedPost = await haloRequest(env, "PUT", `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`, {
      jsonBody: payload,
    });
  }

  if (Object.prototype.hasOwnProperty.call(args, "markdown")) {
    const markdown = stringArg(args.markdown, "markdown") ?? "";
    const draft = cloneJson(await getOwnedPostDraft(env, name));
    draft.metadata = { ...(draft.metadata || {}) };
    draft.metadata.annotations = { ...(draft.metadata.annotations || {}) };
    draft.metadata.annotations["content.halo.run/content-json"] = JSON.stringify({
      raw: markdown,
      content: renderMarkdown(markdown),
      rawType: "markdown",
    });
    await haloRequest(env, "PUT", `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/draft`, {
      jsonBody: draft,
    });
    changed.push("markdown");
  }

  if (Object.prototype.hasOwnProperty.call(args, "publish")) {
    const publish = boolArg(args.publish, false);
    const publishPath = publish ? "publish" : "unpublish";
    updatedPost = await haloRequest(env, "PUT", `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/${publishPath}`);
    changed.push(publish ? "published" : "unpublished");
  }

  if (changed.length === 0) throw new ToolError("No fields were supplied to update");

  return {
    ok: true,
    operation: "update",
    resource: "article",
    name,
    message: `Article updated: ${changed.join(", ")}.`,
    item: summarizePostItem(env, updatedPost),
    changed_fields: changed,
  };
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw new ToolError(`Expected an integer, got ${JSON.stringify(value)}`);
  const n = Number(value);
  if (n < min || n > max) throw new ToolError(`Integer must be between ${min} and ${max}, got ${n}`);
  return n;
}

function boolArg(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ToolError(`Expected a boolean, got ${JSON.stringify(value)}`);
  return value;
}

function stringArg(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new ToolError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new ToolError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ToolError(`${field} cannot be empty`);
  return trimmed;
}

function stringArrayArg(value: unknown, field: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ToolError(`${field} must be an array of strings`);
  const result = value.map((v) => {
    if (typeof v !== "string") throw new ToolError(`${field} must contain only strings`);
    return v.trim();
  }).filter(Boolean);
  return [...new Set(result)];
}

function taxonomyMutationResult(operation: string, resource: "tag" | "category", raw: any, message: string, fallbackName?: string): Record<string, any> {
  const item = raw && typeof raw === "object" && !Array.isArray(raw) && raw.metadata ? summarizeTaxonomyItem(raw) : null;
  return {
    ok: true,
    operation,
    resource,
    name: item?.name ?? fallbackName ?? null,
    message,
    item,
  };
}

async function callTool(env: Env, name: string, args: Record<string, any>): Promise<Record<string, any>> {
  switch (name) {
    case "halo_create_tag": {
      const displayName = stringArg(args.display_name, "display_name", true)!;
      const slug = stringArg(args.slug, "slug");
      const color = stringArg(args.color, "color");
      const cover = stringArg(args.cover, "cover");
      const created = await createTaxonomyItem(env, "tags", buildTagPayload(displayName, slug, color, cover));
      return taxonomyMutationResult("create", "tag", created, "Tag created.");
    }
    case "halo_query_tags": {
      return queryTaxonomy(env, "tags", {
        name: stringArg(args.name, "name"),
        keyword: stringArg(args.keyword, "keyword"),
        page: intArg(args.page, 0, 0, Number.MAX_SAFE_INTEGER),
        size: intArg(args.size, 100, 1, 200),
      });
    }
    case "halo_update_tag": {
      const tagName = stringArg(args.name, "name", true)!;
      const hasChanges = ["display_name", "slug", "color", "cover"].some((key) => Object.prototype.hasOwnProperty.call(args, key));
      if (!hasChanges) throw new ToolError("No tag fields were supplied to update");
      const updated = await updateTaxonomyItem(env, "tags", tagName, (payload) => {
        const spec = payload.spec;
        if (Object.prototype.hasOwnProperty.call(args, "display_name")) spec.displayName = stringArg(args.display_name, "display_name", true)!;
        if (Object.prototype.hasOwnProperty.call(args, "slug")) spec.slug = makeSlug(spec.displayName || tagName, stringArg(args.slug, "slug", true), "tag");
        if (Object.prototype.hasOwnProperty.call(args, "color")) spec.color = stringArg(args.color, "color") ?? "";
        if (Object.prototype.hasOwnProperty.call(args, "cover")) spec.cover = stringArg(args.cover, "cover") ?? "";
      });
      return taxonomyMutationResult("update", "tag", updated, "Tag updated.", tagName);
    }
    case "halo_delete_tag": {
      const tagName = stringArg(args.name, "name", true)!;
      const deleted = await deleteTaxonomyItem(env, "tags", tagName);
      return taxonomyMutationResult("delete", "tag", deleted, "Tag permanently deleted.", tagName);
    }

    case "halo_create_category": {
      const displayName = stringArg(args.display_name, "display_name", true)!;
      const children = stringArrayArg(args.children, "children");
      const created = await createTaxonomyItem(env, "categories", buildCategoryPayload({
        displayName,
        slug: stringArg(args.slug, "slug"),
        description: stringArg(args.description, "description"),
        cover: stringArg(args.cover, "cover"),
        template: stringArg(args.template, "template"),
        priority: Object.prototype.hasOwnProperty.call(args, "priority") ? intArg(args.priority, 0, 0, Number.MAX_SAFE_INTEGER) : null,
        children,
      }));
      return taxonomyMutationResult("create", "category", created, "Category created.");
    }
    case "halo_query_categories": {
      return queryTaxonomy(env, "categories", {
        name: stringArg(args.name, "name"),
        keyword: stringArg(args.keyword, "keyword"),
        page: intArg(args.page, 0, 0, Number.MAX_SAFE_INTEGER),
        size: intArg(args.size, 100, 1, 200),
      });
    }
    case "halo_update_category": {
      const categoryName = stringArg(args.name, "name", true)!;
      const hasChanges = ["display_name", "slug", "description", "cover", "template", "priority", "children"].some((key) => Object.prototype.hasOwnProperty.call(args, key));
      if (!hasChanges) throw new ToolError("No category fields were supplied to update");
      const updated = await updateTaxonomyItem(env, "categories", categoryName, (payload) => {
        const spec = payload.spec;
        if (Object.prototype.hasOwnProperty.call(args, "display_name")) spec.displayName = stringArg(args.display_name, "display_name", true)!;
        if (Object.prototype.hasOwnProperty.call(args, "slug")) spec.slug = makeSlug(spec.displayName || categoryName, stringArg(args.slug, "slug", true), "category");
        if (Object.prototype.hasOwnProperty.call(args, "description")) spec.description = stringArg(args.description, "description") ?? "";
        if (Object.prototype.hasOwnProperty.call(args, "cover")) spec.cover = stringArg(args.cover, "cover") ?? "";
        if (Object.prototype.hasOwnProperty.call(args, "template")) spec.template = stringArg(args.template, "template") ?? "";
        if (Object.prototype.hasOwnProperty.call(args, "priority")) spec.priority = intArg(args.priority, 0, 0, Number.MAX_SAFE_INTEGER);
        if (Object.prototype.hasOwnProperty.call(args, "children")) spec.children = stringArrayArg(args.children, "children") ?? [];
      });
      return taxonomyMutationResult("update", "category", updated, "Category updated.", categoryName);
    }
    case "halo_delete_category": {
      const categoryName = stringArg(args.name, "name", true)!;
      const deleted = await deleteTaxonomyItem(env, "categories", categoryName);
      return taxonomyMutationResult("delete", "category", deleted, "Category permanently deleted.", categoryName);
    }

    case "halo_create_article": {
      const title = stringArg(args.title, "title", true)!;
      const markdown = stringArg(args.markdown, "markdown") ?? "";
      const slug = makeSlug(title, stringArg(args.slug, "slug"), "post");
      const excerpt = stringArg(args.excerpt, "excerpt");
      const cover = stringArg(args.cover, "cover");
      const categories = Object.prototype.hasOwnProperty.call(args, "categories") ? await resolveTaxonomyNames(env, "categories", args.categories) : [];
      const tags = Object.prototype.hasOwnProperty.call(args, "tags") ? await resolveTaxonomyNames(env, "tags", args.tags) : [];
      const allowComment = boolArg(args.allow_comment, true);
      const pinned = boolArg(args.pinned, false);
      const visible = stringArg(args.visible, "visible") ?? "PUBLIC";
      if (!["PUBLIC", "INTERNAL", "PRIVATE"].includes(visible)) throw new ToolError("visible must be PUBLIC, INTERNAL, or PRIVATE");
      const priority = intArg(args.priority, 0, 0, Number.MAX_SAFE_INTEGER);
      const publish = boolArg(args.publish, true);

      const payload = buildPostPayload({
        title,
        markdown,
        slug,
        excerpt,
        categories,
        tags,
        cover,
        allowComment,
        pinned,
        visible,
        priority,
      });
      let created = await haloRequest(env, "POST", "/apis/uc.api.content.halo.run/v1alpha1/posts", { jsonBody: payload });
      const postName = extractPostName(created);
      if (publish) created = await haloRequest(env, "PUT", `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(postName)}/publish`);
      return {
        ok: true,
        operation: "create",
        resource: "article",
        name: postName,
        message: publish ? "Article created and published." : "Article draft created.",
        item: summarizePostItem(env, created),
        url: publicPostUrl(env, slug),
      };
    }
    case "halo_query_articles": {
      const articleName = stringArg(args.name, "name");
      if (articleName) return querySingleArticle(env, articleName, boolArg(args.include_html, false));
      const publishStatus = args.publish_status ?? "ANY";
      if (!["ANY", "PUBLISHED", "DRAFT"].includes(publishStatus)) throw new ToolError("publish_status must be ANY, PUBLISHED, or DRAFT");
      return listPostsImpl(env, {
        page: intArg(args.page, 0, 0, Number.MAX_SAFE_INTEGER),
        size: intArg(args.size, 10, 1, 50),
        keyword: stringArg(args.keyword, "keyword"),
        publishStatus,
      });
    }
    case "halo_update_article": {
      const articleName = stringArg(args.name, "name", true)!;
      return updateArticle(env, articleName, args);
    }
    case "halo_delete_article": {
      const articleName = stringArg(args.name, "name", true)!;
      const permanent = boolArg(args.permanent, false);
      const confirmPermanent = boolArg(args.confirm_permanent, false);
      if (permanent && !confirmPermanent) {
        throw new ToolError("Permanent deletion requires confirm_permanent=true. Omit permanent or set permanent=false to move the article to the recycle bin.");
      }
      const path = permanent
        ? `/apis/content.halo.run/v1alpha1/posts/${encodeURIComponent(articleName)}`
        : `/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(articleName)}/recycle`;
      const deleted = await haloRequest(env, "DELETE", path);
      const item = deleted && typeof deleted === "object" && deleted.metadata ? summarizePostItem(env, deleted) : null;
      return {
        ok: true,
        operation: "delete",
        resource: "article",
        name: articleName,
        message: permanent ? "Article permanently deleted." : "Article moved to recycle bin.",
        item,
        permanent,
      };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function protocolFromRequest(httpRequest: Request, rpc: JsonRpcRequest): string | null {
  const header = httpRequest.headers.get("MCP-Protocol-Version");
  if (header) return header;
  const meta = rpc.params?._meta;
  const modern = meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof modern === "string") return modern;
  const init = rpc.method === "initialize" ? rpc.params?.protocolVersion : undefined;
  return typeof init === "string" ? init : null;
}

function isModernRequest(httpRequest: Request, rpc: JsonRpcRequest): boolean {
  return protocolFromRequest(httpRequest, rpc) === MODERN_PROTOCOL;
}

function modernResult(result: Record<string, any>, modern: boolean, options: { cacheable?: boolean } = {}): Record<string, any> {
  if (!modern) return result;
  const withMeta: Record<string, any> = {
    resultType: "complete",
    ...result,
    _meta: {
      ...(result._meta || {}),
      "io.modelcontextprotocol/serverInfo": SERVER_INFO,
    },
  };
  if (options.cacheable) {
    withMeta.ttlMs = 300000;
    withMeta.cacheScope = "private";
  }
  return withMeta;
}

async function handleRpc(httpRequest: Request, env: Env, rpc: JsonRpcRequest): Promise<Record<string, any> | null> {
  if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return rpcError(rpc?.id, -32600, "Invalid Request");
  }

  const isNotification = rpc.id === undefined;
  if (isNotification) return null;

  const modern = isModernRequest(httpRequest, rpc);

  switch (rpc.method) {
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: modernResult(
          {
            supportedVersions: [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
          true,
          { cacheable: true },
        ),
      };
    case "initialize": {
      const requested = typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "";
      const negotiated = LEGACY_PROTOCOLS.includes(requested) ? requested : LEGACY_PROTOCOLS[0];
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: rpc.id, result: modernResult({}, modern) };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: modernResult({ tools: TOOLS }, modern, { cacheable: true }),
      };
    case "tools/call": {
      const toolName = rpc.params?.name;
      const args = rpc.params?.arguments;
      if (typeof toolName !== "string") return rpcError(rpc.id, -32602, "Invalid params: params.name must be a string");
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
        return rpcError(rpc.id, -32602, "Invalid params: params.arguments must be an object");
      }
      try {
        const data = await callTool(env, toolName, (args || {}) as Record<string, any>);
        const result = {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
          isError: false,
        };
        return { jsonrpc: "2.0", id: rpc.id, result: modernResult(result, modern) };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        const result = {
          content: [{ type: "text", text: message }],
          isError: true,
        };
        return { jsonrpc: "2.0", id: rpc.id, result: modernResult(result, modern) };
      }
    }
    default:
      return rpcError(rpc.id, -32601, "Method not found");
  }
}

function allowedOrigins(env: Env): Set<string> {
  const raw = env.MCP_ALLOWED_ORIGINS || "https://chatgpt.com,https://chat.openai.com";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name");
  headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version");
  return headers;
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).has(origin);
}

function secureEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function isAuthorizedMcpPath(url: URL, env: Env): boolean {
  const key = (env.MCP_GATEWAY_KEY || "").trim();
  if (!key) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "mcp") return false;
  let supplied: string;
  try {
    supplied = decodeURIComponent(parts[1]);
  } catch {
    return false;
  }
  return secureEqual(supplied, key);
}

function jsonResponse(request: Request, env: Env, body: unknown, status = 200): Response {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  if (!originAllowed(request, env)) return jsonResponse(request, env, rpcError(undefined, -32000, "Origin not allowed"), 403);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method === "GET" || request.method === "DELETE") {
    const headers = corsHeaders(request, env);
    headers.set("Allow", "POST, GET, DELETE, OPTIONS");
    return new Response(null, { status: 405, headers });
  }
  if (request.method !== "POST") {
    const headers = corsHeaders(request, env);
    headers.set("Allow", "POST, GET, DELETE, OPTIONS");
    return new Response(null, { status: 405, headers });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(request, env, rpcError(undefined, -32700, "Parse error"), 400);
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) return jsonResponse(request, env, rpcError(undefined, -32600, "Invalid Request"), 400);
    const responses = (await Promise.all(payload.map((item) => handleRpc(request, env, item)))).filter(Boolean);
    if (!responses.length) return new Response(null, { status: 202, headers: corsHeaders(request, env) });
    return jsonResponse(request, env, responses);
  }

  const response = await handleRpc(request, env, payload);
  if (response === null) return new Response(null, { status: 202, headers: corsHeaders(request, env) });
  return jsonResponse(request, env, response);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse(request, env, {
        ok: true,
        service: SERVER_INFO.name,
        version: SERVER_INFO.version,
        tool_count: TOOLS.length,
        halo_base_url: env.HALO_BASE_URL || null,
        halo_pat_configured: Boolean((env.HALO_PAT || "").trim()),
        gateway_key_configured: Boolean((env.MCP_GATEWAY_KEY || "").trim()),
        mcp_endpoint: "/mcp/<MCP_GATEWAY_KEY>",
      });
    }

    if (url.pathname === "/") {
      return jsonResponse(request, env, {
        service: SERVER_INFO.title,
        ok: true,
        version: SERVER_INFO.version,
        tool_count: TOOLS.length,
        health: "/health",
        mcp_endpoint: "/mcp/<secret>",
      });
    }

    if (url.pathname.startsWith("/mcp/")) {
      if (!isAuthorizedMcpPath(url, env)) return new Response("Not Found", { status: 404 });
      return handleMcpRequest(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};
