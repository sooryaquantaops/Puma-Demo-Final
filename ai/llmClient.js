import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function extractJsonText(text) {
  const cleaned = text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("LLM response did not contain a JSON object");
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
}

export async function callLLM(prompt, options = {}) {
  const { systemPrompt } = options;
  const messages = [];

  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages,
    }),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    console.error("OpenAI API error:", data.error || data);
    throw new Error(data?.error?.message || `OpenAI request failed with ${res.status}`);
  }

  const text = data?.choices?.[0]?.message?.content || "";

  if (!text) {
    console.error("Empty LLM response:", JSON.stringify(data));
    throw new Error("LLM returned empty response");
  }

  return text;
}

export async function callJSONLLM(prompt, options = {}) {
  try {
    const text = await callLLM(prompt, options);
    return JSON.parse(extractJsonText(text));
  } catch (error) {
    const retryPrompt = `${prompt}

Return one valid JSON object only. Do not include markdown, comments, or trailing text.`;

    const retryText = await callLLM(retryPrompt, options);
    return JSON.parse(extractJsonText(retryText));
  }
}
