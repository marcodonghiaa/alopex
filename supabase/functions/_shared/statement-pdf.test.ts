import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  geminiRefusal,
  geminiRequest,
  MAX_PDF_BASE64,
  parseGeminiRows,
  parseStatementRequest,
  statementAttemptRefusal,
  statementReply,
} from "./statement-pdf.ts";

Deno.test("a request needs a base64 PDF within the size limit", () => {
  assertEquals(parseStatementRequest({ pdf: "JVBERi0xLjQK" }), { pdf: "JVBERi0xLjQK" });
  assertEquals(typeof parseStatementRequest({}), "string");
  assertEquals(typeof parseStatementRequest({ pdf: "not base64!" }), "string");
  assertEquals(typeof parseStatementRequest({ pdf: "A".repeat(MAX_PDF_BASE64 + 4) }), "string");
});

Deno.test("Gemini gets the PDF inline and a fixed JSON schema", () => {
  const body = geminiRequest("JVBERi0xLjQK") as {
    contents: Array<{ parts: Array<Record<string, unknown>> }>;
    generationConfig: { responseMimeType: string; responseSchema: { items: { required: string[] } } };
  };
  const parts = body.contents[0]!.parts;
  assertEquals(parts[0], { inline_data: { mime_type: "application/pdf", data: "JVBERi0xLjQK" } });
  assertEquals(body.generationConfig.responseMimeType, "application/json");
  assertEquals(body.generationConfig.responseSchema.items.required, [
    "date",
    "description",
    "amount",
    "direction",
  ]);
});

const reply = (rows: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(rows) }] } }],
});

Deno.test("keeps only well-formed rows from Gemini's answer", () => {
  const rows = parseGeminiRows(
    reply([
      { date: "2026-04-25", description: " Ristorante  Mario ", amount: -45.5, direction: "DBIT" },
      { date: "2026-04-24", description: "Bonifico", amount: 5000, direction: "CRDT" },
      { date: "2026-02-31", description: "Bad day", amount: 1, direction: "DBIT" },
      { date: "2026-04-24", description: "", amount: 1, direction: "DBIT" },
      { date: "2026-04-24", description: "Zero", amount: 0, direction: "DBIT" },
      { date: "2026-04-24", description: "Bad direction", amount: 1, direction: "OUT" },
      "junk",
    ]),
  );
  assertEquals(rows, [
    { date: "2026-04-25", description: "Ristorante Mario", amount: 45.5, direction: "DBIT" },
    { date: "2026-04-24", description: "Bonifico", amount: 5000, direction: "CRDT" },
  ]);
});

Deno.test("an unreadable answer is no rows, not a crash", () => {
  assertEquals(parseGeminiRows({}), []);
  assertEquals(parseGeminiRows({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), []);
  assertEquals(parseGeminiRows(reply({ not: "an array" })), []);
});

// H065: a cut-off or blocked answer read as "No transactions found in this PDF".
Deno.test("a cut-off or blocked answer is reported, a finished one is not", () => {
  const done = (finishReason?: string) => ({ candidates: [{ finishReason, content: { parts: [{ text: "[" }] } }] });
  assertEquals(geminiRefusal(done("STOP")), null);
  assertEquals(geminiRefusal(done(undefined)), null);
  assertEquals(geminiRefusal(done("MAX_TOKENS"))?.includes("too long"), true);
  assertEquals(typeof geminiRefusal(done("SAFETY")), "string");
  assertEquals(typeof geminiRefusal({ promptFeedback: { blockReason: "OTHER" } }), "string");
});

// H241: each PDF read claims an attempt first, so one user can't loop PDFs into the Gemini quota.
Deno.test("10 statement reads per 10 minutes per user, claimed before Gemini is asked", async () => {
  const calls: unknown[] = [];
  const rpc = (answer: { data: unknown; error: unknown }) => (fn: string, args: Record<string, unknown>) => {
    calls.push([fn, args]);
    return Promise.resolve(answer);
  };
  assertEquals(await statementAttemptRefusal(rpc({ data: true, error: null }), "u1"), null);
  assertEquals(calls, [["splitwise_attempt", { p_user: "u1", p_kind: "statement", p_max: 10, p_window: "10 minutes" }]]);
  assertEquals(await statementAttemptRefusal(rpc({ data: false, error: null }), "u1"), {
    status: 429,
    error: "Too many PDF imports. Wait 10 minutes and try again.",
  });
  // The check itself failed: don't call Gemini unchecked.
  assertEquals(await statementAttemptRefusal(rpc({ data: null, error: { code: "42883" } }), "u1"), {
    status: 503,
    error: "Couldn't start the PDF import right now. Try again later.",
  });
});

// H235: a 200 from Gemini whose body isn't JSON (an HTML error page, or a body cut off by the
// timeout) threw past the handler, so the browser saw a CORS error instead of a message.
Deno.test("Gemini's 200 answer becomes the reply: rows, a refusal, or 502 when it can't be read", async () => {
  const ok = (body: string) => new Response(body, { status: 200 });
  const answer = (text: string, finishReason = "STOP") => JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
  const row = { date: "2026-11-02", description: "Shop", amount: 12.5, direction: "DBIT" };
  assertEquals(await statementReply(ok(answer(JSON.stringify([row])))), { body: { rows: [row] }, status: 200 });
  assertEquals((await statementReply(ok(answer("[]", "MAX_TOKENS")))).status, 422);
  assertEquals(await statementReply(ok("<html>busy</html>")), { body: { error: "The AI sent an answer that couldn't be read, try again" }, status: 502 });
  const cut = new Response(new ReadableStream({ start: (c) => c.error(new Error("aborted")) }), { status: 200 });
  assertEquals((await statementReply(cut)).status, 502);
});
