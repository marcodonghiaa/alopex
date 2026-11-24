import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { classifyWithGemini } from "./gemini.ts";

const req = { prompt: "p", resultKey: "category", resultEnum: ["A", "B"], apiKey: "k", model: "m" };
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

Deno.test("returns the parsed JSON array from the first candidate", async () => {
  const text = JSON.stringify([{ entry_reference: "r1", category: "A" }]);
  const out = await classifyWithGemini(req, answer(200, { candidates: [{ content: { parts: [{ text }] } }] }));
  assertEquals(out, [{ entry_reference: "r1", category: "A" }]);
});

// protects=logs and errors never carry transaction text; fails_when=the API's body (which can
// echo the prompt) ends up in the thrown error
Deno.test("an API error carries only the status, never the body", async () => {
  const err = await assertRejects(() => classifyWithGemini(req, answer(503, { error: "echo of NETFLIX prompt" })));
  assertEquals([(err as Error).message, (err as { status: number }).status], ["Gemini API error 503", 503]);
});

Deno.test("an answer with no text is an error", async () => {
  const err = await assertRejects(() => classifyWithGemini(req, answer(200, { candidates: [] })));
  assertEquals((err as { code: string }).code, "GEMINI_EMPTY");
});

Deno.test("asks the model's generateContent with the key in a header, never in the URL", async () => {
  const seen: Request[] = [];
  const text = JSON.stringify([]);
  const fetchFn = ((input: string, init: RequestInit) => {
    seen.push(new Request(input, init));
    return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })));
  }) as unknown as typeof fetch;
  await classifyWithGemini(req, fetchFn);
  assertEquals(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent");
  assertEquals([seen[0].method, seen[0].headers.get("x-goog-api-key"), seen[0].headers.get("content-type")], ["POST", "k", "application/json"]);
  assertEquals((await seen[0].json()).contents, [{ parts: [{ text: "p" }] }]);
});
