import { readFileSync, writeFileSync } from "node:fs";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

const [source, iconPath, target, version] = process.argv.slice(2);
const executable = NtExecutable.from(readFileSync(source), { ignoreCert: true });
const resources = NtExecutableResource.from(executable);
const { IconGroupEntry, VersionInfo } = Resource;
const icons = Data.IconFile.from(readFileSync(iconPath)).icons.map(({ data }) => data);
const groups = IconGroupEntry.fromEntries(resources.entries);
if (!groups.length || !icons.length) throw new Error("Expected at least one Windows icon group");
for (const group of groups) {
  IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
}
const [major, minor, patch] = version.split(".").map(Number);
for (const info of VersionInfo.fromEntries(resources.entries)) {
  info.setFileVersion(major, minor, patch, 0);
  info.setProductVersion(major, minor, patch, 0);
  for (const { lang, codepage } of info.getAllLanguagesForStringValues()) {
    info.setStringValues({ lang, codepage }, {
      CompanyName: "MeteorAgent",
      FileDescription: "MeteorAgent Beta",
      InternalName: "MeteorAgent Beta",
      OriginalFilename: "MeteorAgent Beta.exe",
      ProductName: "MeteorAgent Beta",
    });
  }
  info.outputToResourceEntries(resources.entries);
}
resources.outputResource(executable);
writeFileSync(target, Buffer.from(executable.generate()), { flag: "wx" });
