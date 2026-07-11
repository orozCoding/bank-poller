import crypto from "node:crypto";

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAmountText(value) {
  return normalizeWhitespace(value)
    .replace(/[^\d,.-]/g, "")
    .replace(/^[.,]+/, "")
    .replace(/[.,]+$/, "");
}

export function parseAmountValue(value) {
  const normalized = normalizeAmountText(value);
  if (!normalized) return null;

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  let decimalSeparator = null;

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0) {
    decimalSeparator = ",";
  } else if (lastDot >= 0) {
    decimalSeparator = ".";
  }

  let candidate = normalized;
  if (decimalSeparator) {
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    candidate = candidate.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") candidate = candidate.replace(",", ".");
  }

  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

export function fingerprintMovement(movement) {
  const payload = [
    normalizeWhitespace(movement.bankName),
    normalizeWhitespace(movement.date),
    normalizeWhitespace(movement.reference),
    normalizeWhitespace(movement.amountText),
    normalizeWhitespace(movement.description),
    normalizeWhitespace(movement.rawText)
  ].join("|");

  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function normalizeMovement(rawMovement, bankName) {
  const date = normalizeWhitespace(rawMovement.date);
  const reference = normalizeWhitespace(rawMovement.reference);
  const description = normalizeWhitespace(rawMovement.description);
  const rawText = normalizeWhitespace(rawMovement.rawText);
  const amountText = normalizeAmountText(rawMovement.amountText || rawText);

  return {
    bankName,
    observedAt: new Date().toISOString(),
    date,
    reference,
    amountText,
    amountValue: parseAmountValue(amountText),
    description,
    rawText,
    fingerprint: fingerprintMovement({
      bankName,
      date,
      reference,
      amountText,
      description,
      rawText
    })
  };
}
