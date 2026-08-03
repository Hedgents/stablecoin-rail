import type { DestinationActionPlugin, FundingProviderPlugin } from "./types.js";

export function defineFundingProvider<T extends FundingProviderPlugin>(plugin: T): T {
  return plugin;
}

export function defineDestinationAction<T extends DestinationActionPlugin>(plugin: T): T {
  return plugin;
}
