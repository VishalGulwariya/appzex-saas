export type AiPreflightConfiguration = {
  provider: "SET" | "NOT SET" | "INVALID";
  apiKey: "SET" | "NOT SET";
  model: "SET" | "NOT SET";
  timeout: "VALID" | "INVALID";
  timeoutMs: number;
  readyToProbe: boolean;
};

export function inspectAiPreflightConfiguration(source: NodeJS.ProcessEnv): AiPreflightConfiguration {
  const providerValue = source.AI_PROVIDER?.trim();
  const provider = !providerValue ? "NOT SET" : providerValue === "openai" ? "SET" : "INVALID";
  const apiKey = source.AI_API_KEY?.trim() ? "SET" : "NOT SET";
  const model = source.AI_MODEL?.trim() ? "SET" : "NOT SET";
  const timeoutValue = source.AI_TIMEOUT_MS?.trim() || "20000";
  const timeoutNumber = Number(timeoutValue);
  const timeoutValid = Number.isInteger(timeoutNumber) && timeoutNumber >= 1000 && timeoutNumber <= 60000;
  const timeoutMs = timeoutValid ? timeoutNumber : 20000;

  return {
    provider,
    apiKey,
    model,
    timeout: timeoutValid ? "VALID" : "INVALID",
    timeoutMs,
    readyToProbe: provider === "SET" && apiKey === "SET" && model === "SET" && timeoutValid
  };
}