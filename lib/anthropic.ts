import { env } from "./env.js";

/** Minimal Anthropic Messages API client via fetch — no npm dependency. */

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface MessagesResponse {
  content: ContentBlock[];
  stop_reason: string;
}

export async function createMessage(opts: {
  model: string;
  max_tokens: number;
  system?: string;
  tools?: ToolDef[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  messages: MessageParam[];
}): Promise<MessagesResponse> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(opts),
    });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    lastErr = new Error(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr ?? new Error("Anthropic API failed");
}
