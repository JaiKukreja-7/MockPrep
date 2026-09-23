import "server-only";
import { runTask } from "../index";

export interface InterviewerTurnInput {
  /** What the candidate just said, as transcribed. */
  answer: string;
  /** The question they were answering. */
  question: string;
  /** True when this was the final question of the round. */
  isLast: boolean;
  /**
   * True when the round was tailored to a resume: the question names the
   * candidate's own projects, so this call may not reach a provider that
   * trains on what it is sent. Note this drops Gemini, which leads this
   * chain — a tailored voice round runs on Groq alone.
   */
  sensitive?: boolean;
}

/**
 * The brain: the interviewer's bridge between questions.
 *
 * It returns ONLY an acknowledgement — never a question. Letting the model
 * also deliver the next question is what put two different questions on
 * screen at once: the model's paraphrase went to the speaker and the caption
 * while the verbatim question went to the heading and the transcript. The
 * next question is now passed through untouched by the caller, so the spoken,
 * displayed and logged text are one string.
 */
export async function interviewerTurn({
  answer,
  question,
  isLast,
  sensitive,
}: InterviewerTurnInput): Promise<{ text: string; provider: string }> {
  const result = await runTask("interviewer_turn", {
    temperature: 0.6,
    sensitive,
    system:
      "You are conducting a mock interview out loud. You are brief and warm " +
      "but never flattering. Reply with speech only — no stage directions, " +
      "no markdown, no quotation marks. Never ask a question: another part " +
      "of the system delivers those.",
    user:
      `You asked: ${question}\n\n` +
      `They answered: ${answer}\n\n` +
      (isLast
        ? `Acknowledge what they said in ONE short sentence, then say that is ` +
          `the end of the round and their score is being worked out. Do not ` +
          `ask anything.`
        : `Acknowledge what they said in ONE short sentence. Do not ask a ` +
          `question and do not preview what is coming next.`),
  });

  return {
    text: result.text.trim().replace(/^["']|["']$/g, ""),
    provider: `${result.provider}/${result.model}`,
  };
}
