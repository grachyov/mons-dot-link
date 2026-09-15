import { createServer, loadConfigFromFile, mergeConfig } from "vite";

export async function createBrowserViteServer(options) {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    undefined,
    options.root,
    "error",
  );
  if (!loaded) throw new Error("browser-test-vite-config-missing");
  const config = mergeConfig(loaded.config, options);
  return createServer({
    ...config,
    configFile: false,
    plugins: config.plugins.filter(
      (plugin) => plugin?.name !== "vite-plugin-checker",
    ),
  });
}
