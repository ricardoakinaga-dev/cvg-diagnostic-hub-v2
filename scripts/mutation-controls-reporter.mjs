import { JsonReporter } from "vitest/reporters";

// Vitest's standard JSON assigns beforeEach errors to the test assertion.
// Preserve that report, adding native lifecycle/error state from the runner.
export default class MutationControlsReporter extends JsonReporter {
  async onTestRunEnd(testModules, unhandledErrors, reason) {
    let lifecycleFailureCount = 0;
    let retryCount = 0;
    const visit = (task) => {
      for (const state of Object.values(task.result?.hooks ?? {})) if (state !== "pass") lifecycleFailureCount += 1;
      retryCount += task.result?.retryCount ?? 0;
      for (const child of task.tasks ?? []) visit(child);
    };
    for (const testModule of testModules) visit(testModule.task);
    this.mutationControls = { schemaVersion: 1, lifecycleFailureCount, retryCount, unhandledErrorCount: unhandledErrors.length, interrupted: reason === "interrupted" };
    return super.onTestRunEnd(testModules);
  }

  async writeReport(json) {
    return super.writeReport(JSON.stringify({ ...JSON.parse(json), mutationControls: this.mutationControls }));
  }
}
