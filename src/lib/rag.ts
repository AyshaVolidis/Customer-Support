// Retrieval over the support policies in data/policies for grounding answers.
//
// This step only loads and chunks the policy files. There is no retrieval here
// yet.
//
// This is the ONLY file in the codebase allowed to import LangChain, and it
// never lets a LangChain type escape: the exported shape is PolicyChunk, a
// plain object. RecursiveCharacterTextSplitter.splitText returns strings, so no
// Document is ever constructed.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

import { CHUNK_OVERLAP, CHUNK_SIZE } from './config';

/** Where the policy markdown files live, relative to the project root. */
const POLICY_DIR = 'data/policies';

/**
 * One retrievable piece of a policy file.
 *
 * `source` is the file name only (e.g. `return-policy.md`), not a path: it is
 * what a policy answer cites as a source, so it has to be stable and readable.
 * `text` includes the heading line, so a chunk read on its own still says what
 * it is about.
 */
export type PolicyChunk = {
  source: string;
  heading: string;
  text: string;
};

/**
 * Loaded chunks, keyed by directory.
 *
 * The PROMISE is cached rather than the resolved array, so two calls that
 * overlap in time share one read instead of both hitting the disk. Keyed by
 * directory because the default is not the only possible argument — a test
 * passes a fixture directory, and a single unkeyed cache would hand it the
 * chunks of whichever directory was loaded first.
 */
const cache = new Map<string, Promise<PolicyChunk[]>>();

/**
 * Read every .md file in `dir` and return it as chunks.
 *
 * Two passes. First the file is split on its `##` headings, so a chunk never
 * straddles two topics and always knows which heading it came from. Then any
 * section still longer than CHUNK_SIZE is split further by
 * RecursiveCharacterTextSplitter, and every piece keeps the source and heading
 * of the section it came from.
 *
 * The result is cached after the first call, so later calls do no disk I/O.
 */
export async function loadPolicyChunks(
  dir: string = POLICY_DIR,
): Promise<PolicyChunk[]> {
  const cached = cache.get(dir);
  if (cached) return cached;

  // Store the promise before awaiting it, so a second call that arrives while
  // this one is still reading joins it instead of starting its own read. A
  // failed load is evicted so it is not cached as a permanent failure.
  const loading = readPolicyChunks(dir);
  cache.set(dir, loading);
  loading.catch(() => cache.delete(dir));

  return loading;
}

/** Forget the cached chunks. Exported for tests; production never needs it. */
export function clearPolicyChunkCache(): void {
  cache.clear();
}

/** The uncached read. Everything below here is plain string work. */
async function readPolicyChunks(dir: string): Promise<PolicyChunk[]> {
  const entries = await readdir(dir);
  // Sorted so the chunk order is the same on every machine and in every run.
  const fileNames = entries.filter((name) => name.endsWith('.md')).sort();

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const perFile = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await readFile(join(dir, fileName), 'utf8');
      return chunkFile(fileName, content, splitter);
    }),
  );

  return perFile.flat();
}

/** Split one file's content into chunks. */
async function chunkFile(
  source: string,
  content: string,
  splitter: RecursiveCharacterTextSplitter,
): Promise<PolicyChunk[]> {
  const chunks: PolicyChunk[] = [];

  for (const section of splitSections(content)) {
    // A section at or under the limit stays whole: splitting it would only
    // break up text that already fits in a prompt.
    const pieces =
      section.text.length <= CHUNK_SIZE
        ? [section.text]
        : await splitter.splitText(section.text);

    for (const piece of pieces) {
      const text = piece.trim();
      if (text.length === 0) continue; // skip empty chunks
      chunks.push({ source, heading: section.heading, text });
    }
  }

  return chunks;
}

type Section = { heading: string; text: string };

/**
 * Split markdown on its `##` headings.
 *
 * The lookahead keeps the heading line at the start of the section it opens, so
 * the heading ends up inside the chunk text as well as in the `heading` field.
 *
 * Anything before the first `##` is the file's preamble. In these files that is
 * just the `# Title` line, which answers no question on its own, so a preamble
 * is only kept when it has a body under the title.
 */
function splitSections(content: string): Section[] {
  const segments = content.split(/^(?=## )/m);
  const sections: Section[] = [];

  for (const segment of segments) {
    const text = segment.trim();
    if (text.length === 0) continue;

    const [firstLine, ...bodyLines] = text.split('\n');
    const body = bodyLines.join('\n').trim();

    if (firstLine.startsWith('## ')) {
      sections.push({ heading: firstLine.slice('## '.length).trim(), text });
      continue;
    }

    // The preamble. Its heading is the '# Title' line when there is one; a
    // title with nothing under it carries no facts, so it is dropped as empty.
    const hasTitle = firstLine.startsWith('# ');
    if (hasTitle && body.length === 0) continue;

    sections.push({
      heading: hasTitle ? firstLine.slice('# '.length).trim() : '',
      text,
    });
  }

  return sections;
}
