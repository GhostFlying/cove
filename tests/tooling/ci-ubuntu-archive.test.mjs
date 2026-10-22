import { expect, test } from "vitest";
import { officialUbuntuSource } from "../../scripts/ci-ubuntu-archive.mjs";

const os = 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n';
const mirrors =
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
const source = `# Ubuntu archive
Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

test("official route preserves all source semantics and leaves mirror input unchanged", () => {
  const effective = officialUbuntuSource(source, mirrors, os, "x64");
  expect(effective.match(/^URIs: .+$/gm)).toEqual([
    "URIs: https://archive.ubuntu.com/ubuntu/",
    "URIs: https://archive.ubuntu.com/ubuntu/",
  ]);
  expect(effective.replace(/^URIs: .+$/gm, "URIs: ROUTE")).toBe(
    source.replace(/^URIs: .+$/gm, "URIs: ROUTE"),
  );
  expect(mirrors).toContain("azure.archive.ubuntu.com");
  expect(officialUbuntuSource(effective, "", os, "x64")).toBe(effective);
});

test.each([
  [source, mirrors, os.replace("24.04", "26.04"), "x64"],
  [source, mirrors, os, "arm64"],
  [source.replace("noble-security", "jammy-security"), mirrors, os, "x64"],
  [
    source.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://private.invalid/ubuntu/"),
    mirrors,
    os,
    "x64",
  ],
  [source.replace("Signed-By:", "Trusted: yes\nSigned-By:"), mirrors, os, "x64"],
  [source.replace("ubuntu-archive-keyring.gpg", "other.gpg"), mirrors, os, "x64"],
  [source.replace("Types: deb", "Types: deb\nURIs: https://other.invalid/"), mirrors, os, "x64"],
  [source, mirrors + "https://another.invalid/ priority:4\n", os, "x64"],
  [
    source.replace(
      "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
      "URIs:\n mirror+file:/etc/apt/apt-mirrors.txt",
    ),
    mirrors,
    os,
    "x64",
  ],
])(
  "unsupported runner layout refuses without changing the supplied originals (%#)",
  (...inputs) => {
    const originals = [...inputs];
    expect(() => officialUbuntuSource(...inputs)).toThrow(/Unsupported/);
    expect(inputs).toEqual(originals);
  },
);
