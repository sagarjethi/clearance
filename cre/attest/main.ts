import { Runner, cre, decodeJson, type HTTPPayload, type Runtime } from "@chainlink/cre-sdk";
import { attestDecision, attestNextPending, type Config } from "./attest";

const onHttp = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const { decisionId } = decodeJson(payload.input) as { decisionId?: string };
  if (!decisionId) throw new Error("decisionId is required");
  return attestDecision(runtime, decisionId);
};

const onCron = (runtime: Runtime<Config>): string => attestNextPending(runtime);

const initWorkflow = (config: Config) => [
  cre.handler(new cre.capabilities.HTTPCapability().trigger({}), onHttp),
  cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onCron),
];

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
