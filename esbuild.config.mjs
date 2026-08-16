import esbuild from "esbuild";
import process from "node:process";
import { resolve } from "node:path";

const production = process.argv.includes("--production");
const context = await esbuild.context({
  entryPoints: [resolve(process.cwd(), "main.ts")],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "node",
  target: "es2018",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: resolve(process.cwd(), "main.js"),
  logLevel: "info"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching for changes...");
}
