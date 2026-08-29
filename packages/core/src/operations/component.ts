/**
 * Generic operations component and dependency contracts.
 *
 * `kind` is an OPEN string, never an enum. A closed enum would mean every new
 * component kind requires a core edit, which is exactly what acceptance
 * criterion 14 forbids -- and core may not know what a container runtime, a
 * database or a data lake is in the first place. Identifiers are opaque and
 * bounded; core never parses meaning out of one.
 * @module @helium/core/operations/component
 */
import { z } from "zod";

/**
 * An opaque, bounded identifier. Bounded because these arrive from probe
 * output and adapter config, which are untrusted input: an unbounded string
 * becomes an unbounded key in every downstream map, log line and dedupe key.
 */
export const OpsIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "expected an opaque bounded id");

export const ComponentSpecSchema = z.strictObject({
  version: z.literal(1),
  id: OpsIdSchema,
  /** Open-ended on purpose. See the module comment. */
  kind: z.string().min(1).max(64),
  displayName: z.string().min(1).max(200).optional(),
  /** Dimensions this component can be observed along, if it declares any. */
  dimensions: z.array(z.string().min(1).max(64)).optional(),
});
export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

/**
 * One dependency edge, directed from the dependent to the dependency: `from`
 * needs `to`. A self edge is rejected here because it is decidable from the
 * edge alone; a CYCLE spans more than one edge and is therefore the graph's
 * job, not this schema's.
 */
export const DependencyEdgeSchema = z
  .strictObject({
    from: OpsIdSchema,
    to: OpsIdSchema,
  })
  .refine((e) => e.from !== e.to, {
    message: "dependency edge must not be a self edge",
  });
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;
