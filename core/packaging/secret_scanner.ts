import { readFile } from "node:fs/promises";
import { walk } from "../util/walk.ts";
import type { ScanResult } from "../../shared/types.ts";
import { loadGitignorePatterns } from "../util/gitignore.ts";

const ALWAYS_SKIP: RegExp[] = [
  /^\.git\//,
  /^node_modules\//,
  /^\.env/,
  /^\.claude\//,
  /^\.omc\//,
  // Test files commonly contain fake fixtures that look like secrets.
  /(^|\/)tests?\//,
  /(^|\/)__tests?__\//,
  /(^|\/)spec\//,
  /\.(test|spec)\.[a-zA-Z]+$/,
  /_test\.[a-zA-Z]+$/,
];

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const FILE_PATTERNS: RegExp[] = [
  /^\.env$/, /^\.env\./, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /credentials\.json$/, /secrets\.json$/, /secret\.yaml$/, /secret\.yml$/,
];

const CONTENT_PATTERNS: SecretPattern[] = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS Secret Key", pattern: /(?:AWS_SECRET|aws_secret)[_\s]*(?:ACCESS_)?KEY[_\s]*[=:]\s*["']?[A-Za-z0-9/+=]{40}/ },
  { name: "GCP API Key", pattern: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: "GitHub Personal Access Token", pattern: /ghp_[0-9a-zA-Z]{36}/ },
  { name: "GitHub App Token", pattern: /ghs_[0-9a-zA-Z]{36}/ },
  { name: "GitHub OAuth Token", pattern: /gho_[0-9a-zA-Z]{36}/ },
  { name: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9]{48}/ },
  { name: "Anthropic API Key", pattern: /sk-ant-[a-zA-Z0-9\-_]{95}/ },
  { name: "Stripe Secret Key", pattern: /sk_live_[0-9a-zA-Z]{24}/ },
  { name: "Stripe Test Key", pattern: /sk_test_[0-9a-zA-Z]{24}/ },
  { name: "Slack Token", pattern: /xox[baprs]-[0-9a-zA-Z\-]{10,48}/ },
  { name: "Slack Webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/ },
  { name: "Firebase API Key", pattern: /AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}/ },
  { name: "Twilio API Key", pattern: /SK[0-9a-fA-F]{32}/ },
  { name: "SendGrid API Key", pattern: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/ },
  { name: "Generic API Key", pattern: /(?:api[_\-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9\-_]{20,}["']?/i },
  { name: "Generic Secret", pattern: /(?:secret|password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}["']/i },
  { name: "Generic Token", pattern: /(?:token|access_token|auth_token)\s*[=:]\s*["'][A-Za-z0-9\-_\.]{20,}["']/i },
  { name: "Private Key Block", pattern: /^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Database URL with credentials", pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/ },
];

function isFileSensitive(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  return FILE_PATTERNS.some((p) => p.test(base));
}

async function scanFileContent(filePath: string, relPath: string): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return results;
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Skip lines that are too long (ReDoS protection)
    if (lines[i].length > 1000) continue;
    for (const { name, pattern } of CONTENT_PATTERNS) {
      const match = lines[i].match(pattern);
      if (match) {
        results.push({
          file: relPath, line: i + 1, pattern: name,
          match: match[0].slice(0, 40) + (match[0].length > 40 ? "..." : ""),
        });
      }
    }
  }
  return results;
}

export async function scanDirectory(dir: string): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const gitignorePatterns = await loadGitignorePatterns(dir);

  for await (const entry of walk(dir)) {
    if (!entry.isFile) continue;
    const relPath = entry.path.replace(dir + "/", "");
    if (ALWAYS_SKIP.some((p) => p.test(relPath))) continue;
    if (gitignorePatterns.some((p) => p.test(relPath))) continue;

    if (isFileSensitive(entry.name)) {
      results.push({ file: relPath, line: 0, pattern: "Sensitive filename", match: entry.name });
      continue;
    }
    results.push(...await scanFileContent(entry.path, relPath));
  }

  return results;
}

export function formatScanResults(results: ScanResult[]): string {
  if (results.length === 0) return "";
  const lines = ["Sensitive information detected. Upload blocked.\n"];
  for (const r of results) {
    const location = r.line > 0 ? `${r.file}:${r.line}` : r.file;
    lines.push(`  [${r.pattern}] ${location}`);
    lines.push(`    → ${r.match}`);
  }
  lines.push("\nAdd the file(s) to .gitignore or remove the sensitive information, then try again.");
  return lines.join("\n");
}
