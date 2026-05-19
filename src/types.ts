/**
 * Minimal type definitions for OpenClaw plugin SDK.
 * Avoids importing from "openclaw/plugin-sdk/plugin-entry" which is only
 * available at runtime via the host's module alias system.
 */

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

export type AnyAgentTool = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: unknown) => void): Promise<ToolResult>;
  [key: string]: unknown;
};
