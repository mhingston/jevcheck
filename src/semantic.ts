import { noul } from "@mhingston5/jev-cli";
import { semanticDecisionKey } from "./replay.js";
import type { Candidate, JevCheckRule } from "./types.js";

export function labelsFor(rule: JevCheckRule): { true: string; false: string } {
  return {
    true: rule.criteria?.true ?? "The rule violation is present in the supplied code.",
    false: rule.criteria?.false ?? "The rule violation is not present in the supplied code.",
  };
}

export function focusedQuestion(rule: JevCheckRule): string {
  return [
    "Judge only whether the rule is violated by code inside focusLineRange/focusRange.",
    "Code outside that focus is surrounding context only and must not itself cause a positive answer.",
    rule.question,
  ].join(" ");
}

export function semanticRequestForCandidate(
  rule: JevCheckRule,
  path: string,
  candidate: Candidate,
) {
  const focusRange =
    candidate.focusStartColumn !== undefined && candidate.focusEndColumn !== undefined
      ? {
          start: {
            line: candidate.focusStartLine,
            column: candidate.focusStartColumn,
          },
          end: {
            line: candidate.focusEndLine,
            column: candidate.focusEndColumn,
          },
        }
      : undefined;

  const state = {
    path,
    lineRange: [candidate.startLine, candidate.endLine] as [number, number],
    focusLineRange: [candidate.focusStartLine, candidate.focusEndLine] as [number, number],
    ...(focusRange ? { focusRange } : {}),
    ...(candidate.focusKind ? { focusKind: candidate.focusKind } : {}),
    code: candidate.text,
  };
  const question = noul(focusedQuestion(rule), labelsFor(rule));

  return {
    state,
    question,
    identity: semanticDecisionKey(question, state),
  };
}
