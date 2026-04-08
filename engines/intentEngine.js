import { callJSONLLM } from "../ai/llmClient.js";

const FALLBACK = {
  intent: "unknown",
  confidence: 0.1,
  secondary_intents: [],
  entities: {
    order_id: null,
    new_address: null,
  },
  signals: {
    mentions_refund: false,
    mentions_delay: false,
    mentions_damage: false,
    mentions_payment_failure: false,
    asks_for_human_help: false,
    mentions_bank_issue: false,
    mentions_failed_delivery: false,
  },
  evidence: null,
};

export async function detectIntent(email) {
  const prompt = `
You are the Senior Triage Specialist for Puma L1 Support Automation.

Classify the customer's newest message into exactly one primary intent from this enum:
- order_status
- refund_not_received
- cancellation_request
- address_change_request
- return_exchange_request
- invoice_request
- report_problem
- payment_issue
- delivery_issue
- general_inquiry
- unknown

Rules:
- Focus primarily on the latest customer-written message, not the quoted email history.
- Use quoted history only as fallback context for order references.
- If refund and order-status both appear, choose refund_not_received.
- If wrong item, damaged item, missing item, or defective item is mentioned, choose report_problem.
- If payment was charged but order was not created, choose payment_issue.
- If the main issue is delivery attempt failure, repeated reschedule, or shipment not moving, choose delivery_issue.
- If the message is not understandable, empty, or spammy, choose unknown.
- confidence must be a number between 0 and 1.
- secondary_intents must contain only enum values from the same list.
- evidence should be a short snippet copied or paraphrased from the latest message.

Return one valid JSON object in exactly this shape:
{
  "intent": "order_status",
  "confidence": 0.92,
  "secondary_intents": [],
  "entities": {
    "order_id": null,
    "new_address": null
  },
  "signals": {
    "mentions_refund": false,
    "mentions_delay": false,
    "mentions_damage": false,
    "mentions_payment_failure": false,
    "asks_for_human_help": false,
    "mentions_bank_issue": false,
    "mentions_failed_delivery": false
  },
  "evidence": "where is my order"
}

Email metadata:
Subject: ${email.subject || ""}
Is reply in thread: ${Boolean(email.isReply)}

Latest customer message:
${(email.latestMessageText || "").substring(0, 3000)}

Thread context:
${(email.threadText || "").substring(0, 3000)}
`;

  try {
    const res = await callJSONLLM(prompt, {
      systemPrompt:
        "You are a careful support classifier. Follow the schema exactly and never invent fields.",
    });

    return {
      ...FALLBACK,
      ...res,
      entities: {
        ...FALLBACK.entities,
        ...(res?.entities || {}),
      },
      signals: {
        ...FALLBACK.signals,
        ...(res?.signals || {}),
      },
      secondary_intents: Array.isArray(res?.secondary_intents)
        ? res.secondary_intents
        : [],
    };
  } catch (e) {
    console.error("Intent Engine Error:", e);
    return FALLBACK;
  }
}
