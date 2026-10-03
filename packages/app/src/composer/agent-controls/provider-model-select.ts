/**
 * TOPOS custom: choosing a model and the provider it belongs to, together.
 *
 * Both the running-agent model picker and the command center list every enabled
 * provider, so both have to forward the provider to `setAgentModel`: an omitted
 * provider means a model-only change, while a provider other than the agent's
 * current one makes the daemon rebuild the session on it and resume the same
 * conversation.
 *
 * The two call sites deliberately share this one implementation. They used to
 * carry their own copies, and the command center's dropped the provider — so it
 * offered other providers' models and switched nothing when one was picked.
 */

export interface ProviderModelSelection {
  agentId: string;
  provider: string;
  modelId: string;
}

export interface ProviderModelSelectionDeps {
  setAgentModel: (agentId: string, modelId: string, provider: string) => Promise<void> | void;
  /** Files the choice under the provider actually in use, so the picker remembers it. */
  persistModelPreference: (provider: string, modelId: string) => Promise<void> | void;
}

export async function selectProviderModel(
  deps: ProviderModelSelectionDeps,
  selection: ProviderModelSelection,
): Promise<void> {
  await deps.setAgentModel(selection.agentId, selection.modelId, selection.provider);
  await deps.persistModelPreference(selection.provider, selection.modelId);
}
