import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/client.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_FROM = process.env.RESEND_FROM;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_123";
  process.env.RESEND_FROM = "Reverb <noreply@reverb.test>";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_FROM === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = ORIGINAL_FROM;
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  it("posts to Resend with the bearer token, body, and idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendEmail({
      to: "vincent@example.com",
      subject: "Lesson ready",
      html: "<p>hi</p>",
      text: "hi",
      idempotencyKey: "notif-42",
    });

    expect(result).toEqual({ ok: true, messageId: "msg_abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.resend.com/emails");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("notif-42");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "Reverb <noreply@reverb.test>",
      to: "vincent@example.com",
      subject: "Lesson ready",
      html: "<p>hi</p>",
      text: "hi",
    });
  });

  it("returns ok=false with the response body when Resend rejects the call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`{"name":"validation_error","message":"bad email"}`, {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendEmail({
      to: "not-an-email",
      subject: "x",
      html: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error).toContain("bad email");
    }
  });

  it("returns ok=false when the network call throws", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("connection reset"))) as unknown as typeof fetch;

    const result = await sendEmail({
      to: "vincent@example.com",
      subject: "x",
      html: "x",
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("connection reset");
      expect(result.status).toBeNull();
    }
  });
});
