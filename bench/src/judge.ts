// Optional LLM-judged quality score (1-5), opt-in via --judge. The judge grades
// substance and faithfulness; formatting compliance is already covered by the
// deterministic checks in scoring.ts. Defaults to claude-opus-4-8.

import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./providers.ts";
import type { FeatureName } from "./types.ts";

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", enum: [1, 2, 3, 4, 5] },
    rationale: { type: "string" },
  },
  required: ["score", "rationale"],
  additionalProperties: false,
} as const;

const RUBRICS: Record<FeatureName, string> = {
  title:
    "The app generated a title for the note below. A 5 captures the note's specific subject in 3-8 natural words; a 3 is generic but accurate; a 1 is wrong, vague, or echoes formatting.",
  tags:
    "The app suggested topical tags and a destination folder for the note below (JSON). A 5 picks precise topic tags a careful human organizer would choose and the obviously right folder; a 3 is plausible but generic; a 1 tags surface words, uses status/filler words, or routes to a wrong folder.",
  actions:
    "The app extracted action items (JSON) from the note below. A 5 finds exactly the real outstanding actions with sensible categories and correctly resolved due dates, and nothing else; a 3 misses or pads slightly; a 1 invents actions, includes completed work or plain facts, or mangles dates. An empty items list is the correct output when the note contains no actions.",
  bulletify:
    "The app restructured the note below into markdown bullets. A 5 is well-grouped, concise, loses no information, and keeps every link and image reference; a 3 loses minor detail or has awkward grouping; a 1 drops substantive content or invents content.",
  merge:
    "The app merged the overlapping notes below into one note. A 5 keeps every distinct fact, link and task exactly once, with duplicates removed and sensible organization; a 3 keeps most content but duplicates or scrambles some; a 1 loses substantive content.",
  summary:
    "The app summarized the note collection below in one paragraph. A 5 synthesizes the themes, decisions and open items accurately in 4-6 sentences; a 3 is accurate but shallow; a 1 misstates facts or reads like a list.",
};

export async function judgeOutput(
  judgeModel: string,
  feature: FeatureName,
  input: string,
  output: string,
): Promise<{ score: number; rationale: string }> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: judgeModel,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system:
      "You are a strict quality judge for AI features inside a note-taking app. Score the candidate output from 1 (unusable) to 5 (excellent) against the rubric. Judge substance and faithfulness to the input; formatting compliance is checked elsewhere — ignore minor formatting issues.",
    messages: [
      {
        role: "user",
        content: `${RUBRICS[feature]}\n\n<input>\n${input}\n</input>\n\n<candidate_output>\n${output}\n</candidate_output>`,
      },
    ],
  };
  (params as Record<string, unknown>).output_config = {
    format: { type: "json_schema", schema: JUDGE_SCHEMA },
  };
  const response = await anthropic().messages.create(params);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as { score: number; rationale: string };
  return { score: parsed.score, rationale: parsed.rationale };
}
