import type { AgentName } from "@blastradius/shared";
import { EXPERT_PROMPT } from "./expert.ts";
import { INVESTIGATOR_PROMPT } from "./investigator.ts";
import { NAVIGATOR_PROMPT } from "./navigator.ts";
import { SCRIBE_PROMPT } from "./scribe.ts";
import { TRIAGE_PROMPT } from "./triage.ts";

export const SYSTEM_PROMPTS: Record<AgentName, string> = {
  triage: TRIAGE_PROMPT,
  investigator: INVESTIGATOR_PROMPT,
  expert: EXPERT_PROMPT,
  scribe: SCRIBE_PROMPT,
  navigator: NAVIGATOR_PROMPT,
};
