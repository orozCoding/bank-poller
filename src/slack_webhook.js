export class SlackWebhookClient {
  constructor({ webhookUrl, bankName }) {
    this.webhookUrl = webhookUrl;
    this.bankName = bankName;
  }

  async postMovement(movement) {
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(buildPayload(this.bankName, movement))
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack webhook failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
  }
}

function buildPayload(bankName, movement) {
  const title = `${bankName}: nuevo movimiento detectado`;
  const summary = [movement.amountText, movement.reference].filter(Boolean).join(" · ");

  return {
    text: summary ? `${title} — ${summary}` : title,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: title.slice(0, 150)
        }
      },
      {
        type: "section",
        fields: [
          markdownField("*Monto*\n" + fallback(movement.amountText)),
          markdownField("*Referencia*\n" + fallback(movement.reference)),
          markdownField("*Fecha*\n" + fallback(movement.date)),
          markdownField("*Valor numérico*\n" + fallback(movement.amountValue))
        ]
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Descripción*\n${escapeMrkdwn(fallback(movement.description))}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Texto crudo*\n${escapeMrkdwn(fallback(movement.rawText)).slice(0, 2800)}`
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `fingerprint: \`${movement.fingerprint.slice(0, 12)}\` · observado: ${movement.observedAt}`
          }
        ]
      }
    ]
  };
}

function markdownField(text) {
  return {
    type: "mrkdwn",
    text: escapeMrkdwn(text)
  };
}

function fallback(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function escapeMrkdwn(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
