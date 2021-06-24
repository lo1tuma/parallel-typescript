import execa from "execa";

interface Options {
  tscPath: string;
  argv: string[];
}

export async function runTsc(options: Options): Promise<void> {
  await execa.node(options.tscPath, options.argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
}
