import 'dotenv/config';
import { Minimatch } from 'minimatch';
import path from 'path';
import { Octokit } from '@octokit/core';
import * as fs from 'node:fs';

const EXCLUDE_GLOBS = [
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.yarn/**',
  '**/.pnpm/**',
  '**/*.min.*',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar*',
  '**/*.wasm',
  '**/*.bin',
];

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GITHUB_SINCE,
  GITHUB_UNTIL,
  GITHUB_OUTDIR,
} = process.env;

const owner = GITHUB_OWNER!;
const repo = GITHUB_REPO!;
const branch = GITHUB_BRANCH ?? 'master';
const since = GITHUB_SINCE!;
const until = GITHUB_UNTIL!;
const outDir = GITHUB_OUTDIR ?? './tmp/git';

async function main() {
  checkEnvs();
  const result = await extractFromCommits();

  const out = fs.createWriteStream(outDir, { flags: 'w' });
  out.write(result);
  out.end();
  console.error(`Wrote: ${outDir}`);

  console.log(`Done!`);
}

function checkEnvs() {
  if (
    !owner ||
    !repo ||
    !branch ||
    !since ||
    !until ||
    !outDir
  ) {
    throw Error('Wrong envs');
  }
}

function isExcluded(filePath: string): boolean {
  if (isProbablyBinary(filePath)) {
    return true;
  }
  const excludeMatchers = EXCLUDE_GLOBS.map(g => new Minimatch(g, { dot: true, nocase: true }));
  return excludeMatchers.some(m => m.match(filePath));
}

function isProbablyBinary(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const binExts = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.7z',
    '.wasm',
    '.bin',
    '.woff',
    '.woff2',
    '.ttf',
  ];
  return binExts.includes(ext);
}

function stripComments(lines: string[], filePath: string): string[] {
  const ext = path.extname(filePath).toLowerCase();
  const slashes = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.java',
    '.kt',
    '.c',
    '.h',
    '.cpp',
    '.cc',
    '.cs',
    '.go',
    '.rs',
    '.swift',
  ]);
  const hashes = new Set(['.py', '.rb', '.sh', '.bash', '.zsh', '.ps1', '.toml', '.yaml', '.yml']);
  const isSlashLang = slashes.has(ext);
  const isHashLang = hashes.has(ext);

  let inBlock = false;
  return lines.filter(l => {
    if (!(l.startsWith('+') || l.startsWith('-'))) {
      return false;
    }
    if (l.startsWith('+++ ') || l.startsWith('--- ') || l.startsWith('@@')) {
      return false;
    }

    const content = l.slice(1);

    if (content.length > 300) {
      return false;
    }

    if (isSlashLang) {
      if (content.includes('/*')) {
        inBlock = true;
      }
      if (inBlock) {
        if (content.includes('*/')) {
          inBlock = false;
        }
        return false;
      }
      if (/^\s*\/\//.test(content)) {
        return false;
      }
    }
    if (isHashLang) {
      if (/^\s*#(?!\!)/.test(content)) {
        return false;
      }
    }
    if (/^\s*\* /.test(content)) {
      return false;
    }
    if (/^\s*$/.test(content)) {
      return false;
    }

    return true;
  });
}

function limitLines(lines: string[], max: number): string[] {
  if (lines.length <= max) {
    return lines;
  }
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return [...lines.slice(0, head), `\n... [${lines.length - max} lines skipped] ...\n`, ...lines.slice(-tail)];
}

async function extractFromCommits() {

  const octokit = new Octokit({
    auth: GITHUB_TOKEN,
  });

  // https://docs.github.com/en/rest/commits/commits#list-commits
  let page = 1;
  const per_page = 100;
  let out = '';

  while (true) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
      owner: owner,
      repo: repo,
      sha: branch,
      since: since,
      until: until,
      per_page, page,
    });

    const commits = res.data as any[];
    if (!commits.length) {
      break;
    }

    for (const c of commits) {
      const msg: string = c.commit?.message || '';
      const isMerge = /^merge\b/i.test(msg) || (c.parents?.length ?? 0) > 1;
      if (isMerge) {
        continue;
      }

      const sha = c.sha;
      // https://docs.github.com/en/rest/commits/commits#get-a-commit
      const commitResp = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
        owner: owner,
        repo: repo,
        ref: sha,
        headers: { 'Accept': 'application/vnd.github+json' },
      });
      const files = (commitResp.data as any).files || [];

      const fileEntries: any[] = [];
      let totalAdds = 0, totalDels = 0, totalFiles = 0;

      for (const f of files) {
        const fp = f.filename as string;

        if (isExcluded(fp)) {
          continue;
        }

        totalFiles++;
        totalAdds += f.additions || 0;
        totalDels += f.deletions || 0;

        let patch: string | undefined = f.patch;
        if (!patch || patch.split('\n').length < 2) {
          const diffResp = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
            owner: owner,
            repo: repo,
            ref: sha,
            headers: { 'Accept': 'application/vnd.github.diff, application/vnd.github+json' },
          });
          const diffText = diffResp.data as unknown as string;
          patch = extractFilePatchFromUnifiedDiff(diffText, fp);
        }

        if (!patch) {
          continue;
        }
        const rawLines = patch.split('\n');
        const filtered = stripComments(rawLines, fp);
        const limited = limitLines(filtered, 999_999);
        const llmSnippet = limited.join('\n');

        fileEntries.push({
          path: fp,
          additions: f.additions,
          deletions: f.deletions,
          llm_snippet: llmSnippet,
        });
      }

      if (!fileEntries.length) {
        continue;
      }

      const rec = {
        commit: {
          sha,
          author: c.author?.login || 'unknown',
          date: c.commit?.author?.date,
          message: msg,
        },
        stats: { totalFiles, additions: totalAdds, deletions: totalDels },
        files: fileEntries,
      };

      out += (JSON.stringify(rec) + '\n');
    }

    page++;
  }

  return out;
}

function extractFilePatchFromUnifiedDiff(diffText: string, filePath: string): string | undefined {
  if (typeof diffText !== 'string') {
    return undefined;
  }
  const lines = diffText.split('\n');

  const startRegex = new RegExp(`^diff --git a/${escapeRegExp(filePath)} b/${escapeRegExp(filePath)}$`);
  let i = lines.findIndex(l => startRegex.test(l));
  if (i === -1) {
    return undefined;
  }

  const chunk: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (i !== 0 && line.startsWith('diff --git a/') && /^diff --git a\/.+ b\/.+/.test(line)) {
      break;
    }
    chunk.push(line);
  }

  const keep = chunk.filter(l =>
    l.startsWith('@@') || l.startsWith('+++ ') || l.startsWith('--- ') || l.startsWith('+') || l.startsWith('-') ||
    l.startsWith(' '),
  );
  return keep.join('\n');
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
