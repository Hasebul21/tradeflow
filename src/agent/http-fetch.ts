// A fetch for the OpenAI client built on node:http and node:https, with no header or body timeout of its own.
// Node's built-in fetch (undici) stops waiting for response headers, and between body chunks, after 300 s, whatever
// timeout the SDK is given: in the 23 Oct live run every model attempt that timed out stopped at about 301 s, so
// MODEL_TIMEOUT_CAP_MS (420 s) never applied. Here the SDK's timeout and the caller's AbortSignal decide alone.
// Server only. It covers what the SDK sends for a chat completion: a string or URL, a method, headers, a string or
// byte body, and a signal. No keep-alive: each request opens and closes its own connection.
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

/** Statuses whose Response must have no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** The error a spec-compliant fetch rejects with on abort; the SDK checks its name (isAbortError). */
function abortError(signal: AbortSignal): DOMException {
  const reason: unknown = signal.reason;
  const detail = reason instanceof Error && reason.message !== "" ? `: ${reason.message}` : "";
  return new DOMException(`The operation was aborted${detail}`, "AbortError");
}

/** The request body as bytes or a string; anything else (a stream, a form) is not needed by the SDK's JSON calls. */
function bodyOf(body: RequestInit["body"]): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError("httpFetch sends only a string or byte body.");
}

function headersOf(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i], raw[i + 1]);
    } catch {
      // A header name or value Headers refuses is dropped, as a browser would.
    }
  }
  return headers;
}

/** fetch(input, init) over node:http or node:https. Rejects with an AbortError on abort, or TypeError("fetch failed") with the socket error as cause. */
export function httpFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (typeof input !== "string" && !(input instanceof URL)) {
    return Promise.reject(new TypeError("httpFetch takes a URL or a string, not a Request."));
  }
  const url = new URL(String(input));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new TypeError(`httpFetch supports http and https only, not ${url.protocol}`));
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(abortError(signal));

  let body: string | Uint8Array | undefined;
  try {
    body = bodyOf(init.body);
  } catch (error) {
    return Promise.reject(error);
  }
  const headers = new Headers(init.headers);
  // Ask for no compression: this fetch does not decode it.
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(body)));
  const isHttps = url.protocol === "https:";

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let incoming: http.IncomingMessage | undefined;
    const request = (isHttps ? https : http).request(url, {
      method: (init.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(headers),
      agent: isHttps ? httpsAgent : httpAgent,
    });

    const onAbort = () => {
      const error = abortError(signal as AbortSignal);
      // A body still streaming ends with the same AbortError.
      incoming?.destroy(error);
      request.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);

    request.on("response", (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      incoming = response;
      const status = response.statusCode ?? 0;
      const empty = NO_BODY.has(status) || request.method === "HEAD";
      if (empty) response.resume();
      response.on("close", done);
      resolve(
        new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
          status,
          statusText: response.statusMessage ?? "",
          headers: headersOf(response.rawHeaders),
        }),
      );
    });
    request.on("error", (error) => {
      done();
      if (settled) return;
      settled = true;
      reject(signal?.aborted ? abortError(signal) : new TypeError("fetch failed", { cause: error }));
    });
    request.end(body);
  });
}
