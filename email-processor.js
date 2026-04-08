import fetch from "node-fetch";
import { detectIntent } from "./engines/intentEngine.js";
import { detectRisk } from "./engines/riskEngine.js";
import { decideRoute } from "./engines/decisionEngine.js";

/* -------------------------
   CONFIG (KEEP AS-IS)
--------------------------*/
const TENANT_ID = "7e1d931c-a318-4d9d-8472-62e2437de1b0";
const CLIENT_ID = "89f6a458-fc26-4cb5-9e1b-ee045588c093";
const CLIENT = process.env.CLIENT_SECRET; // ✅ keep as-is (your crash already resolved)
const MAILBOX = "support@puma.quantaops.com";
const AUTO_SEND_REPLIES = process.env.AUTO_SEND_REPLIES === "true";

// Backend API URL (default to localhost if not set)
const API_URL =
  process.env.API_URL || "https://puma-backend-demo-production-6abd.up.railway.app";

/* -------------------------
   API HELPERS
--------------------------*/
async function apiCall(endpoint, method, body) {
  try {
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${API_URL}${endpoint}`, options);

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ API Error [${method} ${endpoint}]:`, err);
      return null;
    }

    return res.json();
  } catch (e) {
    console.error(`❌ API Network Error [${method} ${endpoint}]:`, e.message);
    return null;
  }
}

async function fetchCustomerOrders(email) {
  return await apiCall(`/orders?email=${encodeURIComponent(email)}`, "GET");
}

async function fetchOrderById(orderId) {
  return await apiCall(`/orders/${orderId}`, "GET");
}

/* -------------------------
   GRAPH API HELPERS
--------------------------*/
async function getAccessToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        // ✅ keep your current approach: use env secret value
        client_secret: CLIENT,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );

  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get token");
  return data.access_token;
}

