import fetch from "node-fetch";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

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
  const { systemPrompt, temperature = 0 } = options;
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      system_instruction: systemPrompt
        ? {
            parts: [{ text: systemPrompt }],
          }
        : undefined,
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature,
      },
    }),
    }
  );

  const data = await res.json();

  if (!res.ok || data.error) {
    console.error("Gemini API error:", data.error || data);
    throw new Error(data?.error?.message || `Gemini request failed with ${res.status}`);
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim() || "";

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
