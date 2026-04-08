import { callJSONLLM } from "../ai/llmClient.js";

const FALLBACK = {
  risk: false,
  category: null,
  reason: null,
  evidence: null,
  flags: {
    legal: false,
    fraud: false,
    financial_dispute: false,
    harassment: false,
    social_escalation: false,
    police: false,
  },
};

export async function detectRisk(email) {
  const prompt = `
You are the Risk and Compliance Officer for Puma Customer Support.

Review the newest customer-written message and decide whether it contains a high-risk escalation that requires immediate human handling.

High-risk categories:
- legal
- fraud
- financial_dispute
- harassment
- social_escalation
- police

Rules:
- Focus on the latest customer-written message, not the quoted thread.
- Mark risk true only when there is explicit threat, abuse, legal/police escalation, fraud allegation, chargeback/dispute language, or a stated public social-media escalation.
- Normal complaints like delayed delivery, refund pending, product return, or frustration without threat should be risk false.
- evidence should be a short snippet from the latest customer message when risk is true; otherwise null.

Return one valid JSON object in exactly this shape:
{
  "risk": false,
  "category": null,
  "reason": null,
  "evidence": null,
  "flags": {
    "legal": false,
    "fraud": false,
    "financial_dispute": false,
    "harassment": false,
    "social_escalation": false,
    "police": false
  }
}

Subject: ${email.subject || ""}
Latest customer message:
${(email.latestMessageText || "").substring(0, 3000)}

Thread context:
${(email.threadText || "").substring(0, 2000)}
`;

  try {
    const res = await callJSONLLM(prompt, {
      systemPrompt:
        "You are a conservative risk classifier. Only flag risk when the latest message clearly supports it.",
    });

    return {
      ...FALLBACK,
      ...res,
      flags: {
        ...FALLBACK.flags,
        ...(res?.flags || {}),
      },
    };
  } catch (e) {
    console.error("Risk Engine Error:", e);
    return FALLBACK;
  }
}
