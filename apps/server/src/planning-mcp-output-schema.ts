import {
  PLANNING_SECTIONS,
  PlanningSectionSchema,
  PlanningSessionSchema,
} from "@designer/core";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);
const timestamp = z.string().datetime({ offset: true });
const positiveVersion = z.number().int().positive().max(1_000_000_000);

export const PlanningSectionsResultSchema = z.array(PlanningSectionSchema)
  .length(PLANNING_SECTIONS.length)
  .superRefine((sections, context) => {
    for (const [index, expected] of PLANNING_SECTIONS.entries()) {
      if (sections[index] !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Planning section ${index + 1} must be ${expected}.`,
        });
      }
    }
  });

export const PlanningSessionVersionResultSchema = z.object({
  version: positiveVersion,
  status: z.enum(["draft", "in_progress", "ready_for_review", "completed", "cancelled"]),
  currentSection: PlanningSectionSchema,
  actorId: identifier,
  createdAt: timestamp,
}).strict();

export const PlanningSessionResultSchema = z.object({
  session: PlanningSessionSchema,
  versions: z.array(PlanningSessionVersionResultSchema).max(10_000),
  answeredSections: z.array(PlanningSectionSchema).max(PLANNING_SECTIONS.length),
  sectionCount: z.literal(22),
}).strict().superRefine((result, context) => {
  const seen = new Set<string>();
  for (const [index, section] of result.answeredSections.entries()) {
    if (seen.has(section)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answeredSections", index],
        message: `Planning section ${section} appears more than once.`,
      });
    }
    seen.add(section);
  }
});
