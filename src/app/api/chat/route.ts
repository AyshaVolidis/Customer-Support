// POST /api/chat - a thin wrapper around handleMessage.
// Parse, call src/lib, serialise. No business logic here.

import { handleMessage } from '@/lib/agent';
import { parseChatRequest } from '@/lib/chatRequest';
import { gateMessage } from '@/lib/gates';
import { logInfo } from '@/lib/logger';

export const maxDuration = 30;

// NOTE: `export const dynamic = 'force-dynamic'` is intentionally absent.
// next.config.ts sets cacheComponents: true, and Next 16 refuses to build with
// both ("Route segment config \"dynamic\" is not compatible with
// nextConfig.cacheComponents"). A POST handler is never cached anyway, so the
// export would have been a no-op. To get it back, drop cacheComponents.

/** Every 4xx and 5xx body has this one shape. */
function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400);
  }

  const parsed = parseChatRequest(body);
  if (!parsed.ok) {
    return errorResponse(parsed.error, 400);
  }

  const { sessionId, message } = parsed.data;

  // G9 again, only to choose the HTTP status. handleMessage runs it too and
  // answers 200 with a normal reply; over HTTP an unusable request is a 400.
  // gateMessage is pure, so calling it twice costs nothing.
  const usable = gateMessage(message, sessionId);
  if (!usable.ok) {
    return errorResponse(usable.userMessage, 400);
  }

  try {
    const response = await handleMessage(sessionId, message);
    return Response.json(response);
  } catch (error: unknown) {
    // Details stay on the server. logInfo redacts anything key-shaped.
    logInfo('POST /api/chat failed', {
      sessionId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return errorResponse('Something went wrong. Please try again.', 500);
  }
}
