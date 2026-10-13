// Shape check for the POST /api/chat body.
//
// SHAPE ONLY. Whether the message is empty or too long is gate G9, inside
// handleMessage - not here. This file just answers "is this a chat request?".

import { z } from 'zod';

const ChatRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export type ParseChatRequestResult =
  | { ok: true; data: ChatRequest }
  | { ok: false; error: string };

/** Turn Zod's issues into one short sentence a client can act on. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

/** Validate an unknown request body. Never throws. */
export function parseChatRequest(body: unknown): ParseChatRequestResult {
  const parsed = ChatRequestSchema.safeParse(body);

  if (!parsed.success) {
    return { ok: false, error: describeIssues(parsed.error) };
  }

  return { ok: true, data: parsed.data };
}
