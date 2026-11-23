export const USER_QUESTION_TOOL = "meteoragent_ask_user";
export const USER_QUESTION_ANSWER_LIMIT = 2000;

export interface UserQuestion {
  question: string;
  options?: { label: string; description?: string }[];
}

export type UserQuestionChoice = { optionIndex: number } | { text: string };

export interface UserQuestionAnswer {
  question: string;
  answer: string;
}

export type UserQuestionResult =
  | { status: "answered"; answers: UserQuestionAnswer[] }
  | { status: "skipped" };

export function normalizeUserQuestions(questions: UserQuestion[]): UserQuestion[] {
  return questions.map(({ question, options }) => {
    const prompt = question.trim();
    if (!prompt) throw new Error("Each question needs text.");
    if (!options) return { question: prompt };
    const choices = options.map(({ label, description }) => ({ label: label.trim(), description: description?.trim() }));
    const labels = new Set(choices.map(({ label }) => label.toLowerCase()));
    if (labels.has("") || labels.size !== choices.length) throw new Error("Use distinct, nonempty option labels.");
    return { question: prompt, options: choices };
  });
}

export function readUserQuestionAnswers(questions: readonly UserQuestion[], replies: unknown): UserQuestionAnswer[] {
  if (!Array.isArray(replies) || replies.length !== questions.length) {
    throw new Error("Send one answer for each question.");
  }
  return questions.map(({ question, options }, index) => {
    const reply: unknown = replies[index];
    if (reply && typeof reply === "object") {
      if ("text" in reply && !("optionIndex" in reply) && typeof reply.text === "string") {
        const answer = reply.text.trim();
        if (answer && answer.length <= USER_QUESTION_ANSWER_LIMIT) return { question, answer };
      }
      if ("optionIndex" in reply && !("text" in reply) && typeof reply.optionIndex === "number" && Number.isInteger(reply.optionIndex)) {
        const option = options?.[reply.optionIndex];
        if (option) return { question, answer: option.label };
      }
    }
    throw new Error(`Invalid answer for question ${index + 1}.`);
  });
}
