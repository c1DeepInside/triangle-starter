import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { askModel, createApp } from "../app.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
let server;
let baseUrl;

before(async () => {
  server = createApp({ log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function triage(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("invalid input returns 400", () => {
  const cases = {
    "missing text": {},
    "empty text": { text: "" },
    "whitespace only": { text: "   \n " },
    "number": { text: 42 },
    "null text": { text: null },
    "array body": [],
    "null body": null,
    "broken JSON": "{\"text\": ",
    "empty body": "",
  };
  for (const [name, body] of Object.entries(cases)) {
    test(name, async () => {
      assert.deepEqual(await triage(body), { status: 400, body: { status: "invalid_input" } });
    });
  }
});

describe("model failures go to manual review", () => {
  for (const tag of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(tag, async () => {
      assert.deepEqual(await triage({ text: `Где мой заказ? ${tag}` }), { status: 200, body: MANUAL_REVIEW });
    });
  }

  test("timeout answers within the 300 ms limit, not after the mock's 1200 ms", async () => {
    const started = performance.now();
    const { body } = await triage({ text: "Где доставка? [timeout]" });
    const elapsed = performance.now() - started;
    assert.deepEqual(body, MANUAL_REVIEW);
    assert.ok(elapsed < 800, `took ${Math.round(elapsed)} ms`);
  });

  test("a provider that ignores the abort signal is still cut off", async () => {
    const neverAnswers = () => new Promise(() => {});
    await assert.rejects(askModel("text", { model: neverAnswers, timeoutMs: 50 }), /timeout/);
  });
});

describe("valid replies are ready", () => {
  const cases = {
    delivery: "Когда будет доставка?",
    pricing: "Какая цена подписки?",
    other: "Добрый день, есть вопрос",
  };
  for (const [topic, text] of Object.entries(cases)) {
    test(topic, async () => {
      const { status, body } = await triage({ text });
      assert.equal(status, 200);
      assert.equal(body.status, "ready");
      assert.equal(body.topic, topic);
      assert.ok(body.draft.trim().length > 0);
    });
  }
});
