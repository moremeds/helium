/**
 * Bounded filesystem loader for operations components, checks and SOPs.
 *
 * Files are read and parsed completely before the registry is touched. A bad
 * tenant therefore receives an `invalid` health row while every previously
 * installed tenant remains intact. Paths are resolved relative to the
 * caller-supplied configuration base; no current-working-directory assumption
 * leaks into a long-running daemon.
 * @module dsh-plugin-ops-agent/bundle-loader
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { loadAuthoritySource } from "./authority-manifest-loader.js";
import { ComponentRegistry, type OpsBundle } from "./component-registry.js";
import { OpsConfigSchema, type OpsConfig } from "./config.js";

export interface TenantConfigHealth {
  tenantId: string;
  state: "loaded" | "invalid";
  detail?: string;
}

export interface TenantInstallResult {
  health: TenantConfigHealth;
  dispose?: () => void;
}

export interface OpsBundleLoaderOptions {
  baseDir: string;
  config: unknown;
  registeredProbeIds: readonly string[];
  now: () => Date;
}

type BundleSection = "components" | "edges" | "checks" | "sops";

export class OpsBundleLoader {
  readonly registry: ComponentRegistry;
  readonly #baseDir: string;
  readonly #config: OpsConfig;

  constructor(options: OpsBundleLoaderOptions) {
    this.#baseDir = resolve(options.baseDir);
    this.#config = OpsConfigSchema.parse(options.config);
    const authority = loadAuthoritySource({
      authorityManifestPath: this.#path(this.#config.authorityManifestPath),
      trustedKeyPath: this.#path(this.#config.trustedKeyPath),
    });
    this.registry = new ComponentRegistry({
      authority,
      registeredProbeIds: options.registeredProbeIds,
      now: options.now,
      limits: {
        maxComponents: this.#config.maxComponents,
        maxSops: this.#config.maxSops,
        maxChecks: this.#config.maxChecks,
      },
    });
  }

  installTenant(tenantId: string, tenantBaseDir: string): TenantInstallResult {
    try {
      const bundleBase = resolve(tenantBaseDir);
      const files = [
        ...this.#files("components", this.#config.componentsDir, bundleBase),
        ...this.#files("edges", this.#config.dependenciesDir, bundleBase),
        ...this.#files("checks", this.#config.checksDir, bundleBase),
        ...this.#files("sops", this.#config.sopsDir, bundleBase),
      ];
      if (files.length > this.#config.maxFiles) {
        throw new Error(
          `bundle file limit exceeded: ${files.length} > ${this.#config.maxFiles}`,
        );
      }

      const bundle: OpsBundle = {
        tenantId,
        components: [],
        edges: [],
        checks: [],
        sops: [],
      };
      for (const file of files) {
        const values = this.#readYaml(file.path);
        bundle[file.section]?.push(...values);
      }
      const dispose = this.registry.install(bundle);
      return { health: { tenantId, state: "loaded" }, dispose };
    } catch (error) {
      return {
        health: {
          tenantId,
          state: "invalid",
          detail: error instanceof Error ? error.message : "bundle load failed",
        },
      };
    }
  }

  #path(configured: string): string {
    return isAbsolute(configured) ? configured : resolve(this.#baseDir, configured);
  }

  #files(
    section: BundleSection,
    configuredDir: string,
    bundleBase: string,
  ): { section: BundleSection; path: string }[] {
    if (isAbsolute(configuredDir)) {
      throw new Error(`tenant bundle directory must be relative: ${configuredDir}`);
    }
    const dir = resolve(bundleBase, configuredDir);
    return readdirSync(dir)
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort()
      .map((name) => {
        const path = resolve(dir, name);
        if (!statSync(path).isFile()) {
          throw new Error(`bundle entry is not a regular file: ${path}`);
        }
        return { section, path };
      });
  }

  #readYaml(path: string): unknown[] {
    const size = statSync(path).size;
    if (size > this.#config.maxFileBytes) {
      throw new Error(
        `bundle file byte limit exceeded: ${size} > ${this.#config.maxFileBytes}`,
      );
    }
    const documents = parseAllDocuments(readFileSync(path, "utf8"), {
      strict: true,
      uniqueKeys: true,
    });
    const errors = documents.flatMap((document) => document.errors);
    if (errors.length > 0) {
      throw new Error(`invalid YAML: ${errors[0]?.message ?? "parse failed"}`);
    }
    return documents
      .filter((document) => document.contents !== null)
      .map((document) => document.toJS() as unknown);
  }
}
