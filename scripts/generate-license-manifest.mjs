import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const outputPath = path.join(root, "src", "licenses.generated.ts");

const cargoLicenses = {
  axum: "MIT",
  blake3: "CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception",
  libc: "MIT OR Apache-2.0",
  libmpv2: "LGPL-2.1",
  objc2: "MIT",
  "objc2-foundation": "MIT",
  "objc2-app-kit": "Zlib OR Apache-2.0 OR MIT",
  rfd: "MIT",
  rusqlite: "MIT",
  serde: "MIT OR Apache-2.0",
  serde_json: "MIT OR Apache-2.0",
  tauri: "Apache-2.0 OR MIT",
  "tauri-build": "Apache-2.0 OR MIT",
  thiserror: "MIT OR Apache-2.0",
  tokio: "MIT",
  tower: "MIT",
  tracing: "MIT",
  uuid: "Apache-2.0 OR MIT",
  walkdir: "Unlicense/MIT",
};

function parseCargoDependencies(source) {
  const acceptedSections = new Map([
    ["dependencies", "runtime"],
    ["build-dependencies", "build"],
    ["dev-dependencies", "development"],
  ]);
  const entries = [];
  let scope = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      scope = acceptedSections.get(section[1]) ?? null;
      continue;
    }
    if (!scope || !line) continue;
    const dependency = line.match(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{\s*version\s*=\s*"([^"]+)")/);
    if (!dependency) continue;
    const name = dependency[1];
    const license = cargoLicenses[name];
    if (!license) throw new Error(`Cargo 依赖 ${name} 缺少许可映射`);
    entries.push({
      name,
      version: dependency[2] ?? dependency[3],
      license,
      ecosystem: "Cargo",
      scope,
    });
  }
  return entries;
}

function packageEntries(packageJson, packageLock) {
  const groups = [
    [packageJson.dependencies ?? {}, "runtime"],
    [packageJson.devDependencies ?? {}, "development"],
  ];
  return groups.flatMap(([dependencies, scope]) =>
    Object.entries(dependencies).map(([name, declaredVersion]) => {
      const locked = packageLock.packages?.[`node_modules/${name}`];
      if (!locked?.license) throw new Error(`npm 依赖 ${name} 缺少锁定许可信息`);
      return {
        name,
        version: locked.version ?? declaredVersion,
        license: locked.license,
        ecosystem: "npm",
        scope,
      };
    }),
  );
}

const [packageSource, packageLockSource, cargoSource] = await Promise.all([
  readFile(packagePath, "utf8"),
  readFile(packageLockPath, "utf8"),
  readFile(cargoPath, "utf8"),
]);
const entries = [
  ...packageEntries(JSON.parse(packageSource), JSON.parse(packageLockSource)),
  ...parseCargoDependencies(cargoSource),
].sort((left, right) =>
  left.ecosystem.localeCompare(right.ecosystem) || left.name.localeCompare(right.name),
);

const output = `// 此文件由 scripts/generate-license-manifest.mjs 生成，请勿手工编辑。\n\n` +
  `export interface GeneratedLicense {\n` +
  `  name: string;\n  version: string;\n  license: string;\n` +
  `  ecosystem: "Cargo" | "npm";\n  scope: "runtime" | "build" | "development";\n}\n\n` +
  `export const GENERATED_LICENSES: readonly GeneratedLicense[] = ${JSON.stringify(entries, null, 2)};\n`;

await writeFile(outputPath, output, "utf8");
console.log(`已生成 ${path.relative(root, outputPath)}（${entries.length} 项直接依赖）`);
