import { plugin } from "bun";

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
  target: "bun",
  minify: true,
  compile: {
    outfile: "./ccgrep",
  },
  plugins: [stubReactDevtools],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("Built ./ccgrep");
