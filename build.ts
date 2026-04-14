import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

const stubReactDevtools = {
  name: "stub-react-devtools",
  setup(build: Bun.PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
      path: args.path,
      namespace: "stub-devtools",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({
      contents: `export default {}; export const connectToDevTools = () => {};`,
      loader: "js",
    }));
  },
} satisfies Bun.BunPlugin;

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  target: "node",
  format: "esm",
  minify: true,
  external: ["@vscode/ripgrep"],
  plugins: [stubReactDevtools],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const output = result.outputs[0];
if (!output) {
  console.error("Build produced no outputs");
  process.exit(1);
}

const SHEBANG = "#!/usr/bin/env node\n";
const code = await output.text();
const withShebang = code.startsWith("#!")
  ? code
  : SHEBANG + code;

mkdirSync("./dist", { recursive: true });
writeFileSync("./dist/ccgrep.js", withShebang);
chmodSync("./dist/ccgrep.js", 0o755);
console.log("Built ./dist/ccgrep.js");
