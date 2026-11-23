import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const MODEL_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);
const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

export async function askModel(text, { model = classify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([model(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseModelReply(raw) {
  if (typeof raw !== "string") return null;
  let reply;
  try {
    reply = JSON.parse(raw);
  } catch {
    return null;
  }
  if (reply === null || typeof reply !== "object") return null;
  const { topic, draft } = reply;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

async function handleTriage(request, response, log) {
  const text = await readText(request);
  if (text === null) return json(response, 400, INVALID_INPUT);

  let reply = null;
  try {
    reply = parseModelReply(await askModel(text));
    if (!reply) log("triage: manual_review, unusable model reply");
  } catch (error) {
    log(`triage: manual_review, ${error.message}`);
  }
  if (!reply) return json(response, 200, MANUAL_REVIEW);
  return json(response, 200, { status: "ready", ...reply });
}

export function createApp({ log = console.warn } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, log);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}
