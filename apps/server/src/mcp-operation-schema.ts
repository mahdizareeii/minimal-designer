import { DesignOperationSchema } from "@designer/core";
import { z } from "zod";

export const McpTemporaryIdSchema = z.string().regex(/^tmp:[A-Za-z0-9._-]{1,80}$/);

const entityIdProbes = [
  "page_mcpclone0001",
  "node_mcpclone0001",
  "token_mcpclone0001",
  "asset_mcpclone0001",
  "link_mcpclone0001",
] as const;

type ZodConstructor = new (definition: z.ZodTypeDef) => z.ZodTypeAny;

function cloneWithDefinition(
  schema: z.ZodTypeAny,
  overrides: Record<string, unknown>,
): z.ZodTypeAny {
  const Constructor = schema.constructor as ZodConstructor;
  return new Constructor({ ...schema._def, ...overrides });
}

function isTemporaryCapableEntityId(schema: z.ZodBranded<z.ZodTypeAny, string | number | symbol>): boolean {
  const inner = schema.unwrap();
  return inner instanceof z.ZodString && entityIdProbes.some((probe) => inner.safeParse(probe).success);
}

/**
 * Clone the canonical operation schema while widening only stable entity-ID
 * positions to accept transaction-local `tmp:<label>` references. Every
 * object, refinement, bound, discriminated variant, and unknown-key policy is
 * otherwise inherited from the core schema.
 */
function withTemporaryEntityIds(
  schema: z.ZodTypeAny,
  memo = new WeakMap<object, z.ZodTypeAny>(),
): z.ZodTypeAny {
  const cached = memo.get(schema);
  if (cached) return cached;

  let result: z.ZodTypeAny;
  if (schema instanceof z.ZodBranded) {
    result = isTemporaryCapableEntityId(schema)
      ? z.union([schema, McpTemporaryIdSchema])
      : schema;
  } else if (schema instanceof z.ZodArray) {
    result = cloneWithDefinition(schema, { type: withTemporaryEntityIds(schema.element, memo) });
  } else if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as z.ZodRawShape).map(([key, child]) => [key, withTemporaryEntityIds(child, memo)]),
    ) as z.ZodRawShape;
    result = cloneWithDefinition(schema, { shape: () => shape });
  } else if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = (schema.options as readonly z.ZodDiscriminatedUnionOption<string>[])
      .map((option) => withTemporaryEntityIds(option, memo)) as [
      z.ZodDiscriminatedUnionOption<string>,
      ...z.ZodDiscriminatedUnionOption<string>[],
    ];
    result = z.discriminatedUnion(schema.discriminator, options);
  } else if (schema instanceof z.ZodUnion) {
    const options = (schema.options as readonly z.ZodTypeAny[])
      .map((option) => withTemporaryEntityIds(option, memo)) as [
      z.ZodTypeAny,
      z.ZodTypeAny,
      ...z.ZodTypeAny[],
    ];
    result = cloneWithDefinition(schema, { options });
  } else if (schema instanceof z.ZodEffects) {
    result = cloneWithDefinition(schema, { schema: withTemporaryEntityIds(schema.innerType(), memo) });
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    result = cloneWithDefinition(schema, { innerType: withTemporaryEntityIds(schema.unwrap(), memo) });
  } else if (schema instanceof z.ZodDefault) {
    result = cloneWithDefinition(schema, { innerType: withTemporaryEntityIds(schema._def.innerType, memo) });
  } else if (schema instanceof z.ZodRecord) {
    result = cloneWithDefinition(schema, {
      keyType: withTemporaryEntityIds(schema.keySchema, memo),
      valueType: withTemporaryEntityIds(schema.valueSchema, memo),
    });
  } else if (schema instanceof z.ZodString
    || schema instanceof z.ZodNumber
    || schema instanceof z.ZodBoolean
    || schema instanceof z.ZodEnum
    || schema instanceof z.ZodLiteral
    || schema instanceof z.ZodNever
    || schema instanceof z.ZodLazy) {
    // Primitive and recursive JSON-value schemas are immutable and contain no
    // stable entity-ID positions to widen.
    result = schema;
  } else {
    throw new Error(`Unsupported Zod schema node in the design operation contract: ${schema._def.typeName}`);
  }

  memo.set(schema, result);
  return result;
}

const publicOperationOptions = DesignOperationSchema.options.filter(
  (option) => !["insert_component_instance", "archive_page"].includes(String(option.shape.type.value)),
) as unknown as [
  z.ZodDiscriminatedUnionOption<"type">,
  z.ZodDiscriminatedUnionOption<"type">,
  ...z.ZodDiscriminatedUnionOption<"type">[],
];
const PublicDesignOperationListSchema = z.array(
  z.discriminatedUnion("type", publicOperationOptions),
).max(1_000);

const temporaryOperationList = withTemporaryEntityIds(PublicDesignOperationListSchema);
if (!(temporaryOperationList instanceof z.ZodArray)) {
  throw new Error("The canonical design operation list must remain an array schema.");
}

export const McpDesignOperationListSchema = temporaryOperationList.min(1).max(500);
