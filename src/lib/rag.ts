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

import { CHUNK_OVERLAP, CHUNK_SIZE, RETRIEVE_K } from './config';

/** Where the policy markdown files live, relative to the project root. */
const POLICY_DIR = 'data/policies';

/**
 * One retrievable piece of a policy file.
 *
 * `source` is the file name only (e.g. `return-policy.md`), not a path: it is
 * what a policy answer cites as a source, so it has to be stable and readable.
 * `title` is the file's own `# ` line, so it reads the way the policy names
 * itself rather than the way its file is named. Every chunk of a file carries
 * the same title, including the pieces the splitter produces.
 * `text` is the body ALONE, with its own heading line removed: the heading
 * already lives in `heading`, and keeping it in both places would weight those
 * few words twice in the embedding and read as a repetition in a prompt.
 */
export type PolicyChunk = {
  source: string;
  title: string;
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
export function resetPolicyChunksForTests(): void {
  cache.clear();
}

/**
 * The string that will be embedded for this chunk, once retrieval exists.
 *
 * A chunk's body on its own can be ambiguous. It never names its own policy,
 * and a later piece of a long section does not even carry its heading, so
 * "report it within 14 days" and "return it within 30 days" embed as
 * near-identical text while belonging to different policies. Leading with the
 * title and the heading keeps that distinction in the embedded text.
 *
 * `text` is stored without its heading line, so the prefix states the heading
 * once and the body is not rewritten here.
 */
export function embedText(chunk: PolicyChunk): string {
  // A chunk with no heading is a file preamble, which the title alone names.
  // A preamble whose heading IS the title would otherwise repeat it.
  const prefix =
    chunk.heading.length > 0 && chunk.heading !== chunk.title
      ? `${chunk.title} > ${chunk.heading}`
      : chunk.title;

  return `${prefix}: ${chunk.text}`;
}

/**
 * The file's own title: its first `# ` line, or the file name if it has none.
 *
 * Read from the content rather than derived from the file name, so the title
 * reads as the policy writes it — 'Damaged, defective or wrong item' rather
 * than the file name's 'damaged-or-wrong-item.md'.
 */
function documentTitle(source: string, content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // '## ' is a section heading, not the document title.
    if (trimmed.startsWith('# ')) return trimmed.slice('# '.length).trim();
  }

  return source;
}

/**
 * The part of the LangChain Embeddings interface the retriever needs.
 *
 * Narrowed to two methods so a test can supply a deterministic fake without
 * standing up a LangChain class, and so nothing outside this file has to know
 * which provider is behind it.
 */
export type EmbeddingsLike = {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

/** A retrieved chunk and how similar it was to the query. Higher is closer. */
export type ScoredPolicyChunk = PolicyChunk & { score: number };

/**
 * Find the policy chunks most similar to `query`.
 *
 * NOT IMPLEMENTED — this is the stub the step 7B tests are written against.
 */
export async function retrieve(
  query: string,
  k: number = RETRIEVE_K,
  deps?: { embeddings?: EmbeddingsLike },
): Promise<ScoredPolicyChunk[]> {
  void query;
  void k;
  void deps;
  throw new Error('not implemented');
}

/** Forget the cached vector store. Exported for tests. NOT IMPLEMENTED. */
export function resetRetrieverForTests(): void {
  throw new Error('not implemented');
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
  // Read once per file, so every chunk of it gets the same title.
  const title = documentTitle(source, content);
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
      chunks.push({ source, title, heading: section.heading, text });
    }
  }

  return chunks;
}

type Section = { heading: string; text: string };

/**
 * Split markdown on its `##` headings.
 *
 * The lookahead keeps the heading line at the start of the section it opens,
 * which is how the heading is read; the line is then dropped from the section
 * text, so a section's `text` is its body alone and the heading lives only in
 * the `heading` field.
 *
 * Anything before the first `##` is the file's preamble. In these files that is
 * just the `# Title` line, which answers no question on its own, so a preamble
 * is only kept when it has a body under the title — and that title line is
 * dropped from its text in the same way.
 */
function splitSections(content: string): Section[] {
  const segments = content.split(/^(?=## )/m);
  const sections: Section[] = [];

  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (trimmedSegment.length === 0) continue;

    const [firstLine, ...bodyLines] = trimmedSegment.split('\n');
    const body = bodyLines.join('\n').trim();

    if (firstLine.startsWith('## ')) {
      sections.push({
        heading: firstLine.slice('## '.length).trim(),
        text: body,
      });
      continue;
    }

    // The preamble. Its heading is the '# Title' line when there is one; a
    // title with nothing under it carries no facts, so it is dropped as empty.
    const hasTitle = firstLine.startsWith('# ');
    if (hasTitle && body.length === 0) continue;

    sections.push({
      heading: hasTitle ? firstLine.slice('# '.length).trim() : '',
      // With no '# ' line there is no heading line to drop, so the first line
      // is body like any other.
      text: hasTitle ? body : trimmedSegment,
    });
  }

  return sections;
}
