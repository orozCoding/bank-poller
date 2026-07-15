const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_UPDATE_MESSAGE_URL = "https://slack.com/api/chat.update";

export class SlackClient {
  constructor({ botToken, channel, bankName, timezone }) {
    this.botToken = botToken;
    this.channel = channel;
    this.bankName = bankName;
    this.timezone = timezone;
  }

  async postMovement(movement) {
    const payload = buildPayload(this.bankName, movement, this.channel, this.timezone);
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

function buildPayload(bankName, movement, channel, timezone) {
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
          markdownField("*Fecha*\n" + formatHumanDate(movement.date, timezone)),
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

// "14-07-2026 11:16" -> "Hoy martes 14 de julio - 2026 · 11:16 a.m."
// Falls back to the portal's raw text if it ever changes format, so a parsing
// miss degrades to the old display instead of dropping the date entirely.
function formatHumanDate(dateText, timezone) {
  const raw = String(dateText || "").trim();
  const match = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(raw);
  if (!match) return fallback(dateText);

  const [, day, month, year, hours, minutes] = match;
  // Anchor at UTC noon and render in UTC: these are calendar values, not
  // instants, so this keeps the weekday from sliding a day under any host TZ.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  if (Number.isNaN(date.getTime())) return fallback(dateText);

  const name = (options) =>
    new Intl.DateTimeFormat("es-VE", { timeZone: "UTC", ...options }).format(date);

  let label = `${name({ weekday: "long" })} ${Number(day)} de ${name({ month: "long" })} - ${year}`;

  // "Hoy"/"Ayer" are relative to the bank's timezone, not the host's.
  const today = calendarDayIn(timezone, 0);
  const yesterday = calendarDayIn(timezone, -1);
  const stamp = `${year}-${month}-${day}`;
  if (stamp === today) label = `Hoy ${label}`;
  else if (stamp === yesterday) label = `Ayer ${label}`;

  if (hours === undefined) return label;
  return `${label} · ${formatClock(hours, minutes)}`;
}

function formatClock(hours, minutes) {
  const hour = Number(hours);
  const suffix = hour < 12 ? "a.m." : "p.m.";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

// Calendar day in `timezone`, offset by `dayOffset`, as "DD-MM-YYYY" parts
// joined "YYYY-MM-DD" for comparison.
function calendarDayIn(timezone, dayOffset) {
  const at = new Date(Date.now() + dayOffset * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(at);
  } catch {
    return "";
  }
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
