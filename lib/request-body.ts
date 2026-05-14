const CONTENT_LENGTH_REQUIRED = "Content-Length header is required";
const INVALID_CONTENT_LENGTH = "Invalid Content-Length header";

export interface LimitedRequestTextResult {
  text?: string;
  error?: string;
  status?: number;
}

export async function readLimitedRequestText(
  request: Request,
  maxBytes: number,
  tooLargeMessage: string
): Promise<LimitedRequestTextResult> {
  const contentLength = request.headers.get("content-length");
  const trimmedContentLength = contentLength?.trim() ?? null;

  if (trimmedContentLength === "") {
    return { error: INVALID_CONTENT_LENGTH, status: 411 };
  }

  const declaredBytes = trimmedContentLength === null ? null : Number(trimmedContentLength);
  if (declaredBytes !== null && (!Number.isFinite(declaredBytes) || declaredBytes < 0)) {
    return { error: INVALID_CONTENT_LENGTH, status: 411 };
  }
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    return { error: tooLargeMessage, status: 413 };
  }

  if (!request.body) {
    return { text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (declaredBytes === null || declaredBytes === 0) {
      await reader.cancel();
      return { error: CONTENT_LENGTH_REQUIRED, status: 411 };
    }

    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      return { error: tooLargeMessage, status: 413 };
    }

    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(body) };
}
