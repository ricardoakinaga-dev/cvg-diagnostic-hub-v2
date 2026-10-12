import type { AuditTransactionReader, StateStore, StoreState } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
/** Reuse public command policies inside a caller-owned transaction without opening a second transaction. */
export function transactionalServiceContext(context: ApplicationServiceContext, original: StoreState, audit?: AuditTransactionReader) {
  let working = original;
  const transaction: StateStore["transaction"] = async (operation) => { const changed = await operation(working, audit); working = changed.state; return changed.result; };
  const store = new Proxy(context.store, { get(target, property) {
    if (property === "transaction") return transaction;
    if (property === "readState") return async () => working;
    const member = Reflect.get(target, property); return typeof member === "function" ? member.bind(target) : member;
  } });
  return { context: { ...context, store }, state: () => working };
}
