#!/usr/bin/env node

import path from "path";
import { command, run, number, string, boolean, flag, option } from "cmd-ts";
import Piscina from "piscina";
import os from "os";

import ts from "typescript";

interface Args {
  tscPath: string;
  project: string;
  maxWorkers: number;
  verbose: boolean;
}

const cpuCount = os.cpus().length;

const enum ProjectState {
  WaitForDeps,
  ReadyToBuild,
  Building,
  Built,
}

function assert(val: boolean, msg: string): void {
  if (!val) {
    console.error(msg);
    process.exit(1);
  }
}

class ProjectsTree {
  private projectsState = new Map<string, ProjectState>();
  private dependenciesForProject = new Map<string, string[]>();

  public getBuildFlow(): number[] {
    const copy = new ProjectsTree();
    copy.projectsState = new Map(this.projectsState);
    copy.dependenciesForProject = new Map(this.dependenciesForProject);

    const result = [];
    while (!copy.areAllProjectsBuilt()) {
      const projectsToBuild = copy.takeProjectsReadyToBuild();
      result.push(projectsToBuild.length);
      projectsToBuild.forEach(copy.setProjectBuilt, copy);
    }

    return result;
  }

  public projectsCount(): number {
    return this.projectsState.size;
  }

  public addProjectWithDeps(projectPath: string, projDeps: string[]): void {
    this.dependenciesForProject.set(projectPath, projDeps.slice());
    this.updateProjectsState();
  }

  public validateState(): void {
    this.dependenciesForProject.forEach(
      (deps: string[], projectPath: string) => {
        assert(
          this.projectsState.get(projectPath) !== undefined,
          `Cannot find state for ${projectPath}`
        );

        deps.forEach((depPath: string) => {
          assert(
            this.projectsState.get(depPath) !== undefined,
            `Cannot find state for ${depPath}`
          );
        });
      }
    );
  }

  public takeProjectsReadyToBuild(): string[] {
    this.updateProjectsState();
    const result: string[] = [];
    this.projectsState.forEach((state: ProjectState, projectPath: string) => {
      if (state === ProjectState.ReadyToBuild) {
        result.push(projectPath);
      }
    });

    for (const projectPath of result) {
      this.projectsState.set(projectPath, ProjectState.Building);
    }

    return result;
  }

  public setProjectBuilt(projectPath: string): void {
    assert(
      this.projectsState.get(projectPath) === ProjectState.Building,
      `State of ${projectPath} is not building`
    );
    this.projectsState.set(projectPath, ProjectState.Built);
    this.updateProjectsState();
  }

  public areAllProjectsBuilt(): boolean {
    let result = true;

    this.projectsState.forEach((state: ProjectState) => {
      result = result && state === ProjectState.Built;
    });

    return result;
  }

  private updateProjectsState(): void {
    this.dependenciesForProject.forEach(
      (deps: string[], projectPath: string) => {
        const currentState = this.projectsState.get(projectPath);
        if (
          currentState === ProjectState.Built ||
          currentState === ProjectState.Building
        ) {
          return;
        }

        const allDepsAreBuilt = deps.every(
          (depPath: string) =>
            this.projectsState.get(depPath) === ProjectState.Built
        );
        this.projectsState.set(
          projectPath,
          allDepsAreBuilt ? ProjectState.ReadyToBuild : ProjectState.WaitForDeps
        );
      }
    );
  }
}

function durationToStr(durInMs: number): string {
  return `${(durInMs / 1000).toFixed(2)}s`;
}

async function buildInParallel(
  projectsTree: ProjectsTree,
  startTime: number,
  args: Args,
  workerPool: Piscina
): Promise<void> {
  if (projectsTree.areAllProjectsBuilt()) {
    console.log(
      `${projectsTree.projectsCount()} projects are compiled successfully in ${durationToStr(
        Date.now() - startTime
      )}`
    );
    return;
  }

  const projectsToBuild = projectsTree.takeProjectsReadyToBuild();
  if (projectsToBuild.length === 0) {
    return;
  }

  for (const project of projectsToBuild) {
    const projectStartTime = Date.now();
    console.log(`Running build for ${project}...`);

    const argv = ["-b", project];

    if (args.verbose) {
      argv.push("--verbose");
    }

    const tscPath = path.resolve(process.cwd(), args.tscPath);

    try {
      await workerPool.run({ tscPath, argv }, { name: "runTsc" });
      console.log(
        `  ${project} is built successfully in ${durationToStr(
          Date.now() - projectStartTime
        )}`
      );
      projectsTree.setProjectBuilt(project);
      await buildInParallel(projectsTree, startTime, args, workerPool);
    } catch (error) {
      console.log(error);
      console.error(`ERROR: Cannot build ${project}`);
      process.exit(1);
    }
  }
}

async function main(args: Args): Promise<void> {
  let project = args.project;

  const workerPool = new Piscina({
    filename: path.resolve(__dirname, "./worker.js"),
    maxThreads: args.maxWorkers,
  });

  const host = ts.createSolutionBuilderHost();
  const builder = ts.createSolutionBuilder(host, [project], {
    incremental: true,
  }) as any;

  // THIS IS PRIVATE API
  // to force ts read all configs
  void builder.getBuildOrder();

  // THIS IS PRIVATE API
  // it isn't enough to know build order
  // we need to know which one could be run in parallel
  const parsedConfigs: any[] = builder.getAllParsedConfigs();

  const tree = new ProjectsTree();

  for (const proj of parsedConfigs) {
    const deps =
      proj.projectReferences &&
      proj.projectReferences.map((x: any) => {
        if (ts.sys.fileExists(x.path)) {
          return x.path;
        }

        return ts.findConfigFile(x.path, ts.sys.fileExists);
      });

    tree.addProjectWithDeps(proj.options.configFilePath, deps ? deps : []);
  }

  tree.validateState();

  console.log("build flow:", JSON.stringify(tree.getBuildFlow()));

  await buildInParallel(tree, Date.now(), args, workerPool);
}

const app = command({
  name: "ptsc",
  description: "Compile typescript projects in parallel.",
  version: "0.0.1",
  async handler(args) {
    await main(args);
  },
  args: {
    tscPath: option({
      long: "tsc-path",
      type: string,
      defaultValue() {
        return "node_modules/typescript/lib/tsc.js";
      },
      defaultValueIsSerializable: true,
    }),
    project: option({
      long: "project",
      type: string,
      defaultValue() {
        return path.resolve(process.cwd(), "tsconfig.json");
      },
      defaultValueIsSerializable: true,
    }),
    maxWorkers: option({
      long: "workers",
      type: number,
      defaultValue() {
        return cpuCount;
      },
      defaultValueIsSerializable: true,
    }),
    verbose: flag({
      long: "verbose",
      type: boolean,
      defaultValue() {
        return false;
      },
      defaultValueIsSerializable: true,
    }),
  },
});

run(app, process.argv.slice(2));
