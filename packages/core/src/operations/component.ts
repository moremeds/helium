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

export const MUTATION_OWNERS = ["opsd", "external", "none"] as const;
export type MutationOwner = (typeof MUTATION_OWNERS)[number];

/**
 * Who is permitted to mutate this component, and what else was seen trying.
 *
 * REQUIRED on every component. The lease excludes a second Helium controller;
 * it says nothing about the legacy watchdogs, which are independent host jobs
 * outside every lease, lock and event log. A component with no recorded owner
 * is a component nobody has decided about, and defaulting that to "we may
 * mutate it" is the one crash-matrix cell that produces a genuine duplicate
 * production mutation.
 *
 * `competingLabels` is opaque to core: they are host identifiers this package
 * neither parses nor understands.
 */
export const MutationOwnershipSchema = z.strictObject({
  owner: z.enum(MUTATION_OWNERS),
  /** Opaque label of the external owner, when there is one. */
  externalOwnerLabel: z.string().min(1).max(256).optional(),
  /** Other controllers observed for this component. Opaque strings. */
  competingLabels: z.array(z.string().min(1).max(256)),
  changedAt: z.string().min(1),
  /** Evidence reference for the change: who decided, and where it is recorded. */
  changeRef: z.string().min(1).max(512),
});
export type MutationOwnership = z.infer<typeof MutationOwnershipSchema>;

export const ComponentSpecSchema = z.strictObject({
  version: z.literal(1),
  id: OpsIdSchema,
  /** Open-ended on purpose. See the module comment. */
  kind: z.string().min(1).max(64),
  displayName: z.string().min(1).max(200).optional(),
  /** Dimensions this component can be observed along, if it declares any. */
  dimensions: z.array(z.string().min(1).max(64)).optional(),
  mutationOwner: MutationOwnershipSchema,
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
