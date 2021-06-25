import ts from "typescript";

function compile(tsconfigPath: string): void {
  const solutionBuilderHost = ts.createSolutionBuilderHost(ts.sys);
  const solutionBuilder = ts.createSolutionBuilder(
    solutionBuilderHost,
    [tsconfigPath],
    {}
  );
  const exitCode = solutionBuilder.build();

  if (exitCode !== ts.ExitStatus.Success) {
    throw new Error(
      "Your typescript project has compilation errors. Run tsc to debug."
    );
  }
}

interface Options {
  tsconfigPath: string;
}

export function runTsc(options: Options): void {
  compile(options.tsconfigPath);
}
