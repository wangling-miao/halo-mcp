import coreWorker from "./index";

interface Env {
  HALO_BASE_URL: string;
  HALO_PAT: string;
  MCP_GATEWAY_KEY: string;
  HALO_TIMEOUT_MS?: string;
  MCP_ALLOWED_ORIGINS?: string;
}

const HOTFIX_VERSION = "3.0.2";

function baseUrl(env: Env): string {
  return (env.HALO_BASE_URL || "").trim().replace(/\/+$/, "");
}

function haloHeaders(env: Env): Headers {
  return new Headers({
    Authorization: `Bearer ${(env.HALO_PAT || "").trim()}`,
    Accept: "application/json, */*",
  });
}

async function getPublishedState(env: Env, name: string): Promise<boolean> {
  const response = await fetch(
    `${baseUrl(env)}/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`,
    { headers: haloHeaders(env) },
  );
  if (!response.ok) return false;
  const post = (await response.json()) as any;
  return Boolean(post?.spec?.publish);
}

async function republish(env: Env, name: string): Promise<void> {
  const response = await fetch(
    `${baseUrl(env)}/apis/uc.api.content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/publish`,
    {
      method: "PUT",
      headers: haloHeaders(env),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Halo republish failed: ${response.status} ${text.slice(0, 2000)}`);
  }
}

function updateArticleCall(payload: any): { name: string; args: Record<string, any> } | null {
  if (!payload || Array.isArray(payload) || payload?.method !== "tools/call") return null;
  if (payload?.params?.name !== "halo_update_article") return null;
  const args = payload?.params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (typeof args.name !== "string" || !args.name.trim()) return null;
  if (Object.prototype.hasOwnProperty.call(args, "publish")) return null;
  return { name: args.name.trim(), args };
}

function toolSucceeded(body: any): boolean {
  return Boolean(body?.result) && body.result.isError !== true;
}

function markRepublished(body: any): any {
  const result = body?.result;
  if (!result || typeof result !== "object") return body;

  const structured = result.structuredContent;
  if (structured && typeof structured === "object") {
    const fields = Array.isArray(structured.changed_fields) ? structured.changed_fields : [];
    if (!fields.includes("republished")) fields.push("republished");
    structured.changed_fields = fields;
    structured.message = `${structured.message || "Article updated."} Published article automatically republished.`;
    result.structuredContent = structured;
    result.content = [{ type: "text", text: JSON.stringify(structured) }];
  }
  return body;
}

function republishFailure(body: any, message: string): any {
  if (!body?.result || typeof body.result !== "object") return body;
  delete body.result.structuredContent;
  body.result.isError = true;
  body.result.content = [{ type: "text", text: message }];
  return body;
}

async function withHotfix(request: Request, env: Env): Promise<Response> {
  let payload: any = null;
  if (request.method === "POST") {
    try {
      payload = await request.clone().json();
    } catch {
      // Let the core worker return the normal JSON-RPC parse error.
    }
  }

  const target = updateArticleCall(payload);
  const wasPublished = target ? await getPublishedState(env, target.name) : false;

  const response = await coreWorker.fetch(request, env);
  if (!target || !wasPublished || !response.ok) return response;

  let body: any;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!toolSucceeded(body)) return response;

  try {
    await republish(env, target.name);
    body = markRepublished(body);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    body = republishFailure(
      body,
      `Article content was saved, but automatic republish failed. Open Halo admin and publish the article manually. ${message}`,
    );
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Halo-MCP-Version", HOTFIX_VERSION);
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withHotfix(request, env);
  },
};
