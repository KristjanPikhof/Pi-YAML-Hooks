import { OMP_SYNCHRONOUS_BASH_BUDGET_MS } from "../core/runtime.js";
import { resolveSynchronousBashBudgetMs } from "./runtime-registry.js";

interface Case {
  readonly name: string;
  readonly run: () => { ok: boolean; detail?: string };
}

const cases: Case[] = [
  {
    name: "runtime registry configures the synchronous budget only for OMP",
    run: () => {
      const piBudget = resolveSynchronousBashBudgetMs("pi");
      const ompBudget = resolveSynchronousBashBudgetMs("omp");
      return piBudget === undefined && ompBudget === OMP_SYNCHRONOUS_BASH_BUDGET_MS
        ? { ok: true }
        : { ok: false, detail: `pi=${String(piBudget)}, omp=${String(ompBudget)}` };
    },
  },
];

export async function main(): Promise<number> {
  let failures = 0;
  for (const testCase of cases) {
    try {
      const outcome = testCase.run();
      if (outcome.ok) {
        console.info(`PASS  ${testCase.name}`);
      } else {
        failures += 1;
        console.info(`FAIL  ${testCase.name} -- ${outcome.detail ?? "no detail"}`);
      }
    } catch (error) {
      failures += 1;
      console.info(`FAIL  ${testCase.name} -- threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`);
  return failures === 0 ? 0 : 1;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /runtime-registry\.test\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