async function fetchUnreadEmails() {
  const token = await getAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders/inbox/messages?$filter=isRead eq false&$select=id,internetMessageId,subject,bodyPreview,body,receivedDateTime,from,toRecipients,ccRecipients,replyTo,inReplyTo,conversationId`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("Graph error");
  return (data.value || []).filter(isMailboxRecipient);
}

/* -------------------------
   ✅ REPLY (NOT SEND NEW)
--------------------------*/
async function sendReply(messageId, body) {
  const token = await getAccessToken();

  const payload = {
    comment: body, // HTML supported
  };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error("Failed to reply: " + t);
  }

  console.log(`↩️ Replied to message ${messageId}`);
  return true;
}

async function updateDraftBody(messageId, body) {
  const token = await getAccessToken();

  const payload = {
    body: {
      contentType: "HTML",
      content: body,
    },
  };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error("Failed to update draft: " + t);
  }

  return true;
}

async function createReplyDraft(messageId, body) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/${messageId}/createReply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error("Failed to create reply draft: " + t);
  }

  const draft = await res.json();
  await updateDraftBody(draft.id, body);

  console.log(`Drafted reply ${draft.id} for message ${messageId}`);
  return draft;
}

/* -------------------------
   HELPERS
--------------------------*/
function extractOrderIds(text = "") {
  return [...new Set(text.match(/\b\d{5,}\b/g) || [])];
}

function isMailboxRecipient(email) {
  const mailbox = MAILBOX.toLowerCase();
  const recipients = [
    ...(email.toRecipients || []),
    ...(email.ccRecipients || []),
    ...(email.replyTo || []),
  ]
    .map((entry) => entry?.emailAddress?.address?.toLowerCase())
    .filter(Boolean);

  if (recipients.length === 0) return true;
  return recipients.includes(mailbox);
}

function decodeHtmlEntities(text = "") {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html = "") {
  return decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function normalizeWhitespace(text = "") {
  return text
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mergeUniqueTextBlocks(...parts) {
  const normalizedParts = parts
    .map((part) => normalizeWhitespace(part || ""))
    .filter(Boolean);

  const merged = [];
  for (const part of normalizedParts) {
    const alreadyCovered = merged.some(
      (existing) => existing.includes(part) || part.includes(existing)
    );
    if (!alreadyCovered) merged.push(part);
  }

  return normalizeWhitespace(merged.join("\n"));
}

function extractLatestCustomerMessage(email) {
  const htmlText = stripHtml(email.body?.content || "");
  const previewText = email.bodyPreview || "";
  const fullText = mergeUniqueTextBlocks(previewText, htmlText);

  if (!fullText) return "";

  const markers = [
    /^On .+wrote:$/im,
    /^From:\s.+$/im,
    /^Sent:\s.+$/im,
    /^Subject:\s.+$/im,
    /^-----Original Message-----$/im,
    /^_{5,}$/im,
  ];

  let cutoff = fullText.length;
  for (const marker of markers) {
    const match = marker.exec(fullText);
    if (match && typeof match.index === "number" && match.index > 0) {
      cutoff = Math.min(cutoff, match.index);
    }
  }

  const candidate = fullText
    .slice(0, cutoff)
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n");

  return normalizeWhitespace(candidate || previewText || fullText);
}

function buildEmailContext(email) {
  const latestMessageText = extractLatestCustomerMessage(email);
  const threadText = mergeUniqueTextBlocks(
    email.bodyPreview || "",
    stripHtml(email.body?.content || "")
  );

  return {
    subject: email.subject || "",
    latestMessageText,
    threadText,
    searchText: normalizeWhitespace(
      `${email.subject || ""}\n${latestMessageText}\n${threadText}`
    ),
    isReply:
      /^re:/i.test(email.subject || "") ||
      Boolean(email.inReplyTo) ||
      Boolean(email.replyTo?.length),
  };
}

/**
 * ✅ Puma requested: include Refund Number / ARN in replies (if available)
 * ✅ FIX: your DB uses "rrn" (RRN9876...), so include it here.
 */
function getRefundRef(orderData) {
  return (
    orderData?.refund_rrn ||            // ✅ YOUR API KEY
    orderData?.rrn ||                   // optional
    orderData?.arn_number ||
    orderData?.refund_arn ||
    orderData?.refund_reference ||
    orderData?.refund_reference_number ||
    orderData?.refund_number ||
    orderData?.refund_id ||
    null
  );
}

/* -------------------------
   EMAIL TEMPLATES (Polite + Refund Ref)
--------------------------*/
const templates = {
  // --- 1. Information Seeking ---
  ask_order_id: () => `
Hello,<br><br>
Thank you for reaching out to Puma Support.<br>
To assist you better, could you please share your <b>Order ID</b> (e.g., PUMA-123456)?<br><br>
Once we have the Order ID, we will check and update you at the earliest.<br><br>
Regards,<br>
Puma Support
`,

  multiple_orders_found: (orders) => {
    const rows = orders
      .map(
        (o) => `
      <tr>
        <td style="border: 1px solid #ddd; padding: 8px;">${o.order_id}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${o.items || "Items"}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${o.status || "NA"}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${o.created_at || "NA"}</td>
      </tr>
    `
      )
      .join("");

    return `
Hello,<br><br>
Thank you for contacting Puma Support.<br>
We found multiple recent orders linked to your email. Please reply with the specific <b>Order ID</b> from the list below so we can assist you correctly:<br><br>
<table style="border-collapse: collapse; width: 100%;">
  <thead>
    <tr style="background-color: #f2f2f2;">
      <th style="border: 1px solid #ddd; padding: 8px;">Order ID</th>
      <th style="border: 1px solid #ddd; padding: 8px;">Items</th>
      <th style="border: 1px solid #ddd; padding: 8px;">Status</th>
      <th style="border: 1px solid #ddd; padding: 8px;">Date</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<br>
Regards,<br>
Puma Support
`;
  },

  // --- 2. Order Status (FCR) ---
  order_created: (id) => `
Hello,<br><br>
Thank you for your order! Your order <b>${id}</b> is confirmed. 🎉<br>
It typically takes <b>1–2 business days</b> to pack and dispatch your items.<br>
You will receive an update as soon as it ships.<br><br>
Regards,<br>
Puma Support
`,

  order_packed: (id) => `
Hello,<br><br>
Good news! Your order <b>${id}</b> has been packed and is ready for pickup by our courier partner.<br>
It should ship within the next 24 hours.<br><br>
Regards,<br>
Puma Support
`,

 order_shipped: (id, trackingNumber = null, trackingUrl = null) => `
Hello,<br><br>
Your order <b>${id}</b> has been shipped successfully. 🚚<br><br>

${trackingNumber ? `<b>Tracking Number:</b> ${trackingNumber}<br>` : ""}
${trackingUrl ? `You can track your shipment using the link below:<br><a href="${trackingUrl}">Track Your Order</a><br><br>` : ""}
${!trackingNumber && !trackingUrl ? "Tracking details will be shared with you once the courier scan is available.<br><br>" : ""}

If you need any further assistance, feel free to reply to this email.<br><br>

Regards,<br>
Puma Support
`,


delivery_attempt_failed: (id, trackingUrl = null) => `
Hello,<br><br>
We noticed that a delivery attempt was not successful for your order <b>${id}</b>.<br><br>

Our courier partner will attempt delivery again on the next business day.<br>
Kindly ensure someone is available to receive the package.<br><br>

${trackingUrl ? `Please use the link below to track your order in the meanwhile:<br><a href="${trackingUrl}">Track Your Order</a><br><br>` : ""}

Additionally, our support assistant will guide you shortly to ensure successful delivery.<br><br>

Regards,<br>
Puma Support
`,



  order_delivered: (id) => `
Hello,<br><br>
Our records show that your order <b>${id}</b> has been delivered.<br>
If you have not received it, please reply to this email and we will assist you on priority.<br><br>
Regards,<br>
Puma Support
`,

  order_returned: (id) => `
Hello,<br><br>
We have received your return for order <b>${id}</b>.<br>
Your refund is being processed and should reflect within <b>5–7 business days</b>.<br><br>
Regards,<br>
Puma Support
`,

  // --- 3. Agent Handoff / Exceptions ---
  agent_handoff_generic: (id) => `
Hello,<br><br>
Thank you for writing to us${id ? ` regarding order <b>${id}</b>` : ""}. <br>
A support specialist has been assigned and will get back to you shortly.<br><br>
Regards,<br>
Puma Support
`,

  agent_handoff_stuck: (id) => `
Hello,<br><br>
We’re sorry for the inconvenience. We are investigating the movement status for order <b>${id}</b> with our logistics partner.<br>
Our team will update you at the earliest with a resolution.<br><br>
Regards,<br>
Puma Support
`,

  // --- 4. Cancellation & corrections ---
  cancellation_whatsapp: () => `
Hello,<br><br>
To cancel your order quickly, please use our automated WhatsApp service:<br><br>
👉 <a href="https://wa.me/puma_support?text=cancel"><b>Click here to Cancel Order on WhatsApp</b></a><br><br>
Note: Cancellation is only possible before the order is shipped.<br><br>
Regards,<br>
Puma Support
`,

  address_change_denied: () => `
Hello,<br><br>
Thank you for your request.<br>
Currently, we do not support address changes once an order is placed due to security and logistics constraints.<br>
Once you receive the courier SMS, you may coordinate directly with the courier partner.<br><br>
Regards,<br>
Puma Support
`,

  // --- 5. Refunds (FCR) ---
  refund_in_sla: (id, ref = null) => `
Hello,<br><br>
Your refund for order <b>${id}</b> has been initiated.<br>
Refunds are typically credited within <b>5–7 business days</b> after initiation.<br>
${ref ? `<b>Refund Reference / ARN:</b> ${ref}<br>` : ""}
If you do not see the credit after the timeline, please reply here and we will assist you further.<br><br>
Regards,<br>
Puma Support
`,

  refund_processed: (id, ref = "N/A") => `
Hello,<br><br>
Your refund for order <b>${id}</b> has been processed successfully.<br>
<b>Refund Reference / ARN:</b> ${ref}<br><br>
If the amount is not visible yet, kindly check with your bank using the above reference number.<br><br>
Regards,<br>
Puma Support
`,

  // --- 6. Refunds (Agent Handoff) ---
  refund_issue_handoff: (id, ref = null) => `
Hello,<br><br>
We apologize for the delay in your refund for order <b>${id}</b>.<br>
${ref ? `<b>Refund Reference / ARN:</b> ${ref}<br>` : ""}
We have assigned this to our Finance Team for verification and will update you as soon as we have confirmation.<br><br>
Regards,<br>
Puma Support
`,

  // --- 7. Risk / Other ---
 high_risk_escalation: (id, arn = "ARN123456789") => `
Hello,<br><br>
Thank you for reaching out to us${id ? ` regarding order <b>${id}</b>` : ""}.<br><br>
Your email has been flagged for priority review and has been assigned to a support specialist.<br>
<b>Refund Reference / ARN:</b> ${arn}<br><br>
Our team will get back to you shortly with the next steps.<br><br>
Regards,<br>
Puma Support
`,


  unclear_intent: () => `
Hello,<br><br>
Thank you for writing to Puma Support.<br>
We want to assist you, but we need a bit more information. Could you please share your <b>Order ID</b> and a brief description of the issue?<br><br>
Regards,<br>
Puma Support
`,

  invoice_shared: (id) => `
Hello,<br><br>
We have initiated the invoice request for order <b>${id}</b>.<br>
It will be shared to your registered email address shortly.<br><br>
Regards,<br>
Puma Support
`,

  // ✅ You were calling this earlier; adding it prevents runtime issues for that intent.
  return_exchange: (id = "") => `
Hello,<br><br>
Thank you for reaching out.${id ? ` We have noted your request for order <b>${id}</b>.` : ""}<br>
Our support team will assist you with the return or exchange process shortly.<br><br>
Regards,<br>
Puma Support
`,
};

/* -------------------------
   TEMPLATE DECIDER
--------------------------*/
function buildReply({
  intent,
  risk,
  confidence,
  orderIds,
  decision,
  suggestedOrder,
  multipleOrders,
  orderData,
}) {
  // 1. Multiple Orders Found -> Ask user to choose
  if (multipleOrders && multipleOrders.length > 1) {
    return templates.multiple_orders_found(multipleOrders);
  }

  // 2. Missing Order ID check
  const activeOrderId = orderIds[0] || suggestedOrder;

  // Risk override should still preserve order context if we have it.
  if (risk) return templates.high_risk_escalation(activeOrderId || "", getRefundRef(orderData) || "ARN123456789");

  const intentsNeedingId = [
    "order_status",
    "refund_not_received",
    "invoice_request",
    "report_problem",
    "delivery_issue",
    "payment_issue",
    "return_exchange_request",
  ];

  const needsOrderId = intentsNeedingId.includes(intent);

  if (!activeOrderId && needsOrderId) return templates.ask_order_id();

  const id = activeOrderId || "";
  const isAgentHandoff =
    decision?.owner === "agent" || decision?.owner === "senior_support";

  const refundRef = getRefundRef(orderData);

  // 3. Intent Routing
  switch (intent) {
    case "order_status": {
      if (isAgentHandoff)
        return templates.agent_handoff_stuck(id || "YOUR_ORDER");

      const status = orderData?.status?.toLowerCase() || "processing";
      const trackingNumber =
        orderData?.tracking_number ||
        orderData?.awb ||
        orderData?.tracking_id ||
        null;
      const trackingUrl =
        orderData?.tracking_url ||
        orderData?.tracking_link ||
        null;
      if (status === "created") return templates.order_created(id);
      if (status === "packed") return templates.order_packed(id);
      if (status === "delivered") return templates.order_delivered(id);
      if (status === "returned") return templates.order_returned(id);
   if (status === "delivery failed" || status === "delivery_failed") {
  return templates.delivery_attempt_failed(id, trackingUrl);
}
      return templates.order_shipped(id, trackingNumber, trackingUrl);
    }

    case "refund_not_received": {
      if (isAgentHandoff)
        return templates.refund_issue_handoff(id || "YOUR_ORDER", refundRef);

      const refundStatus = (orderData?.refund_status || "").toLowerCase();
      if (refundStatus === "processed" || refundStatus === "success") {
        return templates.refund_processed(id, refundRef || "N/A");
      }

      return templates.refund_in_sla(id, refundRef);
    }

    case "cancellation_request":
      return templates.cancellation_whatsapp();

    case "address_change_request":
      return templates.address_change_denied();

    case "return_exchange_request":
      return templates.return_exchange(id);

    case "invoice_request":
      return templates.invoice_shared(id);

    case "report_problem":
    case "payment_issue":
      return templates.agent_handoff_generic(id);

    default:
      if (confidence < 0.7) return templates.unclear_intent();
      return templates.agent_handoff_generic(id);
  }
}

/* -------------------------
   WORKER
--------------------------*/
async function processEmails() {
  try {
    const emails = await fetchUnreadEmails();
    if (!emails.length) return console.log("📭 No new emails");

    for (const email of emails) {
      const emailId = email.id;
      if (!emailId) continue;

      try {
        console.log(`🔹 Processing email: ${email.subject}`);

        // 0. Extract Sender Email
        const senderEmail = email.from?.emailAddress?.address;
        const emailContext = buildEmailContext(email);

        // 1. Injest Email to DB
        const savedEmail = await apiCall("/email-inbox", "POST", {
          message_id: email.id,
          internet_message_id: email.internetMessageId,
          from_name: email.from?.emailAddress?.name,
          from_email: senderEmail,
          to_email: MAILBOX,
          subject: email.subject,
          body_preview: email.bodyPreview,
          body_html: email.body?.content,
          received_at: email.receivedDateTime,
          channel: "email",
          processing_status: "processing",
          raw_payload: email,
        });

        if (!savedEmail) {
          console.warn("Skipping processing as email ingest failed.");
          continue;
        }

        // 2. AI Engines
        const analysisInput = {
          ...email,
          ...emailContext,
        };
        const intentRes = await detectIntent(analysisInput);
        const riskRes = await detectRisk(analysisInput);

        const intent = intentRes.intent || "unknown";
        const confidence = Number(intentRes.confidence || 0.1);
        const risk = Boolean(riskRes.risk);

        const decision = await decideRoute({
          intent,
          confidence,
          risk,
          emailContext,
          intentMeta: intentRes,
          riskMeta: riskRes,
        });

        console.log(
          `   🔸 Intent: ${intent} | Risk: ${risk} | Decision: ${decision.status}`
        );

        // 3. Extract Order IDs
        let orderIds = extractOrderIds(emailContext.searchText);

        if (orderIds.length === 0) {
          orderIds = extractOrderIds(emailContext.threadText);
        }

        // --- ORDER ID INFERENCE START ---
        let suggestedOrder = null;
        let multipleOrders = null;

        if (orderIds.length === 0 && senderEmail) {
          const customerOrders = await fetchCustomerOrders(senderEmail);

          if (customerOrders && customerOrders.length === 1) {
            suggestedOrder = customerOrders[0].order_id;
            console.log(`   ✅ Auto-inferred Order ID: ${suggestedOrder}`);
          } else if (customerOrders && customerOrders.length > 1) {
            multipleOrders = customerOrders;
            console.log(`   ⚠️ Multiple orders found: ${customerOrders.length}`);
          } else {
            console.log(`   ❌ No orders found for ${senderEmail}`);
          }
        }
        // --- ORDER ID INFERENCE END ---

        // 4. Create Case
        const casePayload = {
          salesforce_case_id: null,
          channel: "email",
          intent_type: intent,
          confidence_score: confidence,
          risk_flag: risk,
          status: decision.status,
          assigned_to: decision.owner,
        };

        const savedCaseResponse = await apiCall("/cases", "POST", casePayload);
        const caseId = savedCaseResponse?.data?.case_id;

        if (caseId) {
          await apiCall("/ai-decisions", "POST", {
            case_id: caseId,
            intent_detected: intent,
            confidence_score: confidence,
            decision_type: decision.status,
            reason_code: decision.owner,
            model_version: "v1.0",
          });

          if (risk) {
            await apiCall("/risk-events", "POST", {
              case_id: caseId,
              keyword_detected: riskRes.reason || "unknown",
              risk_level: "high",
              action_taken: "escalated",
            });
          }
        }

        // 5. Store Orders & Fetch Data
        const finalOrderId = orderIds[0] || suggestedOrder;
        let orderData = null;

        if (finalOrderId) {
          if (caseId) {
            await apiCall("/case-orders", "POST", {
              case_id: caseId,
              order_id: finalOrderId,
              is_valid: true,
            });
          }

          // Fetch real status for dynamic reply
          orderData = await fetchOrderById(finalOrderId);
        }

        // 6. Build and Send Reply
        const replyBody = buildReply({
          intent,
          risk,
          confidence,
          orderIds,
          decision,
          suggestedOrder,
          multipleOrders,
          orderData,
        });

        let communicationStatus = "drafted";
        let communicationCreated = false;

        if (AUTO_SEND_REPLIES) {
          const replySent = await sendReply(emailId, replyBody);
          communicationCreated = Boolean(replySent);
          if (replySent) communicationStatus = "sent";
        } else {
          const replyDraft = await createReplyDraft(emailId, replyBody);
          communicationCreated = Boolean(replyDraft?.id);
        }

        if (communicationCreated && caseId) {
          await apiCall("/communications", "POST", {
            case_id: caseId,
            channel: "email",
            template_id: intent,
            message_status: communicationStatus,
            sent_at: new Date().toISOString(),
          });
        }

        await apiCall("/system-audit-logs", "POST", {
          entity_type: "email",
          entity_id: emailId.substring(0, 99),
          action: "processed",
          performed_by: "system",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`Email ${emailId} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("Worker crashed:", err.message);
  }
}

/* -------------------------
   RUN
--------------------------*/
async function startWorker() {
  console.log("🚀 Email AI Worker started");
  console.log(`connects to: ${API_URL}`);

  while (true) {
    try {
      await processEmails();
    } catch (e) {
      console.error("Worker loop error:", e.message);
    }

    // ⏳ wait 30 seconds before next check
    await new Promise((r) => setTimeout(r, 30000));
  }
}

startWorker();
