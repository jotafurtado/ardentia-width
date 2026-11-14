// Instala a cópia de desenvolvimento em um cofre, com id e nome próprios,
// para conviver com a versão instalada pelo diretório da comunidade.
// Uso: npm run install:dev -- "/caminho/do/cofre"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2];
if (!vault) {
  console.error("informe o caminho do cofre");
  process.exit(1);
}

const configDir = join(vault, ".obsidian");
if (!existsSync(configDir)) {
  console.error(`não é um cofre do Obsidian: ${vault}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const devManifest = { ...manifest, id: `${manifest.id}-dev`, name: `${manifest.name} (Dev)` };
const pluginDir = join(configDir, "plugins", devManifest.id);

mkdirSync(pluginDir, { recursive: true });
copyFileSync("main.js", join(pluginDir, "main.js"));
copyFileSync("styles.css", join(pluginDir, "styles.css"));
writeFileSync(join(pluginDir, "manifest.json"), `${JSON.stringify(devManifest, null, 2)}\n`);

console.log(`${devManifest.name} instalado em ${pluginDir}`);
console.log("Ative em Configurações, Plugins da comunidade. Deixe só uma das duas versões ativa.");
