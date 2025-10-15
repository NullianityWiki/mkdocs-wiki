import { Minimatch } from 'minimatch';
import path from 'path';
import { Octokit } from '@octokit/core';
import OpenAI from 'openai';
import { mkdir, writeFile } from 'fs/promises';

export type CommitRecord = {
  commit: {
    sha: string;
    author: string;
    date?: string;
    message: string;
  };
  stats: {
    totalFiles: number;
    additions: number;
    deletions: number;
  };
  files: {
    path: string;
    additions: number;
    deletions: number;
    llm_snippet: string;
  }[];
}

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

export async function extractFromCommits(
  owner: string,
  repo: string,
  branch: string,
  since: string,
  until: string,
  githubToken: string | undefined,
): Promise<CommitRecord[]> {

  if (!githubToken) {
    throw new Error('no github token');
  }

  const octokit = new Octokit({
    auth: githubToken,
  });

  // https://docs.github.com/en/rest/commits/commits#list-commits
  let page = 1;
  const per_page = 100;
  let out: CommitRecord[] = [];

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
      // console.log('zero commits, break');
      break;
    }

    console.log(`Received ${commits.length} commits`);

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

      out.push(rec);
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

export async function analyzeCommits(
  records: CommitRecord[],
  PROMPT: string,
  MODEL: string,
  handler: (msg: CommitRecord) => string,
) {
  if (!records || records.length === 0) {
    console.log(`No commits to analyze, skipping...`);
    return '';
  }
  let lowestDate = Math.floor(Date.now() / 1000);
  let highestDate = 0;
  let msgCounter = 0;
  let msgCounterCtx = 0;


  let lastMessagesData = '';
  for (const r of records) {
    const dateTime = (new Date(r.commit.date ?? '')).getTime();
    lowestDate = Math.min(lowestDate, dateTime);
    highestDate = Math.max(highestDate, dateTime);
    lastMessagesData += handler(r);
    msgCounter++;
  }

  console.log(`>>> Analyzing commits(${msgCounter} / ${msgCounterCtx +
  msgCounter}) from ${new Date(lowestDate).toISOString()} to ${new Date(highestDate).toISOString()}`);

  let prompt = PROMPT
    .replace('$LAST_MESSAGES', lastMessagesData);

  // console.log(`Prompt:`, prompt);

  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    // apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 1,
  });
  const result = response.choices[0].message.content ?? '';

  console.log(`result:\n`, result);

  //save last prompt to tmp dir

  const tmpDir = new URL('../../tmp/', import.meta.url);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(new URL('last_prompt.txt', tmpDir), prompt);
  await writeFile(new URL('last_result.txt', tmpDir), result);

  console.log('Results saved!');

  return result;
}

export async function loadGithubRecords(
  reposArr: string,
  daysAgo: number,
  ghToken: string,
) {
    try {
        const out = [];
        const now = new Date();
        const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const since = new Date(until);
        since.setUTCDate(until.getUTCDate() - daysAgo);


        const repos = reposArr.split(',');

        for (const repoData of repos) {
            const owner = repoData.split(':')[0];
            const repo = repoData.split(':')[1];
            const branch = repoData.split(':')[2];


            const commitRecords = await extractFromCommits(
                owner,
                repo,
                branch,
                since.toISOString(),
                until.toISOString(),
                ghToken,
            );

            out.push(...commitRecords);
        }

        return out;
    }catch (e) {
        console.error(e);
        return [];
    }
}
