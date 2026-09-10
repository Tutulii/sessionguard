import { AgentAssessmentSchema, type AgentAssessment, type MarketEvent } from "../shared/types.js";

function cleanJson(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export async function assessWithQwen(
  event: MarketEvent,
  requestedNotional: number,
): Promise<AgentAssessment> {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error("Qwen is not configured");
  const baseUrl = process.env.QWEN_BASE_URL ?? "https://hackathon.bitgetops.com/v1";
  const model = process.env.QWEN_MODEL ?? "qwen3.8-max";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are SessionGuard's event analyst. Assess only the supplied official event. Return strict JSON with summary, novelty (NEW|UPDATE|STALE|UNCLEAR), effectiveAt (ISO timestamp), relevance (HIGH|MEDIUM|LOW), confidence (0..1), proposedAction (BUY|SELL|HOLD), proposedNotional (number), and evidence [{claim,sourceUrl}]. Never invent a source. Session permission is enforced separately by code.",
        },
        {
          role: "user",
          content: JSON.stringify({
            symbol: event.symbol,
            headline: event.headline,
            eventSummary: event.summary,
            sourceName: event.sourceName,
            sourceUrl: event.sourceUrl,
            publishedAt: event.publishedAt,
            requestedNotional,
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Qwen request failed (${response.status})`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Qwen returned no assessment");
  return AgentAssessmentSchema.parse(JSON.parse(cleanJson(content)));
}

export function unavailableAssessment(event: MarketEvent): AgentAssessment {
  return {
    summary: "The event could not be assessed by Qwen, so exposure cannot be authorized.",
    novelty: "UNCLEAR",
    effectiveAt: event.publishedAt,
    relevance: "LOW",
    confidence: 0,
    proposedAction: "HOLD",
    proposedNotional: 0,
    evidence: [{ claim: "Official event retained for review.", sourceUrl: event.sourceUrl }],
  };
}

