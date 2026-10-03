import { describe, expect, it, vi } from "vitest";

import { selectProviderModel } from "./provider-model-select";

describe("selectProviderModel", () => {
  it("forwards the provider so the daemon can rebuild the session on it", async () => {
    const setAgentModel = vi.fn().mockResolvedValue(undefined);
    const persistModelPreference = vi.fn().mockResolvedValue(undefined);

    await selectProviderModel(
      { setAgentModel, persistModelPreference },
      { agentId: "agent-1", provider: "deepseek", modelId: "deepseek-v4.1-flash" },
    );

    expect(setAgentModel).toHaveBeenCalledWith("agent-1", "deepseek-v4.1-flash", "deepseek");
  });

  it("records the preference under the provider being switched to", async () => {
    const setAgentModel = vi.fn().mockResolvedValue(undefined);
    const persistModelPreference = vi.fn().mockResolvedValue(undefined);

    await selectProviderModel(
      { setAgentModel, persistModelPreference },
      { agentId: "agent-1", provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
    );

    expect(persistModelPreference).toHaveBeenCalledWith("opencode-go", "deepseek-v4.1-flash");
  });

  it("does not file a preference when the switch itself fails", async () => {
    const setAgentModel = vi.fn().mockRejectedValue(new Error("boom"));
    const persistModelPreference = vi.fn().mockResolvedValue(undefined);

    await expect(
      selectProviderModel(
        { setAgentModel, persistModelPreference },
        { agentId: "agent-1", provider: "deepseek", modelId: "deepseek-v4.1-flash" },
      ),
    ).rejects.toThrow("boom");

    expect(persistModelPreference).not.toHaveBeenCalled();
  });
});
