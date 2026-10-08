import type { StateStore, User } from "../domain/models";
import { findById } from "../domain/state-index";
import { ApiError } from "../http/envelope";
import { createAudit, now, requireActiveUser } from "./service-common";
import type { AlertContactUpdateInput } from "./service-types";

const E164 = /^\+[1-9][0-9]{7,14}$/;
const BRAZIL = /^\+55[1-9][0-9]{9,10}$/;

function invalidPhone(): ApiError {
  return new ApiError("VALIDATION_ERROR", "Informe um celular com DDD, por exemplo +55 11 9 0000-0000.", 400);
}

/**
 * PROD-402: turns what people type ("11 9xxxx-xxxx", "+55 (11) 9xxxx-xxxx") into E.164, the
 * only form the WhatsApp Cloud API accepts. Ten or eleven digits without a country code are a
 * Brazilian number with its area code.
 */
export function normalizeAlertPhone(raw: string): string {
  const typed = raw.trim();
  if (!typed || typed.length > 40 || /[^0-9+()\s.-]/.test(typed) || typed.indexOf("+", 1) !== -1) throw invalidPhone();
  const digits = typed.replace(/[^0-9]/g, "");
  const phone = typed.startsWith("+") || (digits.length !== 10 && digits.length !== 11) ? `+${digits}` : `+55${digits}`;
  if (!E164.test(phone) || (phone.startsWith("+55") && !BRAZIL.test(phone))) throw invalidPhone();
  return phone;
}

/** Enough for the owner to recognise the number; the full number never leaves the server. */
export function maskAlertPhone(phone: string): string {
  return `${phone.slice(0, 3)}${"•".repeat(Math.max(phone.length - 7, 1))}${phone.slice(-4)}`;
}

/**
 * The person registers or removes their own alert number. Consent (LGPD) is recorded with the
 * number; the audit trail keeps what happened, never the number itself.
 */
export async function updateOwnAlertContact(store: StateStore, actor: User, input: AlertContactUpdateInput, correlationId: string): Promise<User> {
  return store.transaction(async (state) => {
    requireActiveUser(state, actor);
    const stored = findById(state.users, actor.id)!;
    let updated: User;
    if (input.whatsappPhone === null) {
      if (!stored.whatsappPhone) return { state, result: { ...stored, sessionId: actor.sessionId } };
      const { whatsappPhone: _phone, whatsappConsentAt: _consent, ...rest } = stored;
      updated = { ...rest, version: stored.version + 1 };
    } else {
      if (input.consent !== true) throw new ApiError("VALIDATION_ERROR", "Autorize o envio de alertas pelo WhatsApp para cadastrar o número.", 400);
      const whatsappPhone = normalizeAlertPhone(input.whatsappPhone);
      if (stored.whatsappPhone === whatsappPhone && stored.whatsappConsentAt) return { state, result: { ...stored, sessionId: actor.sessionId } };
      updated = { ...stored, whatsappPhone, whatsappConsentAt: now(), version: stored.version + 1 };
    }
    const audit = createAudit("AlertContactUpdated", stored.id, "User", stored.id, correlationId,
      stored.whatsappPhone ? "REGISTERED" : "NONE", updated.whatsappPhone ? "REGISTERED" : "NONE",
      { action: updated.whatsappPhone ? "SET_ALERT_CONTACT" : "REMOVE_ALERT_CONTACT", channel: "WHATSAPP", departmentCode: stored.departmentCode });
    return {
      state: { ...state, users: state.users.map((user) => user.id === stored.id ? updated : user), auditEvents: [...state.auditEvents, audit] },
      result: { ...updated, sessionId: actor.sessionId }
    };
  });
}
