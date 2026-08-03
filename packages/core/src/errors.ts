export class RailError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RailError";
    this.code = code;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

export class RailPluginError extends RailError {
  readonly pluginId: string;

  constructor(pluginId: string, code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "RailPluginError";
    this.pluginId = pluginId;
  }
}

export function errorDetails(error: unknown) {
  if (error instanceof RailError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "PLUGIN_ERROR", message: error.message };
  }
  return { code: "PLUGIN_ERROR", message: "The plugin returned an unknown error." };
}
