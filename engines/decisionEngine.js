import { callJSONLLM } from "../ai/llmClient.js";

export async function decideRoute({
  intent,
  confidence,
  risk,
  emailContext = {},
  intentMeta = {},
  riskMeta = {},
}) {
  const prompt = `
You are the Routing Manager for Puma Support.

Decide whether this case should be handled by AI or by a human agent.

Inputs:
- intent: ${intent}
- confidence: ${confidence}
- risk: ${risk}
- is_reply_in_thread: ${Boolean(emailContext.isReply)}
- latest_customer_message:
${(emailContext.latestMessageText || "").substring(0, 2000)}

Intent signals:
${JSON.stringify(intentMeta?.signals || {}, null, 2)}

Risk signals:
${JSON.stringify(riskMeta?.flags || {}, null, 2)}

Routing policy:
- If risk is true -> status "escalated", owner "senior_support".
- If confidence < 0.7 -> status "open", owner "agent".
- order_status -> AI, unless latest message suggests repeated delay, no movement, repeated failed delivery, or explicit dissatisfaction with prior support.
- refund_not_received -> AI, unless latest message mentions bank denial, chargeback/dispute, extreme delay, or repeated follow-up after prior support.
- cancellation_request -> AI.
- address_change_request -> AI.
- invoice_request -> AI.
- report_problem -> AGENT.
- payment_issue -> AGENT.
- delivery_issue -> AGENT.
- return_exchange_request -> AGENT.
- general_inquiry -> AGENT.
- unknown -> AGENT.

Return one valid JSON object in exactly this shape:
{
  "status": "open",
  "owner": "agent",
  "reason": "confidence_below_threshold"
}
`;

  try {
    return await callJSONLLM(prompt, {
      systemPrompt:
        "You are a support routing engine. Follow the routing policy exactly and return only the requested JSON.",
    });
  } catch (e) {
    console.error("Decision Engine Error:", e);
    if (risk) return { status: "escalated", owner: "senior_support", reason: "risk_override" };
    return { status: "open", owner: "agent", reason: "fallback" };
  }
}
