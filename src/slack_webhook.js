const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_UPDATE_MESSAGE_URL = "https://slack.com/api/chat.update";

export class SlackClient {
  constructor({ botToken, channel, bankName }) {
    this.botToken = botToken;
    this.channel = channel;
    this.bankName = bankName;
  }

  async postMovement(movement) {
    const payload = buildPayload(this.bankName, movement, this.channel);
    return this.postWithBotToken(payload);
  }

  // Keep a single heartbeat message and edit it in place so the channel isn't
  // flooded. Falls back to posting a fresh message if there's no prior one, or
  // if the stored message can't be edited (deleted, too old, etc.). Returns the
  // message reference { channel, ts } to persist for the next update.
  async postOrUpdateHeartbeat(text, previous) {
    if (previous && previous.ts && previous.channel) {
      const updated = await this.postWithBotToken(
        { channel: previous.channel, ts: previous.ts, text },
        SLACK_UPDATE_MESSAGE_URL
      ).catch(() => null);
      if (updated) return { channel: updated.channel, ts: updated.ts };
    }

    const payload = { text };
    if (this.channel) payload.channel = this.channel;
    const posted = await this.postWithBotToken(payload);
    return { channel: posted.channel, ts: posted.ts };
  }

  async postWithBotToken(payload, url = SLACK_POST_MESSAGE_URL) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack API failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const body = await response.json();
    if (!body.ok) {
      throw new Error(`Slack API error: ${body.error || "unknown_error"}`);
    }

    return body;
  }
}

function buildPayload(bankName, movement, channel) {
  const title = `${bankName}: ingreso detectado`;
  const summary = [
    movement.amountText,
    movement.referenceLastDigits ? `ref ${movement.referenceLastDigits}` : movement.reference
  ].filter(Boolean).join(" · ");

  const payload = {
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
          markdownField("*Últimos 6*\n" + fallback(movement.referenceLastDigits)),
          markdownField("*Fecha*\n" + fallback(movement.date)),
          markdownField("*Tipo*\n" + fallback(movement.debitCredit))
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
          text: `*Saldo*\n${escapeMrkdwn(fallback(movement.balanceText))}`
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

  if (channel) payload.channel = channel;
  return payload;
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
