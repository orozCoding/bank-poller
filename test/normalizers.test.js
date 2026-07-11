import test from "node:test";
import assert from "node:assert/strict";

import {
  fingerprintMovement,
  normalizeAmountText,
  normalizeMovement,
  parseAmountValue
} from "../src/normalizers.js";

test("normalizeAmountText strips currency noise", () => {
  assert.equal(normalizeAmountText("Bs. 1.234,56 "), "1.234,56");
});

test("parseAmountValue handles comma decimals", () => {
  assert.equal(parseAmountValue("1.234,56"), 1234.56);
});

test("parseAmountValue handles dot decimals", () => {
  assert.equal(parseAmountValue("1234.56"), 1234.56);
});

test("fingerprintMovement is stable for the same normalized payload", () => {
  const left = fingerprintMovement({
    bankName: "Banco",
    date: "11/07/2026 10:33 AM",
    reference: "ABC123",
    amountText: "25,00",
    description: "Pago móvil",
    rawText: "Pago móvil ref ABC123"
  });

  const right = fingerprintMovement({
    bankName: "Banco",
    date: "11/07/2026 10:33 AM",
    reference: "ABC123",
    amountText: "25,00",
    description: "Pago móvil",
    rawText: "Pago móvil ref ABC123"
  });

  assert.equal(left, right);
});

test("normalizeMovement populates parsed fields and fingerprint", () => {
  const movement = normalizeMovement(
    {
      date: "11/07/2026 10:33 AM",
      reference: "ABC123",
      amountText: "Bs. 1.234,56",
      description: "Transferencia",
      rawText: "Transferencia ABC123 Bs. 1.234,56"
    },
    "Banco"
  );

  assert.equal(movement.bankName, "Banco");
  assert.equal(movement.amountValue, 1234.56);
  assert.ok(movement.fingerprint);
});
