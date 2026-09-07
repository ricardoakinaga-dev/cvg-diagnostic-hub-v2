import { describe, expect, it } from "vitest";
import { userAsActor } from "./models";
import { createDemoState } from "../store/fixtures";

describe("domain actor projection", () => {
  it("projects only authorization-relevant user fields into an actor", () => {
    const user = createDemoState("models-actor-password").users.find((candidate) => candidate.id === "user-manager");
    expect(user).toBeDefined();

    const actor = userAsActor(user!);

    expect(actor).toMatchObject({ id: "user-manager", role: "MANAGER", departmentCode: "INPATIENT", active: true });
    expect(actor).not.toHaveProperty("passwordHash");
  });
});
