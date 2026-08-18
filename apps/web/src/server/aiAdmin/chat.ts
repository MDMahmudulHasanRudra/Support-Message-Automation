import type Anthropic from "@anthropic-ai/sdk";
import { resolveAiAdminClient } from "./resolveAiAdminClient";
import { AI_ADMIN_TOOLS, AI_ADMIN_TOOL_MAP } from "./tools";

export interface AiAdminChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AiAdminChatResult {
  reply: string;
  toolsUsed: string[];
}

const SYSTEM_PROMPT = `You are the AI Admin Assistant for a WhatsApp Support Automation dashboard.

Rules:
- Only state facts you got back from a tool call. If a tool doesn't give you what you need, say the information isn't available — never invent numbers, group names, statuses, or settings.
- You can currently only READ data via tools. You cannot change any setting, add/remove a keyword or team member, or perform any action yet — if asked to do so, say that write actions aren't available in this version yet.
- Understand Bangla, Banglish, and English, and reply in whichever the admin used.
- Be concise — a short direct answer, not a report.`;

const MAX_ITERATIONS = 5;

const ANTHROPIC_TOOLS: Anthropic.Tool[] = AI_ADMIN_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

/**
 * Runs one user turn through the Admin Assistant's tool-calling loop. Conversation history is
 * held client-side (see FloatingAiChat.tsx) as plain text turns, not persisted server-side — a
 * deliberate v1 scope cut since every tool here is read-only, so there's nothing a fabricated
 * client-supplied history could cause to happen beyond a confusing conversation (no data can be
 * changed either way). Each call still re-runs real tool queries, so factual answers are always
 * fresh regardless of what the client claims happened earlier.
 */
export async function runAiAdminChat(history: AiAdminChatTurn[], userMessage: string): Promise<AiAdminChatResult> {
  const resolved = await resolveAiAdminClient();
  if (!resolved) {
    return {
      reply:
        'The AI Admin Assistant isn\'t configured yet. An admin needs to add an AI Provider and assign it to the "Admin Assistant Model" job on the AI Models page, with the AI Engine switch turned on in AI Settings.',
      toolsUsed: [],
    };
  }
  const { client, modelId } = resolved;

  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn): Anthropic.MessageParam => ({ role: turn.role, content: turn.text })),
    { role: "user", content: userMessage },
  ];

  const toolsUsed: string[] = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      tools: ANTHROPIC_TOOLS,
    });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return { reply: text || "(no response)", toolsUsed };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      toolsUsed.push(block.name);
      const tool = AI_ADMIN_TOOL_MAP.get(block.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Unknown tool.", is_error: true });
        continue;
      }
      try {
        const result = await tool.handler((block.input as Record<string, unknown>) ?? {});
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Tool failed: ${err instanceof Error ? err.message : "unknown error"}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    reply: "I wasn't able to finish that within the allowed number of steps — try asking something more specific.",
    toolsUsed,
  };
}
