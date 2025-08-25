import 'dotenv/config';
import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { analyzeCommits, CommitRecord, extractFromCommits } from '@/analyze/github-utils.js';
import { getPrompt } from '@/utils/common.js';


const {
  GITHUB_TOKEN,
  GITHUB_REPOS,
  GITHUB_DAYS_AGO,
  GITHUB_PROMPT,
  GITHUB_CONTEXT,
} = process.env;
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-pro-preview';

async function main() {
  if (
    !GITHUB_REPOS ||
    !GITHUB_PROMPT ||
    !GITHUB_CONTEXT
  ) {
    throw Error('Wrong envs');
  }

  const context = await getPrompt(GITHUB_CONTEXT);
  let prompt = (await getPrompt(GITHUB_PROMPT)).replace('$PROJECT_CONTEXT', context);

  const now = new Date();
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(until);
  since.setUTCDate(until.getUTCDate() - Number(GITHUB_DAYS_AGO ?? '7'));


  const repos = GITHUB_REPOS.split(',');

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
      GITHUB_TOKEN,
    );
    // console.log('Result:\n', result);


    if (commitRecords.length !== 0) {
      const tmpDir = new URL('../../tmp/git/', import.meta.url);
      await mkdir(tmpDir, { recursive: true });
      const tmpDest = new URL(`./${repoData}.json`, tmpDir);
      await writeFile(tmpDest, JSON.stringify(commitRecords, null, 2));
      console.log(`Result saved to ${fileURLToPath(tmpDest)}`);
    }

    const results = await analyzeCommits(
      commitRecords,
      prompt,
      MODEL,
      (record: CommitRecord) => {
        return `
{
author: ${record.commit.author},        
date: ${record.commit.date},
head: ${record.commit.message},
files: ${JSON.stringify(record.files, null, 2)},
}        
        `;
      },
    );
  }


  console.log(`Done!`);
}


main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
